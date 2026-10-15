/**
 * 失败尝试的**可重试性分类**单测（2026-10-15 · 收口 `G-dupwake`）
 *
 * 尸体样本 = 线上真实形态：`fetch 异常: TypeError: fetch failed`（超时/未知）——
 * 修前它会触发重试，而那次调用**可能已经在会话里生效** ⇒ 重复投递。
 * `G-dupwake` 现场：两轮各 3 条同文案，而投递日志只记了一行成功。
 *
 * 对照组：连接层失败（`ECONNREFUSED`）**必须**仍可重试——若它也判不可重试，
 * 说明判据退化成「一律不重试」（那就不是分类，是关掉重试）。
 *
 * 判据来源：论文 arXiv:2610.16776 的编排纪律「a timeout does not prove termination」。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { classifyAttemptFailure } from '../lib/wake-delivery.js'

describe('classifyAttemptFailure · 可重试性分类', () => {
  test('尸体样本：超时/未知异常 ⇒ 不可重试（可能已生效）', () => {
    const r = classifyAttemptFailure({ layer: 'exception', detail: 'fetch 异常: TypeError: fetch failed' })
    assert.equal(r.kind, 'unknown')
    assert.equal(r.retryable, false, '未知类必须不重试——这是 G-dupwake 的修法核心')
  })

  test('对照组：连接层失败 ⇒ 仍可重试（证明不是「一律不重试」）', () => {
    for (const detail of [
      'fetch 异常: Error: connect ECONNREFUSED 127.0.0.1:3080',
      'fetch 异常: Error: getaddrinfo ENOTFOUND 127.0.0.1',
      'fetch 异常: Error: socket hang up',
      'fetch 异常: Error: read ECONNRESET',
    ]) {
      const r = classifyAttemptFailure({ layer: 'exception', detail })
      assert.equal(r.kind, 'not-delivered', detail)
      assert.equal(r.retryable, true, detail)
    }
  })

  test('金标准：服务端明确拒绝（RPC ok:false）⇒ 可重试且不产生重复', () => {
    const r = classifyAttemptFailure({ layer: 'rpc-reject', detail: '会话忙' })
    assert.equal(r.kind, 'rejected')
    assert.equal(r.retryable, true)
  })

  test('401 的异常形态归「被拒」（服务端应答了 ⇒ 重试安全）', () => {
    const r = classifyAttemptFailure({
      layer: 'exception',
      detail: 'fetch 异常: SyntaxError: Unexpected token \'u\', "unauthorized" is not valid JSON',
    })
    assert.equal(r.kind, 'rejected')
    assert.equal(r.retryable, true)
  })

  test('分类穷尽：任意文本都落进三类之一（不留未定义）', () => {
    const kinds = new Set(['rejected', 'not-delivered', 'unknown'])
    for (const detail of ['', '随便什么', 'ECONNRESET', 'timeout', 'undefined']) {
      const r = classifyAttemptFailure({ layer: 'exception', detail })
      assert.ok(kinds.has(r.kind), detail + ' → ' + r.kind)
    }
  })

  test('保守侧：空文本/未知文本落 unknown（宁可少发一次，不重复做两遍）', () => {
    assert.equal(classifyAttemptFailure({ layer: 'exception', detail: '' }).retryable, false)
    assert.equal(classifyAttemptFailure({ layer: 'exception', detail: '未识别的怪错误' }).retryable, false)
  })
})

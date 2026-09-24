/**
 * 哨兵消费判据（纯函数）：**内容级** vs 旧的**路径级**。
 *
 * 事故（2026-09-25，4 次复现 + `.watch-events.log` 证据）：成功重启后日志写
 * 「周期完成（期间哨兵被重新 touch，flag 保留待下一轮）」⇒ flag 不退场 ⇒
 * 下一轮用同一份 `daemon_restart:` 哨兵再判闸门，而「预检记录早于本轮 web 启动」
 * 在成功重启后**必然**成立 ⇒ 每轮重启附赠一条误导性「daemon_restart 被拦」+ 哨兵滞留。
 *
 * 尸体样本（第一条用例的输入即旧路径级判据的全部输入）：旧实现返回「保留」（错），
 * 新实现返回「消费」（对）——判据有真区分力。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldConsumeFlag } from '../lib/flag-consume.js'

test('尸体样本：同路径 + 内容未变 = 自触发 ⇒ 消费（旧路径级判据在此必错）', () => {
  assert.equal(
    shouldConsumeFlag({ pendingSamePath: true, flagExists: true, contentUnchanged: true }),
    true,
  )
})

test('真·新触发：同路径但内容已变 ⇒ 保留（2026-08-31 M1 的本意不丢）', () => {
  assert.equal(
    shouldConsumeFlag({ pendingSamePath: true, flagExists: true, contentUnchanged: false }),
    false,
  )
})

test('正常路径：期间无事件 ⇒ 消费', () => {
  assert.equal(
    shouldConsumeFlag({ pendingSamePath: false, flagExists: true, contentUnchanged: false }),
    true,
  )
})

test('文件已不在盘上 ⇒ 视作已消费（不再白跑一轮）', () => {
  assert.equal(shouldConsumeFlag({ pendingSamePath: true, flagExists: false, contentUnchanged: false }), true)
  assert.equal(shouldConsumeFlag({ pendingSamePath: false, flagExists: false, contentUnchanged: false }), true)
})

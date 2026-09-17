/**
 * wake-delivery 单测（2026-09-17 · 唤醒投递的编排与失败取证）。
 * 运行：npm test（导入编译产物 lib/wake-delivery.js）
 *
 * 背景：`.watch-events.log` 首次触发「换候选」路径即暴露三处缺陷——
 *   ① 失败原因被 catch 吞掉（只有「换下一个候选: <id>」）；
 *   ② 首选（= 触发者会话）失败即刻换靶，而重启后该失败常是瞬时状态；
 *   ③ 改投静默（触发者永远不知道自己错过了提醒）。
 * 本套件把这三条钉成可证伪判据（含**事故形状**的尸体样本）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeReject,
  isRerouted,
  planWakeAttempts,
  rerouteNotice,
  summarizeFailures,
  truncateText,
} from '../lib/wake-delivery.js'

// ---------- 编排 ----------

test('planWakeAttempts：首选多给一轮，其余默认 1 轮', () => {
  const plan = planWakeAttempts(['primary', 'a', 'b'])
  assert.deepEqual(plan, [
    { target: 'primary', waves: 2 },
    { target: 'a', waves: 1 },
    { target: 'b', waves: 1 },
  ])
  assert.deepEqual(planWakeAttempts([], {}), [])
  // 可配置 + 非法值被抬到 ≥1（不许出现 0 轮 = 静默不投）
  assert.deepEqual(planWakeAttempts(['p', 'a'], { primaryWaves: 3, othersWaves: 2 }), [
    { target: 'p', waves: 3 },
    { target: 'a', waves: 2 },
  ])
  assert.deepEqual(planWakeAttempts(['p', 'a'], { primaryWaves: 0, othersWaves: -5 }), [
    { target: 'p', waves: 1 },
    { target: 'a', waves: 1 },
  ])
})

// ---------- 失败取证（证据层：reason 永不缺失） ----------

test('describeReject：字符串 / error / message / 嵌套 / null 全形状都能给非空原因', () => {
  assert.equal(describeReject('会话正在运行'), '会话正在运行')
  assert.equal(describeReject({ error: 'session busy' }), 'session busy')
  assert.equal(describeReject({ message: '会话不存在' }), '会话不存在')
  assert.equal(describeReject({ detail: { reason: 'locked' } }), 'locked')
  // 无 error/message ⇒ JSON 兜底（保住形状证据）
  assert.match(describeReject({ code: 409, hint: 'busy' }), /409/)
  // 完全没有可读文本 ⇒ 形状说明（**不得为空串**）
  const empty = describeReject({}, undefined)
  assert.ok(empty.length > 0)
  assert.match(empty, /未知拒绝形状/)
  assert.match(describeReject(null, { error: 'envelope 里的原因' }), /envelope 里的原因/)
  // 循环引用不抛（尸体样本）
  const cyclic = {}
  cyclic.self = cyclic
  assert.ok(describeReject(cyclic).length > 0)
})

test('truncateText：折叠空白并对超长文本截断（留住可归因前缀）', () => {
  assert.equal(truncateText('a\n\n  b\tc'), 'a b c')
  const long = truncateText('x'.repeat(500), 100)
  assert.equal(long.length, 100)
  assert.ok(long.endsWith('…'))
})

test('summarizeFailures：空集给「（无失败）」，多条按上限拼接', () => {
  assert.equal(summarizeFailures([]), '（无失败）')
  const failures = [
    { target: 's1', reason: 'busy' },
    { target: 's2', reason: 'gone' },
    { target: 's3', reason: 'timeout' },
  ]
  assert.equal(summarizeFailures(failures, 2), 's1: busy | s2: gone')
  assert.equal(summarizeFailures(failures, 3), 's1: busy | s2: gone | s3: timeout')
})

// ---------- 改投判定与告警 ----------

test('isRerouted：实投 ≠ 首选才算改投；缺任一侧不算', () => {
  assert.equal(isRerouted('s1', 's1'), false)
  assert.equal(isRerouted('s1', 's2'), true)
  assert.equal(isRerouted(undefined, 's2'), false)
  assert.equal(isRerouted('s1', undefined), false)
})

test('rerouteNotice：首选 / 实投 / 失败原因三要素齐备（主人一眼看懂）', () => {
  const text = rerouteNotice('session-anchor', 'session-other', [{ target: 'session-anchor', reason: '会话正在运行' }])
  assert.match(text, /改投/)
  assert.match(text, /session-anchor/)
  assert.match(text, /session-other/)
  assert.match(text, /会话正在运行/)
  // 无失败记录时也要能生成（不抛）
  assert.ok(rerouteNotice('a', 'b', []).length > 0)
})

// ---------- 事故形状（2026-09-17 实测复刻） ----------

test('事故形状复刻：首选（触发者）连败 → 第二候选败 → 第三候选成功 ⇒ 判为改投并带原因', () => {
  const order = ['session-5ae01805-anchor', 'session-a5375716-second', 'session-879c4ae1-third']
  const plan = planWakeAttempts(order, { primaryWaves: 2, othersWaves: 1 })
  // 首选被给到 2 轮（旧实现只有 1 轮就换靶 —— 这正是事故的直接原因之一）
  assert.equal(plan[0].waves, 2)
  // 模拟执行序：首选 2 轮败 → second 1 轮败 → third 成功
  const failures = [
    { target: 'session-5ae01805-anchor', reason: describeReject({ error: '会话正在运行' }) },
    { target: 'session-a5375716-second', reason: describeReject({ error: '会话不存在' }) },
  ]
  const actual = 'session-879c4ae1-third'
  assert.equal(isRerouted(order[0], actual), true)
  const notice = rerouteNotice(order[0], actual, failures)
  assert.match(notice, /会话正在运行/)
  assert.match(notice, /会话不存在/)
  assert.match(notice, /session-879c4ae1-third/)
})

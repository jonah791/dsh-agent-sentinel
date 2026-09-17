/**
 * wake-target.test.mjs — 唤醒目标裁决的离线单测
 *
 * 尸体测试用 **2026-09-12 的真实候选列表**（当时哨兵把提醒投给了旧会话、守护投给了子代理会话而失败）。
 * 运行：node tests/wake-target.test.mjs（在插件根目录；需先 pnpm build）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideWakeTarget, pickNotifySession, isUserSession, rankUserSessions, toMs, DEFAULT_ANCHOR_STALE_MS,
} from '../lib/wake-target.js'

const NOW = Date.parse('2026-09-12T13:47:46.000Z')

/** 真实候选（节选 2026-09-12 13:47 的 .watch-events.log）：我 = session-879c4ae1。 */
function realCandidates(overrides = {}) {
  return [
    { sessionId: '5bb40b68-ea2e-42ca-8b08-ce83442ab4c9', blank: false, updatedAt: NOW - 120_000 }, // 子代理（裸 uuid，最新）
    { sessionId: 'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c', blank: false, updatedAt: NOW - 180_000 }, // 我
    { sessionId: 'session-89516696-bebe-40ea-a679-fb66fc5c09b1', blank: false, updatedAt: NOW - 3_900_000 }, // 配置钉住的旧锚点
    { sessionId: 'session-ffbdacf2-b4ab-4718-b42a-8d8c22516eae', blank: true, updatedAt: NOW - 5_000_000 },
    { sessionId: '27a1de66-5f2d-4ea3-a2a8-f29ef345a212', blank: false, updatedAt: NOW - 60_000 }, // 另一个子代理
    ...overrides.extra ?? [],
  ]
}

test('isUserSession: 只认 session-* 且非空白（子代理裸 uuid 出局）', () => {
  assert.equal(isUserSession({ sessionId: 'session-abc', blank: false }), true)
  assert.equal(isUserSession({ sessionId: 'session-abc' }), true)
  assert.equal(isUserSession({ sessionId: 'session-abc', blank: true }), false)
  assert.equal(isUserSession({ sessionId: '5bb40b68-ea2e-42ca-8b08-ce83442ab4c9' }), false)
  assert.equal(isUserSession({}), false)
})

test('toMs: 秒/毫秒两种量级都归一到毫秒', () => {
  assert.equal(toMs(1789218593), 1789218593000)
  assert.equal(toMs(1789218593748), 1789218593748)
  assert.equal(toMs(undefined), 0)
})

test('rankUserSessions: 过滤子代理/空白，按最近活跃降序', () => {
  const ranked = rankUserSessions(realCandidates())
  assert.deepEqual(ranked.map((s) => s.sessionId), [
    'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c',
    'session-89516696-bebe-40ea-a679-fb66fc5c09b1',
  ])
})

test('尸体测试 A：钉住的旧锚点已滞后 63min → 改投最近活跃（我的会话），并给出理由（静态锚点模式 trustAnchor=false）', () => {
  const d = decideWakeTarget(realCandidates(), 'session-89516696-bebe-40ea-a679-fb66fc5c09b1', NOW, { trustAnchor: false })
  assert.equal(d.sid, 'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c')
  assert.match(d.why, /锚点腐化|滞后/)
})

test('触发者绑定（主人 2026-09-14 定调）：触发者跑长 turn 滞后 36min，也必须投给它', () => {
  // 真实样本：2026-09-14 18:17 的 .watch-events.log —— 触发者 a5375716（滞后 36min），
  // 旧判据（trustAnchor=false）改投 879c4ae1，主人因此永远收不到重启提醒。
  const sessions = [
    { sessionId: 'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c', blank: false, updatedAt: NOW },
    { sessionId: 'session-a5375716-1e98-4d44-84b3-e60dca22d1e2', blank: false, updatedAt: NOW - 36 * 60_000 },
  ]
  const d = decideWakeTarget(sessions, 'session-a5375716-1e98-4d44-84b3-e60dca22d1e2', NOW, { trustAnchor: true })
  assert.equal(d.sid, 'session-a5375716-1e98-4d44-84b3-e60dca22d1e2', '触发者绑定：滞后不作为腐化证据')
  assert.match(d.why, /触发者/)
  // 对照：缺省（静态锚点语义）仍是旧的改投行为——两种语义都在，不是把旧行为删掉
  assert.equal(
    decideWakeTarget(sessions, 'session-a5375716-1e98-4d44-84b3-e60dca22d1e2', NOW).sid,
    'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c',
  )
})

test('触发者绑定：触发者会话已不存在 → 仍回退最近活跃（不静默丢弃），理由保持可诊断', () => {
  const sessions = [{ sessionId: 'session-me', blank: false, updatedAt: NOW }]
  const d = decideWakeTarget(sessions, 'session-gone', NOW, { trustAnchor: true })
  assert.equal(d.sid, 'session-me')
  assert.match(d.why, /不在会话列表/)
})

test('触发者绑定：触发者是子代理/空白会话（不可 prompt）→ 回退最近活跃用户会话', () => {
  const sessions = [
    { sessionId: 'session-main', blank: false, updatedAt: NOW - 60_000 },
    { sessionId: 'session-blank', blank: true, updatedAt: NOW },
  ]
  const d = decideWakeTarget(sessions, 'session-blank', NOW, { trustAnchor: true })
  assert.equal(d.sid, 'session-main')
  assert.match(d.why, /非用户会话/)
})

test('尸体测试 B：不带锚点时，最新是子代理会话 → 必须跳过它投给我（原事故：投子代理 → 5 次重试失败）', () => {
  const d = decideWakeTarget(realCandidates(), undefined, NOW)
  assert.equal(d.sid, 'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c')
  assert.ok(!d.ranked.includes('5bb40b68-ea2e-42ca-8b08-ce83442ab4c9'))
  assert.ok(!d.ranked.includes('27a1de66-5f2d-4ea3-a2a8-f29ef345a212'))
})

test('锚点仍然新鲜（滞后 2min < 10min 阈值）→ 尊重显式指定', () => {
  const sessions = [
    { sessionId: 'session-new', blank: false, updatedAt: NOW - 30_000 },
    { sessionId: 'session-anchor', blank: false, updatedAt: NOW - 120_000 },
  ]
  const d = decideWakeTarget(sessions, 'session-anchor', NOW)
  assert.equal(d.sid, 'session-anchor')
  assert.match(d.why, /锚点新鲜/)
})

test('锚点正好等于阈值 → 不判腐化（边界：> 才改投）', () => {
  const sessions = [
    { sessionId: 'session-new', blank: false, updatedAt: NOW },
    { sessionId: 'session-anchor', blank: false, updatedAt: NOW - DEFAULT_ANCHOR_STALE_MS },
  ]
  assert.equal(decideWakeTarget(sessions, 'session-anchor', NOW).sid, 'session-anchor')
  const beyond = [
    { sessionId: 'session-new', blank: false, updatedAt: NOW },
    { sessionId: 'session-anchor', blank: false, updatedAt: NOW - DEFAULT_ANCHOR_STALE_MS - 1000 },
  ]
  assert.equal(decideWakeTarget(beyond, 'session-anchor', NOW).sid, 'session-new')
})

test('锚点指向子代理会话 → 不采信，改投用户会话（并说明原因）', () => {
  const sessions = [
    { sessionId: 'session-me', blank: false, updatedAt: NOW - 60_000 },
    { sessionId: '5bb40b68-aaaa', blank: false, updatedAt: NOW },
  ]
  const d = decideWakeTarget(sessions, '5bb40b68-aaaa', NOW)
  assert.equal(d.sid, 'session-me')
  assert.match(d.why, /子代理|非用户会话/)
})

test('非空列表但全是空白/子代理 → 不投递（不再误投）', () => {
  const d = decideWakeTarget([
    { sessionId: 'session-blank', blank: true, updatedAt: NOW },
    { sessionId: '5bb40b68-aaaa', blank: false, updatedAt: NOW },
  ], undefined, NOW)
  assert.equal(d.sid, undefined)
  assert.match(d.why, /不投递/)
})

test('pickNotifySession: 与无锚点裁决一致（守护/预检通道共用）', () => {
  const r = pickNotifySession(realCandidates(), NOW)
  assert.equal(r.sid, 'session-879c4ae1-b33e-43de-91d3-a968a6af6f2c')
  assert.match(r.why, /最近活跃用户会话/)
})

/**
 * 哨兵预检闸门单测（2026-09-13 · t-49913844 判据对齐）
 *
 * 核心是**回归尸体样本**：旧实现（30 分钟滑动窗口）会放行的一种真实形状——
 * 预检发生在**上一个** web 进程里、之后代码又被构建过 → 哨兵若放行，就是
 * kill web 部署一个**从未被预检验证过的新组合**（§5.11 §1 禁止的「拿旧实例健康当免检」）。
 * 这条不成立，本次修复就是假的。
 *
 * 时间轴用事故形状显式构造（不依赖真实时钟，时间由参数注入）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideSentinelGate, pickLatestBuildMs, resolveWebStartMs,
} from '../lib/preflight-gate.js'

// ── 事故形状时间轴（2026-09-13 10:00 起算） ──────────────────────────
const T0 = Date.parse('2026-09-13T10:00:00+08:00')
const T_PREFLIGHT_OLD = T0 + 5 * 60_000   // 上一个 web 进程内调用 preflight_check（pass=true）
const T_BUILD = T0 + 10 * 60_000          // 改代码 + 构建（组合已变更）
const T_WEBNOW = T0 + 20 * 60_000         // web 被重新拉起（本轮进程）
const T_FLAG = T0 + 25 * 60_000           // 哨兵触发（旧实现：25 分钟 < 30 分钟 → 放行 = BUG）

const WS = 'E:/alice'
const oldRec = { atMs: T_PREFLIGHT_OLD, workspace: WS, pass: true, sessionId: 'session-old' }

describe('decideSentinelGate · 组合变更新鲜度', () => {
  test('尸体样本（回归）：预检在上个进程（25 分钟前）+ 之后有新构建 → 必须拒绝', () => {
    // 旧实现：Date.now() - atMs = 25 分钟 ≤ 30 分钟 → 放行（BUG）
    // 新判据：最新构建 ${T_BUILD} 晚于预检 ${T_PREFLIGHT_OLD} → 拒绝
    const d = decideSentinelGate(oldRec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: T_WEBNOW })
    assert.equal(d.ok, false)
    assert.match(d.reason, /组合已变更/)
    assert.ok(d.reason.includes(new Date(T_BUILD).toISOString()), '理由须含构建时刻：' + d.reason)
    assert.match(d.evidence, /最新构建=/)
  })

  test('尸体样本 2：预检晚于构建，但早于本轮 web 启动 → 拒绝（本进程内未调用过）', () => {
    const rec = { atMs: T_BUILD + 60_000, workspace: WS, pass: true }
    const d = decideSentinelGate(rec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: T_WEBNOW })
    assert.equal(d.ok, false)
    assert.match(d.reason, /早于本轮 web 启动/)
  })

  test('良性样本：预检晚于构建、晚于本轮 web 启动、pass=true → 放行', () => {
    const rec = { atMs: T_FLAG - 60_000, workspace: WS, pass: true }
    const d = decideSentinelGate(rec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: T_WEBNOW })
    assert.equal(d.ok, true)
    assert.equal(d.reason, undefined)
  })

  test('边界：预检与构建**同毫秒** → 放行（>=，不误杀紧邻操作）', () => {
    // 只检验构建判据的边界：web 启动必须早于预检（否则先被「早于本轮 web 启动」拦截）
    const rec = { atMs: T_BUILD, workspace: WS, pass: true }
    assert.equal(decideSentinelGate(rec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: T_BUILD - 60_000 }).ok, true)
  })

  test('边界：预检与本轮 web 启动**同毫秒** → 放行', () => {
    const rec = { atMs: T_WEBNOW, workspace: WS, pass: true }
    assert.equal(decideSentinelGate(rec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: T_WEBNOW }).ok, true)
  })

  test('边界：预检比构建早 1ms → 拒绝（fail-closed）', () => {
    const rec = { atMs: T_BUILD - 1, workspace: WS, pass: true }
    assert.equal(decideSentinelGate(rec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: T_WEBNOW }).ok, false)
  })

  test('退化路径：无 web 启动记录（latestBuildMs=0 亦无构建信息）→ 只比 pass，不因缺时间源而误拒', () => {
    const d = decideSentinelGate(oldRec, { workspace: WS, latestBuildMs: 0 })
    assert.equal(d.ok, true, '两个时间源都不可用时退化为 pass 判定，但任何可用时间源失效即拒')
  })

  test('退化路径：无 web 启动记录但有构建 → 构建判据仍生效（更严不更松）', () => {
    const d = decideSentinelGate(oldRec, { workspace: WS, latestBuildMs: T_BUILD })
    assert.equal(d.ok, false)
    assert.match(d.reason, /组合已变更/)
  })
})

describe('decideSentinelGate · 异常样本一律拒绝且理由明确', () => {
  test('记录缺失 → 拒绝，文案说「本 web 进程」（去漂移：不得冒充「本会话」）', () => {
    const d = decideSentinelGate(null, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: T_WEBNOW })
    assert.equal(d.ok, false)
    assert.match(d.reason, /本 web 进程内未调用过预检工具/)
    assert.ok(!/本会话/.test(d.reason), '文案漂移：' + d.reason)
  })

  test('记录不可读（JSON 损坏）→ 拒绝且理由含「不可读」，不伪装成「没调用过」', () => {
    const d = decideSentinelGate(null, { workspace: WS, latestBuildMs: T_BUILD, readIssue: 'Unexpected token < in JSON' })
    assert.equal(d.ok, false)
    assert.match(d.reason, /不可读/)
    assert.ok(!/未调用过/.test(d.reason), '不得把「读不了」说成「没调用」：' + d.reason)
  })

  test('atMs 非数字 → 拒绝', () => {
    const rec = { atMs: 'x', workspace: WS, pass: true }
    const d = decideSentinelGate(rec, { workspace: WS, latestBuildMs: 0 })
    assert.equal(d.ok, false)
    assert.match(d.reason, /记录无效/)
  })

  test('workspace 不匹配 → 拒绝且理由含两侧值', () => {
    const rec = { atMs: T_FLAG, workspace: 'E:/other', pass: true }
    const d = decideSentinelGate(rec, { workspace: WS, latestBuildMs: 0 })
    assert.equal(d.ok, false)
    assert.match(d.reason, /workspace 不匹配/)
    assert.ok(d.reason.includes('E:/other') && d.reason.includes(WS))
  })

  test('pass !== true → 拒绝且理由指向「未通过」', () => {
    const rec = { atMs: T_FLAG, workspace: WS, pass: false }
    const d = decideSentinelGate(rec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: T_WEBNOW })
    assert.equal(d.ok, false)
    assert.match(d.reason, /未通过/)
  })

  test('pass 字段缺失（老记录形状）→ 拒绝（fail-closed）', () => {
    const d = decideSentinelGate({ atMs: T_FLAG, workspace: WS }, { workspace: WS, latestBuildMs: 0 })
    assert.equal(d.ok, false)
  })
})

describe('resolveWebStartMs · 锚点新鲜度（哨兵重启后不采信旧记录）', () => {
  const sentinelStart = T_WEBNOW + 30_000

  test('无记录（web 由 guardian/init 拉起）→ 无 webStartMs + 明示「更严」', () => {
    const r = resolveWebStartMs(null, { sentinelProcStartMs: sentinelStart, workspace: WS })
    assert.equal(r.webStartMs, undefined)
    assert.match(r.why, /更严/)
  })

  test('记录早于本哨兵进程启动（哨兵重启过 → 可能已被别人重拉）→ 不采信', () => {
    const r = resolveWebStartMs({ atMs: T_WEBNOW, workspace: WS, pid: 123 }, { sentinelProcStartMs: sentinelStart, workspace: WS })
    assert.equal(r.webStartMs, undefined)
    assert.match(r.why, /哨兵重启过/)
  })

  test('记录属于本进程但 workspace 不匹配 → 不采信', () => {
    const r = resolveWebStartMs({ atMs: sentinelStart + 1000, workspace: 'E:/other' }, { sentinelProcStartMs: sentinelStart, workspace: WS })
    assert.equal(r.webStartMs, undefined)
    assert.match(r.why, /不匹配/)
  })

  test('记录非法（缺 atMs）→ 不采信', () => {
    const r = resolveWebStartMs({ workspace: WS }, { sentinelProcStartMs: sentinelStart, workspace: WS })
    assert.equal(r.webStartMs, undefined)
    assert.match(r.why, /无效/)
  })

  test('记录属于本进程且 workspace 匹配 → 采信（本轮 web 启动时刻）', () => {
    const at = sentinelStart + 5000
    const r = resolveWebStartMs({ atMs: at, workspace: WS, pid: 456 }, { sentinelProcStartMs: sentinelStart, workspace: WS })
    assert.equal(r.webStartMs, at)
    assert.match(r.why, /本轮 web 启动时刻/)
  })
})

describe('pickLatestBuildMs · 纯取值', () => {
  test('取最大 mtime', () => {
    assert.equal(pickLatestBuildMs([{ path: 'a', mtimeMs: 100 }, { path: 'b', mtimeMs: 300 }, { path: 'c', mtimeMs: 200 }]), 300)
  })
  test('空/非法 → 0（语义：无构建信息，跳过该判据，不假装构建很新）', () => {
    assert.equal(pickLatestBuildMs([]), 0)
    assert.equal(pickLatestBuildMs([{ mtimeMs: Number.NaN }, { mtimeMs: -5 }, {}]), 0)
  })
})

describe('集成：事故时刻表全链路（resolveWebStartMs → decideSentinelGate）', () => {
  test('哨兵本进程内 spawn 过 web + 旧预检 + 新构建 → 拒绝（双时间源联合生效）', () => {
    const sentinelStart = T_WEBNOW - 5_000
    const ws = resolveWebStartMs({ atMs: T_WEBNOW, workspace: WS, pid: 999 }, { sentinelProcStartMs: sentinelStart, workspace: WS })
    const d = decideSentinelGate(oldRec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: ws.webStartMs })
    assert.equal(d.ok, false)
    assert.match(d.reason, /组合已变更/)
  })

  test('哨兵本进程内 spawn + 预检在 web 启动之后（含构建）→ 放行', () => {
    const sentinelStart = T_WEBNOW - 5_000
    const ws = resolveWebStartMs({ atMs: T_WEBNOW, workspace: WS, pid: 999 }, { sentinelProcStartMs: sentinelStart, workspace: WS })
    const rec = { atMs: T_FLAG, workspace: WS, pass: true }
    const d = decideSentinelGate(rec, { workspace: WS, latestBuildMs: T_BUILD, webStartMs: ws.webStartMs })
    assert.equal(d.ok, true)
  })
})

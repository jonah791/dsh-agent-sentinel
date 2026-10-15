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
  classifySessionList,
  classifyWebProbe,
  summarizeFailedAttempts,
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

// ═══════════════════════════════════════════════════════════════════════════
// ★ 2026-10-14：两处**根因级**修复的判据（现场：主人「怎么重启后又没有发提醒」）
//
// 事故链（`.watch-events.log` 2026-10-14T06:01–06:03 现读）：
//   06:01:39 `等待会话列表就绪: items=0 用户会话=0（第 1 轮，已等 0s/180s）`  ← ★ 这**不是**「没起好」
//   06:02:33 唤醒目标裁决 → 首选 = 触发者会话（正常）
//   06:02:45 投递失败（第 1/2 轮）：`fetch 异常: SyntaxError: … "unauthorized" …`
//   06:03:00 投递失败（第 2/2 轮）：同因
//   06:03:01 **改投** session-3ac2bffa ⇒ 提醒进了别的会话，**触发者永远收不到**
//   06:03:04 telegram 兜底也失败（Unauthorized）⇒ 两层防线同时失效
// ═══════════════════════════════════════════════════════════════════════════

test('★ classifySessionList：401 的纯文本 `unauthorized` ⇒ 必须报**读失败**，不许读成「空列表」', () => {
  const r = classifySessionList('unauthorized')
  assert.deepEqual(r.items, [])
  assert.notEqual(r.error, '', '★ 修前这里 catch 吞掉 ⇒ 调用方读作「web 还没起好」并继续等 60 秒')
  assert.match(r.error, /401|认证/, '必须点出「这多半是认证问题」，否则读的人会往「启动慢」上查')
  assert.match(r.error, /unauthorized/, '必须带出原文（可归因）')
})

test('★ classifySessionList：形状不符的对象 ⇒ 同样报读失败（不是只认字符串一种形态）', () => {
  const r = classifySessionList({ some: 'unexpected' })
  assert.notEqual(r.error, '')
  assert.deepEqual(r.items, [])
})

test('★ classifySessionList 的对照：正常信封 ⇒ 无错、带回数组（证明判据不是恒报错）', () => {
  const r = classifySessionList({ result: { value: { items: [{ sessionId: 'session-a' }] } } })
  assert.equal(r.error, '')
  assert.equal(r.items.length, 1)
})

test('★ classifySessionList 的边界：`items` 不是数组（如 null/字符串）⇒ 报读失败，不许当空表', () => {
  assert.notEqual(classifySessionList({ result: { value: { items: null } } }).error, '')
  assert.notEqual(classifySessionList({ result: { value: { items: 'x' } } }).error, '')
})

test('★ summarizeFailedAttempts：必须带出**次数与跨度**（修法取决于这个时长）', () => {
  const s = summarizeFailedAttempts(10, 30000, 'unauthorized', 'unauthorized')
  assert.match(s, /10 次/)
  assert.match(s, /30s/)
  assert.match(s, /unauthorized/)
  // 同因 ⇒ 只报一次（日志要短，不许把同一句原因刷两遍）
  assert.equal(s.split('unauthorized').length - 1, 1)
})

test('★ summarizeFailedAttempts：原因**变化** ⇒ 首末都带出（那是不同故障，不是同一次抖动）', () => {
  const s = summarizeFailedAttempts(3, 6000, 'unauthorized', '会话不存在')
  assert.match(s, /首次\[unauthorized\]/)
  assert.match(s, /末次\[会话不存在\]/)
})

test('★ summarizeFailedAttempts 的边界：firstReason 为空 ⇒ 只报末次（不产出空括号）', () => {
  const s = summarizeFailedAttempts(1, 100, '', '网络超时')
  assert.match(s, /网络超时/)
  assert.doesNotMatch(s, /首次\[\]/)
})

/* ── ★ classifyWebProbe（2026-10-15 根因修复）：401 不得读作「web 没起来」 ──────────
 * 现场（2026-10-15 02:09:57）：web 13 秒就打印了认证 URL（**真的起来了**），
 * 哨兵却判「未在时限内就绪」⇒ **跳过唤醒** ⇒ 提醒没发到（主人报「重启后又没发提醒」）。
 * 根因 = `waitWebReady` 的 `catch { /* 未就绪 *\/ }` 把 401 静默吞成「未就绪」，
 * 而 2026-10-14 的修复只改了**下游** `classifySessionList`（上游闸门没修 ⇒ 修了一半）。
 * 本组钉住三态语义：**401 证明服务器在跑**（unauthenticated ≠ down）。
 */

test('W1 金标准：合法 JSON-RPC 信封 ⇒ ready（不得恒 down）', () => {
  const r = classifyWebProbe({ portOpen: true, status: 200, body: { result: { value: { items: [{ sessionId: 's1' }] } } }, error: '' })
  assert.equal(r.state, 'ready')
})

test('W2 尸体·**401 纯文本 unauthorized ⇒ unauthenticated**（本次事故形状：不得读作 down）', () => {
  const r = classifyWebProbe({ portOpen: true, status: 401, body: 'unauthorized', error: '' })
  assert.equal(r.state, 'unauthenticated', '401 必须与「端口不通」分开 —— 前者是服务器在应答')
  assert.notEqual(r.state, 'down')
  assert.match(r.detail, /认证失败/)
})

test('W3 尸体·状态码缺失但正文含 unauthorized ⇒ 同样算认证失败（不靠单一信号）', () => {
  const r = classifyWebProbe({ portOpen: true, status: 0, body: 'Unauthorized', error: '' })
  assert.equal(r.state, 'unauthenticated')
})

test('W4 尸体·端口不通 ⇒ down（真「没起来」必须仍是 down，不得被放宽）', () => {
  const r = classifyWebProbe({ portOpen: false, status: 0, body: undefined, error: '' })
  assert.equal(r.state, 'down')
  assert.match(r.detail, /端口未监听/)
})

test('W5 尸体·连接层异常 ⇒ down，且**带原因**（不许只说「未就绪」）', () => {
  const r = classifyWebProbe({ portOpen: true, status: 0, body: undefined, error: 'TimeoutError: signal timed out' })
  assert.equal(r.state, 'down')
  assert.match(r.detail, /TimeoutError/)
})

test('W6 对照组·**空会话列表也是就绪**（空 ≠ 未就绪 —— 旧判据 `items=0` 那个坑的变体）', () => {
  const r = classifyWebProbe({ portOpen: true, status: 200, body: { result: { value: { items: [] } } }, error: '' })
  assert.equal(r.state, 'ready', '列表为空只说明没有会话，不说明 web 没起来')
})

test('W7 对照组·形状不符的 JSON ⇒ down（证明 W1/W6 不是恒 ready）', () => {
  const r = classifyWebProbe({ portOpen: true, status: 200, body: { hello: 'world' }, error: '' })
  assert.equal(r.state, 'down')
})

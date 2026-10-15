/**
 * wake-delivery.ts — 唤醒投递的**重试编排**与**失败取证**（纯逻辑，便于离线单测）。
 *
 * 事故驱动（2026-09-17 · 「换候选」路径首次线上触发）：
 *   `03:23:44 唤醒目标裁决: 锚点 … 是本次触发者 → 绑定投递`
 *   `03:23:59 唤醒投递失败，换下一个候选: session-5ae01805…`   ← 触发者会话，失败
 *   `03:24:14 唤醒投递失败，换下一个候选: session-a5375716…`   ← 第二候选，失败
 *   `03:24:19 唤醒消息已发送: session-879c4ae1…`              ← 静默改投给第三个会话
 *   触发者（也是发起重启的那个会话）**始终没收到唤醒**，而且日志里
 *   **没有一行失败原因**——旧 `sendPrompt` 的 catch 分支吞掉异常（注释写着「重试」，
 *   连 web 返回的 `result.ok=false` 也直接丢弃 ⇒ 「断在哪一段」无从判断（§5.22 五问③）。
 *
 * 本模块的判据：**任何一次尝试都必须产出非空的 reason**；「投给了谁」与「为什么不是首选」
 * 必须是可读的确定性输出，而不是靠人肉比对候选列表。
 */

/** 一次投递尝试的结果（证据层：`reason` 在失败时**永不缺失**） */
export interface PromptAttempt {
  /** 是否真的投出去了 */
  ok: boolean
  /** 人类可读原因（成功时 `'ok'`；失败时必须是真实文案，不得为空） */
  reason: string
}

/** 候选级尝试计划（首选多给一轮：重启后的失败常是**瞬时**状态） */
export interface WakeAttemptPlan {
  target: string
  /** 该候选要跑几轮（每轮内部仍由 sendPrompt 做多次尝试） */
  waves: number
}

/**
 * 渲染一次「全部尝试都失败」的失败摘要 —— ★ 2026-10-14 抽成纯函数（判据随之可测）。
 *
 * 存在理由：修前 `sendPrompt` 只回**最后一次**的原因，于是
 *   **「401 持续了 3 秒还是 3 分钟」答不出来** —— 而修法恰恰取决于这个时长
 *   （短 ⇒ 等一轮就好；长 ⇒ 该查 auth，加轮次没用）。
 *   ⇒ 现场（2026-10-14 06:02:45 那次改投）就卡在这一格：日志只说
 *   `fetch 异常: SyntaxError: Unexpected token 'u', "unauthorized" …`，
 *   **次数与跨度都没有**。
 *
 * @param tries - 实际尝试次数
 * @param spanMs - 从第一次尝试到放弃的跨度（毫秒）
 * @param firstReason - 第一次失败的原因
 * @param lastReason - 最后一次失败的原因
 * @returns 人类可读摘要（**永不缺失原因**）
 */
export function summarizeFailedAttempts(tries: number, spanMs: number, firstReason: string, lastReason: string): string {
  const head = '尝试 ' + String(tries) + ' 次 / 跨 ' + String(Math.round(spanMs / 1000)) + 's：'
  // 同因重复 ⇒ 只报一次（日志要短）；原因**变化** ⇒ 全部带出（那说明是不同故障，不是同一次抖动）
  if (firstReason === lastReason || firstReason === '') return head + lastReason
  return head + '首次[' + firstReason + '] → 末次[' + lastReason + ']'
}

/**
 * 把 `session/list` 的返回值判成「会话数组」或「读失败」—— ★ 2026-10-14 抽成纯函数。
 *
 * 存在理由（**根因级**）：修前 `listSessions` 是 `try { … } catch { return [] }`，
 *   把认证失败（web auth 层直回的纯文本 `unauthorized`）**吞成了「空列表」**。
 *   后果不是「读不到」，是**把 401 读成了「web 还没起好」**：调用方见 `items=0`
 *   就继续等 60 秒（日志写「等待会话列表就绪」），而真相是**认证已经失败**。
 *   现场（2026-10-14 06:01:39）就是这么走的，**外部判不出**。
 *
 * @param data - `apiRpc` 的原始返回（成功时是 JSON-RPC 信封；401 时是纯文本）
 * @returns `{ items, error }` —— **恰有一个非空**：`items` 为数组时 `error` 为空串
 */
export function classifySessionList(data: unknown): { items: unknown[]; error: string } {
  const items = (data as { result?: { value?: { items?: unknown } } } | undefined)?.result?.value?.items
  if (Array.isArray(items)) return { items, error: '' }
  // 形状不符：多半是 401（web auth 层直接回纯文本，不是 JSON-RPC 信封）
  const shown = typeof data === 'string' ? JSON.stringify(data.slice(0, 80)) : JSON.stringify(data).slice(0, 120)
  return { items: [], error: '形状不符（可能是认证 401）：' + shown }
}

/**
 * 把**一次 web 探测**判成三态 —— ★ 2026-10-15 修（根因级）。
 *
 * 存在理由：修前 `waitWebReady` 的判据是 `data?.result?.ok === true`，而 401 时
 *   web auth 层直回**纯文本** `unauthorized` ⇒ `apiRpc` 里 `res.json()` 抛 SyntaxError
 *   ⇒ 被 `catch { /* 未就绪 *\/ }` **静默吞掉** ⇒ 90 秒超时后判「web 未在时限内就绪」
 *   并**跳过唤醒**。现场（2026-10-15 02:09:57）：web 13 秒就打印了认证 URL（真的起来了），
 *   唤醒却被跳过，而 `.watch-incident.json` 只说「未就绪」——**认证失败被读成了「没起来」**。
 *
 * ★ 判据核心：**401 证明服务器在跑**（它在应答、在鉴权）。把它读作「没起来」的代价是
 *   「该做的唤醒没做」，而且归因指向错误的方向（去查 web 而不是查认证）。
 *   ⇒ `unauthenticated` **算就绪**，但必须**响亮**（由调用方落日志）。
 *
 * ⚠ 与 2026-10-14 的关系：那次修的是**下游** `classifySessionList`（把 401 从「空列表」里分出来），
 *   **上游闸门 `waitWebReady` 没修** —— 同一个 401，下游会分辨了、上游还在吞（修了一半）。
 *   ⇒ 本函数让上游与下游**共用同一套「401 是认证问题不是可用性问题」的语义**。
 *
 * @param input.portOpen - 端口是否在监听
 * @param input.status   - HTTP 状态码；0 = 没拿到响应（连接层失败）
 * @param input.body     - 响应体（JSON 已解析；401 时是纯文本串）
 * @param input.error    - 连接层异常文本（空串 = 无异常）
 */
export type WebProbeState = 'ready' | 'unauthenticated' | 'down'

export function classifyWebProbe(input: {
  portOpen: boolean
  status: number
  body: unknown
  error: string
}): { state: WebProbeState; detail: string } {
  if (!input.portOpen) return { state: 'down', detail: '端口未监听' }
  if (input.error !== '') return { state: 'down', detail: '连接层失败：' + input.error }
  const text = typeof input.body === 'string' ? input.body : ''
  if (input.status === 401 || text.toLowerCase().includes('unauthorized')) {
    return { state: 'unauthenticated', detail: 'HTTP ' + input.status + ' 认证失败（web 已在应答）' }
  }
  const { items, error } = classifySessionList(input.body)
  if (error === '') return { state: 'ready', detail: 'HTTP ' + input.status + ' 会话列表可读（' + items.length + ' 条）' }
  return { state: 'down', detail: 'HTTP ' + input.status + ' 响应形状不符（可能尚未就绪）：' + error }
}

/**
 * 编排候选尝试计划：`order[0]`（首选/触发者）跑 `primaryWaves` 轮，其余跑 `othersWaves` 轮。
 * 动机：旧实现「首选失败即换靶」——而重启后首选失败的最常见原因是
 * 「该会话刚被打断、正在恢复」，等一轮往往就好了；换靶的代价是**触发者永远收不到**。
 */
export function planWakeAttempts(
  order: readonly string[],
  opts: { primaryWaves?: number; othersWaves?: number } = {},
): WakeAttemptPlan[] {
  const primary = Math.max(1, Math.trunc(opts.primaryWaves ?? 2))
  const others = Math.max(1, Math.trunc(opts.othersWaves ?? 1))
  return order.map((target, index) => ({ target, waves: index === 0 ? primary : others }))
}

/** 文本截断（日志与告警都要短，但要留住可归因的前缀） */
export function truncateText(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return flat.slice(0, Math.max(1, max - 1)) + '…'
}

/** 从任意形状里挖出可读文本（对象 → error/message/detail/reason → JSON 兜底） */
function pickText(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['error', 'message', 'detail', 'reason', 'errorMessage']) {
    const found = pickText(record[key], depth + 1)
    if (found !== undefined) return found
  }
  try {
    const json = JSON.stringify(value)
    if (json !== undefined && json !== '{}' && json !== 'null' && json !== '[]') return json
  } catch {
    /* 循环引用等：落回 undefined */
  }
  return undefined
}

/**
 * 提炼失败原因：先看 RPC 结果体，再看外层信封。
 * **绝不返回空串**——实在没有可读文本时返回形状说明（宁可说「不知形状」也不留白）。
 */
export function describeReject(result: unknown, envelope?: unknown): string {
  const fromResult = pickText(result)
  if (fromResult !== undefined) return truncateText(fromResult)
  const fromEnvelope = pickText(envelope)
  if (fromEnvelope !== undefined) return truncateText('envelope: ' + fromEnvelope)
  return '未知拒绝形状（web 未给 error/message；结果体为空）'
}

/** 失败摘要（一行说清「谁失败了、为什么」） */
export function summarizeFailures(
  failures: ReadonlyArray<{ target: string; reason: string }>,
  max = 2,
): string {
  if (failures.length === 0) return '（无失败）'
  return failures
    .slice(0, Math.max(1, max))
    .map((f) => `${f.target}: ${f.reason}`)
    .join(' | ')
}

/** 是否发生了「改投」（实投会话 ≠ 首选会话） */
export function isRerouted(primary: string | undefined, actual: string | undefined): boolean {
  return primary !== undefined && actual !== undefined && primary !== actual
}

/** 改投告警文案（主人视角：一眼看出「这条提醒本该发到哪个会话」） */
export function rerouteNotice(
  primary: string | undefined,
  actual: string,
  failures: ReadonlyArray<{ target: string; reason: string }>,
): string {
  const cause = truncateText(summarizeFailures(failures, 2), 320)
  return `⚠ [守护] 重启唤醒**改投**：首选会话 ${String(primary ?? '（未裁决）')} 投递失败（${cause}）→ 已投 ${actual}`
}

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

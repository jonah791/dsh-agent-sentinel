/**
 * 哨兵预检闸门的**纯逻辑层**（无 IO、时间注入、可离线单测）。
 *
 * 为什么抽出来（2026-09-13 任务 t-49913844；来源：写 `preflight-gate` 语义文档时
 * 被逼出来的两条未决 U1/U2，证据已钉死）：
 *  ① **判据漂移**：原实现用 `Date.now() - rec.atMs > 30 * 60 * 1000`（30 分钟滑动窗口），
 *     与 plugin-manager 侧的进程级判据（`rec.atMs >= webStartMs`）**不是同一把尺**。
 *     危险窗口：预检发生在**上一个** web 进程里（≤30 分钟前）→ 哨兵放行 → kill web
 *     部署**新构建**，而那次预检从未验证过新组合——正是 AGENTS.md §5.11 §1 禁止的
 *     「拿旧实例健康当免检」。
 *  ② **文案漂移**：说「本**会话**未调用过预检工具」，而判据是「本 **web 进程**内是否调用过」。
 *     plugin-manager 侧已于 `44144be` 修正，哨兵侧遗漏。
 *
 * 本层语义——**组合变更新鲜度**（fail-closed）：
 *   `pass===true && workspace 匹配 && rec.atMs >= max(最新构建 mtime, 本轮 web 启动时刻)`
 * 两个时间源缺一不可用则**更严不更松**：无 web 启动记录（web 由 guardian/init 拉起）→
 * 退化为只比构建 mtime（见 `resolveWebStartMs`）。
 */

/** 落盘的预检记录（dsh-agent-plugin-manager 写；向后兼容：老记录只有前 5 个字段）。 */
export interface PreflightRecord {
  at?: string
  atMs?: number
  workspace?: string
  /** 历史遗留字段：活跃会话（**不是**调用者）。 */
  sessionId?: string | null
  pass?: boolean
  mode?: string
  /** 真实调用者（v0.2 起；老记录缺失）。 */
  caller?: { sessionId?: string | null; isMain?: boolean; hasAgent?: boolean; cwd?: string } | null
}

/** 哨兵自记的「本轮 web 启动时刻」记录（`.sentinel-web-start.json`）。 */
export interface WebStartRecord {
  atMs?: number
  workspace?: string
  pid?: number
}

export interface GateDecision {
  ok: boolean
  reason?: string
  /** 证据行（无论放行与否都给）：判据用到的三个时间源，让「为什么放行/拒绝」事后可回答。 */
  evidence: string
}

export interface SentinelGateOpts {
  workspace: string
  /** `self-plugins/&lt;name&gt;/lib/index.js` 的最大 mtime；0 = 无构建信息（跳过构建判据）。 */
  latestBuildMs: number
  /** 本轮 web 启动时刻（本哨兵进程内 spawn 过才有）；undefined = 不施加该判据。 */
  webStartMs?: number
  /** IO 层解析记录时的问题（读盘/JSON）——显式传入，**不伪装成「没调用过」**。 */
  readIssue?: string
}

/** 时间戳 -> 人读（证据行用）。0/非法 = 未知。 */
const fmtMs = (ms: number): string => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '未知')

/**
 * 从扫盘结果里取最大 mtime（纯函数）。
 * 空数组/全非法 → 0，语义是「无构建信息」→ 调用方跳过构建判据（不假装构建很新）。
 */
export function pickLatestBuildMs(entries: Array<{ path?: string; mtimeMs?: number }>): number {
  let max = 0
  for (const e of entries ?? []) {
    const m = e?.mtimeMs
    if (typeof m === 'number' && Number.isFinite(m) && m > max) max = m
  }
  return max
}

/**
 * 解析「本轮 web 启动时刻」——**锚点新鲜才采信，否则回退「无记录」**（§5.16 §2 纪律）。
 *
 * 为什么需要这层：哨兵是独立进程，它只能在**自己 spawn web 时**知道 web 的启动时刻；
 * 记录若早于本哨兵进程启动，说明哨兵重启过（期间 web 可能被 guardian/init 重新拉起），
 * 采信它会把判据**放松**——故一律不采信，退化为只比构建 mtime（更严）。
 */
export function resolveWebStartMs(
  record: WebStartRecord | null,
  opts: { sentinelProcStartMs: number; workspace: string },
): { webStartMs?: number; why: string } {
  if (record === null || record === undefined) {
    return { why: '无 web 启动记录（web 由 guardian/init 拉起）——退化为只比构建 mtime（更严，不更松）' }
  }
  if (typeof record.atMs !== 'number' || !Number.isFinite(record.atMs)) {
    return { why: 'web 启动记录无效（缺 atMs 或非数字）——退化为只比构建 mtime' }
  }
  if (record.atMs < opts.sentinelProcStartMs) {
    return { why: 'web 启动记录早于本哨兵进程启动（哨兵重启过，无法确认其后 web 是否被重新拉起）——不采信' }
  }
  if (record.workspace !== opts.workspace) {
    return { why: 'web 启动记录 workspace 不匹配（记录=' + String(record.workspace) + '，当前=' + opts.workspace + '）——不采信' }
  }
  return { webStartMs: record.atMs, why: '本轮 web 启动时刻（本哨兵进程内 spawn 记录，' + fmtMs(record.atMs) + '）' }
}

/**
 * 门控裁决（**组合变更新鲜度**，fail-closed）。判据顺序即理由优先级：
 *  1. 记录读盘/解析问题 → 拒绝（不伪装成「没调用过」）
 *  2. 记录缺失 → 拒绝（文案：**本 web 进程**内未调用过）
 *  3. `atMs` 可解析
 *  4. `workspace` 一致
 *  5. `atMs >= 最新构建 mtime`（**组合变更新鲜度**：预检必须晚于最新构建）
 *  6. `atMs >= 本轮 web 启动时刻`（有记录时；即「本轮进程内调用过」）
 *  7. 最近一次预检 `pass === true`
 * 边界：与任一门槛**同毫秒** → 放行（`>=`）。
 */
export function decideSentinelGate(
  rec: PreflightRecord | null,
  opts: SentinelGateOpts,
): GateDecision {
  const evidence = '判据时间源：最新构建=' + fmtMs(opts.latestBuildMs)
    + ' · 本轮web启动=' + (opts.webStartMs === undefined ? '无记录（跳过）' : fmtMs(opts.webStartMs))
    + ' · 预检记录=' + fmtMs(typeof rec?.atMs === 'number' ? rec.atMs : 0)
  if (opts.readIssue !== undefined) {
    return { ok: false, reason: '预检记录不可读（' + opts.readIssue + '）', evidence }
  }
  if (rec === null || rec === undefined) {
    return { ok: false, reason: '本 web 进程内未调用过预检工具（preflight_check）', evidence }
  }
  if (typeof rec.atMs !== 'number' || !Number.isFinite(rec.atMs)) {
    return { ok: false, reason: '预检记录无效（缺 atMs 或非数字）', evidence }
  }
  if (rec.workspace !== opts.workspace) {
    return {
      ok: false,
      reason: '预检记录 workspace 不匹配（记录=' + String(rec.workspace) + '，当前=' + opts.workspace + '）',
      evidence,
    }
  }
  if (opts.latestBuildMs > 0 && rec.atMs < opts.latestBuildMs) {
    return {
      ok: false,
      reason: '组合已变更：最新构建（' + fmtMs(opts.latestBuildMs) + '）晚于预检（' + fmtMs(rec.atMs)
        + '）——该预检未验证当前组合，请重新 preflight_check',
      evidence,
    }
  }
  if (opts.webStartMs !== undefined && rec.atMs < opts.webStartMs) {
    return {
      ok: false,
      reason: '预检记录早于本轮 web 启动（' + fmtMs(opts.webStartMs) + '）——本进程内未调用过预检，请重新 preflight_check',
      evidence,
    }
  }
  if (rec.pass !== true) {
    return { ok: false, reason: '本进程最近一次预检未通过——重启会被拒绝，请先修复后重新 preflight_check', evidence }
  }
  return { ok: true, evidence }
}

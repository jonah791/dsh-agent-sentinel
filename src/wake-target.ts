/**
 * wake-target.ts — 唤醒目标裁决（纯逻辑，便于离线用真实数据做尸体测试）
 *
 * 2026-09-12 事故（主人实测两次「重启提醒没发给我」）：
 *   ① 哨兵周期用**配置里钉住的 mainSessionId**（`session-89516696`）当显式目标，而「显式 id
 *      只要在会话列表里存在就只认它」→ 提醒被投进一个我不在的旧会话，我永远看不到；
 *   ② 守护的保活拉起路径**不带显式 id**，于是投给「最近更新的非空会话」——那一刻最新的是
 *      **子代理会话**（`5bb40b68-…`，web 起一个 turn 就报错）→ sendPrompt 重试 5 次后放弃，
 *      提醒静默消失。
 *   共同根因：**「存在」被当成「活跃」，「最近更新」没排除不是给人用的会话**。
 *
 * 裁决规则（v2）：
 *   - 只认「用户会话」：id 形如 `session-*`（子代理/分身是被派生的裸 uuid）且非 blank；
 *   - 按 updatedAt 降序：**最近活跃者优先**；
 *   - 显式 id 只在「仍新鲜」时优先（滞后超过阈值即视为腐化锚点，改投最近活跃）；
 *   - 每次裁决返回**理由**，写进事件日志——「为什么是这个目标」必须可回答（今天的教训）。
 */

/** 会话列表条目的最小投影（session/list 返回的字段子集）。 */
export interface SessionLite {
  sessionId?: string
  blank?: boolean
  updatedAt?: number
}

/** 目标裁决结果。 */
export interface WakeTargetDecision {
  sid: string | undefined
  why: string
  /** 排序后的候选（用户会话优先，便于失败后换人重试） */
  ranked: string[]
}

/** 显式锚点新鲜度阈值（ms）：滞后超过它即认为锚点腐化。 */
export const DEFAULT_ANCHOR_STALE_MS = 10 * 60_000

/**
 * updatedAt 归一化到 ms：会话列表在不同宿主版本上给秒或毫秒，按量级判别。
 * @param value - 原始 updatedAt
 */
export function toMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return value > 1e12 ? value : value * 1000
}

/** 是否「用户会话」（可被人对话、可被唤醒）：`session-*` 前缀且非空白。 */
export function isUserSession(session: SessionLite): boolean {
  const id = session.sessionId ?? ''
  return id.startsWith('session-') && session.blank !== true
}

/** 按最近活跃降序排列用户会话。 */
export function rankUserSessions(sessions: readonly SessionLite[]): SessionLite[] {
  return sessions
    .filter(isUserSession)
    .slice()
    .sort((a, b) => toMs(b.updatedAt) - toMs(a.updatedAt))
}

/** 人类可读的「距今」描述。 */
function ageText(updatedAt: number | undefined, nowMs: number): string {
  const ms = toMs(updatedAt)
  if (ms === 0) return '无时间戳'
  const sec = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (sec < 90) return sec + 's 前'
  const min = Math.round(sec / 60)
  return min < 90 ? min + 'min 前' : Math.round(min / 60) + 'h 前'
}

/**
 * 裁决唤醒目标。
 * @param sessions - session/list 原始条目
 * @param explicitId - 哨兵/调用方指定的锚点会话（可为空）
 * @param nowMs - 裁决时刻
 * @param opts - 锚点新鲜度阈值
 * @returns 目标会话 id、裁决理由、候选排序
 */
export function decideWakeTarget(
  sessions: readonly SessionLite[],
  explicitId: string | undefined,
  nowMs: number,
  opts: { anchorStaleMs?: number } = {},
): WakeTargetDecision {
  const staleMs = opts.anchorStaleMs ?? DEFAULT_ANCHOR_STALE_MS
  const ranked = rankUserSessions(sessions)
  const rankedIds = ranked.map((s) => String(s.sessionId))
  if (ranked.length === 0) {
    return {
      sid: undefined,
      why: '候选 ' + String(sessions.length) + ' 条，但无「用户会话」（session-* 且非空白）——不投递',
      ranked: rankedIds,
    }
  }
  const newest = ranked[0]!
  const newestId = String(newest.sessionId)
  const hasExplicit = explicitId !== undefined && explicitId !== ''
  if (!hasExplicit) {
    return { sid: newestId, why: '未指定锚点 → 投最近活跃用户会话（' + ageText(newest.updatedAt, nowMs) + '）', ranked: rankedIds }
  }
  const anchor = ranked.find((s) => s.sessionId === explicitId)
  if (anchor === undefined) {
    const known = sessions.some((s) => s.sessionId === explicitId)
    return {
      sid: newestId,
      why: known
        ? '锚点 ' + String(explicitId) + ' 是空白会话/子代理会话（非用户会话）→ 改投最近活跃 ' + newestId
        : '锚点 ' + String(explicitId) + ' 不在会话列表 → 改投最近活跃 ' + newestId,
      ranked: rankedIds,
    }
  }
  const lagMs = toMs(newest.updatedAt) - toMs(anchor.updatedAt)
  if (lagMs > staleMs) {
    return {
      sid: newestId,
      why: '锚点 ' + String(explicitId) + ' 已滞后 ' + Math.round(lagMs / 60000) + 'min（>阈值 '
        + Math.round(staleMs / 60000) + 'min，锚点腐化）→ 改投最近活跃 ' + newestId,
      ranked: rankedIds,
    }
  }
  return { sid: String(explicitId), why: '锚点新鲜（滞后 ' + Math.round(lagMs / 1000) + 's），尊重显式指定', ranked: rankedIds }
}

/**
 * 通知类（非唤醒）目标：最近活跃用户会话，无需锚点。
 * @param sessions - session/list 原始条目
 * @param nowMs - 裁决时刻
 */
export function pickNotifySession(sessions: readonly SessionLite[], nowMs: number): { sid: string | undefined; why: string } {
  const d = decideWakeTarget(sessions, undefined, nowMs)
  return { sid: d.sid, why: d.why }
}

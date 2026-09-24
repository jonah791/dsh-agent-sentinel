/**
 * flag-consume.ts — 哨兵消费判据（纯函数，可离线测）
 *
 * 事故背景（2026-09-25，4 次复现 + `.watch-events.log` 直接证据）：
 * 成功重启那一轮，日志写的是「周期完成（期间哨兵被重新 touch，flag 保留待下一轮）」
 * ⇒ 哨兵**不退场**。根因是判据只有**路径级**：
 * 周期内 watcher 对该哨兵文件自身的任何事件（含重启过程本身的扰动）都会走 `onFlag`，
 * 而 `busy` 为真 ⇒ `pendingFlagPath = flagPath`（**同一个路径**）⇒ 末尾判成「被重新 touch」。
 * 下一轮拿到的还是**同一份** `daemon_restart:` 哨兵，而其闸门判据
 * （「预检记录早于本轮 web 启动」）在成功重启后**必然**成立 ⇒ 每轮重启都附赠一条
 * 误导性的「daemon_restart 被拦」+ 哨兵滞留；滞留期内只要有人调过一次 `preflight_check`，
 * 这条陈旧哨兵就会**真的再触发一次重启**（唯一拦住它的是闸门，不是设计）。
 *
 * 修法：加入**内容级**比较——内容与本轮开始时逐字节一致 ⇒ 是自触发，可消费；
 * 内容变了 ⇒ 真·新触发，保留（2026-08-31 审计 M1 的本意不丢）。
 */

/** 消费判据的输入（全部为观测事实，无隐式状态）。 */
export interface ConsumeInput {
  /** watcher 在周期内报告过**同一个路径**（旧判据的唯一输入） */
  pendingSamePath: boolean
  /** 周期结束时哨兵文件仍存在 */
  flagExists: boolean
  /** 其内容与本轮开始时读到的**逐字节一致** */
  contentUnchanged: boolean
}

/**
 * 周期结束后是否可以消费（删除 + 不再重排）哨兵。
 * @returns true = 消费；false = 保留待下一轮
 */
export function shouldConsumeFlag(input: ConsumeInput): boolean {
  if (!input.flagExists) return true // 已不在盘上 = 已消费（没必要再重排一轮）
  if (!input.pendingSamePath) return true // 期间无事件 = 正常路径
  return input.contentUnchanged // 有事件：内容未变 ⇒ 自触发；变了 ⇒ 真新触发
}

/**
 * web 生命周期租约（2026-09-12 双重重启事故修复）
 *
 * 事故：主人一次重部署触发了两次重启。根因——**web 生命周期有两个 owner**：
 *   - 哨兵（dsh-agent-sentinel）：收到 `.hot-reload-flag` → kill 旧 web → spawn 新 web → 唤醒
 *   - 守护（dsh-agent-guardian）：保活巡检发现端口空闲 → spawn web → 唤醒
 * 两者没有互斥交接，于是哨兵重启的窗口里守护也去拉一个：
 *   `22:33:13 接管端口：kill 进程 35016` → `22:33:31 web 认证 URL 已捕获`（哨兵拉起）
 *   → `22:33:35 唤醒目标裁决`（哨兵路径）**+** `22:33:35 唤醒目标裁决`（守护路径）
 *   → `22:34:29 web 退出但端口被活 dsh web 占用（PID 23456）——收养接管，跳过拉起`
 *   即多出来的那个实例绑定端口失败退出，且唤醒被发了两遍。
 *
 * 解法：**租约**（lease）。谁发起重启，谁在动手前取租约；另一方在「拉起前」与「唤醒前」
 * 查租约，被持有就**收养而非拉起**、**不重复唤醒**。租约有 TTL，发起者崩溃也不会永久锁死
 * （过期即视为空闲，另一方可接管；腐败/时偏同样不阻塞，只落盘说明）。
 *
 * 纪律（SOUL §5.10 §3 / §5.18 §4）：本模块**不吞异常**——读取问题通过 `issue` 显式返回，
 * 由调用方落盘证据行；每次裁决都带 `why`（为什么放行 / 为什么让位）。
 *
 * 双胞胎声明：`dsh-agent-guardian/src/lease.ts` 是本文件的**同语义副本**（两个插件不跨包
 * 依赖——跨包 `file:` 依赖会在消费方 `.pnpm` 里产生陈旧副本，见 SOUL §5.15 §4）。改这里
 * 必须同步改那边，两边各有自己的单测（`tests/lease.test.mjs`）守护语义一致。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export type LeaseOwner = 'sentinel' | 'guardian'

export interface WebLease {
  /** 持租方 */
  owner: LeaseOwner
  /** 取租时刻（epoch ms） */
  atMs: number
  /** 租约时长（ms）——超过即视为过期，另一方接管 */
  ttlMs: number
  /** 人读说明（写进证据行） */
  note?: string
}

export type LeaseAction = 'proceed' | 'hold'

export interface LeaseGate {
  action: LeaseAction
  /** 裁决理由（必须落盘） */
  why: string
  holder?: LeaseOwner
  remainingMs?: number
}

export interface LeaseReadResult {
  lease: WebLease | null
  /** 读取/解析问题（非空即需落盘告警；lease 为 null 表示按空闲处理） */
  issue?: string
}

/** 默认 TTL：覆盖「kill → spawn → 等就绪 → 唤醒」全程（实测约 24s，留足余量） */
export const LEASE_TTL_MS = 120_000
export const LEASE_FILE_NAME = '.web-lifecycle-lease.json'

export const leasePath = (dshHome: string): string => join(dshHome, LEASE_FILE_NAME)

const isOwner = (v: unknown): v is LeaseOwner => v === 'sentinel' || v === 'guardian'

/** 结构校验（宽进严出：字段不合法即判无租约，由调用方落盘 issue） */
export function parseLease(raw: unknown): WebLease | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!isOwner(o.owner)) return null
  if (typeof o.atMs !== 'number' || !Number.isFinite(o.atMs)) return null
  if (typeof o.ttlMs !== 'number' || !Number.isFinite(o.ttlMs) || o.ttlMs <= 0) return null
  const lease: WebLease = { owner: o.owner, atMs: o.atMs, ttlMs: o.ttlMs }
  if (typeof o.note === 'string') lease.note = o.note
  return lease
}

/**
 * 纯裁决：此刻 `role` 该放行还是让位。
 * - 无租约 → 放行（no-lease）
 * - 自己持有 → 放行（self-held，重启正在自己手上）
 * - 过期 / 时钟偏移（atMs 在未来）→ 放行（不因坏数据锁死服务）
 * - 他人持有且新鲜 → 让位（hold），理由含持有者/已持时长/剩余/TTL 与 note
 */
export function decideLeaseGate(lease: WebLease | null, nowMs: number, role: LeaseOwner): LeaseGate {
  if (lease === null) return { action: 'proceed', why: 'no-lease' }
  const age = nowMs - lease.atMs
  if (!Number.isFinite(age)) return { action: 'proceed', why: 'lease-bad-clock(age=NaN)' }
  if (age < 0) return { action: 'proceed', why: 'lease-clock-skew(age=' + String(age) + 'ms)' }
  if (age >= lease.ttlMs) {
    return {
      action: 'proceed',
      why: 'lease-expired(age=' + String(Math.round(age)) + 'ms>=ttl=' + String(lease.ttlMs)
        + 'ms,holder=' + lease.owner + ')',
    }
  }
  if (lease.owner === role) return { action: 'proceed', why: 'self-held(age=' + String(Math.round(age)) + 'ms)' }
  return {
    action: 'hold',
    why: 'held-by-' + lease.owner + '(age=' + String(Math.round(age)) + 'ms,remaining='
      + String(Math.round(lease.ttlMs - age)) + 'ms,note=' + (lease.note ?? '') + ')',
    holder: lease.owner,
    remainingMs: lease.ttlMs - age,
  }
}

/** 读租约（不吞异常：问题走 issue 返回，让调用方落盘） */
export function readLease(dshHome: string): LeaseReadResult {
  const p = leasePath(dshHome)
  if (!existsSync(p)) return { lease: null }
  let text: string
  try {
    text = readFileSync(p, 'utf8')
  } catch (e) {
    return { lease: null, issue: 'lease-read-failed: ' + String((e as Error).message) }
  }
  if (text.trim() === '') return { lease: null, issue: 'lease-empty' }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (e) {
    return { lease: null, issue: 'lease-json-invalid: ' + String((e as Error).message) }
  }
  const lease = parseLease(raw)
  if (lease === null) return { lease: null, issue: 'lease-shape-invalid: ' + text.slice(0, 200) }
  return { lease }
}

/** 取租（原子写：tmp → rename，避免读到半截文件） */
export function writeLease(dshHome: string, lease: WebLease): void {
  const p = leasePath(dshHome)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(lease, null, 2), 'utf8')
  renameSync(tmp, p)
}

/** 释放租约——**只释放自己的**（不夺别人的权：guardian 不得清 sentinel 的租约） */
export function clearLease(dshHome: string, owner: LeaseOwner): { cleared: boolean; why: string } {
  const { lease, issue } = readLease(dshHome)
  if (lease === null) return { cleared: false, why: issue ?? 'no-lease' }
  if (lease.owner !== owner) return { cleared: false, why: 'not-owner(current=' + lease.owner + ')' }
  try {
    // 写一条「已释放」而不是删文件——保留最后一次交接的证据（谁在什么时候放的手）
    writeLease(dshHome, { owner, atMs: 0, ttlMs: 1, note: 'released-at-' + String(Date.now()) })
    return { cleared: true, why: 'released' }
  } catch (e) {
    return { cleared: false, why: 'release-write-failed: ' + String((e as Error).message) }
  }
}

/** 便捷：当前是否被别人持有（一次性查询，供唤醒/拉起前使用） */
export function checkLeaseFor(dshHome: string, role: LeaseOwner, nowMs: number): LeaseGate & { issue?: string } {
  const { lease, issue } = readLease(dshHome)
  const gate = decideLeaseGate(lease, nowMs, role)
  return issue === undefined ? gate : { ...gate, issue }
}

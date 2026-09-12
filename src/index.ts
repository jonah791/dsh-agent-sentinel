/**
 * dsh-agent-sentinel：哨兵插件（2026-08-26 主人指令：从 dsh-agent-watch 拆分）。
 *
 * 职责：监听哨兵文件（.hot-reload-flag）→ 触发时调用沙盒预检（ctx.preflight.run，
 * 消费 dsh-agent-preflight 服务）→ **预检通过才重启 web**（fail-closed）→ 唤醒
 * 目标会话 → 清哨兵。预检失败则保留哨兵 + 落盘 incident + 通知会话（修复后 touch 重试）。
 *
 * 借鉴「编辑前需要阅读」思路（主人 2026-08-26）：重启是破坏性动作，**必须预检先行**——
 * preflight 是重启的必要条件（不通过绝不 kill 旧 web）。
 *
 * 职责边界：sentinel 只做「监听 + 协调重启」；实际拉起 web 由 guardian 插件负责
 * （渐进拆分：本版暂内嵌 spawn，guardian 拆出后改注入 ctx.guardian）。
 * @module dsh-agent-sentinel
 */
import { watch as fsWatch, existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { sendTelegramAlert } from './alert-transport.ts'
import { decideWakeTarget, type SessionLite } from './wake-target.ts'
import { LEASE_TTL_MS, clearLease, writeLease } from './lease.ts'
import { createHash, createHmac } from 'node:crypto'
import net from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'agent-sentinel'

export interface Config {
  /** DSH_HOME（哨兵默认目录）。 */
  dshHome: string
  /** 监听哨兵的目录列表。 */
  watchDirs: string[]
  /** 哨兵文件名。 */
  flagFile: string
  /** 兼容旧路径的额外哨兵绝对路径列表。 */
  legacyFlags: string[]
  /** bin.js 绝对路径；留空则从 @deepseek-ai/dsh 解析。 */
  bin: string
  /** 重启的目标 profile。 */
  profile: string
  /** web 监听端口。 */
  port: number
  /** web API 基址。 */
  baseUrl: string
  /** 重启后等待 web 就绪的时限（ms）。 */
  readyTimeoutMs: number
  /** 事故文件路径。 */
  incidentFile: string
  /** workspace 兜底。 */
  defaultWorkspace: string
  /** 哨兵事件防抖（ms）。 */
  debounceMs: number
  /** web 启动命令（留空用 bin 直连）。 */
  launchCmd: string[]
  /** Telegram 通知（可选）。 */
  telegramBotToken: string
  telegramChatId: string
  httpProxy: string
}

export const Config = z.object({
  dshHome: z.string().default(process.env.DSH_HOME || ''),
  watchDirs: z.array(z.string()).default([]),
  flagFile: z.string().default('.hot-reload-flag'),
  legacyFlags: z.array(z.string()).default([]),
  bin: z.string().default(''),
  profile: z.string().default('web'),
  port: z.number().default(3080),
  baseUrl: z.string().default('http://127.0.0.1:3080'),
  readyTimeoutMs: z.number().default(30000),
  incidentFile: z.string().default(''),
  defaultWorkspace: z.string().default(''),
  debounceMs: z.number().default(300),
  launchCmd: z.array(z.string()).default([]),
  telegramBotToken: z.string().default(''),
  telegramChatId: z.string().default(''),
  httpProxy: z.string().default('http://127.0.0.1:16888'),
})

// 注入 preflight/runtime/webman 服务（dsh-agent-preflight / dsh-agent-runtime 提供）
// 2026-09-02 重构 D2：进程管理归 ctx.webman，环境归 ctx.agentRuntime——sentinel 只做监听+协调
export const inject = ['preflight', 'agentRuntime', 'webman'] as const

/** 唤醒结果（把决策信息公开返回，供调用方决定告警）。 */
export interface WakeResult {
  /** 是否真的把提醒投递出去了 */
  ok: boolean
  /** 实际唤醒的会话 id（ok=false 时缺省） */
  sessionId?: string
  /** 人类可读的原因 */
  reason: string
  /** 诊断：当时列表里的候选会话 */
  candidates: string[]
}

/**
 * 会话唤醒服务（`ctx.sessionWaker`）。
 *
 * 2026-09-10 提炼：本能力原先只存在于 sentinel 的哨兵周期内，导致
 * **guardian 的自动拉起路径没有唤醒**（旧 dsh-agent-watch 有，
 * 2026-08-27 拆三插件时丢失 → 主人实测「重启后没收到提醒」）。
 * 现提炼为服务：sentinel（哨兵周期）与 guardian（保活自愈拉起）共用同一实现，
 * 从结构上消除「两条路径各写一份、改一处漏一处」的漂移。
 */
export interface SessionWakerService {
  /**
   * 等待 web 就绪后向目标会话投递一条提醒。
   * 目标选择：`explicitId` 有值 → **只认它**（未出现则轮询等待，绝不 fallback 到别的会话，
   * 避免误唤醒无关会话）；缺省 → 列表内最近活跃的非空会话。
   * @param text - 投递正文
   * @param opts - explicitId 指定目标会话；waitWebReadyMs 覆盖就绪等待预算
   * @returns 唤醒结果（含候选列表，便于诊断）
   */
  wakeLatestSession(text: string, opts?: { explicitId?: string; waitWebReadyMs?: number }): Promise<WakeResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionWaker?: SessionWakerService
  }
}

/** preflight 服务类型（dsh-agent-preflight 提供，跨插件类型增强）。 */
export interface PreflightService {
  run(workspace: string, mode?: 'full' | 'quick'): Promise<{ pass: boolean; output: string; checks?: Record<string, { ok: boolean; detail: string }> }>
  name: string
}

/** agentRuntime 服务类型（dsh-agent-runtime 提供）。 */
export interface RuntimeService {
  readonly bin: string
  readonly profile: string
  readonly port: number
  readonly baseUrl: string
  readonly dshHome: string
  readonly workspace: string
  readonly launchCmd: string[]
  resolve(): void
}

/** webman 服务类型（dsh-agent-runtime 提供）。 */
export interface WebmanService {
  spawnWeb(workspace: string): Promise<void>
  killWeb(pid: number): Promise<boolean>
  portOwnerPid(): Promise<number | null>
  isDshWebProcess(pid: number): Promise<boolean>
  portInUse(port?: number): Promise<boolean>
  waitPortFree(maxWaitMs?: number): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    preflight: PreflightService
    agentRuntime: RuntimeService
    webman: WebmanService
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const norm = (p: string) => p.replaceAll('\\', '/')

// ---------- /api 认证辅助（alpha.1 起 web 对 /api/* 要求 browser-auth cookie） ----------
function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}
function browserCookieName(authority: string): string {
  return 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest())
}
function browserCookieValue(payload: { version: 1; authority: string; issuedAt: number; expiresAt: number }, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(createHmac('sha256', secret).update(body).digest())}`
}
/** 读 DSH browser-session secret，构造 /api 认证 cookie（alpha.1 起 /api/* 需要 cookie）。 */
function buildBrowserAuthCookie(dshHome: string, authority: string): string | undefined {
  try {
    const yaml = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8')
    const m = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/)
    const secretB64 = m?.[1]
    if (secretB64 === undefined) return undefined
    const secret = decodeBase64Url(secretB64)
    if (secret === undefined || secret.byteLength !== 32) return undefined
    const now = Date.now()
    return browserCookieName(authority) + '=' + browserCookieValue(
      { version: 1, authority, issuedAt: now, expiresAt: now + 24 * 60 * 60 * 1000 },
      secret,
    )
  } catch { return undefined }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('sentinel')
  const dshHome = config.dshHome || process.env.DSH_HOME || process.cwd()
  // telegram 告警凭据单一来源（2026-09-06）：config 优先 → .credentials.yaml refs.TELEGRAM_BOT_TOKEN 兜底
  if (!config.telegramBotToken || !config.telegramChatId) {
    try {
      const cred = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8')
      const m = cred.match(/^\s*TELEGRAM_BOT_TOKEN:\s*(\S+)/m)
      if (m && m[1] && !config.telegramBotToken) config.telegramBotToken = m[1]
      const mc = cred.match(/^\s*TELEGRAM_CHAT_ID:\s*(\S+)/m)
      if (mc && mc[1] && !config.telegramChatId) config.telegramChatId = mc[1]
    } catch { /* 无凭据文件 */ }
  }

  const logEvent = (msg: string) => {
    try {
      writeFileSync(join(dshHome, '.watch-events.log'), '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: 'a' })
    } catch { /* 忽略 */ }
  }

  // ---------- /api Remote RPC 调用（alpha.1：cookie 认证 + /api/<endpoint> + args._request） ----------
  const authority = (() => { try { return new URL(ctx.agentRuntime.baseUrl).host } catch { return '127.0.0.1:' + ctx.agentRuntime.port } })()
  const apiRpc = async (endpoint: string, rpcBody: unknown): Promise<any> => {
    const cookie = buildBrowserAuthCookie(dshHome, authority)
    const res = await fetch(ctx.agentRuntime.baseUrl + '/api/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie !== undefined ? { cookie } : {}) },
      body: JSON.stringify(rpcBody),
      // 2026-08-31 审计 S4：web 假活（端口通 /api 半死）时防 fetch 无限挂起
      signal: AbortSignal.timeout(10000),
    })
    return await res.json()
  }

  const writeIncident = (detail: Record<string, unknown>) => {
    try {
      const file = config.incidentFile || join(dshHome, '.watch-incident.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...detail }, null, 2), 'utf8')
      logger.error('事故已落盘: ' + file)
    } catch (err) {
      logger.error('事故落盘失败: ' + String(err))
    }
  }

  // 2026-08-31 审计 M3：web 重启失败等重大事故需电报告警（此前 sentinel 无主动告警能力）
  // 2026-09-11 修复（同批审计发现两处缺陷）：
  //   ① 传输层用 curl.exe（schannel）经代理 → 本环境 TLS 必失败（实测 exit 35，-k/--http1.1 各变体同样失败），
  //      而同一代理下 Node fetch 正常 → 改用 alert-transport（node-fetch 主通道 + curl 兜底）。
  //   ② 原实现 `if (!token || !chat) return` + `child.on('error', () => {})` + 无任何落盘 = **静默失败**
  //      （违反 5.10 §3 / 5.12 §3）→ 现全程落盘（发送中/送达通道/失败原因）。
  const sendTelegram = async (text: string): Promise<void> => {
    const hint = text.slice(0, 60).replace(/\s+/g, ' ')
    logEvent('telegram 告警发送中: ' + hint)
    const r = await sendTelegramAlert({
      token: config.telegramBotToken,
      chatId: config.telegramChatId,
      text,
      proxy: config.httpProxy || 'http://127.0.0.1:16888',
    })
    logEvent('telegram 告警' + (r.ok ? '已送达（' + r.channel + '）' : '失败（' + r.channel + '）：' + r.detail)
      + ' — ' + hint)
  }

  // ---------- 重启 web（2026-09-02 重构 D2：进程管理归 ctx.webman） ----------
  // portInUse/killWeb/spawnWeb/portOwnerPid/isDshWebProcess 已抽到 dsh-agent-runtime 的 ctx.webman
  const portInUse = ctx.webman.portInUse
  const killWeb = ctx.webman.killWeb
  const spawnWeb = ctx.webman.spawnWeb
  const portOwnerPid = ctx.webman.portOwnerPid
  const isDshWebProcess = ctx.webman.isDshWebProcess

  const restartWeb = async (workspace: string) => {
    // 杀旧 web（哨兵授权重启 = 接管）——先确认占用者是 dsh web，防误杀非 dsh 进程（2026-08-31 审计 S1）
    const owner = await portOwnerPid()
    if (owner !== null && await isDshWebProcess(owner)) {
      logEvent('接管端口：kill 进程 ' + owner)
      const killed = await killWeb(owner)
      if (!killed) {
        // 2026-08-31 审计 M2：kill 失败要落盘，否则新 web 会因端口被占启动失败
        logEvent('kill 旧 web 失败（PID ' + owner + '）——写事故')
        writeIncident({ message: 'kill 旧 web 失败 PID ' + String(owner) + '，新 web 可能无法绑定端口' })
      }
      await sleep(1200)
    } else if (owner !== null) {
      // 端口被非 dsh 进程占用：不接管不杀（避免误杀用户服务），写事故 + 跳过重启
      logEvent('端口被非 dsh 进程占用（PID ' + owner + '）——不接管，跳过重启')
      writeIncident({ message: '哨兵重启跳过：端口 ' + String(ctx.agentRuntime.port) + ' 被非 dsh 进程占用（PID ' + owner + '）' })
      return
    }
    await spawnWeb(workspace)
  }

  // ---------- 唤醒 ----------
  const waitWebReady = async (timeoutMs: number): Promise<boolean> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await portInUse(ctx.agentRuntime.port)) {
        try {
          const data = await apiRpc('session/list', {
            type: 'client-request', rpcId: 'dsh-sentinel-ready-' + Date.now(),
            method: 'session/list', payload: { args: { _request: {} } },
          })
          if (data?.result?.ok === true) return true
        } catch { /* 未就绪 */ }
      }
      await sleep(1000)
    }
    return false
  }

  const listSessions = async (): Promise<Array<{ sessionId?: string; blank?: boolean; updatedAt?: number }>> => {
    try {
      const data = await apiRpc('session/list', {
        type: 'client-request', rpcId: 'dsh-sentinel-list-' + Date.now(),
        method: 'session/list', payload: { args: { _request: {} } },
      })
      return data?.result?.value?.items ?? []
    } catch { return [] }
  }

  const sendPrompt = async (sessionId: string, text: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const data = await apiRpc('session/prompt', {
          type: 'client-request', rpcId: 'dsh-sentinel-' + Date.now(),
          method: 'session/prompt',
          payload: { args: { request: { requestId: 'dsh-sentinel-' + Date.now(), sessionId, mode: 'steer', content: [{ type: 'text', text }] } } },
        })
        if (data?.result?.ok === true) return true
      } catch { /* 重试 */ }
      await sleep(3000)
    }
    return false
  }

  /** 通知类目标选择（预检报告/拦截告知）：与唤醒共用同一套裁决——不再各自手搓排序。 */
  const pickNotifySid = async (anchorId?: string): Promise<{ sid: string | undefined; why: string }> => {
    const decision = pickTarget(await listSessions(), anchorId)
    logEvent('通知目标裁决: ' + decision.why)
    return { sid: decision.sid, why: decision.why }
  }

  /** 目标会话选择（纯逻辑，便于诊断）：见 wake-target.ts 的裁决规则与理由。 */
  const pickTarget = (
    sessions: SessionLite[],
    explicitId?: string,
  ): { sid: string | undefined; why: string; ranked: string[] } =>
    decideWakeTarget(sessions, explicitId, Date.now())

  /**
   * 唤醒实现（服务与哨兵周期共用）。
   * @param text - 投递正文
   * @param opts - explicitId 目标会话；waitWebReadyMs 就绪等待预算
   * @returns 唤醒结果（含候选列表）
   */
  const wakeLatestSession = async (text: string, opts: { explicitId?: string; waitWebReadyMs?: number } = {}): Promise<WakeResult> => {
    const explicitId = opts.explicitId
    if (!(await waitWebReady(opts.waitWebReadyMs ?? config.readyTimeoutMs))) {
      return { ok: false, reason: 'web 未在时限内就绪', candidates: [] }
    }
    const MAX_WAIT_MS = 60_000
    const startedWait = Date.now()
    let sessions: SessionLite[] = []
    let decision: { sid: string | undefined; why: string; ranked: string[] } = { sid: undefined, why: '未裁决', ranked: [] }
    for (;;) {
      sessions = await listSessions()
      decision = pickTarget(sessions, explicitId)
      if (decision.sid !== undefined) break
      if (Date.now() - startedWait >= MAX_WAIT_MS) break
      await sleep(3000)
    }
    const candidates = sessions.map((s) => String(s.sessionId ?? '?'))
    if (decision.sid === undefined) {
      logEvent('唤醒目标裁决: ' + decision.why)
      return {
        ok: false,
        reason: explicitId !== undefined && explicitId !== ''
          ? '等待 ' + Math.round((Date.now() - startedWait) / 1000) + 's 后仍无可用用户会话（锚点 ' + String(explicitId) + ' 不可用，且无可替代——不误投）'
          : '等待 ' + Math.round((Date.now() - startedWait) / 1000) + 's 后列表内仍无用户会话',
        candidates,
      }
    }
    // 2026-09-12：首选失败**换下一个候选**（最多 3 个）并逐次留痕——原实现一次失败即静默放弃
    const order = [decision.sid, ...decision.ranked.filter((id) => id !== decision.sid)].slice(0, 3)
    logEvent('唤醒目标裁决: ' + decision.why + ' → 尝试顺序=[' + order.join(',') + ']')
    for (const target of order) {
      if (await sendPrompt(target, text)) {
        return { ok: true, sessionId: target, reason: '已发送', candidates }
      }
      logEvent('唤醒投递失败，换下一个候选: ' + target)
    }
    return { ok: false, reason: '候选 ' + String(order.length) + ' 个全部发送失败（各重试 5 次后放弃）', candidates }
  }

  // 暴露为服务：watch profile 内其他插件（guardian）复用同一实现
  ctx.provide('sessionWaker', { wakeLatestSession })

  const decideAndWake = async (explicitId?: string) => {
    const r = await wakeLatestSession('[守护] web 已重启（' + new Date().toLocaleTimeString() + '）。请继续。', { explicitId })
    // 2026-09-10：补「唤醒决策」诊断日志（原实现只记结果，选错对象时无从追查候选列表）
    logEvent('唤醒决策: explicit=' + String(explicitId ?? '无') + ' 候选=[' + r.candidates.join(',') + '] → ' + String(r.sessionId ?? '未发送'))
    if (r.ok) {
      logEvent('唤醒消息已发送: ' + String(r.sessionId))
      return
    }
    logEvent('唤醒未发送: ' + r.reason)
    if (r.reason.includes('未在时限内就绪')) {
      writeIncident({ message: 'web 重启后未在 ' + String(config.readyTimeoutMs) + 'ms 内就绪，唤醒跳过' })
      void sendTelegram('⚠ [守护] web 重启后未在时限内就绪——请检查 web 启动日志')
    } else {
      writeIncident({ message: 'web 重启后未能唤醒目标会话（explicit=' + String(explicitId ?? '无') + '）：' + r.reason })
      void sendTelegram('⚠ [守护] web 已重启但未能唤醒目标会话：' + r.reason + '\n候选=[' + r.candidates.join(',') + ']')
    }
  }

  // ---------- 哨兵周期（核心：preflight gate 是重启的必要条件） ----------
  interface FlagInfo { workspace?: string; sessionId?: string; note?: string }
  const parseFlag = (raw: string): FlagInfo => {
    try {
      const j = JSON.parse(raw) as FlagInfo
      if (j && (j.workspace || j.sessionId)) return j
    } catch { /* 旧纯文本 */ }
    return {}
  }

  /** 预检工具调用记录闸门（主人 2026-08-30）：重启前检查会话中是否调用过预检工具。 */
  const readPreflightInvokedGate = (workspace: string): { ok: boolean; reason?: string } => {
    try {
      const invokedFile = join(dshHome, '.preflight-invoked.json')
      if (!existsSync(invokedFile)) return { ok: false, reason: '本会话未调用过预检工具（preflight_check）' }
      const rec = JSON.parse(readFileSync(invokedFile, 'utf8')) as { atMs?: number; workspace?: string; pass?: boolean }
      if (rec.pass !== true) return { ok: false, reason: '最近预检未通过' }
      if (rec.workspace !== workspace) return { ok: false, reason: '预检记录 workspace 不匹配' }
      if (typeof rec.atMs !== 'number' || Date.now() - rec.atMs > 30 * 60 * 1000) {
        return { ok: false, reason: '预检记录已过期（>30 分钟，非本会话）' }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: '读取预检记录失败: ' + String(e) }
    }
  }

  let busy = false
  let pendingTimer: NodeJS.Timeout | null = null
  // 2026-08-31 审计 M1：busy/pending 期间收到的新哨兵不丢弃，记录待 runCycle 结束后重跑
  let pendingFlagPath: string | null = null

  const runCycle = async (flagPath: string) => {
    if (busy) return
    busy = true
    // 2026-08-31 审计 M1：debounce 期间记录的同路径 pending 由本轮处理（读最新内容），先清避免误判
    if (pendingFlagPath === flagPath) pendingFlagPath = null
    try {
      let raw = ''
      try { raw = readFileSync(flagPath, 'utf8') } catch { logger.info('哨兵不存在，跳过: ' + flagPath); return }
      const info = parseFlag(raw)
      let workspace = info.workspace
      if (!workspace) workspace = config.defaultWorkspace || process.cwd()
      logger.info('哨兵触发: ' + flagPath + ' | workspace=' + workspace)
      logEvent('哨兵触发 ' + flagPath + ' workspace=' + workspace)

      // 【核心】preflight gate——重启的必要条件（主人 2026-08-26：借鉴「编辑前需要阅读」）
      // 调 dsh-agent-preflight 服务；失败 = 绝不重启（web 免疫层，保留哨兵）
      let pf: { pass: boolean; output: string }
      try {
        pf = await ctx.preflight.run(workspace, 'full')
      } catch (e) {
        pf = { pass: false, output: '[sentinel] preflight 服务调用失败: ' + String(e) }
      }
      logEvent('预检 ' + (pf.pass ? 'PASS' : 'FAIL') + ' workspace=' + workspace)
      if (!pf.pass) {
        writeIncident({ message: 'preflight failed; web kept running', flag: flagPath, workspace, detail: pf.output.slice(-1500) })
        // 通知目标会话（不删哨兵，修复后 touch 重试）——目标裁决统一走 pickNotifySid（2026-09-12）
        const { sid: notifySid } = await pickNotifySid(info.sessionId)
        if (notifySid) {
          await sendPrompt(notifySid, '[守护] 哨兵触发失败：预检 FAIL（组合无法加载/存在风险），web 未重启（免疫层拦截）。\n' + pf.output.slice(0, 600) + '\n哨兵已保留，修复后 touch ' + flagPath + ' 重试。')
        }
        return // 哨兵保留
      }
      logger.info('预检通过')
      // 2026-08-27 方案 c（主人定调「预检报告先给爱丽丝才能重启」，类似编辑前阅读）：
      // 预检通过后不自动重启——先判断哨兵来源。
      //  - daemon_restart 哨兵（note 前缀 "daemon_restart:"）= 爱丽丝已主动决策 → 直接重启
      //  - 其他来源（plugin_configure / plugin_start / plugin_stop / 外部 touch）→ 发预检报告给爱丽丝
      //    （wakeup 唤醒），保留哨兵等确认；爱丽丝确认后调 daemon_restart 覆盖哨兵 → 再次触发走上一分支重启
      const isAliceConfirmed = (info.note ?? '').startsWith('daemon_restart:')
      if (isAliceConfirmed) {
        // 【预检工具调用校验 · 主人 2026-08-30】重启前检查会话中是否调用过预检工具（.preflight-invoked.json）。
        // plugin-manager 的 daemon_restart 写哨兵前已校验；此处兜底防绕过（直接手写 daemon_restart 哨兵）。
        const invokedGate = readPreflightInvokedGate(workspace)
        if (!invokedGate.ok) {
          writeIncident({ message: 'daemon_restart 被拦：未调用预检工具', flag: flagPath, workspace, detail: invokedGate.reason ?? '' })
          const { sid: notifySid } = await pickNotifySid(info.sessionId)
          if (notifySid) {
            await sendPrompt(notifySid, '[守护] daemon_restart 被拦：会话中未调用过预检工具（或记录过期）。\n' + (invokedGate.reason ?? '') + '\n请先调用 preflight_check 预检工具，再 daemon_restart。\n哨兵已保留。')
          }
          logEvent('daemon_restart 被拦（未调用预检工具）: ' + (invokedGate.reason ?? ''))
          return // 哨兵保留
        }
        // 【生命周期租约 · 2026-09-12 双重重启事故修复】取租后再动手：web 生命周期的两个
        // owner（哨兵 kill+spawn+唤醒 / 守护保活拉起+唤醒）必须有互斥交接——守护在窗口内
        // 查租约，被持有即「收养而非拉起、不重复唤醒」。finally 释放（只释放自己的）；
        // TTL 兜底：哨兵崩溃也不会把服务永久锁给别人（过期即视为空闲）。
        writeLease(dshHome, {
          owner: 'sentinel', atMs: Date.now(), ttlMs: LEASE_TTL_MS,
          note: 'hot-reload:' + basename(flagPath),
        })
        logEvent('生命周期租约：哨兵持有（ttl=' + String(LEASE_TTL_MS) + 'ms）——守护应让位')
        try {
          await restartWeb(workspace)
          await decideAndWake(info.sessionId)
          if (pendingFlagPath === flagPath) {
            // 2026-08-31 审计 M1：周期内哨兵被重新 touch——保留 flag，由 finally 重新调度下一轮（不丢弃新触发）
            logger.info('周期内哨兵被重新 touch，保留 flag 待下一轮: ' + flagPath)
            logEvent('周期完成（期间哨兵被重新 touch，flag 保留待下一轮）')
          } else {
            try { unlinkSync(flagPath) } catch { /* 已清理 */ }
            logger.info('哨兵已清理: ' + flagPath)
            logEvent('周期完成，哨兵已清理')
          }
        } finally {
          const rel = clearLease(dshHome, 'sentinel')
          logEvent('生命周期租约：哨兵释放（' + rel.why + '）')
        }
      } else {
        const { sid: notifySid } = await pickNotifySid(info.sessionId)
        const report = '[守护] 预检通过（' + new Date().toLocaleTimeString() + '）——有配置变更请求重启 web，需爱丽丝确认。\n\n【预检报告】\n' + (pf.output.slice(0, 800) || '(无明细)') + '\n\n确认重启：调用 daemon_restart(reason)（哨兵将覆盖，守护执行重启）。拒绝/暂不：哨兵保留，不动 web。'
        const delivered = notifySid ? await sendPrompt(notifySid, report) : false
        logEvent(delivered ? '预检报告已送达爱丽丝（' + notifySid + '），等待确认（哨兵保留）' : '预检报告发送失败（无目标会话），哨兵保留')
      }
    } catch (err) {
      logger.error('哨兵周期异常: ' + String(err))
    } finally {
      busy = false
      // 2026-08-31 审计 M1：周期内收到的新哨兵重新调度（不丢弃）
      if (pendingFlagPath !== null) {
        const p = pendingFlagPath
        pendingFlagPath = null
        if (!pendingTimer) {
          pendingTimer = setTimeout(() => {
            pendingTimer = null
            void runCycle(p)
          }, config.debounceMs)
        }
      }
    }
  }

  const onFlag = (flagPath: string) => {
    if (busy || pendingTimer) {
      // 2026-08-31 审计 M1：busy/pending 期间不丢弃，记录待 runCycle 结束后重跑
      pendingFlagPath = flagPath
      return
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      void runCycle(flagPath)
    }, config.debounceMs)
  }

  // ---------- 生命周期：监听哨兵 ----------
  const flagPaths = [
    ...(config.watchDirs.length > 0 ? config.watchDirs : (dshHome ? [dshHome] : [process.cwd()]))
      .map((d) => resolve(d, config.flagFile)),
    ...config.legacyFlags.map((f) => resolve(f)),
  ].filter((p, i, arr) => arr.indexOf(p) === i)

  const disposers: Array<() => void> = []
  for (const flagPath of flagPaths) {
    const dir = dirname(flagPath)
    const fname = basename(flagPath)
    try {
      const watcher = fsWatch(dir, (event, name) => {
        if (name && norm(String(name)) === norm(fname)) {
          onFlag(flagPath)
        } else if (!name && existsSync(flagPath)) {
          onFlag(flagPath)
        }
      })
      watcher.on('error', (err) => logger.warn('watch 错误 ' + dir + ': ' + String(err)))
      disposers.push(() => { try { watcher.close() } catch { /* 忽略 */ } })
      logger.info('监听哨兵: ' + flagPath)
    } catch (err) {
      logger.warn('无法监听 ' + dir + ': ' + String(err))
    }
    if (existsSync(flagPath)) {
      logger.info('发现遗留哨兵（启动前已存在）: ' + flagPath)
      onFlag(flagPath)
    }
  }

  ctx.effect(() => {
    logger.info('dsh-agent-sentinel 就绪：监听 ' + String(flagPaths.length) + ' 个哨兵路径，消费 ctx.preflight')
    return () => { for (const d of disposers) d() }
  })
}

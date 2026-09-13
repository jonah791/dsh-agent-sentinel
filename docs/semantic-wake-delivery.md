# 语义文档：唤醒与通知投递（Wake & Notification Delivery）

> 版本 v0.1 · 2026-09-13 · 作者：爱丽丝 · 状态：implemented（22 条验收：19 已取证 / 3 待线上验收）
> 开发方式：语义文档优先（先写清「是什么 / 什么关系 / 怎么裁决」，再让实现逼近，最后用实践回修）
> 主实现落点：`self-plugins/dsh-agent-sentinel/src/wake-target.ts`（裁决纯函数）+ `self-plugins/dsh-agent-sentinel/src/index.ts`（编排/投递/证据）
> 消费方落点：`self-plugins/dsh-agent-guardian/src/index.ts`（`notifyWebReady`，经 `ctx.sessionWaker` 可选消费）
> 上游锚点来源：`self-plugins/dsh-agent-plugin-manager/src/sentinel.ts`（写 `.hot-reload-flag`）
> 对应插件版本：`dsh-agent-sentinel` v0.1.1 / `dsh-agent-guardian` v0.1.1

---

## 1 · 元信息

| 字段 | 值 |
|------|-----|
| 能力名 | 唤醒与通知投递（wake-delivery）|
| 主副本 | 本文件（`self-plugins/dsh-agent-sentinel/docs/semantic-wake-delivery.md`）|
| 版本 / 状态 | v0.1 / implemented（3 条待线上验收，见 §7；pending 未归零不得晋升 verified）|
| owners | `dsh-agent-sentinel`（实现 + 服务提供方）、`dsh-agent-guardian`（消费方）|
| 对应插件版本 | sentinel v0.1.1、guardian v0.1.1（见各自 `package.json`）|
| 同语义副本（交叉指认）| `self-plugins/dsh-agent-guardian/docs/semantic.md`（守护侧文档写「唤醒」这一调用点与让位语义，本文写裁决与投递全链；两份不得平行维护同一条规则）|
| 租约语义 | **不在本文**：租约文件格式/裁决表/TTL/边界的主副本是 `self-plugins/dsh-agent-sentinel/docs/semantic.md`（条目 `web-lifecycle`）。本文只写「投递侧如何受租约约束」|
| 关联规则 | AGENTS.md §5.18（唤醒/通知投递纪律）、§5.19（单点所有权纪律）、§5.10 §3–§4（不静默 / 重试告警）、§5.2（watch 重启归主人）|
| 复核时间 | 2026-09-13 |

## 2 · 定位与反定位

**定位**：定义「一条提醒/通知如何落到**我此刻在的那个会话**」的端到端语义——
目标裁决（谁是用户会话、锚点什么时候还算数、腐化后投给谁）、候选换腿与重试上限、
失败分支（禁止静默放弃）、保活路径与哨兵路径如何共用同一实现、以及投递如何受
**web 生命周期单点所有权（租约让位）**约束。一句话：**投递不是「找得到会话就发」，是「裁决出唯一正当目标并留痕」。**

**反定位（本文不含什么）**：

- **不管租约本身**——租约文件格式、`decideLeaseGate` 裁决表、TTL、坏数据口径的主副本在 `web-lifecycle`（sentinel `docs/semantic.md`）。本文只写接管点：守护在「唤醒前」查租让位（§5.4）。
- **不管 web 进程生命周期**——kill/spawn/收养/预检 gate 归 `dsh-agent-sentinel`（协调）与 `dsh-agent-guardian`（保活）；本文只管「重启完成后那一条消息往哪投」。
- **不管 web 的就绪判定细则**——`/api/session/list` 的认证（browser-auth cookie）与 API 形态归 DSH 本体；本文只依赖「`result.ok === true` 即就绪」。
- **不管消息内容语义**——正文由调用方给（哨兵「web 已重启，请继续」/ 守护「web 已拉起」/ 预检报告）。
- **不是 IM / 不是推送系统**——没有队列、没有送达确认回执、没有重发窗口；投递是**一次编排内的尽力而为 + 证据留痕**。
- **不保证必达**——I3 优先级高于必达：候选不可用时**宁可不投**（返回 `ok=false` + 理由），也不投「看起来像会话」的东西。

## 3 · 术语表

| 术语 | 含义 |
|------|------|
| 用户会话（user session）| id 形如 `session-*` 且 `blank !== true` 的会话——可被人对话、可被 `session/prompt` 投递 |
| 派生会话（derived session）| 子代理/分身会话，id 是**裸 uuid**（如 `5bb40b68-…`）——不可 prompt，投递必然报错 |
| 空白会话（blank session）| `blank: true` 的会话（空壳），不作为投递目标 |
| 锚点（anchor / `explicitId`）| 调用方显式指定的目标会话 id；实源是 `.hot-reload-flag` 的 `sessionId` 字段（谁写哨兵谁给）|
| 新鲜度窗口（`anchorStaleMs`）| `DEFAULT_ANCHOR_STALE_MS = 600000`（10 分钟）——锚点相对滞后超过它即判腐化 |
| 锚点腐化（anchor rot）| 锚点的 `updatedAt` 比「最近活跃用户会话」落后**超过**阈值 → 不再采信锚点 |
| 候选排序（`ranked`）| 用户会话按 `updatedAt` 降序（`toMs` 归一后排序）|
| 尝试顺序（order）| `[首选, ...ranked 其余]` 截取前 **3** 个候选 |
| 换腿（failover）| 一个候选重试 5 次仍失败 → 换下一个候选，并**逐次留痕** |
| 静默放弃（silent give-up）| 失败后既不换候选、也不落证据/告警——**明令禁止**（§5.18 §3）|
| 投递（delivery）| 通过 web `/api/session/prompt`（`mode: 'steer'`）把文本塞进目标会话；成功判据 `result.ok === true` |
| 唤醒（wake）| 重启/拉起成功后投递「请继续」提醒（哨兵路径带锚点、保活路径无锚点）|
| 通知（notify）| 非唤醒类投递（预检报告 / 拦截告知）——共用同一裁决，但**无换腿**（见 U4）|
| 保活路径（keepalive path）| guardian 拉起 web 成功后经 `ctx.sessionWaker.wakeLatestSession` 投递 |
| 持租方 / 让位（hold）| 生命周期动作权的持有者 / 非持有者在「拉起前」「唤醒前」放弃动作权（语义见 `web-lifecycle`）|

## 4 · 概念模型与不变量

```
        ┌── 哨兵路径：.hot-reload-flag（note=daemon_restart:*）→ kill+spawn → decideAndWake(flag.sessionId)
触发源 ─┤
        └── 保活路径：guardian spawnWeb 成功后 notifyWebReady()（无锚点，先查租约）
                                   │
                                   ▼
      ① waitWebReady(readyTimeoutMs)  ── 未就绪 ──► ok=false「web 未在时限内就绪」
                                   │                 └─ 哨兵侧：incident + telegram
                                   ▼
      ② listSessions() → decideWakeTarget(sessions, explicitId, nowMs)   ← 纯函数，可注入时间
             ├─ 无用户会话 ─────────────► sid=undefined「不投递」（绝不误投）
             ├─ 无锚点 ─────────────────► 最近活跃用户会话 + 理由
             ├─ 锚点腐化/缺失/派生 ─────► 改投最近活跃用户会话 + 理由（含滞后分钟数）
             └─ 锚点新鲜（相对滞后≤10min）► 锚点 + 理由
                                   │
                                   ▼
      ③ order = [首选, ...ranked 其余].slice(0,3) → 逐个 sendPrompt（每个最多 5 次 × 3s）
             ├─ 成功 ──► ok=true, sessionId，落「已发送」行
             └─ 失败 ──► 落「换下一个候选」行 → 下一个；3 个全败 ──► ok=false + 候选清单
                                   │
                                   ▼
      ④ 失败分支：哨兵侧 incident + telegram 告警；守护侧证据行（不静默，但不发告警——见 U3）

  并行约束：守护在 ③ 之前查租约；他人持有且新鲜 → 跳过唤醒（由持租方唤醒，I7）
```

**不变量（invariants）**：

1. **I1 只有人能被投递**：投递目标必为「用户会话」（`session-*` 且非 blank）；派生会话永不入选候选。
2. **I2 锚点不是真源**：锚点只在**新鲜**时优先；腐化 / 不在列表 / 是派生会话 → 改投最近活跃用户会话，且理由必须落盘（「为什么改投」可回答）。
3. **I3 不误投优先于必达**：无正当候选时**不投递**（`ok=false` + 理由），不 fallback 到「看起来像会话」的对象。
4. **I4 不静默放弃**：每次裁决有理由行；每次换腿有失败行；每次整体失败有 `ok=false` 的 reason 与候选清单（哨兵侧再升 incident + telegram）。
5. **I5 就绪先行**：web 未在预算内就绪（`/api/session/list` 不返回 `result.ok === true`）→ 不投递。
6. **I6 单一实现**：唤醒只有一份实现 `ctx.sessionWaker`（sentinel 提供、guardian 可选消费）——两条路径不得各写一份（历史教训：拆分时能力丢失）。
7. **I7 一次生命周期动作只产生一条唤醒**：持租方唤醒、让位方不唤醒（租约语义主副本见 `web-lifecycle`）。
8. **I8 坏数据不锁死**：租约损坏 / 空 / 时钟偏移一律放行 + 落 issue 行；**不因坏数据停在半路**。

## 5 · 契约

### 5.1 输入与上游契约

| 输入 | 来源 | 语义 |
|------|------|------|
| `explicitId`（锚点）| `.hot-reload-flag` 的 `sessionId` 字段 | 由写哨兵者给：`dsh-agent-plugin-manager` 的 `daemon_restart` 工具（`note` 前缀 `daemon_restart:`）与 `triggerReload`；`dsh-panel` 的面板 `writeSentinel` 只写 `workspace` + `note`（**无锚点** → 走无锚点裁决）|
| `sessions` | web `/api/session/list`（`result.value.items`）| 每项投影 `{sessionId?, blank?, updatedAt?}`；`updatedAt` 秒或毫秒均可（`toMs` 归一）|
| `nowMs` | 调用时刻 | **只用于理由文本**（`ageText`）——不参与裁决判定，故裁决可离线注入时间做尸体测试 |
| `readyTimeoutMs` | sentinel 配置（watch profile 现值 `90000`）| 就绪等待预算 |
| `waitWebReadyMs` | 调用方可覆盖 | 同上（守卫/哨兵可各自收窄）|

### 5.2 裁决表（`decideWakeTarget`）

| 输入状态 | 结果 `sid` | 理由串形态 |
|---------|-----------|-----------|
| 无用户会话（列表为空 / 全是 blank / 全是派生）| `undefined` | `候选 N 条，但无「用户会话」（session-* 且非空白）——不投递` |
| 无锚点（`explicitId` 空）| 最近活跃用户会话 | `未指定锚点 → 投最近活跃用户会话（<距今>）` |
| 锚点在列表但**非用户会话**（blank / 派生）| 最近活跃用户会话 | `锚点 X 是空白会话/子代理会话（非用户会话）→ 改投最近活跃 Y` |
| 锚点不在列表 | 最近活跃用户会话 | `锚点 X 不在会话列表 → 改投最近活跃 Y` |
| 锚点存在且**相对滞后 > `anchorStaleMs`** | 最近活跃用户会话 | `锚点 X 已滞后 Nmin（>阈值 10min，锚点腐化）→ 改投最近活跃 Y` |
| 锚点存在且相对滞后 ≤ 阈值（含 ==）| **锚点** | `锚点新鲜（滞后 Ns），尊重显式指定` |

**语义注记**：滞后 = `toMs(最近活跃.updatedAt) − toMs(锚点.updatedAt)`，是**相对滞后**（相对最近活跃用户会话），**不是锚点的绝对年龄**——若最近活跃者本身已数小时无更新，锚点同样会被判「新鲜」（见 U5）。

### 5.3 纯函数与模块契约

| 符号 | 位置 | 契约 |
|------|------|------|
| `isUserSession(session) → boolean` | `src/wake-target.ts` | `sessionId.startsWith('session-') && blank !== true`（缺失字段一律 false）|
| `rankUserSessions(sessions) → SessionLite[]` | 同上 | 过滤非用户会话后按 `updatedAt` 降序；**唯一**的 `isUserSession` 消费点 |
| `toMs(value) → number` | 同上 | `> 1e12` 视为毫秒，否则按秒 ×1000；`undefined`/非有限 → `0` |
| `decideWakeTarget(sessions, explicitId, nowMs, {anchorStaleMs?}) → {sid, why, ranked}` | 同上 | 纯函数（无 IO、时间可注入）；`ranked` 为候选 id 序列（换腿用）|
| `pickNotifySession(sessions, nowMs) → {sid, why}` | 同上 | 等价「无锚点裁决」，通知通道专用 |
| `wakeLatestSession(text, {explicitId?, waitWebReadyMs?}) → WakeResult` | `src/index.ts` | 就绪等待 → 裁决（最多等 60s 出现候选）→ 最多 3 候选 × 各 5 次重试；`ctx.provide('sessionWaker', …)` 暴露 |
| `checkLeaseFor(dshHome, role, nowMs) → LeaseGate & {issue?}` | `src/lease.ts`（副本在 guardian）| 守护侧唯一让位查询入口；裁决表见 `web-lifecycle` 文档 |

### 5.4 调用点清单 `[MUST]`

| 路径 | 调用点（文件:符号）| 目标裁决 | 失败分支 |
|------|------------------|---------|---------|
| 哨兵重启唤醒 | `src/index.ts` `runCycle` → `decideAndWake(info.sessionId)`（仅在 `note` 前缀 `daemon_restart:` 分支）| 带锚点 | `ok=false` → `writeIncident` + `sendTelegram`（未就绪 / 未能唤醒两类分流）|
| 保活拉起唤醒 | `guardian/src/index.ts` `notifyWebReady()` ← `spawnWeb` 成功后（仅 `spawned !== null`）；首行查租约 | 无锚点 | 落证据行「拉起后唤醒未发送: <reason>（候选=[…]）」——**无 telegram**（见 U3）|
| 预检 FAIL 通知 | `src/index.ts` `runCycle` → `pickNotifySid(info.sessionId)` → `sendPrompt` | 同裁决（带锚点）| 无目标则不发（哨兵保留）|
| `daemon_restart` 被拦通知 | 同上（`readPreflightInvokedGate` 不过时）| 同裁决 | 同上 |
| 预检通过报告（待确认）| `runCycle` else 分支 → `pickNotifySid` → `sendPrompt` | 同裁决 | 落「预检报告发送失败（无目标会话），哨兵保留」|
| 服务暴露 | `src/index.ts` → `ctx.provide('sessionWaker', { wakeLatestSession })` | — | — |
| 服务消费（守护侧）| `guardian/src/index.ts` → `ctx.get('sessionWaker')`（**不进 `inject`**：缺席时保活不得被激活门挡住）| — | 缺席 → 证据行「跳过唤醒」，保活继续 |
| 租约让位（守护侧）| `guardian/src/index.ts` `notifyWebReady` 首行 + `spawnWeb` 入口 `checkLeaseFor(dshHome,'guardian',Date.now())` | — | `hold` → 跳过唤醒 / 抛弃拉起 + 理由行 |

> `isUserSession` 的**全部**调用点只有 `rankUserSessions`（全库 grep 无第二个消费者）——契约面窄是事实，值得在改动时保留（见 U6）。

### 5.5 证据面（外部可读契约）

| 落点 | 形状 | 语义 |
|------|------|------|
| `<DSH_HOME>/.watch-events.log`（追加行）| `唤醒目标裁决: <why> → 尝试顺序=[…]` / `唤醒决策: explicit=… 候选=[…] → <sid|未发送>` / `唤醒消息已发送: <sid>` / `唤醒未发送: <reason>` / `唤醒投递失败，换下一个候选: <sid>` / `通知目标裁决: <why>` / `拉起后唤醒已发送: <sid>` / `拉起后唤醒未发送: <reason>（候选=[…]）` / `生命周期租约: …` | 每次裁决与投递都可在日志里复原（I4）；候选列表整行落盘（体积问题见 U8）|
| `<DSH_HOME>/.watch-incident.json`（覆盖式快照）| `{at, message, …}` | 唤醒未能完成的上报（「未就绪」/「未能唤醒目标会话」）|
| `.dsh/.web-lifecycle-lease.json` | `{owner, atMs, ttlMs, note?}` | 让位判据；语义主副本见 `web-lifecycle` |
| web `/api/session/prompt` | `{mode:'steer', sessionId, content:[{type:'text',text}]}` | 投递通道；成功判据 `result.ok === true` |

## 6 · 边界与信任

- **能力边界 ≠ 沙箱**：投递是**协作式**的——它不认证、不授权、不隔离；它假设 web 与调用方同主同信任域（`/api` cookie 由 `DSH_HOME/.credentials.yaml` 的 browser-session secret 现算）。
- **不越界清单**：不 kill 任何进程；不改 web 组合；不投非用户会话；不夺他人租约（只释放自己的）；不替主人决定「要不要重启」；不改写 web 的就绪判据。
- **信任面**：候选列表来自 web；锚点来自写哨兵者——两者都可能陈旧，故裁决层只把锚点当**优先锚点**，把 `updatedAt` 当**活跃度证据**（相对量，非绝对时间）。

| 失败面场景 | 行为 |
|-----------|------|
| web 未在 `readyTimeoutMs` 内就绪 | 返回 `ok=false`；哨兵侧 incident + telegram；守护侧证据行 |
| 列表内无用户会话 | 等待至多 60s 轮询 → 仍无 → `ok=false`「不误投」 |
| 首选候选 3 个全失败 | `ok=false`（reason 含候选数与「各重试 5 次后放弃」）→ 哨兵侧 incident + telegram |
| 单个候选 `session/prompt` 抛错 | 计入该候选的 5 次重试；**不冒泡**（不影响后续候选）|
| 锚点腐化 / 不在列表 / 是派生会话 | 改投最近活跃用户会话 + 理由行 |
| 租约被他人持有（新鲜）| 守护跳过唤醒（由持租方唤醒）+ 理由行 |
| 租约坏数据（损坏/空/shape 非法/时钟偏移）| 放行 + `issue` 证据行（不静默、不死锁）|
| `sessionWaker` 服务缺席 | 证据行「跳过唤醒」，保活继续（不因唤醒缺失而停保活）|

## 7 · 可证伪验收清单

（每条都能被一次测量判真假；证据栏是判定依据——单测给文件名+用例名，线上给可复现命令与输出要点。）

| # | 可证伪命题 | 证据出处（测量方式）· 状态 |
|---|-----------|--------------------------|
| A1 | `isUserSession` 只认 `session-*` 且非 blank；裸 uuid / 空白 / 空对象一律出局 | ✔ `node --test tests/wake-target.test.mjs` → 10 pass / 0 fail，用例「isUserSession: 只认 session-* 且非空白（子代理裸 uuid 出局）」 |
| A2 | 无锚点时投最近活跃用户会话；若当时最新的是子代理会话必须被跳过 | ✔ 同文件尸体测试 B「不带锚点时，最新是子代理会话 → 必须跳过它投给我」（断言 `ranked` 不含裸 uuid）|
| A3 | 锚点相对滞后 63min → 判腐化并改投最近活跃，理由含「锚点腐化」 | ✔ 同文件尸体测试 A「钉住的旧锚点已滞后 63min → 改投最近活跃（我的会话），并给出理由」 |
| A4 | 阈值边界：滞后 == 10min 不改投；> 10min 才改投 | ✔ 同文件「锚点正好等于阈值 → 不判腐化（边界：> 才改投）」 |
| A5 | 锚点新鲜（滞后 2min）时尊重显式指定 | ✔ 同文件「锚点仍然新鲜（滞后 2min < 10min 阈值）→ 尊重显式指定」 |
| A6 | 锚点指向派生（子代理）会话 → 不采信并改投用户会话 | ✔ 同文件「锚点指向子代理会话 → 不采信，改投用户会话（并说明原因）」 |
| A7 | 列表里全是空白/派生会话时**不投递**（宁可失败也不误投）| ✔ 同文件「非空列表但全是空白/子代理 → 不投递（不再误投）」 |
| A8 | 通知通道与唤醒共用同一裁决（`pickNotifySession` = 无锚点裁决）| ✔ 同文件「pickNotifySession: 与无锚点裁决一致（守护/预检通道共用）」 |
| A9 | 秒/毫秒两种 `updatedAt` 量级都归一（否则排序会错乱）| ✔ 同文件「toMs: 秒/毫秒两种量级都归一到毫秒」 |
| A10 | 线上真实发生过锚点腐化并成功改投（不只靠单测）| ✔ `.dsh/.watch-events.log` 2026-09-13T03:01:10.448Z「锚点 session-89516696… 已滞后 793min（>阈值 10min，锚点腐化）→ 改投最近活跃 session-879c4ae1…」；通知路径 02:59:25.029Z 同款一条 |
| A11 | 锚点新鲜路径在线上生效（尊重显式指定）| ✔ 同日志 2026-09-13T03:20:31.356Z「锚点新鲜（滞后 0s），尊重显式指定 → 尝试顺序=[session-879c4ae1…, …]」 |
| A12 | 每次投递都留「为什么是这个目标」的理由行 | ✔ 同日志 `唤醒目标裁决:` 11 条 + `通知目标裁决:` 1 条（三类理由齐备：腐化改投 / 无锚点改投 / 新鲜尊重）|
| A13 | 线上投递目标从不为派生会话 | ✔ 同日志 `唤醒消息已发送: session-` 277 条 = `唤醒消息已发送` 总数 277；`拉起后唤醒已发送: session-` 23 条 = 总数 23（裸 uuid 命中 0）|
| A14 | 投递失败必留痕（不静默）| ✔ 同日志 `拉起后唤醒未发送:` 63 条（最近 2026-09-12T13:47:46.621Z，reason 含「发送失败（重试 5 次后放弃）」+ 候选列表）；哨兵侧 `唤醒未发送:` 64 条 |
| A15 | 事故形态可从日志复原：守护曾投给子代理会话（5bb40b68）后放弃 | ✔ 同日志 2026-09-12T13:47:46.621Z 该行首候选即 `5bb40b68-…`；同一时刻被选作单测时间基准（测试内 `NOW = 2026-09-12T13:47:46Z`）|
| A16 | web 未在时限内就绪时不投递并给出失败理由 | ✔ 同日志 `web 未在时限内就绪` 61 条；代码路径 `src/index.ts` `decideAndWake` 就绪分支落 incident + telegram |
| A17 | 唤醒失败在哨兵侧升级为 incident + telegram 告警 | 待线上验收：代码路径存在（`decideAndWake` 失败分流），但 incident 与 telegram 送达未逐条核对（线上 `唤醒未发送` 64 条 / `web 未在时限内就绪` 61 条，差额未见证据）|
| A18 | 首选失败后逐次换候选（最多 3 个）且每次留痕 | 待线上验收：代码路径存在（`src/index.ts` `wakeLatestSession`：`order = [sid, ...ranked].slice(0,3)`；失败 `logEvent('唤醒投递失败，换下一个候选: ')`），但**无单测**、线上该串命中 0（从未触发）——见 U1 |
| A19 | 租约裁决：他人持有 → 让位；过期 / 自持 / 无租约 → 放行 | ✔ `node --test tests/lease.test.mjs` → 17 pass / 0 fail，含 22:33 真实时刻表尸体样本（sentinel 22:33:13 取租 → guardian 22:33:35 查 → 必须 `hold`）|
| A20 | 坏租约（JSON 损坏 / 空 / shape 非法 / 时钟偏移）一律放行且留 issue，不锁死服务 | ✔ 同文件（`lease-json-invalid` / `lease-empty` / `clock-skew` 等分支各有断言）|
| A21 | 不得夺权：guardian 清不掉 sentinel 的租约；释放写「已释放」留痕而非删文件 | ✔ 同文件（`not-owner(current=sentinel)`；读回 `ttlMs=1` + `note=released-at-<ts>`）|
| A22 | 一次重启只产生一条唤醒（让位语义在线上生效）| 待线上验收：`.dsh/.watch-events.log` 中 `生命周期租约` 命中 **0**、`.dsh/.web-lifecycle-lease.json` **不存在** ⇒ live 未执行租约路径（watch PID 19000 启动 2026-09-12 22:14:05 < lib 构建 22:55:33；watch profile 虽配了 HMR（root=`E:/alice/self-plugins`），日志中未见其接管该构建），2026-09-13T03:20:31 双唤醒重现（哨兵 `.598` / 守护 `.888`）——见 U2 |

**验收计数**：total **22** / proven **19** / pending **3**（其中显式标「待线上验收」3 条，无「未标未证」项）。

## 8 · 与实现的关系

- **主实现（裁决层）**：`self-plugins/dsh-agent-sentinel/src/wake-target.ts`——纯函数、无 IO、时间可注入；本文 §5.2/§5.3 与之逐条对应。
- **主实现（编排层）**：`self-plugins/dsh-agent-sentinel/src/index.ts`——`wakeLatestSession`（就绪等待 / 裁决 / 换腿 / 证据）、`decideAndWake`（哨兵侧失败分流）、`pickNotifySid`（通知通道）、`ctx.provide('sessionWaker', …)`。文中「`src/index.ts`」均指此文件。
- **消费方**：`self-plugins/dsh-agent-guardian/src/index.ts` `notifyWebReady`（可选服务 + 让位；`spawnWeb` 成功后非阻塞调用）。
- **上游 producer**：`self-plugins/dsh-agent-plugin-manager/src/sentinel.ts`（写 `.hot-reload-flag`，契约 `{workspace, sessionId, note}`）；`dsh-panel` 的面板写哨兵只给 `workspace` + `note`。
- **同语义副本（双胞胎，互相指认）**：`src/lease.ts` ↔ `self-plugins/dsh-agent-guardian/src/lease.ts`——两侧各有单测守护一致性；**权威语义（文件格式/裁决表/TTL/边界）主副本在 `web-lifecycle`**（sentinel `docs/semantic.md`），本文只引用不复制。
- **交叉文档**：`self-plugins/dsh-agent-guardian/docs/semantic.md` 从守护视角写同一调用点（其 §5.4 唤醒行、A2、A10）；两份文档不得各自维护一份平行语义——有冲突以本文（投递裁决）与 `web-lifecycle`（租约）为准。
- **未实现 / 未验证（显式）**：
  1. **候选换腿循环无单测**（A18）：编排在 `apply()` 闭包内，未抽纯函数，故只能靠线上触发取证。
  2. **租约未在 live watch 进程生效**（A22）：lib 产物已含租约代码（`lib/index.js` 命中「生命周期租约」3 处），但 live 进程早于该构建启动（watch PID 19000 = 2026-09-12 22:14:05 < lib mtime 22:55:33；对照：裁决 v2 的线上首行出现在 14:14:31Z = 22:14:31 local，证明 v2 构建早于进程启动），且 HMR 未见接管 → 让位/取租在线上从未发生；需一次 watch profile 重启（§5.2 归主人）后复验。
  3. **守护侧唤醒失败无 telegram 升级**（U3）：只有证据行；哨兵侧有告警——两条路径的失败升级不对称。
  4. **源码注释漂移**（U7）：`src/index.ts` 中 `SessionWakerService` 接口注释仍写「`explicitId` 有值 → 只认它（未出现则轮询等待，绝不 fallback 到别的会话）」，与 v2 实现（腐化即改投）**相反**——本次只报不改。
- **测试入口**：`npm test` = `node --test "tests/*.test.mjs"`（跑 `lib/` 产物）。本次实测：`wake-target.test.mjs` 10/10、`lease.test.mjs` 17/17（WSL 侧 `node --test` 可跑通）。

## 9 · 实践修订记录

（I3：事故暴露的语义缺口当场回写。本节同时是这条防线的「事故史」。）

- **2026-08-27 拆分四件套 → 唤醒能力丢失**
  - 语义**被补充**：原 `dsh-agent-watch` 的「自动拉起后补齐唤醒」在拆分中**未迁移**，直到 2026-09-10 主人实测「重启后没收到提醒」才被发现。
  - 教训：**职责迁移要逐项核对能力清单**（唤醒 / 通知 / 告警 / 保活）——「新插件能跑起来」不是迁移完成的判据（§5.18 由来的前置）。
- **2026-09-10 唤醒提炼为服务（修复上述丢失）**
  - 语义**被修正**：唤醒从「哨兵周期私有」提炼为 `ctx.sessionWaker`，由 guardian 经 `ctx.get` 可选消费——从结构上消除「两条路径各写一份、改一处漏一处」。
  - 取证：`src/index.ts` 服务注释（2026-09-10 提炼）+ guardian `notifyWebReady` 注释。
- **2026-09-12 两次「重启提醒没发给我」→ 裁决 v2**
  - 语义**被修正**：① 哨兵用配置钉住的锚点（`session-89516696`）当唯一目标 → 投进我**不在的旧会话**还报「已发送」；② 守护保活路径投给「最近更新的非空会话」——当时最新的是**子代理会话**（`5bb40b68-…`）→ `session/prompt` 报错、重试 5 次后**静默放弃**。
  - 语义**被补充**：`isUserSession()` 过滤派生会话；锚点 10 分钟新鲜度判腐化；最多 3 候选依次重试；每次裁决写理由行（提交 `d273dd2`）。**共同根因**：「存在」被当成「活跃」，「最近更新」没排除不是给人用的会话。
  - 线上取证：2026-09-12T13:47:46.621Z「拉起后唤醒未发送: 发送失败（重试 5 次后放弃）（候选=[5bb40b68-…」= 事故现场；2026-09-13T03:01:10.448Z 腐化改投成功 = 修复生效。
- **2026-09-12 双重重启事故 → 生命周期租约（投递侧接上让位）**
  - 语义**被补充**：一次重部署触发两次重启 + 两条唤醒（哨兵与守护都在管 web 生命周期，无互斥交接）。修法：落盘租约（`owner/atMs/ttlMs`，TTL 120s）；哨兵取租前置于 `restartWeb`、`finally` 释放；守护在 `spawnWeb` 入口与 `notifyWebReady` 两处让位（提交 sentinel `607ca00` / guardian `1a0a1ed`）。
  - 语义**被修正**：唤醒的归属从「谁拉起谁发」改为「**持租方发**，让位方不发」——一次生命周期动作只产生一条唤醒（本文 I7）。
  - 线上取证（当时）：`.dsh/.watch-events.log` 22:33 序列两条唤醒（哨兵 + 守护各一条）；统计口径见 `docs/rulebook.md` §5.19。
- **2026-09-13 本文首次成文（实践回修）+ 三个新发现**
  - 语义**被确认**：裁决 v2 的六类输入 → 结果映射与实现一致；线上 277 + 23 次投递全部落在 `session-*`，无一例派生会话。
  - 语义**被补充**：新增「锚点是相对滞后而非绝对年龄」的注记（§5.2）、「`nowMs` 不参与判定」的纯函数纪律、通知通道**无换腿**的不对称（U4）、守护侧失败**无 telegram 升级**的不对称（U3）。
  - 语义**被修正（发现的缺口）**：租约修复**尚未在 live watch 进程生效**——lib 已构建（2026-09-12 22:55:33）但 watch 进程启动于 22:14:05（对照：裁决 v2 的线上首行在 14:14:31Z，即 v2 构建早于该启动），HMR 亦未见接管；2026-09-13T03:19:56 哨兵周期（`周期完成，哨兵已清理` = 已确认分支）**零**「生命周期租约」行，03:20:31 双唤醒重现。记为 A22 + U2，处置需主人重启 watch profile（§5.2）。

## 10 · 未决问题

- **U1 换腿循环要不要抽纯函数 + 补单测？** 现逻辑内联在 `apply()` 闭包（`wakeLatestSession`），是 A18 无法离线取证的根本原因。倾向：抽出 `selectAttemptOrder(decision, max)` 与 `decideAfterCandidateFailure(attempts)` 两个纯函数，配尸体测试（喂「首选 5 次失败 → 必须换第二个」与「3 个全败 → 必须 ok=false」）。
- **U2 租约修复何时真正上线？** watch 进程早于 22:55 构建启动 → 取租/让位在线上从未执行（A22 判定为未生效）。需要一次 watch profile 重启（§5.2 归主人），并配一条最小验收：重启后首个哨兵周期必须出现「生命周期租约：哨兵持有 / 释放」两行 + `.dsh/.web-lifecycle-lease.json` 落盘。**附带裁决**：watch profile 配了 HMR（root=`E:/alice/self-plugins`）却未见它接管这次重建——若 HMR 本应生效，那是与租约无关的第二个缺口，需单独定性（HMR 是否只接管 `src` / 是否要求插件声明热重载能力）。
- **U3 守护侧唤醒失败要不要升级为告警？** 现只落证据行（哨兵侧有 telegram）。补告警需与哨兵侧**去重**（同一事故两条告警 = 狼来了），倾向：由 sentinel 侧统一告警，guardian 侧只留证据行——但要把这条不对称**写进规则**而不是留在代码里。
- **U4 通知通道要不要与唤醒统一换腿？** `pickNotifySid` 单目标 + `sendPrompt` 5 次失败后只落一行（线上 `预检报告发送失败` 4 条 / `预检报告已送达` 37 条）。预检报告丢失的后果与唤醒不同（主人看不到就不知道要确认），倾向：至少升级为 telegram 告警。
- **U5 新鲜度是「相对滞后」而非「绝对年龄」**：若最近活跃用户会话本身已 N 小时无更新（长时间无人交互），锚点同样被判「新鲜」→ 仍会投给一个可能没人在看的会话。是否引入「绝对年龄上限」（如候选 `updatedAt` 距今 > 12h 则改发 telegram 而不投会话）？
- **U6 用户会话判据靠 id 前缀是否够？** 若宿主改名，或派生会话改用 `session-` 前缀，`isUserSession` 会**静默失效**（线上表现为又投给不可 prompt 的对象）。是否需要第二判据（如 `delegationDepth === 0` / 会话 header）并在不一致时告警？
- **U7 源码注释漂移未修**：`self-plugins/dsh-agent-sentinel/src/index.ts` 的 `SessionWakerService.wakeLatestSession` 文档注释仍描述旧行为（「只认它…绝不 fallback」），与 v2 实现相反。本次只报不改——需一次 sentinel 改动窗口同步注释与构建。
- **U8 证据日志无轮转**：`.dsh/.watch-events.log` 现 11,492 行，且「候选列表」整行落盘（单行可达数 KB，实测单行数百至数千字符）。是否需要「候选只记前 3 个 + 总数」以压体积（代价：失去完整现场）？
- **U9 锚点来源不统一**：写哨兵者有三处形态（plugin-manager `daemon_restart`（带会话 id + `daemon_restart:` 前缀）、plugin-manager `triggerReload`、dsh-panel 面板（**不带** id）），历史上还有配置钉住的 `mainSessionId` 流入。裁决层已兜住腐化锚点，但「上游该不该写锚点、写谁」尚无成文契约——是否统一为「只写当前会话，否则不写」？

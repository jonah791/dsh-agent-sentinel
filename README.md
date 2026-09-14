<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 哨兵（热重载协调员）——监听哨兵文件 .hot-reload-flag → 调预检门控（ctx.preflight.run）→ 取生命周期租约 → kill+spawn web → 等就绪 → 唤醒目标会话 → 清哨兵；预检失败则保留哨兵 + 落盘 incident + 通知（fail-closed）
  inject: 'preflight','agentRuntime','webman'
  tools: （无）—— 纯守护进程，无工具面
  runtime: host-only（watch profile）
  envDeps: 同 profile 内的 dsh-agent-preflight（预检服务）· dsh-agent-runtime（环境发现 + 进程原语）· 可选：telegramBotToken/telegramChatId（事故告警）· 可选 http 代理（告警通道）· DSH_HOME 可写
  boundary: **只协调重启，不保活**（拉起是 guardian 的职责）· 同一资源的生命周期只允许一个 owner（租约互斥，TTL 120s）· **本插件所在 watch profile 的重启归主人执行**——开发者可改码/构建/测试，不得自行 kill 或重启守护进程
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1
-->
# dsh-agent-sentinel

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-sentinel"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-56%20passed-brightgreen" alt="tests">
</p>

**一句话**：**热重载的协调员**——监听到哨兵文件就按固定顺序走一遍「预检 → 取租约 → 停旧实例 → 起新实例 → 等就绪 → 唤醒会话 → 清哨兵」，任何一步不过就**停手留档**，绝不盲重启。

**为什么值得用**：改完代码重启，是这套体系里**唯一不可逆**的动作——重启前的实例已经在跑，重启后的实例没人验证过。没有协调员的「热重载」实际是**赌博**：坏组合一装上去就是服务不可用 + 守护熔断。本插件把「验证」「互斥」「留痕」「唤醒」串成一条**fail-closed 的流水线**：预检 FAIL 就保留哨兵、落盘 incident、通知会话并等修复后重试——**旧实例毫发无伤**。

## 能力

本插件**无工具面**，它对外的能力是「被哨兵文件触发的一段流程」：

| 步骤 | 做什么 | 失败时 |
|------|--------|--------|
| ① 监听 | `fs.watch` 监听 `watchDirs` 下的哨兵文件（`.hot-reload-flag` 及 `legacyFlags`）；`debounceMs` 去抖 | — |
| ② 预检 | `ctx.preflight.run(workspace, 'full')`（消费 `dsh-agent-preflight`） | **保留哨兵** + 落盘 incident + 通知「免疫层拦截，修复后 touch 重试」 |
| ③ 取租约 | 写 `<DSH_HOME>/.web-lifecycle-lease.json`（owner=`sentinel`，TTL 120s） | 他人持租则**让位**（落一行理由） |
| ④ 重启 | `ctx.webman.killWeb(portOwner)` → `ctx.webman.spawnWeb(workspace)` | 通知告警；不重复拉起 |
| ⑤ 等就绪 | 轮询 `baseUrl` 至 ready（`readyTimeoutMs`） | 告警「web 重启后未在时限内就绪——请检查 web 启动日志」 |
| ⑥ 唤醒 | 选目标会话投递唤醒（`session-*` 用户会话优先；显式锚点滞后 > 10 分钟判**锚点腐化** → 改投最近活跃用户会话） | 告警「已重启但未能唤醒目标会话」+ 候选列表 |
| ⑦ 清哨兵 | 删除哨兵文件 + 释放租约（写「已释放」留痕） | 留痕不静默 |

另外它还承担一道**门控**：拦截「本 web 进程内未通过预检闸门」的 `daemon_restart` 请求（判据读 `<DSH_HOME>/.preflight-invoked.json`，进程级，不比对会话 id），提示先做预检再重启。

职责分工：**sentinel 协调重启 / preflight 把关 / guardian 保活**——三者的能力边界不得互相吞并。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在 watch profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-sentinel": "link:<工作区>/self-plugins/dsh-agent-sentinel"
```

**2) 构建**：

```bash
cd self-plugins/dsh-agent-sentinel && npm install && npm run build && npm test
```

**3) 挂组合**（**watch** profile；`inject` 要求同侧存在 `preflight` / `agentRuntime` / `webman` 三个服务）：

```yaml
- id: agent-sentinel
  name: dsh-agent-sentinel
  config:
    profile: web
    port: 3080
    watchDirs: ["<工作区>"]
```

**4) 30 秒验证**：

```bash
# ① 结构性验证（不重启任何东西）：插件装载证据 + 事件日志尾部
tail -3 "$DSH_HOME/.watch-events.log"
# ② 行为验证（**会真的重启 web**，确认当前无人在用时再做）：
#    按开发流程写哨兵文件：改代码 → 构建 → 测试 → 写哨兵
printf '{"workspace":"<工作区>","sessionId":"session-<id>","note":"readme 验证"}' > "$DSH_HOME/.hot-reload-flag"
tail -8 "$DSH_HOME/.watch-events.log"
# 期望顺序：预检 PASS → 取租约 → kill/spawn → web 就绪 → 已唤醒会话 → 哨兵已清
ls -l "$DSH_HOME/.hot-reload-flag"       # 期望：文件已被删除（清哨兵成功）
```

## 配置

（键名与 `src/index.ts` 的 `Config` schema 一致；默认值取自源码）

| 项 | 默认 | 说明 |
|----|------|------|
| `dshHome` | `$DSH_HOME`（空串则回退进程 cwd） | 哨兵文件/日志/租约/incident 的根 |
| `watchDirs` | `[]` | `fs.watch` 监听的目录列表（哨兵文件所在目录，通常是工作区） |
| `flagFile` | `.hot-reload-flag` | 哨兵文件名 |
| `legacyFlags` | `[]` | 兼容的旧哨兵文件名（可多个） |
| `bin` | `''`（交给 runtime 发现） | `dsh bin.js` 路径覆盖 |
| `profile` | `web` | 重启目标 profile |
| `port` | `3080` | web 端口（查端口归属 / 判活） |
| `baseUrl` | `http://127.0.0.1:3080` | 就绪探活基址 |
| `readyTimeoutMs` | `30000` | 重启后就绪等待上限 |
| `incidentFile` | `''`（回退 `$DSH_HOME/.watch-incident.json`） | 事故落档路径 |
| `defaultWorkspace` | `''`（回退进程 cwd） | 默认工作区 |
| `debounceMs` | `300` | 哨兵文件事件去抖（编辑器写文件会触发多次事件） |
| `launchCmd` | `[]` | 启动命令覆盖（交给 runtime） |
| `telegramBotToken` | `''` | 事故告警 bot token（**只在组合 patch 里配，不进源码**） |
| `telegramChatId` | `''` | 事故告警目标 chat（同上） |
| `httpProxy` | `http://127.0.0.1:16888` | 告警通道代理 |

## 落盘与自证（出问题时先看这里）

本插件**不写 `*-trace.jsonl` 阶段轨迹**，它的自证是**一组状态文件 + 一行行事件日志**：

| 文件 | 谁写 | 内容 |
|------|------|------|
| `<DSH_HOME>/.hot-reload-flag` | **调用方**（人/agent） | 哨兵本体：`{ workspace, sessionId, note }`。被成功处理才删除——**它在 = 这次热重载没完成** |
| `<DSH_HOME>/.watch-events.log` | 本插件 | 事件行（append）：预检结果 / 租约取得与让位 / 重启 / 就绪 / 唤醒结果 / 哨兵清理。**这是主要的人类可读时间线** |
| `<DSH_HOME>/.watch-incident.json` | 本插件 | 事故落档（覆盖写）：`{ at, ...detail }`——预检失败等重大异常的结构化记录 |
| `<DSH_HOME>/.web-lifecycle-lease.json` | 本插件（与 guardian 共用的同一份契约） | 生命周期租约：`{ owner, atMs, ttlMs, note? }`。TTL 120s；释放写「已释放」留痕而非删文件 |
| `<DSH_HOME>/.sentinel-web-start.json` | 本插件 | `{ atMs, workspace, pid }`——本次 web 的启动时刻与 pid。**「构建产物 vs 生效」判据的取证面** |
| `<DSH_HOME>/.preflight-invoked.json` | `dsh-agent-plugin-manager` | **只读**输入：`daemon_restart` 门控据此判断「本 web 进程内是否调用过预检」 |

**一条命令答五问**：

```bash
tail -12 "$DSH_HOME/.watch-events.log"; echo ---; cat "$DSH_HOME/.sentinel-web-start.json"
# ① 跑的是哪个构建  → 本插件不写 build 自报；用 .sentinel-web-start.json 的 atMs（web 启动时刻）对比 lib/index.js 的 mtime——**产物 mtime 晚于启动时刻 = 新构建还没生效**
# ② 谁发起          → 哨兵文件里的 workspace/sessionId/note（触发者留的信）；事件行记录"谁来唤醒/投给谁"
# ③ 断在哪一段      → 事件行序列即断点：只有"预检…"无后续 = 卡在门控；有 kill 无 spawn = 卡在拉起；有 spawn 没就绪 = 卡在等待；就绪了没唤醒 = 卡在会话选择
# ④ 结果质量        → 是否出现"哨兵已清"（成功收口）；告警行文案区分「未就绪」与「已重启但未唤醒」（+候选列表）
# ⑤ 耗时与预算      → 就绪等待对比 readyTimeoutMs(30000)；租约 ttlMs=120000；debounceMs=300（去抖）
```

> **读日志的正确姿势**：`.watch-events.log` 是 append-only 的时间线，**最后一行才是当前状态**。哨兵文件仍存在 + 最后一行是预检 FAIL = 免疫层正确拦下（不是故障，是设计）；哨兵文件仍存在 + 最后一行是「等待确认」= 报告已送达，等人工放行。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. **产物 vs 进程**（本插件最可靠的一条）：`<DSH_HOME>/.sentinel-web-start.json` 的 `atMs` **晚于** `lib/index.js` 的 mtime ⇒ 当前守护进程加载的是这个构建。反之（产物比启动新）⇒ **改了代码但没重启守护，改动未生效**；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回的 `liveNow` 含本插件 ⇒ 同上；
3. 行为级：写哨兵文件后 `.watch-events.log` 出现新的预检/重启/唤醒行 ⇒ 监听与流程都在工作。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。**watch 侧没有 `hasUnverifiedBuilds()` 类兜底**（web 侧有），所以守护侧的「构建完没重启」是最容易漏的一类失效：改动躺在磁盘上，机制照旧跑旧代码。

**回退**（三档）：

- 源码级：`git -C self-plugins/dsh-agent-sentinel revert <commit>` → `npm run build` → `npm test` → （由主人）重启 watch profile；
- 组合级：在 watch profile 给 `agent-sentinel` 行加 `disabled: true`（或移除该行）→ 由主人重启 watch profile；
- 运行期：删除残留哨兵文件 `rm "$DSH_HOME/.hot-reload-flag"`（= 主动放弃这次热重载，仓库保持旧代码运行）；事件日志/incident 可随时归档。

> **部署边界（守护族硬约束）**：本插件运行在 **watch profile**，而 **watch 侧的更新与重启由主人执行**——改代码、构建、跑测试、出报告都归开发者；**kill / 重启守护进程不归开发者**（守护链是最后一道托底，自己把自己杀掉会让整个体系在无人接管时停摆）。同理，本插件负责重启的是 **web 实例**，不是它自己所在的守护进程。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，需先 npm run build）
```

**56 例离线测试全部通过**（`# pass 56 / # fail 0`，8 个 suite）：

| 文件 | 覆盖 |
|------|------|
| `tests/lease.test.mjs` | 生命周期租约（单点所有权）：无租约放行、坏时钟/时钟偏移放行 + 落盘 issue、过期接管、自持放行、他人持有时**让位**且理由里带 holder/age/remaining/note；**尸体测试用真实时刻表**（事故当刻：一方取租 → 另一方巡检必须让位）+ 过期接管样本 |
| `tests/wake-target.test.mjs` | 唤醒目标选择：`isUserSession` 判据（`session-*` 前缀且非空白——子代理裸 uuid **不可**唤醒）、按最近活跃降序排名、显式锚点新鲜度（滞后 > `DEFAULT_ANCHOR_STALE_MS` 10 分钟判腐化 → 改投最近活跃用户会话）、`updatedAt` 秒/毫秒归一化、候选列表逐次换人留痕 |
| `tests/preflight-gate.test.mjs` | `daemon_restart` 门控判据：本进程内已调用预检 → 放行；未调用 / 调用早于进程启动 → 拦截并给出理由（**进程级**判据，不比对会话 id） |
| `tests/alert-transport.test.mjs` | 告警传输：走 Node 子进程 `fetch`（`NODE_USE_ENV_PROXY=1`）主通道，`curl.exe -x <proxy>` 为兜底；**每条结论都落盘**（发送中／送达通道／失败原因）——不允许「告警发没发出去事后无法回答」 |

**可能需要网络/真实外部依赖**：仅**告警通道**（Telegram）需要真实 token + 网络/代理；测试用桩覆盖，不真发消息。其余全部离线（文件系统 + 纯函数）。

## 设计要点

- **fail-closed 是全部意义**：预检 FAIL ⇒ 保留哨兵、不 kill 旧 web。旧实例可能有毛病，但它是**在跑**的；新实例没验证过。**判据不是"能不能起来"，而是"能不能加载完"**（见 `dsh-agent-preflight` 的 grace 窗口）。
- **单点所有权用落盘租约，不用内存锁**：重启与保活是两个进程，内存锁跨不了进程。租约必须带 **TTL（120s）**——发起者崩溃不得把资源永久锁死；坏数据（损坏/时钟偏移）一律**放行 + 落盘 issue**，不静默也不死锁；让位必须写理由（否则下次事故仍回答不了「为什么多发了一条唤醒」）。
- **唤醒目标是「用户会话」而非「最近更新的会话」**：子代理会话是裸 uuid、不可 prompt，且「最近更新」常常就是它。判据严格取 `session-*` 前缀且非空白；显式锚点只在**新鲜**（≤10 分钟）时优先，滞后即判腐化并改投——**锚点是锚点，不是真源**。
- **`curl.exe` 不能用来发告警**：实测经代理 CONNECT 成功但 TLS 必失败（`exit 35`，`-k` / `--http1.1` / `--tlsv1.2` 各变体同样失败），同代理下 Node `fetch` 正常。这条是环境事实，不是偏好。
- **告警不许静默失败**：任何「本应发生但没发生」的分支都要落盘（`if (!token || !chat) return` + 空 `on('error')` 是反模式）——**静默失败是死亡温床**。
- **模型可见 ⟺ 已记录**：唤醒/通知走会话事件（`session/prompt`），不搞私有投递通道，否则「投过没有」无法从日志重建。
- **`.sentinel-web-start.json` 是刻意保留的取证面**：它让「这次重启之后，跑的是哪个产物」变成一条 `cat` 能回答的问题——构建 vs 生效的判据就是它。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `guardian-lifecycle` / `guardian-robustness-audit` / `preventive-lifecycle` / `plugin-maintainability` | 守护型进程的安全替换（先新后旧 / 验证再杀）、守护链健壮性审计清单、预防性存活、可维护性五问 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。

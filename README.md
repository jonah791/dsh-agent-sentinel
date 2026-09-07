# dsh-agent-sentinel

> 哨兵插件：监听热重载信号 → 预检门控 → 重启 web → 唤醒会话。
> DeepSeek Harness 自研插件 · v0.1.1（从 dsh-agent-watch 拆分）

## 定位

**热重载的协调员**：监听哨兵文件（`.hot-reload-flag`）触发重启流程，但每一步都有门控——预检不过就停手留档，绝不盲重启。

## 功能特性

- **监听哨兵文件**：检测 `.hot-reload-flag`（含 workspace + sessionId + note）
- **预检门控（fail-closed）**：触发时调用沙盒预检（`ctx.preflight.run`，消费 dsh-agent-preflight 服务）——通过才重启
- **重启 + 唤醒**：重启 web 后自动唤醒目标会话（回传执行结果）
- **失败留档**：预检失败则保留哨兵 + 落盘 incident + 通知，可排查后重试
- **设计原则**：借鉴「编辑前需要阅读」——重启前必须预检

## 安装

```bash
git clone https://github.com/jonah791/dsh-agent-sentinel.git self-plugins/dsh-agent-sentinel
cd self-plugins/dsh-agent-sentinel && pnpm install && pnpm build
```

挂载到 watch profile（与 preflight / guardian / runtime 协作）。

## 使用

- **触发方式**：写 `.hot-reload-flag` 文件（插件开发流程：改代码 → 构建 → 测试 → 写哨兵 flag）
- **自动完成**：预检 → 重启 → 唤醒 → 清哨兵，全程无需人工干预
- **失败处理**：预检失败保留 flag + incident 落盘，修复后重试

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `flagPath` | DSH_HOME/.hot-reload-flag | 哨兵文件路径 |
| `profile` | web | 重启目标 profile |

## 技术要点

- **fail-closed**：预检失败不 kill 旧 web——守护协议 v2 核心（2026-08-27 主人定调）
- **唤醒协议**：重启后唤醒目标会话，保证热重载不丢上下文
- 三插件分工：sentinel 协调重启 / preflight 把关 / guardian 保活

## License

MIT
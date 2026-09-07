# dsh-agent-sentinel

哨兵插件（从 dsh-agent-watch 拆分）：监听哨兵文件（.hot-reload-flag）→ 触发时调用沙盒预检（ctx.preflight.run，消费 dsh-agent-preflight 服务）→ 通过才重启 web → 唤醒目标会话 → 清哨兵；预检失败则保留哨兵 + 落盘 incident + 通知（fail-closed，借鉴「编辑前需要阅读」——重启前必须预检）。

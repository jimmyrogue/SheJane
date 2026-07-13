# SheJane 路线图

## 当前产品边界

SheJane 首先是独立的 Desktop Agent Harness：

- Desktop 只连接 Runtime；
- Runtime 拥有任务、对话、模型供应商、工具、MCP、Skills、工作区和持久状态；
- Go Cloud 与 Admin 是可选服务，不是本地 Harness 的启动条件；
- 远程能力只能通过标准模型供应商或 MCP 接入，不能恢复产品私有 Gateway。

## 已完成

- Monorepo 目录拆分：`apps/`、`services/`、`packages/`、`tests/`、`infra/`。
- pnpm 11.7 工作区和唯一根锁文件。
- 公共 `@shejane/runtime-client`，包含命令、SSE、快照、错误与生成协议类型。
- Desktop Web Agent、云账号、计费和云文档路径删除。
- Runtime Go 模型网关、Cloud 会话和 Cloud 工具网关删除。
- Runtime BYOK 供应商与操作系统凭据存储。
- Runtime 高级默认设置进入 SQLite/API。
- Runtime、Desktop、Cloud、Admin 和 Runtime SDK 独立发布工作流。
- 模块化环境配置；Desktop、Runtime、SDK 和 Admin 默认零环境变量。

## 当前优先级

1. 完成真实 Runtime HTTP 契约测试，覆盖认证、命令、SSE 重连、快照和等待决定。
2. 增加真实 BYOK“模型 → 工具 → 模型”离线 Cloud 验证。
3. 继续收敛 Runtime 状态所有权，减少 Desktop 的本地投影兼容代码。
4. 完善 Runtime 安装包、Desktop Runtime 锁定和跨平台发布验证。
5. 审计第三方依赖、许可证、签名、SBOM 和供应链安全。

## 后续方向

- 移动端先作为 Remote Client，连接用户自己的 Runtime。
- 远程 Runtime 服务必须是独立产品和独立安全边界。
- 需要新能力时优先使用 MCP、Skills 或标准供应商接口。
- 不预建移动端、远程网关或托管 Runtime 空目录。

## 明确不做

- 不恢复 Web Agent。
- 不要求用户登录 SheJane Cloud 才能使用 Desktop。
- 不由 SheJane Cloud 默认提供模型服务。
- 不把 Runtime 直接暴露到公网。
- 不在 Desktop 或 Runtime 恢复 Auto、fast/deep 或 Go Cloud 模型目录。

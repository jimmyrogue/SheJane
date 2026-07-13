# SheJane Monorepo 模块边界

本文记录当前仓库边界。实际执行链路以 [`run-loop.md`](./run-loop.md) 为准；Runtime 阶段编号只由
[`harness-runtime-stages.md`](./harness-runtime-stages.md) 定义。

## 目标目录

```text
apps/
  desktop/                 Electron 桌面客户端
services/
  runtime/                 Python Harness Runtime
packages/
  runtime-client/          公共 TypeScript Runtime SDK
tests/
  e2e/
scripts/                   跨模块开发与发布脚本
```

不为移动端、远程网关或托管 Runtime 创建空目录。根 `Makefile` 继续作为统一命令入口。

## 所有权与依赖

- Desktop 只依赖 Runtime SDK 和 Runtime HTTP 协议。
- Runtime 独立拥有任务、对话、供应商、工具、MCP、Skills、工作区和持久状态。
- Runtime SDK 不依赖 Electron、React、IndexedDB 或任何 SheJane 产品界面类型。
- 未来模型中转通过标准供应商接口接入，业务平台通过标准工具或 MCP 接入。

## 工具链

- JavaScript 使用 `pnpm@11.7.0` 和根工作区锁文件。
- Python Runtime 使用 uv。
- 目录迁移与行为删除分开提交，每个提交都必须保持相关模块可测试、可构建。
- 不保留旧目录软链接或第二套命令入口。

## 配置所有权

- 根目录不拥有 `.env`。
- Desktop、Runtime 和 Runtime SDK 默认不要求用户环境变量。
- Desktop Main 负责托管 Runtime 的地址、端口和配对凭证；Runtime 用户设置通过 Runtime API 保存。
- Runtime 非密钥设置进入 SQLite，供应商密钥进入操作系统凭据库。

## 版本与发布

模块使用独立版本和标签：

- `runtime-vX.Y.Z`
- `desktop-vX.Y.Z`
- `runtime-client-vX.Y.Z`

Runtime 发布 macOS arm64/x64、Windows x64 和 Linux x64 自包含产物。Desktop 显式锁定
一个 Runtime 版本，正式打包下载对应产物，本地开发运行当前源码。

## 兼容纪律

目录重组没有改变 `/local/v1`、持久命令、事件游标、检查点和 SQLite 数据格式。Desktop 已删除
Web Agent、云账号、计费和云文档路径；Runtime 已删除专用 Cloud 会话、Go 模型网关和 Cloud 工具网关。
旧 Cloud 与 Admin 架构只保存在 [`history/cloud-admin-architecture.md`](./history/cloud-admin-architecture.md) 和 Git 历史中。

## 行为修改的阶段记录

以下记录只引用 [`harness-runtime-stages.md`](./harness-runtime-stages.md) 的阶段编号，不建立第二套编号。

| 修改批次 | 主要阶段 | 直接上游 | 直接下游 | 状态所有者 | 替换的旧路径 |
|---|---|---|---|---|---|
| Desktop 只连接 Runtime | P1 | Electron Main 启动与连接配置 | P2 幂等命令 | Desktop 连接控制器与 Runtime 会话 | 浏览器 Cloud Agent、Cloud 失败回退、用共享环境变量启动 daemon |
| 公共 SDK 与待投递命令 | P2 | P1 已认证会话 | P3 命令接纳、P4 快照与变化 | 客户端只拥有未确认命令；Runtime 拥有已接纳命令 | Desktop 私有 HTTP、命令与 SSE 类型 |
| Runtime 权威对话投影 | P4 | P3 已持久化命令和资源 | P5 作业领取 | Runtime 快照与变化；Desktop 只保存游标和临时投影 | Desktop 本地聊天记录作为权威状态、Cloud 对话来源标记 |
| Runtime 设置与模型供应商 | P3.4 | P3.2 请求校验、P3.3 幂等检查 | P3.5 原子提交 | Runtime SQLite 设置和供应商凭据引用 | Desktop 本地高级默认值、Go Cloud 模型目录和 Auto 解析 |
| 模型与工具资源绑定 | P6 | P5 冻结的执行上下文 | P7 LangGraph 启动或恢复 | 本次执行上下文与不可变 Agent 定义 | 专用 Go LLM Gateway、Cloud Tool Gateway 和 Cloud 会话 |

每个后续行为提交仍须在修改前从 P1 到 P12 扫描，并在实现说明中记录同样五项信息。

# SheJane Monorepo 模块边界

本文记录当前仓库边界。实际执行链路以 [`run-loop.md`](./run-loop.md) 为准；Runtime 阶段编号只由
[`harness-runtime-stages.md`](./harness-runtime-stages.md) 定义。

## 目标目录

```text
apps/
  desktop/                 Electron 桌面客户端
  admin/                   Go Cloud 管理后台
services/
  runtime/                 Python Harness Runtime
  cloud/                   可选 Go Cloud
packages/
  runtime-client/          公共 TypeScript Runtime SDK
tests/
  e2e/
infra/
  cloud/                   Cloud Compose、Caddy 和部署配置
scripts/                   跨模块开发与发布脚本
```

不为移动端、远程网关或托管 Runtime 创建空目录。根 `Makefile` 继续作为统一命令入口。

## 所有权与依赖

- Desktop 只依赖 Runtime SDK 和 Runtime HTTP 协议，不依赖 Go Cloud。
- Runtime 独立拥有任务、对话、供应商、工具、MCP、Skills、工作区和持久状态。
- Go Cloud 完整保留为可选服务，但不能成为 Desktop 或 Runtime 的启动条件。
- Admin 只管理 Go Cloud，不进入 Desktop 构建。
- Runtime SDK 不依赖 Electron、React、IndexedDB 或任何 SheJane 产品界面类型。
- 未来模型中转通过标准供应商接口接入，业务平台通过标准工具或 MCP 接入。

## 工具链

- JavaScript 使用 `pnpm@11.7.0` 和根工作区锁文件。
- Python Runtime 继续使用 uv；Go Cloud 继续使用 Go Modules。
- 目录迁移与行为删除分开提交，每个提交都必须保持相关模块可测试、可构建。
- 不保留旧目录软链接或第二套命令入口。

## 配置所有权

- 根目录不拥有 `.env`。
- Desktop、Runtime 和 Runtime SDK 默认不要求用户环境变量。
- Desktop Main 负责托管 Runtime 的地址、端口和配对凭证；Runtime 用户设置通过 Runtime API 保存。
- Runtime 非密钥设置进入 SQLite，供应商密钥进入操作系统凭据库。
- Cloud 只通过自己的环境模板接收服务密钥和外部端点。
- Cloud Infra 只接收数据库密码、域名、ACME 邮箱及 Cloud/Admin 镜像版本。

## 版本与发布

模块使用独立版本和标签：

- `runtime-vX.Y.Z`
- `desktop-vX.Y.Z`
- `cloud-vX.Y.Z`
- `admin-vX.Y.Z`
- `runtime-client-vX.Y.Z`

Runtime 发布 macOS arm64/x64、Windows x64 和 Linux x64 自包含产物。Desktop 显式锁定
一个 Runtime 版本，正式打包下载对应产物，本地开发运行当前源码。Cloud 和 Admin 分别发布
独立镜像。

## 兼容纪律

目录重组没有改变 `/local/v1`、持久命令、事件游标、检查点和 SQLite 数据格式。Desktop 已删除
Web Agent、云账号、计费和云文档路径；Runtime 已删除专用 Cloud 会话、Go 模型网关和 Cloud 工具网关。

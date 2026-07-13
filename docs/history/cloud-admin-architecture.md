# 已退役的 Cloud 与 Admin 方案

> 历史记录：本文描述 2026 年 7 月 13 日前的旧方案，不代表当前产品能力或公开接口。

SheJane 曾同时包含桌面客户端、本地 Runtime、Go Cloud、Admin 后台和云端部署配置。随着产品收口为独立桌面 Agent Harness，Desktop 与 Runtime 已解除 Cloud 依赖，Cloud 和 Admin 因此从主仓库退役。

## 旧架构

```text
Desktop / Web
      │
      ▼
Go Cloud API ◀──── Admin
      │
      ├── 用户、登录与权限
      ├── 模型目录、模型路由与用量记录
      ├── 钱包、积分账本与 Stripe 支付
      ├── 文档上传、S3 存储与解析
      ├── Tavily / E2B / 图片等云端工具
      └── PostgreSQL

Desktop ──loopback HTTP──▶ Python Runtime
```

### Go Cloud

旧目录为 `services/cloud/`，主要包含：

- 用户注册、登录、刷新令牌、邮箱验证和管理员权限；
- 模型目录、Auto 模型解析、OpenAI/Anthropic 适配和流式模型网关；
- 调用前预留、调用后结算或释放的钱包积分账本；
- Stripe 订阅、充值、Webhook 幂等处理和审计记录；
- S3 文档上传、解析、问答和云端附件；
- Tavily、E2B、图片生成及其他云端工具网关；
- 内存与 PostgreSQL 两套存储实现，以及顺序数据库迁移。

### Admin

旧目录为 `apps/admin/`，是独立的 React/Vite 应用，仅用于管理 Go Cloud：

- 用户状态和积分调整；
- 模型配置、供应商密钥状态和计费参数；
- 订单、模型调用、Agent Run、工具调用和审计日志；
- Cloud 管理员登录和权限检查。

### Cloud Infra

旧目录为 `infra/cloud/`，包含本地及生产 Docker Compose、Caddy 和部署环境模板。Cloud 与 Admin 曾分别通过 `cloud-vX.Y.Z` 和 `admin-vX.Y.Z` 标签发布镜像。

## 退役原因

当前产品边界是：

```text
Desktop → Runtime Client SDK → 本地 Runtime → 用户自己的模型供应商
```

Runtime 已直接管理 BYOK 模型、工具、MCP、Skills、对话、任务状态、审批和检查点。Desktop 只连接 Runtime，不再需要云账号、平台积分、Cloud 模型目录、云文档或专用工具网关。继续保留旧 Cloud 会增加依赖更新、密钥管理、支付合规和安全维护成本，却不服务当前产品目标。

Admin 只管理 Cloud，因此 Cloud 退役后也没有独立存在价值。

## 可恢复位置

完整源码仍可通过 Git 历史查看。以下提交标记了旧方案拆分和去耦过程：

- `b411d762`：Admin 迁入独立应用目录；
- `96014401`：Go Cloud 迁入独立服务目录；
- `fc47e6cc`：Cloud 部署配置独立；
- `dcd043fa`：Cloud 与 Admin 独立发布；
- `b41db054`：删除浏览器 Cloud Agent；
- `c994188f`：Runtime 启动不再依赖 Cloud 配置。

## 将来如何提供中转服务

如果将来提供官方模型中转服务，应把它做成独立产品，并通过 Runtime 已支持的标准模型供应商接口接入。远程工具使用 MCP。不要恢复 SheJane 专用的账号、积分、模型目录或工具网关耦合。

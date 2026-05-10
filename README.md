# 简单 Jiandanly

简单是一款面向小团队和职业人群的 AI 生产力工具。Phase 1 的目标不是做多模型工作站，而是先交付一个可以注册、登录、聊天、看额度、进入订阅、并把聊天历史默认留在本地的可收费 MVP。

## Phase 1 已实现

- Go API Gateway：健康检查、JWT 注册登录、HTTPOnly Refresh Token 轮换、用户信息接口。
- Chat API：`POST /api/v1/chat/completions`，OpenAI-compatible SSE 流式输出，支持 `fast` / `deep` 模式和最小场景 system prompt 注入。
- 模型路由：默认本地 mock；可通过环境变量接入 DeepSeek/OpenAI-compatible provider 和 Anthropic Claude。
- 额度账本：月额度、额外额度、请求前预留、结束后结算、失败释放。
- PostgreSQL 持久化：用户、refresh token、wallet、usage reservation、wallet transaction、LLM call record、payment order、Stripe event。
- Stripe 订阅闭环：Checkout Session 创建、Webhook 签名校验、事件幂等处理、订阅 ID 入库、续费发放月额度、失败/取消状态同步；本地无 Stripe 密钥时返回 mock checkout URL。
- React/Vite 客户端：登录/注册、基础聊天、快速/深度切换、额度展示、订阅入口、本地导入/导出。
- 独立管理后台 MVP：单独 React/Vite admin web，使用 shadcn/ui 组件体系，管理员可看概览、用户、用量、订单、模型状态，并执行启用/禁用用户和人工调整额外额度。
- 管理后台审计：订单只读展示 Stripe session/subscription，审计页只读展示后台操作和关键账务事件。
- Local-first 历史：Web 使用 IndexedDB；后端只保存调用 metadata 和账务数据，不保存完整聊天正文。
- Electron 壳：复用同一套 React UI，renderer 禁用 Node，预留安全 preload 边界。
- Docker Compose：PostgreSQL、Redis、migration、API、Client、可选 Caddy reverse proxy。

## Phase 1.5：真实模型对接

Phase 1 默认可以用 mock provider 本地开发。Phase 1.5 的目标是把聊天链路切到真实 LLM provider，先接 DeepSeek。

在 `.env` 中配置：

```dotenv
MOCK_LLM=false
FAST_PROVIDER_BASE_URL=https://api.deepseek.com
FAST_PROVIDER_API_KEY=你的 DeepSeek API Key
FAST_MODEL=deepseek-v4-flash
```

然后重启 API 并跑 smoke：

```bash
docker compose up -d --build api
make smoke-real-llm
```

如果 smoke 输出 `The response is still using the mock provider`，说明 API 进程没有读到 `MOCK_LLM=false` 或 provider key。

## Phase 1.6：管理后台 MVP

Phase 1.6 提供单独部署的管理后台 web，不再把后台入口放进普通用户 client。第一个管理员通过 `.env` 的 `ADMIN_EMAILS` 创建：

```dotenv
ADMIN_EMAILS=admin@example.com,ops@example.com
ADMIN_BASE_URL=http://localhost:5174
```

用其中任意邮箱注册或登录后，后端会在注册、登录、刷新时自动把该用户提权为 `role=admin`。从 `ADMIN_EMAILS` 移除邮箱不会自动降级，避免误锁管理员；需要降级时请直接在数据库中审慎修改。

管理员在独立后台登录：本地默认地址是 `http://localhost:5174`。当前后台能力边界：

- 可查看：系统概览、用户列表、用户详情、钱包、最近调用、订单、fast/deep provider 状态。
- 可操作：启用/禁用用户、调整用户 `extra_credits_balance`。
- 有审计：额度调整写入 `wallet_transactions(type=admin_adjust)` 和 `audit_logs(action=admin.extra_credit_adjust)`；状态修改写入 `audit_logs(action=admin.user_status_update)`。
- 不可操作：后台不修改 provider key，不手工修改订单状态，不做退款/补单，不改月额度、plan code 或订阅状态。

Provider key 不进入后台管理：密钥只通过环境变量提供，后台只展示 key 是否已配置，避免把高权限供应商密钥暴露到浏览器、日志或管理员误操作路径里。

## Phase 1.7：生产准备与账单稳固

Phase 1.7 加固真实订阅和运营闭环：

- `checkout.session.completed`：保存 `stripe_subscription_id`，订单标记为 `paid`，钱包切到 `pro/active` 并发放本月额度。
- `invoice.paid` / `invoice.payment_succeeded`：对续费账单重置本月已用额度并重新发放月额度；同一 Stripe event 只处理一次。
- `invoice.payment_failed`：钱包状态同步为 `past_due`。
- `customer.subscription.updated/deleted`：同步 Stripe subscription 状态，取消后显示 `canceled`。
- `GET /api/v1/admin/audit-logs`：管理员只读查看审计日志；后台不提供删除、修改或重放审计的入口。

本地验证 Stripe webhook 闭环：

```bash
docker compose up -d --build
make smoke-stripe-webhook
```

如果 API 设置了 `STRIPE_WEBHOOK_SECRET`，脚本会优先使用当前 shell 的同名变量；没有时会自动读取当前目录 `.env` 中的 `STRIPE_WEBHOOK_SECRET`，并生成 `Stripe-Signature`。

## 后续阶段边界

团队版、BYOK、云端历史同步、RAG、Office/图片生成、文件解析、Chrome Use、Computer Use、MCP、移动端和开放平台 API Key 都是后续阶段能力。

## 本地开发

```bash
cp .env.example .env
cd api && go test ./...
cd ../client && npm install && npm test -- --run
cd ../admin && npm install && npm test -- --run
```

启动开发服务：

```bash
cd api
HTTP_ADDR=:8080 go run ./cmd/api
```

另一个终端：

```bash
cd client
npm run dev
```

第三个终端：

```bash
cd admin
npm run dev
```

默认 `MOCK_LLM=true`，不需要外部模型密钥就能跑通聊天流。

## Docker 启动

```bash
cp .env.example .env
docker compose up --build
```

服务地址：

- Web: `http://localhost:5173`
- Admin: `http://localhost:5174`
- API: `http://localhost:8080`
- Postgres: `localhost:15432`（容器内仍是 `5432`，避免冲突本机已有 PostgreSQL）
- Redis: `localhost:16379`（容器内仍是 `6379`）

## 接入真实服务

在 `.env` 中配置：

- `JWT_SECRET`：生产必须替换成长随机值。
- `DATABASE_URL`：PostgreSQL 连接串。
- `CLIENT_BASE_URL`：普通用户 Web 地址。
- `ADMIN_BASE_URL`：独立管理后台 Web 地址，用于 API CORS 放行。
- `ADMIN_EMAILS`：逗号分隔的管理员邮箱列表。
- `MOCK_LLM=false`
- `FAST_PROVIDER_API_KEY`：DeepSeek 或 OpenAI-compatible provider key。
- `ANTHROPIC_API_KEY`：深度模式 Claude key。
- `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_ID`：Stripe Billing Checkout。

Stripe Checkout 使用订阅模式，Webhook 至少需要订阅 `checkout.session.completed`、`invoice.paid`、`invoice.payment_failed`、`customer.subscription.updated`、`customer.subscription.deleted`。系统不会在后台存储或展示 Stripe secret key。

## 系统管理

Phase 1.6 已提供独立管理后台 MVP。日常运营可以通过 `admin/` web 查看用户、用量、订单和 provider 状态，并执行账号启停、额外额度调整。更高风险操作仍应使用 Stripe/DeepSeek 控制台、PostgreSQL 和部署平台完成。操作手册见 [`docs/operations.md`](docs/operations.md)。

## 验证命令

```bash
make test
make build
```

有真实 provider key 且 API 已用 `MOCK_LLM=false` 启动时，再运行：

```bash
make smoke-real-llm
```

本地合成 Stripe webhook：

```bash
make smoke-stripe-webhook
```

前端单测覆盖 SSE 解析、本地 IndexedDB 历史导入导出、发送消息本地落库与 assistant delta 合并、普通 client 不暴露后台入口、独立 admin web 渲染、功能 tab、订单订阅 ID、审计页与额度调整表单校验。后端单测覆盖注册登录、鉴权、流式聊天、额度预留/结算、模型路由、Stripe 订阅生命周期和 admin API 权限/审计。

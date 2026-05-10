# 简单 Jiandanly

简单是一款面向小团队和职业人群的 AI 生产力工具。Phase 1 的目标不是做多模型工作站，而是先交付一个可以注册、登录、聊天、看额度、进入订阅、并把聊天历史默认留在本地的可收费 MVP。

## Phase 1 已实现

- Go API Gateway：健康检查、JWT 注册登录、HTTPOnly Refresh Token 轮换、用户信息接口。
- Chat API：`POST /api/v1/chat/completions`，OpenAI-compatible SSE 流式输出，支持 `fast` / `deep` 模式和最小场景 system prompt 注入。
- 模型路由：默认本地 mock；可通过环境变量接入 DeepSeek/OpenAI-compatible provider 和 Anthropic Claude。
- 额度账本：月额度、额外额度、请求前预留、结束后结算、失败释放。
- PostgreSQL 持久化：用户、refresh token、wallet、usage reservation、wallet transaction、LLM call record、payment order、Stripe event。
- Stripe 订阅入口：Checkout Session 创建、Webhook 签名校验、事件幂等处理；本地无 Stripe 密钥时返回 mock checkout URL。
- React/Vite 客户端：登录/注册、基础聊天、快速/深度切换、额度展示、订阅入口、本地导入/导出。
- Local-first 历史：Web 使用 IndexedDB；后端只保存调用 metadata 和账务数据，不保存完整聊天正文。
- Electron 壳：复用同一套 React UI，renderer 禁用 Node，预留安全 preload 边界。
- Docker Compose：PostgreSQL、Redis、migration、API、Client、可选 Caddy reverse proxy。

## 暂不进入 Phase 1

团队版、BYOK、云端历史同步、RAG、Office/图片生成、文件解析、Chrome Use、Computer Use、MCP、移动端和开放平台 API Key 都是后续阶段能力。

## 本地开发

```bash
cp .env.example .env
cd api && go test ./...
cd ../client && npm install && npm test -- --run
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

默认 `MOCK_LLM=true`，不需要外部模型密钥就能跑通聊天流。

## Docker 启动

```bash
cp .env.example .env
docker compose up --build
```

服务地址：

- Web: `http://localhost:5173`
- API: `http://localhost:8080`
- Postgres: `localhost:5432`

## 接入真实服务

在 `.env` 中配置：

- `JWT_SECRET`：生产必须替换成长随机值。
- `DATABASE_URL`：PostgreSQL 连接串。
- `MOCK_LLM=false`
- `FAST_PROVIDER_API_KEY`：DeepSeek 或 OpenAI-compatible provider key。
- `ANTHROPIC_API_KEY`：深度模式 Claude key。
- `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_ID`：Stripe Billing Checkout。

Stripe Checkout 使用订阅模式，Webhook 处理 `checkout.session.completed` 并按月额度发放到账户钱包。

## 验证命令

```bash
make test
make build
```

前端单测覆盖 SSE 解析、本地 IndexedDB 历史导入导出、发送消息本地落库与 assistant delta 合并。后端单测覆盖注册登录、鉴权、流式聊天、额度预留/结算和模型路由。

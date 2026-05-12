# 简单 Jiandanly

简单是一款面向小团队和职业人群的 Agentic Chat 生产力工具。Phase 1 已完成可收费聊天 MVP；Phase 2 的方向已经从“场景模板 / 独立文档阅读”升级为 **Local Agent Harness**：用户只在一个输入入口里提问、上传附件、贴 URL 或描述任务，系统自动决定是否解析文档、调用工具、加载 skill、请求权限、验证结果或进入多步 agent loop。

Local Agent Harness 总规格见 [`spec.md`](spec.md)。

## Phase 1 已实现

- Go API Gateway：健康检查、JWT 注册登录、HTTPOnly Refresh Token 轮换、用户信息接口。
- Chat API：`POST /api/v1/chat/completions`，OpenAI-compatible SSE 流式输出，支持 `fast` / `deep` 模式和最小 system prompt / skill instructions 注入。
- 模型路由：默认本地 mock；可通过环境变量接入 DeepSeek/OpenAI-compatible provider 和 Anthropic Claude。
- 额度账本：月额度、额外额度、请求前预留、结束后结算、失败释放。
- PostgreSQL 持久化：用户、refresh token、wallet、usage reservation、wallet transaction、LLM call record、payment order、Stripe event。
- Stripe 订阅闭环：Checkout Session 创建、Webhook 签名校验、事件幂等处理、订阅 ID 入库、续费发放月额度、失败/取消状态同步；本地无 Stripe 密钥时返回 mock checkout URL。
- React/Vite 客户端：登录/注册、基础聊天、快速/深度切换、额度展示、订阅入口、本地导入/导出。
- Phase 2.1 统一 composer：普通用户 client 已把 PDF / DOCX / XLSX 上传、同步提取文本、单文件问答和额度扣减并入普通聊天入口。
- Phase 2.2 云端兼容 Agent Run：普通问题和附件问答都会创建 run、消费事件流、记录短期 `agent_events`，并在 admin 后台只读观察 run 摘要。
- Phase 2.3a Local Agent Harness daemon foundation：新增 `local-host/` Node/TypeScript daemon，提供 loopback health/tools/runs/stream/cancel API、pairing token、本地 SQLite run/event store 和 Electron 探测。
- Phase 2.4 Harness Loop MVP：Local Host 可调用云端 `/api/v1/agent/llm`，执行 `time.now`、授权 workspace 内 `file.read` / `file.search`，并对 `shell.run` 进入 permission-gated 流程。
- Phase 2.5-2.21 Local Harness UI / Workspace / Browser Bridge：已加入本地 artifact、checkpoint、context compaction、memory、verification、`web.fetch` / 可选 Tavily `web.search` / stdio MCP runtime / 并发安全工具批处理 / 模型失败 durable handling、通用工具原语、Playwright 托管浏览器、页面搜索/阅读/验证/快照/截图/点击/输入/滚动、本地环境观察和研究策略控制，并在普通 client 中支持本地工作区授权、诊断、撤销、本地项目引用、最近 run 恢复、当前 run 诊断面板、脱敏诊断导出、权限批准/拒绝、artifact 预览、验证事件和观察事件展示。
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
FAST_PROVIDER_KIND=deepseek-v4
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

## Phase 2：Local Agent Harness

Phase 2 的目标已经调整为 Local Agent Harness。用户不再需要理解“聊天 / 文档阅读 / 任务 Agent”的区别；一个 composer 承载普通问题、附件、URL 和复杂任务。系统自动选择文档解析、工具、skill、权限请求、验证循环或多步 agent loop。

长期架构是 **Local Agent Harness + Cloud Control Plane**：

- Local Agent Harness：负责 12 个 harness 组件，包括编排循环、工具、记忆、上下文管理、提示词构建、输出解析、状态管理、错误处理、护栏安全、验证循环、子智能体预留和生命周期管理。
- Local Host / Worker：负责本地上下文、权限、工具执行、本地 MCP、文件、终端、浏览器和 IDE 能力。
- Cloud Control Plane：负责 Auth、wallet、Stripe、admin、LLM provider、S3 文档、用量、审计和云端兼容 Agent Run。

Phase 2A 已经补齐“文档能力”的底座，Phase 2.1 已把它并入统一 composer。Phase 2.2 进一步把普通聊天和附件问答收敛到同一套 Agent Run 协议。Phase 2.3a-2.20 已新增本地 daemon、Harness loop、artifact/checkpoint/memory、web 工具、stdio MCP runtime、并发安全工具批处理、模型失败 durable handling、client UI bridge、工作区授权治理、本地项目引用、最近 run 恢复、当前 run 诊断面板、脱敏诊断导出和 Playwright 托管浏览器：Electron 会探测 `GET /local/v1/health`，已配对时普通无附件消息会进入本地 run，并在 timeline 中展示权限、artifact、验证结果、来源收集、浏览器观察和诊断入口。

当前 Phase 2A 文档能力边界：

- 支持：单文件上传、同步解析、单文件问答、删除文档、问答扣额度。
- 不支持：多文档问答、向量库/RAG、团队文档库、长期知识库、admin 后台文档管理、Local Host 本地文件读取。
- 上传和解析免费；只有文档问答会走现有 LLM reservation/settlement 账本。
- 默认限制：单文件 30MB、提取文本 60k 字符、对象和记录保留 7 天。

`.env` 需要配置 AWS S3：

```dotenv
AWS_REGION=ap-east-1
AWS_ACCESS_KEY_ID=你的开发 IAM access key
AWS_SECRET_ACCESS_KEY=你的开发 IAM secret
S3_BUCKET=你的 dev bucket
S3_DOCUMENT_PREFIX=documents
DOCUMENT_MAX_BYTES=31457280
DOCUMENT_TEXT_LIMIT=60000
DOCUMENT_TTL_HOURS=168
AGENT_RUN_TTL_HOURS=168
```

S3 bucket CORS 至少允许来自 `CLIENT_BASE_URL` 的 `PUT`，并允许 `Content-Type` header。API 使用同一组 IAM 凭证执行 `HeadObject`、`GetObject`、`PutObject` 和 `DeleteObject`。

### 本地 Harness 开发

本地 Host 默认只监听 loopback。开发时需要 pairing token：

```bash
cd local-host
npm install
npm run browser:install
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token npm run dev
```

Electron 端默认探测 `http://127.0.0.1:17371`，也可以覆盖：

```bash
cd client
JIANDANLY_LOCAL_HOST_URL=http://127.0.0.1:17371 \
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token \
npm run electron
```

Phase 2.21 已把这些本地能力接入普通 client：本地 Host 在线且已配对时，无附件消息会创建 Local Harness run；附件消息仍走云端兼容 run。用户可以用 Electron 原生目录选择器选择工作区，或手动填写路径后通过 Local Host 授权、诊断和撤销。Local Host 会拒绝未授权的 `workspace_path`；composer 会显示当前本地项目引用；最近本地任务支持恢复和下载脱敏诊断 JSON；消息 timeline 支持批准/拒绝权限请求、查看 artifact、打开当前 run 诊断面板、展示规则验证结果，并显示 `browser.observed` / `source.collected` / `environment.observed` 等观察事件。`mcp.call` 已可在 allowlist 和用户权限批准后调用本地 stdio MCP server；并发安全的读类工具会批量并行执行但保持 observation 顺序；模型网关异常会进入 `run.failed`；Playwright 托管浏览器支持搜索、打开、阅读、验证、快照、截图、点击、输入和滚动。研究策略控制会把搜索结果页排除在来源外，达到来源/搜索预算后阻止继续绕圈，并在未配置 Tavily 时不向模型暴露旧 `web.search` 工具。Local Harness 默认不设置工具轮数硬上限，`JIANDANLY_LOCAL_MAX_STEPS` 只作为可选安全阀；`JIANDANLY_LOCAL_STEP_WARNING_INTERVAL` 默认每 20 个工具轮次发出长任务软提醒，但不停止任务。屏幕 OCR、IDE 控制、用户现有浏览器标签读取和更完整的 run 回放 UI 继续后置。

Electron 是 Local Harness 的主入口。Phase 2.14 已加入本地 session bridge：用户在 Electron 正常登录后，client 会通过 paired loopback API 把当前云端 access token 注入 Local Host 内存 session；Local Host 再用这个短期 token 调 `/api/v1/agent/llm` 并扣该用户额度。退出登录时会调用 `DELETE /local/v1/session` 清掉本地 session。开发者不再需要手动复制 `JIANDANLY_CLOUD_ACCESS_TOKEN`；环境变量仍保留为 smoke 和无 UI 调试兜底。

启用本地 MCP 需要同时配置 allowlist 和 stdio server JSON：

```bash
cd local-host
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token \
JIANDANLY_MCP_ALLOWLIST=local-docs.safe.search \
JIANDANLY_MCP_SERVERS_JSON='{"local-docs":{"command":"node","args":["/absolute/path/to/mcp-server.mjs"]}}' \
npm run dev
```

## 后续阶段边界

场景模板工作台不再是后续主线。后续能力按 Local Agent Harness 路线推进：统一 composer、云端兼容 Agent Run、Local Agent Harness、本地 MCP、受控 shell/浏览器/IDE、memory/context/checkpoint/artifact、verification loops、Office/图片生成、多工具编排、团队版、移动端和开放平台 API Key。BYOK 仍作为最后阶段可选评估项，不进入当前核心架构。

## 本地开发

```bash
cp .env.example .env
cd api && go test ./...
cd ../client && npm install && npm test -- --run
cd ../admin && npm install && npm test -- --run
cd ../local-host && npm install && npm test -- --run
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

可选本地 Harness 终端：

```bash
cd local-host
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token npm run dev
```

仅在无 UI/headless smoke 调试时，才需要用环境变量预置当前登录用户的 access token：

```bash
cd local-host
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token \
JIANDANLY_CLOUD_BASE_URL=http://localhost:8080 \
JIANDANLY_CLOUD_ACCESS_TOKEN=用户 access token \
npm run dev
```

正常 Electron 手动测试不需要上面这段 token 注入。推荐流程是先启动 API，再启动 Local Host 和 Electron，最后在 Electron 里正常登录：

```bash
make dev-electron
```

这条命令会用 `docker compose up -d --build` 在后台启动云端控制面，启动 Local Host，使用隔离端口 `55173` 启动 client dev server，最后打开 Electron。关闭 Electron 窗口后，本次脚本启动的本地 helper 进程会自动退出；Docker 栈可用 `make docker-down` 关闭。

默认 `MOCK_LLM=true`，不需要外部模型密钥就能跑通聊天流。

开发时查看日志：

```bash
make logs-dev          # API / Local Host / client / 最近 LLM 错误快照
make logs-api          # 持续查看 Docker API 日志
make logs-local-host   # 持续查看本地 Harness 日志
make logs-client       # 持续查看 client Vite 日志
make logs-llm-errors   # 查看最近 LLM 调用和错误原因
```

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
- `FAST_PROVIDER_KIND`：可选，`deepseek-v4` 或 `openai-compatible`；未设置时会从 base URL 推断。
- `FAST_PROVIDER_API_KEY`：DeepSeek 或 OpenAI-compatible provider key。
- `DEEP_PROVIDER_KIND`：可选，`anthropic`、`deepseek-v4` 或 `openai-compatible`。
- `ANTHROPIC_API_KEY`：深度模式 Claude key。
- `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_ID`：Stripe Billing Checkout。
- `AWS_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`S3_BUCKET`：Phase 2A 文档上传与解析。
- `AGENT_RUN_TTL_HOURS`：Phase 2.2 云端 run/event 短期保留时长，默认 168 小时。
- `JIANDANLY_LOCAL_HOST_TOKEN`：本地 Harness pairing token，仅用于本机 daemon。
- `JIANDANLY_LOCAL_HOST_URL`：Electron 探测本地 Harness 的 loopback URL，默认 `http://127.0.0.1:17371`。
- `JIANDANLY_CLOUD_BASE_URL`：Local Harness 调用云端 Control Plane 的 API base URL。
- `JIANDANLY_CLOUD_ACCESS_TOKEN`：Local Harness 调用云端模型网关的短期用户 token；当前开发阶段手动注入，后续改为 pairing/session 流程。
- `JIANDANLY_BROWSER_ENGINE=playwright`、`JIANDANLY_BROWSER_HEADLESS=true`、`JIANDANLY_BROWSER_TIMEOUT_MS=15000`、`JIANDANLY_BROWSER_SEARCH_URL=https://cn.bing.com/search?q={query}`、`JIANDANLY_ALLOW_PROXY_FAKE_IPS=true`：Local Harness 托管浏览器配置；首次使用前运行 `cd local-host && npm run browser:install`。`JIANDANLY_ALLOW_PROXY_FAKE_IPS` 用于兼容本地代理/TUN 的 `198.18.0.0/15` fake-ip DNS。

Stripe Checkout 使用订阅模式，Webhook 至少需要订阅 `checkout.session.completed`、`invoice.paid`、`invoice.payment_failed`、`customer.subscription.updated`、`customer.subscription.deleted`。系统不会在后台存储或展示 Stripe secret key。

## 系统管理

Phase 1.6 已提供独立管理后台 MVP。日常运营可以通过 `admin/` web 查看用户、用量、订单和 provider 状态，并执行账号启停、额外额度调整。更高风险操作仍应使用 Stripe/DeepSeek 控制台、PostgreSQL 和部署平台完成。操作手册见 [`docs/operations.md`](docs/operations.md)。

## 自动化测试

```bash
make test
make build
make test-e2e
make test-ci
```

默认测试以“本地确定性”为边界，不依赖真实 LLM、Stripe、S3、Tavily 或公网：

- `make test`：Go test + client/admin/local-host Vitest，覆盖 API 账本、文档、Agent Run、admin、本地 Harness runner/tools/store。
- `make test-e2e`：启动隔离的 client/admin Vite dev server（默认 `55173/55174`），使用 `e2e/` Playwright Chromium 模拟注册、统一 composer、附件 Agent Run、本地 Harness 权限/artifact/恢复和 admin tabs。
- `make test-ci`：`make test` + `make build` + Playwright simulated E2E；GitHub Actions 默认跑这条。
- `make smoke-local-host`：启动真实 Local Host daemon，检查 health、未配对 401、工具注册表和 mock run event stream。
- `make smoke-docker-local`：用 disposable Compose project + `MOCK_LLM=true` 启动本地闭环，验证 API health、注册、mock chat 扣额度、admin overview。

真实服务 smoke 需要显式运行，避免误消耗额度、创建 Stripe test object 或上传 S3 文件：

```bash
RUN_EXTERNAL_SMOKE=1 make smoke-external
make smoke-real-llm
make smoke-stripe-webhook
make smoke-s3-document
```

`smoke-s3-document` 会在上传后调用文档删除接口做 best-effort 清理，避免 dev bucket 长期堆积 smoke 对象。

前端单测覆盖 OpenAI/Agent SSE 解析、本地 IndexedDB 历史导入导出、发送消息本地落库与 assistant delta 合并、统一 composer 附件上传/Agent Run 文档问答、普通 client 不暴露后台入口、独立 admin web 渲染、功能 tab、Agent Runs 观察页、订单订阅 ID、审计页与额度调整表单校验。后端单测覆盖注册登录、鉴权、流式聊天、额度预留/结算、模型路由、文档上传/解析/问答、Agent Run create/events/stream/cancel/admin observe、Stripe 订阅生命周期和 admin API 权限/审计。Local Host 单测覆盖 pairing token、run/event stream、workspace 授权治理、permission flow、artifact/checkpoint/memory、web SSRF 防护、MCP allowlist、stdio MCP runtime、Harness loop 观察回填、并发安全工具批处理和模型失败 durable handling。Playwright E2E 只验证用户可见行为和跨边界契约，不重复底层分支测试。

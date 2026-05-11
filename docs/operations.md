# Jiandanly 运维与管理手册

Updated: 2026-05-11

## 当前管理边界

Phase 1.7 提供独立管理后台和账单生命周期加固。Phase 2 起产品方向调整为 Local Agent Harness，长期采用 Local Agent Harness + Cloud Control Plane。普通用户 client 与 admin web 分开构建、分开部署：

- 用户与额度：PostgreSQL 是唯一真实来源；后台可启用/禁用用户，可调整 `extra_credits_balance`。
- 模型调用：后端保存调用 metadata、provider、model、token 与 credits，不保存完整聊天正文；后台只读展示调用记录。
- 支付与订阅：后台只读展示订单、Stripe session/subscription 和钱包订阅状态；真实支付、退款、补单仍由 Stripe Dashboard 管理。
- 模型/provider：后台只读展示 fast/deep 当前 provider、base URL、model、mock/real 状态和 key 是否已配置，不显示也不修改 API key。
- 审计：账号状态变更、额外额度调整和关键账务 webhook 都会写入 `audit_logs`，额度调整还会写入 `wallet_transactions(type=admin_adjust)`。
- Local Agent Harness：完整路线见根目录 [`spec.md`](../spec.md)。云端负责账号、额度、模型网关、文档服务、admin 和审计；Local Harness 负责 12 个 harness 组件、本地工具、文件、终端、浏览器、IDE、本地 MCP、checkpoint 和 artifact。
- Agent Run：Phase 2.2 起普通聊天和附件问答会创建短期 `agent_runs` / `agent_events`。后台只展示摘要、状态和错误，不展示完整用户输入或文档正文。

## 本地启动

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
```

访问：

- Web: `http://localhost:5173`
- Admin: `http://localhost:5174`
- API: `http://localhost:8080`
- Postgres: `localhost:15432`
- Redis: `localhost:16379`

可选 Caddy reverse proxy 已预留 `jiandanly.com` 和 `admin.jiandanly.com` 两个入口；生产环境需要把 `CLIENT_BASE_URL`、`ADMIN_BASE_URL` 配到真实域名。

## 创建第一个管理员

编辑 `.env`：

```dotenv
ADMIN_EMAILS=你的邮箱@example.com
ADMIN_BASE_URL=http://localhost:5174
```

重启 API：

```bash
docker compose up -d --build api
```

然后在 `http://localhost:5174` 用该邮箱注册或登录。后端会在注册、登录、刷新会话时自动把命中的用户提权为 `role=admin`，独立后台会进入运营面板。

注意：

- `ADMIN_EMAILS` 使用逗号分隔，匹配时会去掉空格并忽略大小写。
- `ADMIN_BASE_URL` 用于 API CORS 放行独立后台域名；生产部署时请设置为真实后台域名。
- 从 `ADMIN_EMAILS` 移除邮箱不会自动降级已存在管理员，避免误锁第一个管理员。
- 禁用用户会让旧 access token 也无法继续访问受保护接口。
- 管理员不能在后台禁用自己的账号。

## 切换到真实 DeepSeek

编辑 `.env`：

```dotenv
MOCK_LLM=false
FAST_PROVIDER_BASE_URL=https://api.deepseek.com
FAST_PROVIDER_API_KEY=你的 DeepSeek API Key
FAST_MODEL=deepseek-v4-flash
```

重启 API：

```bash
docker compose up -d --build api
```

运行真实模型 smoke：

```bash
make smoke-real-llm
```

如果要让深度模式也走 DeepSeek：

```dotenv
ANTHROPIC_API_KEY=
DEEP_PROVIDER_BASE_URL=https://api.deepseek.com
DEEP_PROVIDER_API_KEY=同一个或单独的 DeepSeek API Key
DEEP_MODEL=deepseek-v4-pro
```

## Stripe 订阅与 Webhook

Stripe Checkout 使用 `mode=subscription` 和 `STRIPE_PRICE_ID` 创建订阅 checkout。生产环境需要在 Stripe Workbench 配置 webhook endpoint：

```text
POST https://你的 API 域名/api/v1/payment/webhook
```

建议至少订阅这些事件：

- `checkout.session.completed`：保存 subscription ID，订单标记为 `paid`，发放本月额度。
- `invoice.paid` / `invoice.payment_succeeded`：续费成功后重置本月已用额度并发放新周期额度。
- `invoice.payment_failed`：同步钱包状态为 `past_due`。
- `customer.subscription.updated`：同步 Stripe subscription 状态。
- `customer.subscription.deleted`：同步钱包状态为 `canceled`。

本地合成 webhook smoke：

```bash
docker compose up -d --build
make smoke-stripe-webhook
```

如果 API 配置了 `STRIPE_WEBHOOK_SECRET`，脚本会优先使用当前 shell 的同名变量；没有时会自动读取当前目录 `.env` 中的值：

```bash
export STRIPE_WEBHOOK_SECRET=whsec_xxx
make smoke-stripe-webhook
```

账本规则：

- Stripe event ID 先进入 `stripe_events`，处理成功后写 `processed_at`；重复事件不会重复发放额度。
- 月额度只通过 subscription grant/renewal 重置，人工后台只允许调整 `extra_credits_balance`。
- `wallet_transactions.idempotency_key` 会记录 `stripe:<event_id>`，便于排查重复投递。
- 后台订单和审计页只读，不提供手动改订单、补单、退款、删除审计或重放 webhook 的入口。

## 文档上传、Agentic Chat 与 S3

Phase 2A 的文档能力使用真实 AWS S3，不在本地磁盘保存原文件。Phase 2.1 已把文档上传和单文件问答合并进普通 client 的统一 Agentic Chat composer。Phase 2.2 起，发送问题会走 Agent Run event stream，附件会触发 `document.read` 工具事件。`.env` 至少需要：

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

建议 IAM 权限只覆盖这个 bucket/prefix：

```text
s3:PutObject
s3:GetObject
s3:HeadObject
s3:DeleteObject
```

S3 bucket CORS 需要允许普通用户 Web 的 origin，例如本地：

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "x-amz-*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

本地验证流程：

1. 配好 `.env` 后运行 `docker compose up -d --build`。
2. 登录普通用户 Web：`http://localhost:5173`。
3. 在普通聊天 composer 的“上传附件”入口上传 PDF / DOCX / XLSX。
4. 确认 bucket 中出现 `documents/<user_id>/<document_id>/source.*` 和 `extracted.txt`。
5. 附件显示 ready 后，在同一个 composer 发送问题，确认真实 LLM 回复、额度减少、管理后台用量可见。
6. 在 admin 的 Agent Runs 页确认能看到 run 摘要、状态、模式和用户邮箱。
7. 删除文档后，系统会 best-effort 删除 S3 原文件和文本对象。

边界说明：

- 上传和解析不扣额度；文档问答扣额度。
- 本阶段只做单文件上下文，不做向量库、多文档 RAG、团队文档库或 Local Host 本地文件读取。
- 提取文本只保留前 `DOCUMENT_TEXT_LIMIT` 字符，避免超长 prompt 失控。
- 文档默认 7 天过期；当前没有后台手工延长或恢复入口。
- Agent Run 事件默认 7 天过期；当前没有后台重放、修改、取消已完成 run 的入口。

## Local Agent Harness 运维边界

Phase 2 的目标不是让云端代替本地执行所有工具。运维上按两个平面理解：

- **Cloud Control Plane**：继续部署在现有 API/admin/postgres/redis/S3/Stripe/LLM provider 链路里，保存账号、账务、provider 配置、文档临时对象、LLM metadata、run 摘要和审计。
- **Phase 2.2 云端兼容 run**：已提供 `POST /api/v1/agent/runs`、`GET /api/v1/agent/runs/{id}`、`GET /api/v1/agent/runs/{id}/events`、`GET /api/v1/agent/runs/{id}/stream`、`POST /api/v1/agent/runs/{id}/cancel`。Web 先使用这套协议；Local Harness 后续复用事件模型。
- **Phase 2.3-2.16 本地 daemon / harness**：`local-host/` 提供 `GET /local/v1/health`、`GET /local/v1/tools`、`GET/POST/DELETE /local/v1/session`、`GET/POST /local/v1/workspaces`、`POST /local/v1/workspaces/diagnose`、`DELETE /local/v1/workspaces/{id}`、`GET/POST /local/v1/runs`、`GET /local/v1/runs/{id}`、`GET /local/v1/runs/{id}/stream`、`GET /local/v1/runs/{id}/diagnostics`、`POST /local/v1/runs/{id}/cancel`、`POST /local/v1/permissions/{request_id}`、`GET /local/v1/artifacts/{id}`。除 health 外都需要 pairing token；Phase 2.13 起普通 client 可以选择、授权、诊断和撤销工作区，创建/恢复本地 run、导出脱敏诊断、批准/拒绝权限并按需读取 artifact；Phase 2.14 起 Electron 登录成功后会自动把云端 access token 注入 Local Host 内存 session，退出登录时清理 session；Phase 2.15 起 Local Host 暴露通用办公 Agent 基础原语 `fs.*`、`open.*`、`clipboard.*` 和 `task.verify`，并保留旧 `file.*` 兼容工具；Phase 2.16 起 Local Host 支持受控 `browser.*` 页面观察和 `environment.observe` 本地环境观察；Local Host 可在 allowlist 和权限批准后调用配置好的本地 stdio MCP server，可并行执行连续的并发安全读类工具，并会把模型网关异常转成 durable `run.failed`。
- **Local Agent Harness**：运行在用户本机，只通过短期 token 调云端模型网关和计费接口；本地文件、shell、浏览器、IDE、MCP 结果默认留在本机。
- **Admin 可见性**：后台可以观察 run 摘要、工具错误、额度消耗和订单，不应提供浏览用户本地私有文件、完整本地 prompt 或完整工具输出的入口。
- **密钥边界**：provider key 仍只在云端环境变量中配置，不下发给 client 或 Local Harness。

本地开发 Local Harness：

```bash
cd local-host
npm install
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token npm run dev
```

Electron client 连接本地 Host：

```bash
cd client
JIANDANLY_LOCAL_HOST_URL=http://127.0.0.1:17371 \
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token \
npm run electron
```

连接云端模型网关：

```bash
cd local-host
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token \
JIANDANLY_CLOUD_BASE_URL=http://localhost:8080 \
JIANDANLY_CLOUD_ACCESS_TOKEN=用户 access token \
npm run dev
```

上面的 `JIANDANLY_CLOUD_ACCESS_TOKEN` 只用于无 UI 调试或 smoke。Electron 手动测试推荐走正常登录流程：

```bash
make dev-electron
```

这条命令会用 `docker compose up -d --build` 在后台启动云端控制面，启动 Local Host，使用隔离端口 `55173` 启动 client dev server，最后打开 Electron。关闭 Electron 窗口后，本次脚本启动的本地 helper 进程会自动退出；Docker 栈可用 `make docker-down` 关闭。如果你已经手动启动 API，可以用 `SKIP_DOCKER=1 make dev-electron` 只启动 Local Host、client dev server 和 Electron。

登录成功后，client 会调用 `POST /local/v1/session` 注入短期云端 session。Local Host 不会把 access token 写入 SQLite、diagnostics 或 API 响应；`GET /local/v1/session` 只返回是否已连接、cloud base URL 和更新时间。

本地开发日志：

```bash
make logs-dev          # API / Local Host / client / 最近 LLM 错误快照
make logs-api          # 持续查看 Docker API 日志
make logs-local-host   # 持续查看本地 Harness 日志
make logs-client       # 持续查看 client Vite 日志
make logs-llm-errors   # 查看最近 LLM 调用和错误原因
```

如果 UI 里只看到 `Cloud LLM gateway returned HTTP ...`，优先运行 `make logs-llm-errors`。这会从 `llm_call_records.error_message` 里看到真实原因，例如 provider 400、额度不足、结算失败或上游模型错误。

启用 Phase 2.6+ 可选搜索和 MCP：

```bash
cd local-host
JIANDANLY_LOCAL_HOST_TOKEN=dev-local-token \
TAVILY_API_KEY=tvly-... \
JIANDANLY_MCP_ALLOWLIST=local-docs.safe.search,design-system.tokens.read \
JIANDANLY_MCP_SERVERS_JSON='{"local-docs":{"command":"node","args":["/absolute/path/to/local-docs-mcp.mjs"]}}' \
npm run dev
```

`web.fetch` 不需要第三方 key，但会在请求前解析目标域名并阻止 localhost、私网、链路本地、多播和保留地址。`web.search` 当前只支持 Tavily；未配置 `TAVILY_API_KEY` 时会返回可恢复的 disabled-tool observation。`mcp.call` 必须同时满足三层条件：模型请求的 `server.tool` 命中 `JIANDANLY_MCP_ALLOWLIST`、本地用户批准 `permission.required`、`JIANDANLY_MCP_SERVERS_JSON` 中存在对应 server 配置。MCP server 通过 stdio JSON-RPC 启动，Local Host 不会把 command、args、env 或 secret 回传给模型或 UI。

Phase 2.15 通用工具原语：

- `fs.list`、`fs.read`、`fs.search`：只读工具，只能访问已授权 workspace 内路径。
- `fs.write`：写入 UTF-8 文本文件，只能写授权 workspace 内路径，每次都需要用户批准。
- `open.url`：打开 `http` / `https` URL，每次都需要用户批准；不支持 `file://` 等本地协议。
- `open.file`：用系统默认应用打开授权 workspace 内文件，每次都需要用户批准。
- `clipboard.read`、`clipboard.write`：只处理纯文本，每次都需要用户批准。
- `task.verify`：用于验证文件存在、文件包含文本、URL 格式和布尔断言。

旧 `file.read`、`file.search`、`file.write` 仍保留，用于兼容已有 run 和测试；新模型提示会优先引导使用 `fs.*`。

Phase 2.16 浏览器与环境观察：

- `browser.open`：在 Local Host 管理的受控页面上下文中打开 `http` / `https` URL，每次都需要用户批准；请求前会做 DNS 校验并阻止 localhost、私网、链路本地、多播和保留地址。
- `browser.snapshot`：读取受控页面的标题、URL、可见文本、主要链接、表单和按钮；只观察 Local Host 自己管理的页面，不读取用户已有 Chrome/Safari 标签。
- `browser.close`：关闭当前受控页面上下文。
- `environment.observe`：读取基础本地环境元数据，例如平台、前台应用和窗口标题；每次都需要用户批准，不采集屏幕截图。
- 事件流会额外出现 `browser.observed`、`environment.observed`、`ui.action.requested` 和 `ui.action.completed`，client 会显示为“观察网页”“观察环境”“请求操作”等普通用户文案。
- 本阶段不做点击、输入、提交表单、屏幕 OCR、系统设置修改或读取用户现有浏览器标签页。

测试本地 health：

```bash
curl http://127.0.0.1:17371/local/v1/health
curl -H "Authorization: Bearer dev-local-token" http://127.0.0.1:17371/local/v1/tools
```

注意：

- daemon 只应监听 `127.0.0.1`，不要绑定公网网卡。
- `JIANDANLY_LOCAL_HOST_TOKEN` 是本机 pairing 材料，不应写入仓库、日志或云端后台。
- Phase 2.16 已实现 `time.now`、授权 workspace 内 `fs.list` / `fs.read` / `fs.search` / `fs.write`、旧 `file.*` 兼容工具、`open.url` / `open.file`、`clipboard.read` / `clipboard.write`、`task.verify`、受控 `browser.open` / `browser.snapshot` / `browser.close`、`environment.observe`、`shell.run` 权限确认、云端 `/api/v1/agent/llm` 扣费入口、长工具输出 artifact、checkpoint resume、上下文压缩、基础本地 memory、规则验证事件、`web.fetch`、可选 Tavily `web.search`、MCP allowlist + stdio runtime adapter、并发安全工具批处理、模型失败 durable handling，以及 client 侧工作区选择/授权/诊断/撤销、本地项目引用、最近 run 恢复、脱敏诊断导出、权限批准/拒绝、artifact 预览和验证结果展示。
- Local Host 会拒绝未授权的 `workspace_path`，因此本地文件和 shell 工具必须先经 `POST /local/v1/workspaces` 授权工作区。
- 诊断导出默认不包含 artifact 正文或完整 checkpoint messages；仍未实现诊断包导入/回放、真实浏览器点击/输入、IDE 控制和 Playwright/截图验证。

## 自动化测试与 Smoke

Jiandanly 的默认测试按“本地确定性优先”设计：PR 和本机默认命令不依赖真实 LLM、Stripe、S3、Tavily 或外网。真实服务只通过显式 smoke 验证。

常用命令：

```bash
make test
make build
make test-e2e
make test-ci
```

含义：

- `make test`：运行 API Go test、client/admin Vitest、Local Host Vitest。适合日常开发中频繁跑。
- `make test-e2e`：运行 `e2e/` Playwright Chromium simulated E2E。测试会启动隔离的 client/admin dev server（默认 `55173/55174`），并用 route mocking 模拟 API、S3 PUT、Agent SSE 和 Local Host loopback API。
- `make test-ci`：`make test` + `make build` + `make test-e2e`。GitHub Actions 的 PR 默认门禁使用这条命令。
- `make smoke-local-host`：启动真实 Local Host daemon，检查 `/health`、未配对 `/tools` 返回 401、配对后工具列表包含 `mcp.call`，并创建/stream 一个 deterministic local run。
- `make smoke-docker-local`：用 disposable Docker Compose project 启动 API/client/admin/postgres/redis，强制 `MOCK_LLM=true`，验证注册、mock chat 扣额度和 admin overview。默认端口是 API `18080`、client `15173`、admin `15174`，避免影响普通开发栈。

真实服务 smoke：

```bash
RUN_EXTERNAL_SMOKE=1 make smoke-external
```

这条会串联：

- `make smoke-real-llm`：要求 API 已用 `MOCK_LLM=false` 和真实 provider key 启动。
- `make smoke-stripe-webhook`：合成 Stripe webhook 并验证订阅状态生命周期。
- `make smoke-s3-document`：创建文档 presigned upload，向真实 S3 PUT 一个小 PDF source object，并通过文档删除接口做 best-effort 清理。

注意：

- 不要把真实 provider、Stripe、AWS 密钥写入仓库；CI 的 External Smoke workflow 只通过 GitHub Secrets 注入。
- Docker smoke 会使用独立 `COMPOSE_PROJECT_NAME=jiandanly_smoke` 并在退出时 `down -v` 清理；不要把它指向正在使用的生产或日常开发 Compose project。
- Playwright E2E 只验证用户可见行为和关键网络契约，不替代 API/Local Host 单元与集成测试。
- 外部 smoke 可能消耗 LLM 额度、创建 Stripe test object、写入 S3 dev bucket，不应放进每次 PR 的默认门禁。

## 常用管理命令

查看 API 日志：

```bash
docker compose logs -f api
```

查看数据库记录：

```bash
docker compose exec postgres psql -U jiandanly -d jiandanly
```

常用查询：

```sql
select count(*) as users from users;

select
  request_id,
  provider,
  model,
  status,
  input_tokens,
  output_tokens,
  credits_cost,
  started_at,
  finished_at
from llm_call_records
order by started_at desc
limit 10;

select
  user_id,
  plan_code,
  monthly_credit_limit,
  monthly_credits_used,
  extra_credits_balance,
  status,
  updated_at
from wallets
order by updated_at desc
limit 10;

select
  actor_user_id,
  target_type,
  target_id,
  action,
  metadata,
  created_at
from audit_logs
order by created_at desc
limit 20;

select
  stripe_event_id,
  event_type,
  processed_at,
  created_at
from stripe_events
order by created_at desc
limit 20;

select
  ar.id,
  u.email,
  ar.status,
  ar.mode,
  ar.goal_summary,
  ar.updated_at
from agent_runs ar
join users u on u.id = ar.user_id
order by ar.created_at desc
limit 20;

select
  run_id,
  seq,
  event_type,
  payload,
  created_at
from agent_events
order by created_at desc
limit 30;

select
  po.id,
  u.email,
  po.status as order_status,
  po.stripe_checkout_session_id,
  po.stripe_subscription_id,
  w.status as wallet_status,
  po.created_at
from payment_orders po
join wallets w on w.id = po.wallet_id
join users u on u.id = w.user_id
order by po.created_at desc
limit 20;
```

停止服务：

```bash
docker compose down
```

清空本地数据库并重新来过：

```bash
docker compose down -v
docker compose up --build -d
```

## 管理后台能力

后台作为单独 web 部署，只对 `role=admin` 且 `status=active` 的用户可访问。普通用户 client 不再包含后台入口或后台 UI 代码。

当前支持：

- 系统概览：用户数、调用数、失败调用数、总额度消耗、订单数。
- 用户管理：搜索用户、查看用户详情、钱包、最近调用、最近订单、最近账本。
- 用户状态：启用/禁用用户，必须填写原因。
- 额度调整：只调整额外额度，必须填写原因，不允许扣成负数。
- 调用记录：全局只读列表，可按 API 参数扩展过滤。
- 订单记录：全局只读列表，显示订单 ID、用户、金额、状态、Stripe session、创建时间。
- 审计日志：只读展示后台操作和关键账务事件，不提供删除、修改或重放入口。
- 模型状态：只读展示 provider、base URL、model、mock/real 状态、API key 是否配置。

当前不支持：

- 不在后台保存、展示或修改 provider API key。
- 不手工修改订单状态，不做退款、补单或支付对账写操作。
- 不修改月额度、已用额度、plan code、订阅状态。
- 不做团队/组织后台、成员邀请、团队额度池或发票管理。

Provider key 不进入后台，是为了降低浏览器泄露、日志泄露和误操作风险。密钥继续由 `.env`、部署平台 secret 和供应商控制台管理；后台只显示布尔状态，便于判断当前 API 是否可能走真实 provider。

## 生产上线检查

上线前至少确认：

- `JWT_SECRET` 已替换为强随机值，`COOKIE_SECURE=true`，`CLIENT_BASE_URL` 和 `ADMIN_BASE_URL` 是真实 HTTPS 域名。
- `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_ID` 已在部署平台 secret 中配置，不写入仓库。
- Stripe webhook endpoint 已订阅 Phase 1.7 事件列表，Dashboard 中最近一次投递为 2xx。
- `make test-ci` 通过；本地或预发环境按需跑过 `RUN_EXTERNAL_SMOKE=1 make smoke-external`。
- 管理员只能通过 `ADMIN_EMAILS` 创建/提权，生产后台域名只开放给可信运营人员。

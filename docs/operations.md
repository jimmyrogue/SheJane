# 石间 / SheJane 运维与管理手册

Updated: 2026-05-17

## 当前管理边界

Phase 1.7 提供独立管理后台和账单生命周期加固。Phase 2 起产品方向调整为 Local Agent Harness，长期采用 Local Agent Harness + Cloud Control Plane。普通用户 client 与 admin web 分开构建、分开部署：

- 用户与额度：PostgreSQL 是唯一真实来源；后台可启用/禁用用户，可调整 `extra_credits_balance`。
- 模型调用：后端保存调用 metadata、provider、model、token 与 credits，不保存完整聊天正文；后台只读展示调用记录。
- 支付与订阅：后台只读展示订单、Stripe session/subscription 和钱包订阅状态；真实支付、退款、补单仍由 Stripe Dashboard 管理。
- 模型/provider（Phase 4 起改为动态）：后台「模型配置」页可**新增/编辑/启停/删除** provider、模型、成本倍率、生图每次金额，并设置全局计费参数（加价系数 + 基准每 token 成本）；保存即时生效，**不再依赖 `.env` 重启**。API key 加密存储（`CONFIG_ENCRYPTION_KEY`）且永不回显，仅显示「key 已配置」。`.env` 的 provider 变量仅作**首次空库的种子**。
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

可选 Caddy reverse proxy 已预留 `shejane.com` 和 `admin.shejane.com` 两个入口；生产环境需要把 `CLIENT_BASE_URL`、`ADMIN_BASE_URL` 配到真实域名。

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

## 模型配置（Phase 4：动态、后台可改）

模型 provider / 模型名 / API key / 成本倍率不再从 `.env` 读取并需要重启。`.env` 的 `FAST_PROVIDER_*` / `DEEP_PROVIDER_*` / `ANTHROPIC_API_KEY` 等变量**只在首次空库启动时作为种子**写入 `model_configs` 表；之后一切以后台「模型配置」页为准，保存即时生效（同进程立即、其它实例 ≤30s 收敛）。

新增一个 `.env` 变量用于密钥加密：

```dotenv
CONFIG_ENCRYPTION_KEY=任意足够强的口令（用于 AES-GCM 加密落库的 model API key）
```

未设置时 key 以明文存库并在启动打 WARN（MVP 可接受，生产务必设置）。

**在后台配置（推荐路径）**：admin → 模型配置 →

- 槽位（下拉）：`chat.fast`（快速对话）、`chat.deep`（深度对话）、`image.default`（生图）。每个槽位同一时刻只有一个「启用」的配置生效。
- 每行：provider 类型（`deepseek-v4`/`openai-compatible`/`anthropic`/`mock`）、Base URL、模型名、API key（只写，留空保持原值）、成本倍率，生图行另填「每次金额」。
- 全新/空库首启会自动种子：`chat.fast`=deepseek-v4-flash(成本倍率 0.1)、`chat.deep`=deepseek-v4-pro(1.0)、计费参数 加价系数 1.15 / 基准每 token 成本 0.00002 cny。**现有库不会被覆盖**，需手动调。
- 种子条件是「`model_configs` 整表为空」(`EnsureSeed`，`count==0`，见 `api/internal/modelreg/seed.go`)。因此若在后台把某槽位的**全部模型行删光**导致整表清空，下次重启会再次从 `.env` 种子。**即便已迁到后台管理，也不要从 `.env` 删除** `FAST_*` / `DEEP_*` / `ANTHROPIC_*`：它们仍作首启种子，并在 resolver 找不到启用行时作为兜底（`router.go` → `app.go` 静态 provider）。请求时模型选择走 DB（`Router.Select` 优先咨询 `registry.Resolve`），env 仅在上述两种情况被读取。

真实模型 smoke 仍可用：

```bash
make smoke-real-llm
```

## 计费模型（统一 credits）

最终扣费统一用 credits：

```
文本：credits = (input+output tokens) × 该模型成本倍率 × 全局加价系数      （下限 1，估算下限 300）
生图：credits/张 = ceil(每次金额 ÷ 基准每 token 成本 × 全局加价系数)，× 张数
```

- **成本倍率**（每模型）= 该模型相对 **DeepSeek-V4-Pro** 的纯成本比，不含利润。`chat.deep`=Pro=基准=**1.0**；`chat.fast`=Flash≈**0.1**（约为 Pro 的 1/10）；更贵的模型按真实价填 Nx。
- **全局加价系数**（计费参数卡片，存 `app_settings`，默认 **1.15 = 全线加价 15%**，限 1.0–3.0）= 产品固定毛利旋钮，改一个数全线生效。注意 1.15 是「加价 15%」，对应毛利率 ≈ 13%（0.15/1.15）。
- **基准每 token 成本**（¥/token，默认 `0.00002` ≈ ¥20/1M）= 「1 credit ≈ 1 个 DeepSeek-Pro token 成本」的锚点，**仅生图等按次金额模型换算用**；文本计费不需要它。建议按 **Pro 原价**（非 2.5 折促销价）锚定，促销到期不亏。
- 生图作为 **Agent 工具 `image.generate`** 经 Cloud Tool Gateway 计费（复用 `external_tool_call_records` reserve/settle/release，幂等），也提供 `POST /api/v1/images/generations` REST 入口。未配置基准成本时生图直接拒绝（`image_billing_not_configured`），不会乱扣。

生图与各档模型的基准成本/加价口径在 Admin「模型」页配置（见管理员文档）。

> 历史兼容：`FAST_PROVIDER_KIND` / `DEEP_PROVIDER_KIND` 仍可显式选 `deepseek-v4` / `openai-compatible` / `anthropic`，仅影响**首启种子**；未设置时 `https://api.deepseek.com` 自动按 `deepseek-v4`，其它 OpenAI 兼容地址按通用兼容模式。

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

- **Cloud Control Plane**：继续部署在现有 API/admin/postgres/S3/Stripe/LLM provider 链路里，保存账号、账务、provider 配置、文档临时对象、LLM metadata、run 摘要和审计。
- **Phase 2.2 云端兼容 run**：已提供 `POST /api/v1/agent/runs`、`GET /api/v1/agent/runs/{id}`、`GET /api/v1/agent/runs/{id}/events`、`GET /api/v1/agent/runs/{id}/stream`、`POST /api/v1/agent/runs/{id}/cancel`。Web 先使用这套协议；Local Harness 后续复用事件模型。
- **Phase 2.3-2.22 本地 daemon / harness**：`local-host/` 提供 `GET /local/v1/health`、`GET /local/v1/tools`、`GET/POST/DELETE /local/v1/session`、`GET/POST /local/v1/workspaces`、`POST /local/v1/workspaces/diagnose`、`DELETE /local/v1/workspaces/{id}`、`GET/POST /local/v1/runs`、`GET /local/v1/runs/{id}`、`GET /local/v1/runs/{id}/stream`、`GET /local/v1/runs/{id}/diagnostics`、`POST /local/v1/runs/{id}/cancel`、`POST /local/v1/permissions/{request_id}`、`GET /local/v1/artifacts/{id}`。除 health 外都需要 pairing token；Phase 2.13 起普通 client 可以选择、授权、诊断和撤销工作区，创建/恢复本地 run、导出脱敏诊断、批准/拒绝权限并按需读取 artifact；Phase 2.14 起 Electron 登录成功后会自动把云端 access token 注入 Local Host 内存 session，退出登录时清理 session；Phase 2.15 起 Local Host 暴露通用办公 Agent 基础原语 `fs.*`、`open.*`、`clipboard.*` 和 `task.verify`，并保留旧 `file.*` 兼容工具；Phase 2.17 起 Local Host 默认用 Playwright 托管 Chromium 支持 `browser.search/open/read/verify/snapshot/screenshot/click/type/scroll/close`，并继续支持 `environment.observe` 本地环境观察；Phase 2.18 起浏览器观察会标记页面质量、收集 usable 来源并阻止同一 run 内第三次重复搜索/打开；Phase 2.20 起普通 client 可直接从当前消息 timeline 打开本地 run 诊断面板并导出脱敏 JSON；Phase 2.21 起研究策略会排除搜索结果页来源并达到来源/搜索预算后阻止继续浏览；Phase 2.22 起 Tavily 等平台付费搜索只走 Cloud Tool Gateway，Local Host 不保存第三方 API key；Local Host 可在 allowlist 和权限批准后调用配置好的本地 stdio MCP server，可并行执行连续的并发安全读类工具，并会把模型网关异常转成 durable `run.failed`。
- **Local Agent Harness**：运行在用户本机，只通过短期 token 调云端模型网关和计费接口；本地文件、shell、浏览器、IDE、MCP 结果默认留在本机。
- **Admin 可见性**：后台可以观察 run 摘要、工具错误、额度消耗和订单，不应提供浏览用户本地私有文件、完整本地 prompt 或完整工具输出的入口。
- **密钥边界**：provider key 仍只在云端环境变量中配置，不下发给 client 或 Local Harness。

本地开发 Local Harness：

```bash
cd local-host
npm install
npm run browser:install
SHEJANE_LOCAL_HOST_TOKEN=dev-local-token npm run dev
```

Electron client 连接本地 Host：

```bash
cd client
SHEJANE_LOCAL_HOST_URL=http://127.0.0.1:17371 \
SHEJANE_LOCAL_HOST_TOKEN=dev-local-token \
npm run electron
```

连接云端模型网关：

```bash
cd local-host
SHEJANE_LOCAL_HOST_TOKEN=dev-local-token \
SHEJANE_CLOUD_BASE_URL=http://localhost:8080 \
SHEJANE_CLOUD_ACCESS_TOKEN=用户 access token \
npm run dev
```

上面的 `SHEJANE_CLOUD_ACCESS_TOKEN` 只用于无 UI 调试或 smoke。Electron 手动测试推荐走正常登录流程：

```bash
make dev-electron
```

这条命令会用 `docker compose up -d --build` 在后台启动云端控制面，启动 Local Host，使用隔离端口 `55173` 启动 client dev server，最后打开 Electron。关闭 Electron 窗口后，本次脚本启动的本地 helper 进程会自动退出；Docker 栈可用 `make docker-down` 关闭。如果你已经手动启动 API，可以用 `SKIP_DOCKER=1 make dev-electron` 只启动 Local Host、client dev server 和 Electron。

登录成功后，client 会调用 `POST /local/v1/session` 注入短期云端 session。Local Host 不会把 access token 写入 SQLite、diagnostics 或 API 响应；`GET /local/v1/session` 只返回是否已连接、cloud base URL 和更新时间。

托管浏览器环境变量：

```dotenv
SHEJANE_LOCAL_MAX_STEPS=
SHEJANE_LOCAL_STEP_WARNING_INTERVAL=20
SHEJANE_BROWSER_ENGINE=playwright
SHEJANE_BROWSER_HEADLESS=true
SHEJANE_BROWSER_TIMEOUT_MS=15000
SHEJANE_BROWSER_SEARCH_URL=https://cn.bing.com/search?q={query}
SHEJANE_ALLOW_PROXY_FAKE_IPS=true
```

`SHEJANE_LOCAL_MAX_STEPS` 是可选硬安全阀。默认留空，表示不按工具轮数硬停止，Local Harness 会像 Claude Code 风格的交互式 loop 一样持续运行直到模型给出无工具最终答案、用户取消、权限暂停、额度/模型错误或显式配置的硬上限触发。设置为正整数时，达到上限会再发起一次不带工具的 finalization 调用，让模型基于已收集证据给出阶段性答案。`SHEJANE_LOCAL_STEP_WARNING_INTERVAL` 只发出软提醒和系统提示，不会停止 run；设为 `0` 可关闭。
默认 `headless=true`，避免 Electron 手动测试时额外弹出浏览器窗口；需要观察真实 Chromium 时可临时设为 `false`。
`SHEJANE_ALLOW_PROXY_FAKE_IPS=true` 用于兼容 Clash、Surge 等本地代理/TUN 的 fake-ip DNS（常见为 `198.18.0.0/15`）。如果部署在不使用本地代理的服务器环境，可以设为 `false`，让 SSRF guard 继续拦截该保留网段。

本地开发日志：

```bash
make logs-dev          # API / Local Host / client / 最近 LLM 错误快照
make logs-api          # 持续查看 Docker API 日志
make logs-local-host   # 持续查看本地 Harness 日志
make logs-client       # 持续查看 client Vite 日志
make logs-llm-errors   # 查看最近 LLM 调用和错误原因
```

如果 UI 里只看到 `Cloud LLM gateway returned HTTP ...`，优先运行 `make logs-llm-errors`。这会从 `llm_call_records.error_message` 里看到真实原因，例如 provider 400、额度不足、结算失败或上游模型错误。

如果 UI timeline 只显示“工具失败”但没有具体原因，打开 Local Host debug 日志：

```bash
SHEJANE_LOCAL_HOST_DEBUG=1 make dev-electron
make logs-local-host
```

`make dev-electron` 默认会用 `SHEJANE_LOCAL_HOST_DEBUG=1` 启动 Local Host，并把日志写到 `.dev-logs/local-host.log`。日志会输出 `tool.requested`、`tool.failed`、`verification.completed`、`run.budget_warning`、`run.failed` 等关键事件；工具参数中的 `query`、`text`、`content`、token、secret 和 API key 会被脱敏。排查网页能力时重点看：

- `cloud_session_required`：本地 `web.search` 需要登录后的 Cloud Tool Gateway session；Electron 正常登录后会自动注入。
- `web_search_disabled`：Cloud API 未配置 Tavily，`web.search` 不会暴露给模型；托管浏览器搜索 `browser.search` 仍可作为 fallback。
- `browser_page_required`：模型在未打开托管浏览器页面时调用了 read/snapshot/screenshot/scroll。
- `browser_open_failed` / `browser_search_failed`：通常是 Chromium 未安装、目标被 URL guard 拦截、DNS/网络失败或 Playwright 启动失败。
- `browser_http_error`：页面成功打开但 HTTP 状态是 4xx/5xx，例如搜索到的旧 API 已经 404；这是可恢复错误，模型应换来源或基于已有证据说明限制。
- `browser_empty` / `browser_login_required` / `browser_captcha_like`：页面打开了，但没有可用正文、要求登录或疑似验证码；模型应换来源或说明限制。
- `browser_duplicate_observation`：同一 run 内第三次重复相同搜索 query 或 URL open 被拦截；模型应换关键词、换来源或总结已有证据。
- `research_enough_sources`：已收集足够的可用非搜索页来源；模型应停止继续搜索/打开网页，直接基于已有来源回答。
- `research_search_budget_exhausted` / `research_navigation_budget_exhausted`：当前 run 已达到搜索或候选来源打开预算；模型应收束回答或说明仍缺少的证据。
- `run.output_guardrail`：最终回答声称已打开/读取/核实来源，但事件流里没有足够 `source.collected` 或最近 `browser.verify` 失败；Harness 会要求模型继续取证或明确说明限制。
- `browser_navigation_blocked`：点击后跳转到了被禁止的 localhost、私网或非 HTTP(S) 目标。
- `run.budget_warning`：`reason=long_running` 表示 run 已进入较长循环但仍会继续；`reason=max_steps_reached` 表示显式配置的 `SHEJANE_LOCAL_MAX_STEPS` 已触发，Harness 正在要求模型停止调用工具并基于已收集观察输出最终答案。
- `ssrf_blocked ... resolved_ips=198.18.x.x`：本机代理 fake-ip 被拦截；保持 `SHEJANE_ALLOW_PROXY_FAKE_IPS=true` 并重启 Local Host。

Phase 2.19-2.20 Electron 手动 smoke：

1. 运行 `make dev-electron` 并用普通用户登录。
2. 授权一个无敏感内容的本地测试工作区。
3. 让 Agent 搜索一个公开网页问题，要求它收集来源并在回答前验证页面证据。
4. 确认 timeline 出现 `搜索网页`、`阅读网页正文`、`验证网页`、`收集来源` 和最终回答。
5. 点击当前消息 timeline 的“诊断”，确认诊断面板只显示 run 状态、事件/权限/artifact 计数、最新 checkpoint 摘要和最近来源/验证/错误事件。
6. 点击“导出当前诊断”，确认下载的 JSON 不包含 artifact 正文或完整 checkpoint messages。

启用 Phase 2.22 云端工具网关搜索和本地 MCP：

```bash
# .env / API 环境，只给 Cloud API 读取
TAVILY_API_KEY=tvly-...
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_SEARCH_CREDITS=20

# Local Host 只保留本地 MCP 配置，不保存 Tavily / Stripe / AWS / LLM provider key
SHEJANE_MCP_ALLOWLIST=local-docs.safe.search,design-system.tokens.read
SHEJANE_MCP_SERVERS_JSON='{"local-docs":{"command":"node","args":["/absolute/path/to/local-docs-mcp.mjs"]}}'
```

`web.fetch` 不需要第三方 key，但会在请求前解析目标域名并阻止 localhost、私网、链路本地、多播和保留地址；HTTP 4xx/5xx 错误只返回短摘要，避免把大段错误 HTML/CSS 塞进模型上下文。`web.search` 当前只支持 Cloud Tool Gateway 上的 Tavily；Local Host 不再读取 `TAVILY_API_KEY` / `TAVILY_BASE_URL`，而是通过登录态向 `/api/v1/agent/tool-capabilities` 查询能力，并通过 `/api/v1/agent/tools/execute` 执行和扣费。`make dev-electron` 会读取项目根目录 `.env` 给 Docker/API 使用，但 Local Host、client 和 Electron 进程会用 allowlist 环境启动，避免继承 Tavily、LLM provider、Stripe 或 AWS secret。Cloud API 配置 Tavily 后，Local Harness 会优先引导模型用 `web.search` 做快速搜索发现，再用 `browser.open` / `browser.read` 打开和阅读真实来源；只有云端搜索不可用、不足够或需要操作搜索结果页时才回退到 `browser.search`。`mcp.call` 必须同时满足三层条件：模型请求的 `server.tool` 命中 `SHEJANE_MCP_ALLOWLIST`、本地用户批准 `permission.required`、`SHEJANE_MCP_SERVERS_JSON` 中存在对应 server 配置。MCP server 通过 stdio JSON-RPC 启动，Local Host 不会把 command、args、env 或 secret 回传给模型或 UI。

研究策略预算可用环境变量微调：

- `SHEJANE_RESEARCH_MAX_SEARCHES`：默认 `3`，超过后 `browser.search` 返回可恢复阻断。
- `SHEJANE_RESEARCH_MAX_SOURCE_NAVIGATIONS`：默认 `5`，超过后 `browser.open` / `web.fetch` 返回可恢复阻断。
- `SHEJANE_RESEARCH_TARGET_SOURCES`：默认 `2`，收集到足够非搜索页来源后阻止继续搜索/打开，要求模型基于已有证据回答。
- 调试时可运行 `make logs-local-host`，启动日志不应出现 `tavily_configured` 或任何 provider key；如果需要确认云端搜索是否可用，先登录 Electron，再看模型是否收到 `web.search` 工具，或用 admin 的“工具调用”页查看 `web.search` 记录。

Phase 2.15 通用工具原语：

- `fs.list`、`fs.read`、`fs.search`：只读工具，只能访问已授权 workspace 内路径。
- `fs.write`：写入 UTF-8 文本文件，只能写授权 workspace 内路径，每次都需要用户批准。
- `open.url`：用用户系统默认浏览器打开 `http` / `https` URL，每次都需要用户批准；不支持 `file://` 等本地协议，也不用于 Agent 网页研究取证。
- `open.file`：用系统默认应用打开授权 workspace 内文件，每次都需要用户批准。
- `clipboard.read`、`clipboard.write`：只处理纯文本，每次都需要用户批准。
- `task.verify`：用于验证文件存在、文件包含文本、URL 格式和布尔断言。

旧 `file.read`、`file.search`、`file.write` 仍保留，用于兼容已有 run 和测试；新模型提示会优先引导使用 `fs.*`。

Phase 2.17-2.20 Playwright 托管浏览器：

- `browser.search`：使用 `SHEJANE_BROWSER_SEARCH_URL` 在 Playwright 托管 Chromium 中打开搜索结果页，每次都需要用户批准。
- `browser.open`：在 Local Host 自己管理的 Playwright Chromium 中打开 `http` / `https` URL，每次都需要用户批准；请求前会做 DNS 校验并阻止 localhost、私网、链路本地、多播和保留地址。研究任务应使用 `browser.open` + `browser.read` 收集来源，而不是 `open.url`。
- `browser.read`：读取当前托管页面的标题、URL、meta 描述、正文和关键链接；长正文保存为 artifact，模型上下文只拿到来源元数据和 artifact 引用。
- `browser.verify`：验证当前托管页面是否包含期望文本、是否处于 usable 状态；验证失败是可恢复 observation，可按需保存页面截图 artifact。
- `browser.snapshot`：读取托管页面的标题、URL、可见文本、主要链接、表单、按钮和可交互元素 refs；只观察 Local Host 自己管理的页面，不读取用户已有 Chrome/Safari 标签。
- `browser.screenshot`：截取当前托管页面 PNG，并保存为本地 artifact；模型上下文只拿到 artifact id 和摘要，不直接塞 base64。
- `browser.click`、`browser.type`：按 snapshot 中的 `ref` 点击或输入，每次都需要用户批准；密码和一次性验证码输入会被阻止。
- `browser.scroll`：滚动当前托管页面并返回新的 snapshot，默认允许。
- `browser.close`：关闭当前托管浏览器 page/context/browser。
- `environment.observe`：读取基础本地环境元数据，例如平台、前台应用和窗口标题；每次都需要用户批准，不采集屏幕截图。
- 事件流会额外出现 `browser.observed`、`source.collected`、`environment.observed`、`ui.action.requested` 和 `ui.action.completed`，client 会显示为“观察网页”“收集来源”“观察环境”“请求操作”等普通用户文案。
- 当前消息 timeline 的“诊断”按钮会读取 `GET /local/v1/runs/{id}/diagnostics`，只展示状态、计数、最新 checkpoint 摘要和最近来源/验证/错误事件；不会展示 artifact 正文或完整 checkpoint messages。
- 浏览器观察会返回 `observation_status=usable|empty|http_error|blocked|login_required|captcha_like`；只有 usable 且不是搜索结果页的 `browser.read` / `browser.snapshot` 页面会进入 `source.collected`。页面头部普通“登录/注册”导航不会单独导致 `login_required`，只有显式要求登录、密码/登录表单或登录后查看类页面才会被判为登录页。
- 研究任务中如果模型误调用 `open.url`，Local Harness 会返回 `research_external_open_blocked`，不会请求权限，也不会打开用户系统浏览器。
- 研究任务中如果模型误用 `shell.run` 执行 `curl` / `wget` / URL 抓取，Local Harness 会返回 `research_shell_network_blocked`，要求改用 `web.search` / `web.fetch` 或 `browser.open` / `browser.read`。
- 同一 run 内第三次重复相同搜索 query 或打开相同 URL 会被拦截为可恢复 observation，避免模型在同一来源上绕圈。
- 默认使用 headless Chromium；调试时可设 `SHEJANE_BROWSER_HEADLESS=false`。首次使用前运行 `cd local-host && npm run browser:install` 安装 Chromium。
- CloakBrowser 只作为未来可选 engine 预留，不进入默认依赖，也不打包 binary。
- 本阶段不做提交订单、支付、发帖、发送邮件、读取用户现有浏览器标签页、Chrome extension/native messaging、屏幕 OCR 或系统设置修改。

测试本地 health：

```bash
curl http://127.0.0.1:17371/local/v1/health
curl -H "Authorization: Bearer dev-local-token" http://127.0.0.1:17371/local/v1/tools
```

注意：

- daemon 只应监听 `127.0.0.1`，不要绑定公网网卡。
- `SHEJANE_LOCAL_HOST_TOKEN` 是本机 pairing 材料，不应写入仓库、日志或云端后台。
- Phase 2.22 已实现 `time.now`、授权 workspace 内 `fs.list` / `fs.read` / `fs.search` / `fs.write`、旧 `file.*` 兼容工具、`open.url` / `open.file`、`clipboard.read` / `clipboard.write`、`task.verify`、Playwright 托管 `browser.search` / `browser.open` / `browser.read` / `browser.verify` / `browser.snapshot` / `browser.screenshot` / `browser.click` / `browser.type` / `browser.scroll` / `browser.close`、`source.collected` 来源展示、重复浏览保护、研究策略预算、`environment.observe`、`shell.run` 权限确认、云端 `/api/v1/agent/llm` 扣费入口、云端 `/api/v1/agent/tools/execute` 非 LLM 工具扣费入口、长工具输出 artifact、checkpoint resume、上下文压缩、基础本地 memory、规则验证事件、`web.fetch`、Cloud Tool Gateway 计费版 `web.search`、MCP allowlist + stdio runtime adapter、并发安全工具批处理、模型失败 durable handling，以及 client/admin 侧工作区选择/授权/诊断/撤销、本地项目引用、最近 run 恢复、当前 run 诊断面板、脱敏诊断导出、权限批准/拒绝、artifact 预览、验证结果展示和 admin 工具调用只读观察。
- Local Host 会拒绝未授权的 `workspace_path`，因此本地文件和 shell 工具必须先经 `POST /local/v1/workspaces` 授权工作区。
- 诊断导出默认不包含 artifact 正文或完整 checkpoint messages；仍未实现诊断包导入/回放、IDE 控制、屏幕/app 控制、桌面 OCR 或 LLM-as-judge 视觉裁判。

## 自动化测试与 Smoke

石间的默认测试按“本地确定性优先”设计：PR 和本机默认命令不依赖真实 LLM、Stripe、S3、Tavily 或外网。真实服务只通过显式 smoke 验证。

常用命令：

```bash
make test          # 4 个单元套件（Go + client + admin + daemon），快
make test-race     # go test -race（账本等并发竞态）
make test-e2e      # Playwright 模拟 E2E
make test-contract # client ↔ daemon 真实 HTTP 契约往返
make ci            # 本地跑一遍 CI 的全部（推 PR 前的总门禁）
```

含义：

- `make test`：运行 API Go test、client/admin Vitest、Local Host Vitest。适合日常开发中频繁跑。
- `make test-race`：`go test -race ./...`，专门抓信用账本这类并发竞态。CI 的 `test` job 跑它（已涵盖普通 Go run，不再重复跑非 race 版）。
- `make test-e2e`：运行 `e2e/` Playwright Chromium simulated E2E。测试会启动隔离的 client/admin dev server（默认 `55173/55174`），并用 route mocking 模拟 API、S3 PUT、Agent SSE 和 Local Host loopback API。
- `make test-contract`：在专用端口 `:17399` 启动一个真实 daemon，用 TypeScript client 跑契约套件（真 HTTP，无 MockTransport），抓 client↔daemon 的 shape drift。
- `make ci`：把 CI 的全部检查在本地跑一遍 —— `lint` + 单元 + race + build + e2e + contract。`make test-ci` 是它的兼容别名。
- `make smoke-local-host`：启动真实 Local Host daemon，检查 `/health`、未配对 `/tools` 返回 401、配对后工具列表包含 `mcp.call`，并创建/stream 一个 deterministic local run。
- `make smoke-docker-local`：用 disposable Docker Compose project 启动 API/client/admin/postgres，强制 `MOCK_LLM=true`，验证注册、mock chat 扣额度和 admin overview。默认端口是 API `18080`、client `15173`、admin `15174`，避免影响普通开发栈。

CI（`.github/workflows/ci.yml`）现在拆成 4 个并行 job：`lint` / `test`（单元 + race + build）/ `e2e`（Playwright）/ `contract`（真实 daemon 往返）。拆开后，一个浏览器抖动不会再淹没单元信号，每个失败也各自成独立的 PR check。

真实服务 smoke：

```bash
RUN_EXTERNAL_SMOKE=1 make smoke-external
```

`RUN_EXTERNAL_SMOKE=1 make smoke-external` 会串联：

- `make smoke-real-llm`：要求 API 已用 `MOCK_LLM=false` 和真实 provider key 启动。
- `make smoke-stripe-webhook`：合成 Stripe webhook 并验证订阅状态生命周期。
- `make smoke-s3-document`：创建文档 presigned upload，向真实 S3 PUT 一个小 PDF source object，并通过文档删除接口做 best-effort 清理。

注意：

- 不要把真实 provider、Stripe、AWS 密钥写入仓库；CI 的 External Smoke workflow 只通过 GitHub Secrets 注入。
- Docker smoke 会使用独立 `COMPOSE_PROJECT_NAME=shejane_smoke` 并在退出时 `down -v` 清理；不要把它指向正在使用的生产或日常开发 Compose project。
- Playwright E2E 只验证用户可见行为和关键网络契约，不替代 API/Local Host 单元与集成测试。
- 外部 smoke 可能消耗 LLM 额度、创建 Stripe test object、写入 S3 dev bucket，不应放进每次 PR 的默认门禁。

## 常用管理命令

查看 API 日志：

```bash
docker compose logs -f api
```

查看数据库记录：

```bash
docker compose exec postgres psql -U shejane -d shejane
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

## 生产部署（GHCR 镜像 + docker-compose.prod.yml）

生产采用「CI 构建镜像 → 服务器拉取运行」的模式，不在服务器上从源码构建。Local Agent Harness daemon 不在此发布——它随 Electron 桌面端分发，不是服务端容器。

**发布镜像（在开发机）**

```bash
make release VERSION=v0.1.0
```

会校验工作区干净、当前在 `main`，然后打 annotated tag 并推送。推 tag 触发 `.github/workflows/release.yml`：用 buildx 把 `api` / `client` / `admin` 构建成多架构（amd64 + arm64）镜像并推到 GHCR：

- `ghcr.io/jimmyrogue/shejane-api:v0.1.0`（同时打 `latest`）
- `ghcr.io/jimmyrogue/shejane-client:v0.1.0`
- `ghcr.io/jimmyrogue/shejane-admin:v0.1.0`

`client` / `admin` 用**空的 `VITE_API_BASE_URL`** 构建，因此发出相对、同源的 `/api/*` 请求，由 Caddy 路由到 `api`——一套镜像适用于任意域名，无需为每个部署重建。

**服务器首次部署**

```bash
# 1. 准备 .env（见 .env.example 的 “M. Deployment” 段）。至少改：
#    JWT_SECRET（强随机）、CONFIG_ENCRYPTION_KEY（32B hex，加密落库的
#    provider key；不设则明文存库）、POSTGRES_PASSWORD（别留默认 shejane）、
#    MOCK_LLM=false、COOKIE_SECURE=true、
#    CLIENT_BASE_URL / ADMIN_BASE_URL（真实 https 域名）、
#    APP_DOMAIN / ADMIN_DOMAIN、IMAGE_TAG（钉到发布版本，别留 latest），
#    以及 provider / Stripe / S3 凭据。
cp .env.example .env

# 2. 把 APP_DOMAIN / ADMIN_DOMAIN 的 DNS A 记录指向本机。

# 3. 拉镜像 + 起栈（迁移由 migrate 服务在 up 时自动执行）。
make deploy
```

`make deploy` = `docker compose -f docker-compose.prod.yml pull && up -d`。Caddy 在 80/443 终止 TLS（首次访问真实域名时自动签发 Let's Encrypt 证书，联系邮箱在 `Caddyfile` 的全局 `email`，可用 `ACME_EMAIL` 覆盖），把 `APP_DOMAIN` 路由到 `client`、`ADMIN_DOMAIN` 路由到 `admin`，两者的 `/api/*` 都转给 `api`。

> **首启前必须就位（否则会播成 mock / 明文 / 假结账）：**
>
> - **provider key 和 `CONFIG_ENCRYPTION_KEY` 必须在第一次 `make deploy` 之前就写进 `.env`。** 模型注册表只在「空表首启」时从 env 播种；若首启时 key 为空，`chat.fast`/`chat.deep` 会播成 **mock（假回复）**，之后再往 `.env` 加 key **无效**（表非空不再播种，见 `seed.go` 的 `count>0` 提前返回），只能去后台「模型配置」逐槽位改。`CONFIG_ENCRYPTION_KEY` 未设则 provider key **明文**落库（仅启动告警）。
> - **（开计费时）`STRIPE_PRICE_ID` / `STRIPE_SECRET_KEY` 不能留空** —— 否则结账走 dev 假成功路径（伪造 `dev_` 会话、不扣款、不发 webhook、不发放 credits），前端却显示「订阅成功」。不开计费可忽略。
> - `IMAGE_TAG` 在 `.env` 钉到具体版本；否则后续某次裸 `make deploy` 会漂回 `latest`。

常用：

```bash
make deploy IMAGE_TAG=v0.1.0   # 固定到某个发布版本（默认 latest）
make deploy-logs               # 跟踪日志
make deploy-down               # 停栈（保留数据卷）
```

数据（Postgres）落在命名卷 `postgres-data`，`deploy-down` 不会删它；要彻底清空需 `docker compose -f docker-compose.prod.yml down -v`（危险）。Postgres、client、admin 都不对外暴露端口，只有 Caddy 的 80/443 和 api 的 `127.0.0.1:8080`（给本机反代或巡检用）对外可达。

**备份与恢复**：持久卷不等于备份。仓库提供：

```bash
make backup                         # = scripts/backup-db.sh：导出到仓库外 + 自动拷到 S3
make backup-cron-install            # 装每日 03:00 的 cron（幂等），日志写 ~/shejane-backup.log
make deploy-restore BACKUP=<文件>    # 从某个 .sql.gz 覆盖当前库（需输入 yes 确认）
```

`scripts/backup-db.sh` 做三件事：① `pg_dump` → gzip 到 **`$HOME/shejane-backups/`（仓库之外）**，绝不落进 repo；② 本地按 `SHEJANE_BACKUP_KEEP`（默认 14 份）滚动保留；③ 机器上有 `aws` CLI 且 `.env` 配了 `S3_BUCKET` 时，自动 `aws s3 cp` 到 `s3://$S3_BUCKET/db-backups/` 并同样滚动保留 —— **这一步才让它成为「异地备份」**（同机快照不算备份）。缺 aws/桶时只警告、仍保留本地快照，不会让 cron 失败。

上线必做：服务器装 AWS CLI（Amazon Linux：`dnf install -y awscli`）并确认 `.env` 有 `S3_BUCKET` + `AWS_*` → `make backup` 手跑一次验证本地产物 + S3 对象都出现 → `make backup-cron-install` 装上每日定时 → **定期做恢复演练**（把某个 `.sql.gz` 拉到临时机 `make deploy-restore` 验证能还原，没演练过的备份不算数）。

> ⚠️ 旧的「导出到当前目录」已改为写仓库外。注意迁移是**只进不退**、每次 `up` 全量重跑且无版本表，因此镜像回滚 **不会** 回滚数据库；破坏性 schema 变更只能从备份恢复，切勿用 `down -v` 当恢复手段。

## 生产上线检查

上线前至少确认：

- `JWT_SECRET` 已替换为强随机值，`COOKIE_SECURE=true`，`MOCK_LLM=false`，`CLIENT_BASE_URL` 和 `ADMIN_BASE_URL` 是真实 HTTPS 域名（与浏览器 Origin 精确一致、无尾斜杠）。
- `CONFIG_ENCRYPTION_KEY` 已设（32B hex），且 provider key 在**首次 `make deploy` 前**已入 `.env`（否则模型注册表会播成 mock，只能后台逐槽位改）。
- `POSTGRES_PASSWORD` 已从默认 `shejane` 改掉；`IMAGE_TAG` 已在 `.env` 钉到具体发布版本（非 `latest`）。
- `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_ID` 已在部署平台 secret 中配置，不写入仓库（任一缺失会让结账走 dev 假成功路径）。
- Stripe webhook endpoint 已订阅事件列表，Dashboard 中最近一次投递为 2xx。
- 忘记密码邮件:`RESEND_API_KEY` + `MAIL_FROM_ADDRESS`(Resend 已验证的发件域名)已配置;否则 API 只把重置链接打到日志、不真正发信。重置链接指向 `CLIENT_BASE_URL`(网页端 `/reset?token=`)。
- 数据库备份方案已就位：`make deploy-backup` 能跑通且产物已拷到异地（持久卷不是备份）。
- `make ci` 通过；本地或预发环境按需跑过 `RUN_EXTERNAL_SMOKE=1 make smoke-external`。
- 管理员只能通过 `ADMIN_EMAILS` 创建/提权，生产后台域名只开放给可信运营人员。

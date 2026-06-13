# 石间 / SheJane 运维与管理手册

Updated: 2026-06-11

## 当前管理边界

SheJane 长期采用 Local Agent Harness + Cloud Control Plane。普通用户 client 与 admin web 分开构建、分开部署：

- 用户与额度：PostgreSQL 是唯一真实来源；后台可启用/禁用用户，可调整 `extra_credits_balance`。
- 模型调用：后端保存调用 metadata、provider、model、token 与 credits，不保存完整聊天正文；后台只读展示调用记录。
- 支付与订阅：后台只读展示订单、Stripe session/subscription 和钱包订阅状态；真实支付、退款、补单仍由 Stripe Dashboard 管理。
- 模型/provider：后台「模型配置」页可**新增/编辑/启停/删除** chat 模型、provider、上游模型名、输入/输出 token 费率、生图每次金额，并设置全局计费参数（加价系数 + 基准每 token 成本）；保存即时生效，**不再依赖 `.env` 重启**。API key 加密存储（`CONFIG_ENCRYPTION_KEY`）且永不回显，仅显示「key 已配置」。`.env` 的 provider 变量仅作**首次空库的种子**。
- 审计：账号状态变更、额外额度调整和关键账务 webhook 都会写入 `audit_logs`，额度调整还会写入 `wallet_transactions(type=admin_adjust)`。
- Local Agent Harness：完整路线见根目录 [`spec.md`](../spec.md)。云端负责账号、额度、模型网关、文档服务、admin 和审计；Local Harness 负责 12 个 harness 组件、本地工具、文件、终端、浏览器、IDE、本地 MCP、checkpoint 和 artifact。
- Agent Run：普通聊天和附件问答会创建短期 `agent_runs` / `agent_events`。后台只展示摘要、状态和错误，不展示完整用户输入或文档正文。

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

## 模型配置（后台模型目录）

模型 provider / 模型名 / API key / token 费率不再从 `.env` 读取并需要重启。`.env` 的 `FAST_PROVIDER_*` / `DEEP_PROVIDER_*` / `ANTHROPIC_API_KEY` 等变量**只在首次空库启动时作为 `chat.fast` / `chat.deep` 种子**写入 `model_configs` 表；之后一切以后台「模型配置」页为准，保存即时生效（同进程立即、其它实例 ≤30s 收敛）。另外，API 会补齐一组默认停用的 OpenRouter 推荐模型模板，方便管理员启用主流厂商模型。

新增一个 `.env` 变量用于密钥加密：

```dotenv
CONFIG_ENCRYPTION_KEY=任意足够强的口令（用于 AES-GCM 加密落库的 model API key）
```

未设置时 key 以明文存库并在启动打 WARN（MVP 可接受，生产务必设置）。

**在后台配置（推荐路径）**：admin → 模型配置 →

- **模型 ID**：chat 模型可自由填写稳定 ID，例如 `gpt-4o`、`claude-sonnet`、`deepseek-v4`、`chat.fast`。`auto` 和 `auto.` 前缀是系统保留值（`auto.fast` / `auto.smart` 是用户端 Auto 意图 sentinel），不能作为后台模型 ID；当前 DB 字段仍叫 `slot`，这是历史字段名，产品语义按「模型 ID」理解。
- **显示名 / 厂商 / 厂商简介 / 能力档位 / 描述 / 优先级**：显示名是用户端模型选择器看到的名称；厂商用于把用户端模型列表按 DeepSeek、Xiaomi、ChatGPT、Claude、MiniMax、Kimi 等分组；厂商简介用于厂商名后 info 图标的悬浮提示，支持后台编辑；能力档位支持 `fast` / `balanced` / `reasoning` / `max`。Auto 会先按用户问题难度筛选档位，再扣入最近 30 分钟 `llm_call_records` 的失败率/延迟和模型输入/输出 token 费率；用户端「更快」发送 `auto.fast`，优先 `fast/balanced` 候选；「更强」发送 `auto.smart`，优先 `reasoning/max` 候选。三者都继续复用同一健康/成本/priority 排序和 classifier。
- **Provider 配置**：每行填写 provider 类型（`deepseek-v4`/`openai-compatible`/`anthropic`/`mock`）、Base URL、模型名、API key（只写，留空保持原值）。AWS 或其它渠道先通过兼容网关按 `key + base_url + model_name` 接入。
- **Token 费率**：每行填写相对 DeepSeek Pro 的基础倍率、输入 token 费率、输出 token 费率；缓存命中/缓存写入费率可配置但目前仅作为 provider usage 细分接入的兼容预留。留空或 0 的新费率字段会回退到基础倍率，旧 `credit_multiplier` 行不会失效。
- **Anthropic 扩展思考**：Anthropic 行可在 `params` 里配置 `max_tokens`、`thinking_type`、`thinking_budget_tokens`、`thinking_display`、`thinking_effort`。手动预算示例：`{"max_tokens":8192,"thinking_type":"enabled","thinking_budget_tokens":2048,"thinking_display":"summarized"}`；Claude 新模型推荐：`{"max_tokens":16000,"thinking_type":"adaptive","thinking_display":"summarized","thinking_effort":"medium"}`。返回的 `thinking` / `thinking_delta` 会统一映射成现有 `llm.reasoning` 事件；`thinking_display:"omitted"` 会减少可展示思考内容。
- **生图配置**：image capability 当前固定模型 ID 为 `image.default`，不会出现在用户端聊天模型选择器；生图行另填「每次金额」。
- 全新/空库首启会自动种子：`chat.fast`=deepseek-v4-flash(输入/输出费率 0.1、档位 fast)、`chat.deep`=deepseek-v4-pro(输入/输出费率 1.0、档位 reasoning)、计费参数 加价系数 1.15 / 基准每 token 成本 0.00002 cny。**现有库不会被覆盖**，需手动调。
- OpenRouter 推荐模板会在缺失时补齐，默认 `enabled=false`，包括 DeepSeek V4 Flash/Pro、Mimo V2.5、MiniMax M3、GPT-5.5、Claude Opus 4.8、Kimi K2、Qwen3 Coder、Gemini 3.1 Pro 等。它们是可编辑模板，不会在未启用或未配置 key 时出现在用户聊天选择器。
- `chat.fast` / `chat.deep` 的 env 种子条件仍是「`model_configs` 整表为空」(`EnsureSeed`，`count==0`，见 `api/internal/modelreg/seed.go`)。因此若在后台把**全部模型配置删光**导致整表清空，下次重启会再次从 `.env` 种子。**即便已迁到后台管理，也不要从 `.env` 删除** `FAST_*` / `DEEP_*` / `ANTHROPIC_*`：它们仍作首启种子，并在 resolver 找不到启用行时作为兜底（`router.go` → `app.go` 静态 provider）。请求时模型选择走 DB（`Router.Select` 优先咨询 `registry.Resolve`），env 仅在上述两种情况被读取。
- `/api/v1/agent/llm/stream` 若某个模型上游失败，会把该次 reservation release 并把该 LLM call 记为 `failed`，然后按同一 Auto 排序选择下一候选重试一次；降级会通过 `llm.model_selected` SSE 映射为前端的 `model.selected`，所以用户仍能看到「Auto/当前模型 → 新模型」而不是静默换模。若降级模型也失败，才返回 `llm.error`。

真实模型 smoke 仍可用：

```bash
make smoke-real-llm
```

## Local Host MCP / Skills 管理

桌面端「MCP」和「技能」页可以直接管理 SheJane 自己的配置源：

- MCP 新增/编辑/删除只写 `~/.shejane/mcp-servers.json`。Claude Desktop、Cursor、Codex、环境变量来源仍是只读发现源，只能在原工具里改。
- Skills 新增/编辑/删除只写 `~/.shejane/skills/<name>/SKILL.md`。`~/.claude/skills` 或 `SHEJANE_LOCAL_SKILLS_PATH` 发现到的外部 skill 仍只读。
- MCP catalog 只回显 `env_keys`，不会把 `env` 的值返回给 renderer。若需要密钥型 MCP server，应在新增表单外手动补好本机环境变量或由后续安全输入 UI 接入。

## 计费模型（统一 credits）

最终扣费统一用 credits：

```
文本：credits = (input_tokens × 输入费率 + output_tokens × 输出费率) × 全局加价系数      （下限 1，估算下限 300）
生图：credits/张 = ceil(每次金额 ÷ 基准每 token 成本 × 全局加价系数)，× 张数
```

- 文本调用的预留估算会计入完整 request 形状：message content、reasoning、tool call 参数、工具 name / description / inputSchema。真实结算仍优先使用 provider 返回的 token usage；provider 未返回 usage 时才使用本地估算 fallback。
- Anthropic provider 会在 Go 模型网关内为长 request 自动加顶层 `cache_control={"type":"ephemeral"}`，利用 Claude prompt caching 复用 `tools` / `system` / `messages` 的稳定前缀。Local daemon 不写 provider-specific cache 标记，也不需要旧版 beta header；真命中率只能通过真实 Anthropic usage 字段验证。
- **Token 费率**（每模型）= 该模型相对 **DeepSeek-V4-Pro** 的纯成本比，不含利润。种子里的 `chat.deep`=Pro=基准=**1.0**；`chat.fast`=Flash≈**0.1**（约为 Pro 的 1/10）；更贵的模型按真实输入价/输出价分别填写。旧 **基础倍率** 仍作为兼容兜底。
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
3. 在普通聊天 composer 的“上传附件”入口上传一个或多个 PDF / DOCX / XLSX。
4. 确认 bucket 中出现 `documents/<user_id>/<document_id>/source.*` 和 `extracted.txt`。
5. 附件显示 ready 后，在同一个 composer 发送问题，确认真实 LLM 回复、额度减少、管理后台用量可见。
6. 在 admin 的 Agent Runs 页确认能看到 run 摘要、状态、模式和用户邮箱。
7. 删除文档后，系统会 best-effort 删除 S3 原文件和文本对象。

边界说明：

- 上传和解析不扣额度；文档问答扣额度。
- 本阶段支持同一提问附加多个上传文档，并把每个文档的抽取文本注入同一个云端 agent run；仍不做向量库、团队文档库或 Local Host 本地文件读取。附件与工具的组合策略见 `docs/document-tool-policy.md`。
- 提取文本只保留前 `DOCUMENT_TEXT_LIMIT` 字符，避免超长 prompt 失控。
- 文档默认 7 天过期；当前没有后台手工延长或恢复入口。
- Agent Run 事件默认 7 天过期；当前没有后台重放、修改、取消已完成 run 的入口。

## Local Agent Harness 运维边界

SheJane 的目标不是让云端代替本地执行所有工具。运维上按两个平面理解：

- **Cloud Control Plane**：继续部署在现有 API/admin/postgres/S3/Stripe/LLM provider 链路里，保存账号、账务、provider 配置、文档临时对象、LLM metadata、run 摘要和审计。
- **Phase 2.2 云端兼容 run**：已提供 `POST /api/v1/agent/runs`、`GET /api/v1/agent/runs/{id}`、`GET /api/v1/agent/runs/{id}/events`、`GET /api/v1/agent/runs/{id}/stream`、`POST /api/v1/agent/runs/{id}/cancel`。Web 先使用这套协议；Local Harness 后续复用事件模型。
- **本地 Python daemon / harness**：`local-host/python` 提供 `GET /local/v1/health`、`GET /local/v1/tools`、`GET/POST/DELETE /local/v1/session`、`GET/POST /local/v1/workspaces`、`POST /local/v1/workspaces/diagnose`、`DELETE /local/v1/workspaces/{id}`、`GET/POST /local/v1/runs`、`GET /local/v1/runs/{id}`、`GET /local/v1/runs/{id}/stream`、`GET /local/v1/runs/{id}/diagnostics`、`POST /local/v1/runs/{id}/cancel`、`GET/POST /local/v1/schedules`、`DELETE /local/v1/schedules/{id}`、`POST /local/v1/schedules/{id}/notified`、`POST /local/v1/permissions/{request_id}`、`POST /local/v1/questions/{request_id}`、`GET /local/v1/artifacts/{id}`。除 health 外都需要 pairing token。当前 agent loop 由 Python/FastAPI + LangGraph/deepagents 运行，事件、checkpoint 和本机 schedule 存在本地 SQLite。
- **Local Agent Harness**：运行在用户本机，只通过短期 token 调云端模型网关和计费接口；本地文件、shell、IDE、MCP 结果默认留在本机。`web.search`、`image.*`、`pdf.inspect`、`code.execute` 等平台付费或云资源工具通过 Cloud Tool Gateway 代理，provider key 不进入 Local Host。`browser.task` 是未来浏览器自动化入口；未安装 `browser-use` 且未配置 browser LLM 时不会暴露给模型。
- **自我纠错栈**：plan-first、计划审批、tool critic、verification loop、progress ledger 和 reflect 的外部能力说明见 [`docs/self-correction-stack.md`](self-correction-stack.md)；底层时序仍以 [`docs/run-loop.md`](run-loop.md) 为准。
- **Admin 可见性**：后台可以观察 run 摘要、工具错误、额度消耗和订单；`GET /api/v1/admin/agent-runs/{id}/trace` 会按单个 run 聚合 run 摘要、事件、LLM 调用、Tool Gateway 调用和该 run 相关钱包流水，仍不提供浏览用户本地私有文件、完整本地 prompt 或完整工具输出的入口。
- **密钥边界**：provider key 仍只在云端环境变量中配置，不下发给 client 或 Local Harness。

本地开发 Local Harness：

```bash
cd local-host/python
SHEJANE_LOCAL_HOST_TOKEN=dev-local-token \
uv run shejane-local-host
```

Electron client 连接本地 Host：

```bash
cd client
SHEJANE_LOCAL_HOST_URL=http://127.0.0.1:17371 \
SHEJANE_LOCAL_HOST_TOKEN=dev-local-token \
npm run electron
```

自定义 subagent 可放在 `~/.shejane/agents/*.md`，也可以用 `SHEJANE_LOCAL_AGENTS_PATH=/path/a,/path/b` 完整覆盖扫描目录。每个文件使用 YAML frontmatter：

```markdown
---
name: reviewer
description: Review implementation diffs with a narrow evidence trail.
tools:
  - read_file
  - web.search
---

You are a focused reviewer. Return concrete findings with file and line evidence.
```

`name` / `description` / 正文都必填；`tools` 是对主 agent 当前工具集的白名单，未列出的工具不会暴露给该 subagent。同名配置会覆盖内置 `researcher` / `writer`。

连接云端模型网关：

```bash
cd local-host/python
SHEJANE_LOCAL_HOST_TOKEN=dev-local-token \
SHEJANE_CLOUD_BASE_URL=http://localhost:8080 \
SHEJANE_CLOUD_TOKEN=用户 access token \
uv run shejane-local-host
```

上面的 `SHEJANE_CLOUD_TOKEN` 只用于无 UI 调试或 smoke。Electron 手动测试推荐走正常登录流程：

```bash
make dev-electron
```

这条命令会用 `docker compose up -d --build` 在后台启动云端控制面，启动 Local Host，使用隔离端口 `55173` 启动 client dev server，最后打开 Electron。关闭 Electron 窗口后，本次脚本启动的本地 helper 进程会自动退出；Docker 栈可用 `make docker-down` 关闭。如果你已经手动启动 API，可以用 `SKIP_DOCKER=1 make dev-electron` 只启动 Local Host、client dev server 和 Electron。

登录成功后，client 会调用 `POST /local/v1/session` 注入短期云端 session。Local Host 不会把 access token 写入 SQLite、diagnostics 或 API 响应；`GET /local/v1/session` 只返回是否已连接、cloud base URL 和更新时间。

本地 harness 常用环境变量：

```dotenv
SHEJANE_LOCAL_HOST_TOKEN=dev-local-token
SHEJANE_CLOUD_BASE_URL=http://localhost:8080
SHEJANE_CLOUD_TOKEN=
SHEJANE_LOCAL_MAX_MODEL_CALLS=20
SHEJANE_LOCAL_MAX_HISTORY_TURNS=40
SHEJANE_LOCAL_MAX_MODEL_RETRIES=2
SHEJANE_LOCAL_MAX_TOOL_RETRIES=2
SHEJANE_LOCAL_INPUT_GUARD=observe
SHEJANE_PLAN_FIRST=off
SHEJANE_LOCAL_TOOL_SELECTOR_MAX=0
SHEJANE_LOCAL_TOOL_CRITIC=off
SHEJANE_LOCAL_VERIFY_REPAIR_MAX=1
SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX=3
SHEJANE_LOCAL_CRITIC=false
SHEJANE_LOCAL_BROWSER_HEADLESS=true
```

`SHEJANE_LOCAL_VERIFY_REPAIR_MAX` 控制验证回环：当 `task.verify` 明确返回 `ok=false` 且模型准备结束时，daemon 会最多跳回模型这几次，让模型修复后重新验证。设为 `0` 可关闭，超过 `3` 会被夹到 `3`，避免无限循环。`SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX` 控制用户点击“尝试修复”后创建的 repair run attempt 上限，默认 `3`，夹在 `0–5`；超过上限的 `metadata.intent=repair` run 会 fail-fast，发出 `repair.workflow(status=rejected)` 和结构化 `run.failed`，不会再调用模型。合法 repair run 会把 source run/message、attempt、原失败分类写进 `<state>`，并发出 `repair.workflow` started/completed/failed/canceled 事件；client 会按失败 `{conversation_id, assistant_message_id}` 给“尝试修复”和 quota checkout 创建请求加 in-flight guard，连续点击同一个修复或充值按钮不会创建重复 repair run 或多个 checkout session。`SHEJANE_LOCAL_BROWSER_HEADLESS` 只在未来 `browser.task` 真实接线时生效；当前未配置 browser LLM 时该工具不会出现在 `/local/v1/tools` 或 agent toolset 中。Local Host 的 step/model 上限由 `SHEJANE_LOCAL_MAX_MODEL_CALLS`（默认 20）和客户端 Advanced 设置控制，夹在 1–100 之间；新 run 带入的历史消息数由 `SHEJANE_LOCAL_MAX_HISTORY_TURNS` 控制，默认 40，夹在 1–200 之间，超出时 `<state>` 会提示省略了多少早期消息并附带确定性早期历史摘要；client 自己因消息数/字符预算省略更早对话时，也会在 omission marker 中附带短摘要，且该 marker 在 daemon 二次截断时会被保留为压缩锚点，不会被当成普通最旧消息吃掉。两端摘要都会保留开头/结尾摘录，并优先纳入中段包含“决定、必须、记住、decision、must、remember”等关键约束的 turn；这仍是无 LLM 的确定性摘要。模型网关失败重试由 `SHEJANE_LOCAL_MAX_MODEL_RETRIES` 控制，默认 2，夹在 0–5 之间，和诊断面板共用 `failure_policy` 分类：只重试 transient 或 unknown 且云端显式标记 `retryable:true` 的模型错误，quota/auth/configuration/workspace/validation/fatal 不会仅因响应里出现 `429` 或误带 `retryable:true` 就被自动重试；重试耗尽后会保留结构化 `run.failed`，不会伪装成普通 assistant 回答。工具失败重试由 `SHEJANE_LOCAL_MAX_TOOL_RETRIES` 控制，默认 2，夹在 0–5 之间，客户端 Advanced 面板也可以覆盖。`SHEJANE_LOCAL_RESEARCH_SEARCH_LIMIT` 默认 3，夹在 1–20 之间；`SHEJANE_LOCAL_TOOL_SELECTOR_MAX` 默认 0，夹在 0–50 之间，0 表示关闭。web build 的云端工具循环另有独立的 5-step cap，并且当前发送中的 web loop 可以通过 Stop 按钮中断。浏览器标签页关闭或刷新后留下的 client-generated web tool-loop `run_...` orphan `streaming` 消息，会在会话加载/刷新时自动收束为失败；server-backed cloud run 和 local run 不会被这条兜底清理。

本机定时任务：

- `POST /local/v1/schedules` 写入本地 SQLite 的 `local_scheduled_runs`，字段与普通 run 保持一致：`goal`、`workspace_path`、`model`、`history`、`settings`、`metadata` 和 ISO `run_at`。daemon 内置 `ScheduledRunDispatcher` 每 5 秒 claim 到期任务，并复用 `RunCoordinator.start_run()` 创建正常本地 run。
- dispatcher 会主动消费该 run 的 stream，避免没有前台 renderer 时 live queue 堵住；事件仍写入 `local_events`，后续诊断和恢复查看会从 SQLite replay。run 完成后 schedule 记录 `result_text`，失败记录 `error_message`；如果 run 暂停在权限或用户问题，schedule 会标记为 failed 并提示需要人工介入。
- Electron renderer 会轮询 `GET /local/v1/schedules?notify_pending=true`，收到 completed/failed schedule 后调用系统通知，再 `POST /local/v1/schedules/{id}/notified` 标记已提醒。当前是本机最小版：不做云端推送、不跨设备同步，也不替代普通 foreground run 的审批交互。

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

`make dev-electron` 默认会启动 Local Host 并把日志写到 `.tmp/dev/local-host.log`。日志会输出模型调用、工具调用、权限暂停、run 失败和 checkpoint 恢复等关键事件；工具参数中的 `query`、`text`、`content`、token、secret 和 API key 会被脱敏。排查网页/研究能力时重点看：

- `cloud_session_required`：本地 `web.search` 需要登录后的 Cloud Tool Gateway session；Electron 正常登录后会自动注入。
- `web_search_disabled` 或网关返回未配置：Cloud API 未配置 Tavily，`web.search` 会返回可恢复错误。
- `ssrf_blocked` / `web_fetch_blocked`：`web.fetch` 解析到 localhost、私网、链路本地、多播或保留地址，被 SSRF guard 拦截。
- `gateway_unreachable` / `gateway_transient_response`：Local Host 调 Cloud Tool Gateway 的 transport 层失败，或网关/反向代理返回非 JSON 的瞬态 HTTP 响应（429/500/502/503/504）。daemon 会按 `SHEJANE_LOCAL_MAX_TOOL_RETRIES` / `max_tool_retries` 通过统一 `failure_policy.build_retry_decision` 做有界指数退避重试，复用同一个 `tool_call_id` / idempotency key，避免瞬时网络抖动直接失败或重复扣费。Cloud Tool Gateway 返回结构化 tool result envelope 时默认不重试，因为它可能已经代表一次 provider 调用和账本/审计记录；如果该结构化失败显式带 `retryable:true`，并且工具在 retry allowlist 中、共享 failure policy 也判定为 transient/可重试，`ToolResultRetryMiddleware` 才会按同一工具重试预算重试。用户动作、配置、账单、工作区、参数校验或实现类错误即使误带 `retryable:true` 也不会被工具结果重试。没有显式 `retryable` 字段时，Local Host 会默认补 `retryable:false`。
- `llm.error`：云端模型网关返回的模型错误。Local Host 会把 `message`、`code` / `error_code`、`request_id`、`provider`、`recoverable`、`retryable` 和 `action_kind` 保留到 `run.failed` 和 `handoff.failure`；`action_kind` 会把它进一步标成 `retry`、`user_action`、`repair`、`operator_action` 或 `inspect`；模型重试同样通过 `failure_policy.build_retry_decision` 判定，所以错误显式 `retryable:false` 或字段冲突为 `recoverable:false` + `retryable:true` 时 daemon 不会重复调用模型；如果用户/配置/账单/工作区/参数/实现类错误误带 `retryable:true`，共享 failure policy 仍会保持非自动重试。
- `tool.failed`：看 `payload.tool`、`payload.content` 和 Local Host 日志里的异常类型，区分云 session、网关、路径、权限和模型错误；如果工具结果 envelope 明确返回 `ok:false`，Local Host 会按失败事件处理并保留 `error_code`、`recoverable`、`retryable`；白名单工具的 `{ok:false,retryable:true}` envelope 只有在共享 failure policy 判定可重试时，才会在进入最终事件/诊断前先做有界重试，仍失败才作为 `tool.failed` 暴露。诊断面板会把最近失败归类为 `transient`、`auth`、`quota`、`permission`、`configuration`、`workspace`、`validation`、`fatal` 或 `unknown`，并显示 `action_kind` 对应的本地化策略标签。`task.verify` 的最新机器可读结果另见 `handoff.verification`：如果后续验证已经通过，较早的 `task.verify` 失败不会继续作为当前 failure/blocker。
- `run.failed`：durable 终态。重启 daemon 后旧 `running` run 会被标记 failed，`waiting_permission` 和 `waiting_input` run 会保留为可 resume；`handoff.failure` 会给出最近失败的 `recoverable`、`retryable`、`action_kind` 和 suggested action。`retry` 类失败会在 runtime budget 内自动退避重试；`user_action` / `repair` / `operator_action` 类失败会 fail-fast 并留给 diagnostics / UI 引导，当前还不会在用户完成登录、充值、配置或授权后自动重跑。

Electron 手动 smoke：

1. 运行 `make dev-electron` 并用普通用户登录。
2. 授权一个无敏感内容的本地测试工作区。
3. 让 Agent 读写该工作区里的测试文件，确认写入动作触发权限卡，批准后继续运行。
4. 让 Agent 搜索一个公开网页问题，确认 `web.search` 经 Cloud Tool Gateway 计费并返回来源摘要；如果 Tavily 未配置，应看到可恢复工具错误而不是 daemon 直连第三方。
5. 点击当前消息 timeline 的“诊断”，确认诊断面板显示 run 状态、事件/权限/artifact 计数、交接摘要、最新 checkpoint 摘要和最近错误事件。
6. 点击“导出当前诊断”，确认下载的 JSON 不包含 artifact 正文或完整 checkpoint messages。

启用 Phase 2.22 云端工具网关搜索和本地 MCP：

```bash
# .env / API 环境，只给 Cloud API 读取
TAVILY_API_KEY=tvly-...
TAVILY_BASE_URL=https://api.tavily.com
TAVILY_SEARCH_CREDITS=20
WEB_TOOL_LOOP_MAX_STEPS=5

# Local Host 只保留本地 MCP 配置，不保存 Tavily / Stripe / AWS / LLM provider key
SHEJANE_MCP_ALLOWLIST=local-docs.safe.search,design-system.tokens.read
SHEJANE_MCP_SERVERS_JSON='{"local-docs":{"command":"node","args":["/absolute/path/to/local-docs-mcp.mjs"]}}'
```

`web.fetch` 不需要第三方 key，但会在请求前解析目标域名并阻止 localhost、私网、链路本地、多播和保留地址；HTTP 4xx/5xx 错误只返回短摘要，避免把大段错误 HTML/CSS 塞进模型上下文。`web.search` 当前只支持 Cloud Tool Gateway 上的 Tavily；Local Host 不再读取 `TAVILY_API_KEY` / `TAVILY_BASE_URL`，而是通过登录态调用 `/api/v1/agent/tools/execute` 执行和扣费。`GET /api/v1/agent/tool-capabilities` 是 web build 的云端工具发现来源：它返回 configured/provider/cost，也返回 LLM-facing `description` 和 `inputSchema`，所以 browser web loop 不再维护自己的工具 schema；同一响应还返回 `web_tool_loop_max_steps`（来自 `WEB_TOOL_LOOP_MAX_STEPS`，API 夹在 1-50），web client 撞到该段上限时会停在「继续 N 步？」确认卡，确认后用同一 `run_id` 和保存的模型/工具 history 继续下一段，后续模型与工具调用照常计费。Cloud gateway 工具的模型可见 schema 来源是 `api/internal/httpapi/cloud_tool_schemas.json`；Go API embed 这份 artifact，Local Host contract test 校验 Python BaseTool schema 覆盖同一字段。`web.search` 的模型可见参数名是 `max_results`，Go gateway 仍兼容旧 `maxResults`。`make dev-electron` 会读取项目根目录 `.env` 给 Docker/API 使用，但 Local Host、client 和 Electron 进程会用 allowlist 环境启动，避免继承 Tavily、LLM provider、Stripe 或 AWS secret。MCP server 通过 stdio / HTTP / SSE 配置接入；Local Host 不会把 command、args、env 或 secret 回传给模型或 UI。

研究策略预算可用环境变量微调：

- `SHEJANE_LOCAL_RESEARCH_SEARCH_LIMIT`：默认 `3`，夹在 `1`–`20` 之间，由 `ToolCallLimitMiddleware(tool_name="web.search")` 限制同一 run 内搜索次数。
- 调试时可运行 `make logs-local-host`，启动日志不应出现任何 provider key；如果需要确认云端搜索是否可用，先登录 Electron，再看模型是否收到 `web.search` 工具，或用 admin 的“工具调用”页查看 `web.search` 记录。

当前本地工具面：

- deepagents filesystem：`ls`、`read_file`、`write_file`、`edit_file`、`glob`、`grep` 和 `execute` 绑定到已授权 workspace 或默认 scratch 目录；`write_file`、`edit_file`、`execute` 每次都需要用户批准。`GET /local/v1/tools` 会列出这些当前运行时名称；`fs.*` 仍只是未来 primitive 规范里的目标词汇。
- `workspace.open`：授权一个本地工作区给后续 run 使用。
- `web.fetch`：只读 HTTP(S) 抓取，带 SSRF guard。
- `web.search`：通过 Cloud Tool Gateway 调 Tavily；daemon 不保存 Tavily key。
- `image.generate` / `image.edit`、`pdf.inspect`、`code.execute`：通过 Cloud Tool Gateway 调云端资源或沙箱；daemon 不保存 provider key。
- `open.url`：用用户系统默认浏览器打开 `http` / `https` URL，每次都需要用户批准；不支持 `file://` 等本地协议，也不用于 Agent 网页研究取证。
- `open.file`：用系统默认应用打开授权 workspace 内文件，每次都需要用户批准。
- `clipboard.read`、`clipboard.write`：只处理纯文本，每次都需要用户批准。
- `task.verify`：用于验证文件存在、文件包含文本、URL 格式和布尔断言。失败结果会触发有上限的验证回环，让模型先修复再尝试最终回答。
- `task.progress`：用于维护长任务进展账本，记录摘要、验收标准、关键决策、涉及文件、验证命令、未解决风险和下一步；写入本地 `progress_ledger` artifact，诊断面板展示最新一条，并在交接摘要里标记账本是 `not_required` / `fresh` / `missing` / `stale`。
- `environment.observe`：读取基础本地环境元数据，例如平台、前台应用和窗口标题；每次都需要用户批准，不采集屏幕截图。
- `memory.search`、`user.ask`、office read/write 工具和 MCP 工具按 run 设置接入。`memory.search` 只查询当前 workspace 的记忆 namespace；没有 workspace 的 run 使用 legacy global namespace。每个完成的 run 会写一条 `kind=run_note` 的短摘要；只有用户明确说 `remember...` / `记住...` 时才额外写 `kind=user_fact`，不会从普通对话或 assistant 回答里猜事实。完全相同的显式 `user_fact` 已存在时会跳过重复写入；语义相近但文本不同的事实仍不会自动合并。搜索结果会优先返回显式 `user_fact`，再返回自动 `run_note`，同类内部按 `updated_at` / `created_at` 较新优先。

浏览器自动化当前边界：

- `browser.task` 保留为未来 `browser-use` 接入口，但默认不暴露给模型。只有安装 `uv sync --extra browser` 并在 `build_agent` 传入真实 browser LLM 后，registry 才会把它加入 agent toolset。
- 当前消息 timeline 的“诊断”按钮会读取 `GET /local/v1/runs/{id}/diagnostics`，只展示状态、计数、交接摘要、最新失败分类、最新 `task.verify` 结果、最新进展账本、账本新鲜度、最新 checkpoint 摘要和最近来源/验证/错误事件；不会展示普通 artifact 正文或完整 checkpoint messages。
- 研究任务不应使用 `open.url` 作为取证路径；它会打开用户系统默认浏览器，适合用户可见跳转，不适合模型读取来源。取证应走 `web.search` / `web.fetch`。
- 研究任务中如果模型误用 shell/`execute` 执行 `curl` / `wget` / URL 抓取，应改用 `web.search` / `web.fetch`，这样 SSRF guard、工具预算和计费链路都在可控路径内。
- 未来若恢复 granular browser primitives（`browser.open/read/verify/snapshot/...`），需要先补 tool registry、权限策略、SSE timeline、诊断脱敏和测试覆盖，再写入本手册。
- 本阶段不做提交订单、支付、发帖、发送邮件、读取用户现有浏览器标签页、Chrome extension/native messaging、屏幕 OCR 或系统设置修改。

测试本地 health：

```bash
curl http://127.0.0.1:17371/local/v1/health
curl -H "Authorization: Bearer dev-local-token" http://127.0.0.1:17371/local/v1/tools
```

注意：

- daemon 只应监听 `127.0.0.1`，不要绑定公网网卡。
- `SHEJANE_LOCAL_HOST_TOKEN` 是本机 pairing 材料，不应写入仓库、日志或云端后台。
- 当前已实现 `time.now`、`environment.observe`、`open.url` / `open.file`、`clipboard.read` / `clipboard.write`、`task.verify`、`task.progress`、结束前进展账本刷新 guard、`workspace.open`、deepagents filesystem/shell 工具、office read/write、`web.fetch`、Cloud Tool Gateway 计费版 `web.search` / `image.*` / `pdf.inspect` / `code.execute`、MCP adapter、checkpoint resume、上下文压缩、按 workspace namespace 隔离的基础本地 memory、规则验证、权限批准/拒绝、artifact 预览、当前 run 诊断面板、脱敏诊断导出、模型失败 durable handling，以及 admin 工具调用只读观察。`browser.task` 和 granular browser primitives 仍是后续工作，未配置时不会暴露给模型。
- Local Host 会拒绝未授权的 `workspace_path`，因此本地文件和 shell 工具必须先经 `POST /local/v1/workspaces` 授权工作区。
- 诊断导出默认不包含普通 artifact 正文或完整 checkpoint messages；`handoff` 是从 run 状态、事件类型、权限和 artifact metadata 派生的交接摘要，并包含 `ledger_state` / `ledger_message` 来提示进展账本不需要、已更新、缺失或陈旧；`run.waiting` 也会携带同样的轻量 handoff snapshot，方便只看事件流时判断暂停点是否适合交接；`handoff.failure` 是当前仍需要动作的 `run.failed` / `tool.failed` 结构化分类，包含 `action_kind` 策略提示；completed run 中已经被后续成功事件恢复的普通工具失败不会继续作为当前 failure/blocker，但原始事件仍保留在事件列表和 recent event types 里；`handoff.verification` 是最新 `task.verify` 机器可读结果，后续通过会覆盖早先失败；`feature_ledger` 是最新 `task.progress` 进展账本的结构化摘要；`reflection` 是最新 checkpoint 里的轻量反思摘要，只包含消息/工具计数、最终回答长度和可选 critic 分数/notes/raw，不包含 checkpoint messages。仍未实现诊断包导入/回放、IDE 控制、屏幕/app 控制、桌面 OCR 或 LLM-as-judge 视觉裁判。

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

Nightly External Smoke 在 GitHub Actions 中会把缺失配置显式降级为 warning：

- 缺 `SHEJANE_API_BASE_URL` 时整套 external smoke 跳过，job summary 会说明原因。
- 缺 `STRIPE_WEBHOOK_SECRET` 时只跳过 Stripe webhook smoke；真实 LLM 和 S3 文档 smoke 仍会继续跑。
- 本地运行不受这个降级影响：`smoke-stripe-webhook.sh` 仍会在 shell 变量为空时尝试从当前目录 `.env` 读取 `STRIPE_WEBHOOK_SECRET`。

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
  run_id,
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
  run_id,
  request_id,
  status,
  estimated_credits,
  actual_credits,
  created_at,
  settled_at
from usage_reservations
where run_id is not null
order by created_at desc
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
  run_id,
  tool_call_id,
  tool,
  provider,
  status,
  credits_cost,
  error_code,
  started_at,
  finished_at
from external_tool_call_records
where run_id is not null
order by started_at desc
limit 20;

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

Release workflow 在每个镜像推送后会按 digest 做供应链守门：

- Trivy 扫描镜像 OS/library 漏洞；未修复的 HIGH / CRITICAL 漏洞会让 workflow 失败，阻止继续签名和发布 SBOM。
- Anchore Syft 生成 `spdx-json` SBOM，作为 workflow artifact 保存；tag 发布时还会附到同名 GitHub Release，文件名形如 `shejane-api-v0.1.0.spdx.json`。
- Cosign 使用 GitHub Actions OIDC 做 keyless 签名，把 `vX.Y.Z` 和 `latest` 两个 tag 对应的同一 manifest digest 都签入 GHCR。

`client` / `admin` 用**空的 `VITE_API_BASE_URL`** 构建，因此发出相对、同源的 `/api/*` 请求，由 Caddy 路由到 `api`——一套镜像适用于任意域名，无需为每个部署重建。

**服务器首次部署**

```bash
# 1. 准备 .env（见 .env.example 的 “M. Deployment” 段）。至少改：
#    JWT_SECRET（强随机）、CONFIG_ENCRYPTION_KEY（强随机 passphrase，加密落库的
#    provider key；不设则生产 API 直接启动失败）、POSTGRES_PASSWORD（别留默认 shejane）、
#    MOCK_LLM=false、COOKIE_SECURE=true、
#    CLIENT_BASE_URL / ADMIN_BASE_URL（真实 https 域名）、
#    APP_DOMAIN / ADMIN_DOMAIN、IMAGE_TAG（钉到发布版本，别留 latest），
#    以及 provider / Stripe / S3 凭据。
cp .env.example .env

# 2. 把 APP_DOMAIN / ADMIN_DOMAIN 的 DNS A 记录指向本机。

# 3. 拉镜像 + 起栈（迁移由 migrate 服务在 up 时自动执行）。
make deploy
```

`make deploy` = `docker compose -f docker-compose.prod.yml pull && up -d`。生产 compose 会给 API 注入 `SHEJANE_ENV=production`，因此 `JWT_SECRET` / `CONFIG_ENCRYPTION_KEY` 若为空、过短或仍是常见占位值，API 会 fail-fast 而不是带着弱配置启动。Caddy 在 80/443 终止 TLS（首次访问真实域名时自动签发 Let's Encrypt 证书，联系邮箱在 `Caddyfile` 的全局 `email`，可用 `ACME_EMAIL` 覆盖），把 `APP_DOMAIN` 路由到 `client`、`ADMIN_DOMAIN` 路由到 `admin`，两者的 `/api/*` 都转给 `api`。Caddy 会给 client/admin 静态站点设置 HSTS、CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy 和 Permissions-Policy；Go API 也会直接返回 API 侧安全头，避免绕过 Caddy 时裸奔。API 进程使用显式 `http.Server`：`ReadHeaderTimeout=5s`、`ReadTimeout=30s`、`IdleTimeout=120s`，收到 SIGINT/SIGTERM 时最多等待 10s graceful shutdown；`WriteTimeout` 保持 0，避免长 SSE / streaming 响应被服务器定时切断。

迁移由 API 镜像内置的 `/app/shejane-migrate` 执行，SQL 文件随同一 API 镜像发布在 `/app/migrations`。runner 会先创建 `schema_migrations`，再按文件版本顺序执行未应用版本；已应用且 checksum 一致的版本会跳过，checksum 与数据库记录不一致会 fail-fast，避免“改旧迁移文件后静默漂移”。首次升级到版本表 runner 的已有数据库会重放一次当前 idempotent 迁移并补齐版本记录，之后只执行新增迁移。`make migrate` 和 CI Postgres conformance 也使用同一个 runner。

> **首启前必须就位（否则会播成 mock / 明文 / 假结账）：**
>
> - **provider key 和 `CONFIG_ENCRYPTION_KEY` 必须在第一次 `make deploy` 之前就写进 `.env`。** `chat.fast`/`chat.deep` 只在「空表首启」时从 env 播种；若首启时 provider key 为空，会播成 **mock（假回复）**，之后再往 `.env` 加 key **无效**（表非空不再重写这两行），只能去后台「模型配置」逐模型配置改。推荐模型模板会按缺失补齐但默认停用，不会替代真实 key 配置。生产环境中 `CONFIG_ENCRYPTION_KEY` 未设或仍是弱占位值会让 API 启动失败；开发环境仍允许明文以便本地调试。
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

> ⚠️ 旧的「导出到当前目录」已改为写仓库外。迁移已有 `schema_migrations` 版本表，不会在每次 `up` 反复执行已成功版本；但迁移仍然是**只进不退**，镜像回滚 **不会** 回滚数据库。破坏性 schema 变更只能从备份恢复，切勿用 `down -v` 当恢复手段。

## 生产上线检查

上线前至少确认：

- `JWT_SECRET` 已替换为强随机值，`COOKIE_SECURE=true`，`MOCK_LLM=false`，`CLIENT_BASE_URL` 和 `ADMIN_BASE_URL` 是真实 HTTPS 域名（与浏览器 Origin 精确一致、无尾斜杠）。
- `CONFIG_ENCRYPTION_KEY` 已设为强随机 passphrase，且 provider key 在**首次 `make deploy` 前**已入 `.env`（否则模型注册表会播成 mock，只能后台逐模型配置改）。
- `POSTGRES_PASSWORD` 已从默认 `shejane` 改掉；`IMAGE_TAG` 已在 `.env` 钉到具体发布版本（非 `latest`）。
- `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_ID` 已在部署平台 secret 中配置，不写入仓库（任一缺失会让结账走 dev 假成功路径）。
- Stripe webhook endpoint 已订阅事件列表，Dashboard 中最近一次投递为 2xx。
- 忘记密码 + 邮箱验证邮件:`RESEND_API_KEY` + `MAIL_FROM_ADDRESS`(Resend 已验证的发件域名)已配置;否则 API 只把链接打到日志、不真正发信。重置链接指向 `CLIENT_BASE_URL/reset?token=`,验证链接指向 `CLIENT_BASE_URL/verify?token=`(都在网页端落地)。邮箱验证为 advisory(横幅提示,不拦登录);迁移会把已有用户回填为已验证。
- 数据库备份方案已就位：`make deploy-backup` 能跑通且产物已拷到异地（持久卷不是备份）。
- `make ci` 通过；本地或预发环境按需跑过 `RUN_EXTERNAL_SMOKE=1 make smoke-external`。
- 管理员只能通过 `ADMIN_EMAILS` 创建/提权，生产后台域名只开放给可信运营人员。

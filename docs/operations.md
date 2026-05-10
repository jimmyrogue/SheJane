# Jiandanly 运维与管理手册

Updated: 2026-05-10

## 当前管理边界

Phase 1.7 提供独立管理后台和账单生命周期加固。Phase 2 起产品方向调整为统一 Agentic Chat，长期采用 Local Agent Host + Cloud Control Plane。普通用户 client 与 admin web 分开构建、分开部署：

- 用户与额度：PostgreSQL 是唯一真实来源；后台可启用/禁用用户，可调整 `extra_credits_balance`。
- 模型调用：后端保存调用 metadata、provider、model、token 与 credits，不保存完整聊天正文；后台只读展示调用记录。
- 支付与订阅：后台只读展示订单、Stripe session/subscription 和钱包订阅状态；真实支付、退款、补单仍由 Stripe Dashboard 管理。
- 模型/provider：后台只读展示 fast/deep 当前 provider、base URL、model、mock/real 状态和 key 是否已配置，不显示也不修改 API key。
- 审计：账号状态变更、额外额度调整和关键账务 webhook 都会写入 `audit_logs`，额度调整还会写入 `wallet_transactions(type=admin_adjust)`。
- Agentic Chat：完整路线见根目录 [`spec.md`](../spec.md)。云端负责账号、额度、模型网关、文档服务、admin 和审计；未来 Local Agent Host 负责本地工具、文件、终端、浏览器、IDE 和本地 MCP。

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

Phase 2A 的文档能力使用真实 AWS S3，不在本地磁盘保存原文件。当前实现仍通过普通 client 的“文档阅读”页面测试；后续会把该流程合并进统一 Agentic Chat composer。`.env` 至少需要：

```dotenv
AWS_REGION=ap-east-1
AWS_ACCESS_KEY_ID=你的开发 IAM access key
AWS_SECRET_ACCESS_KEY=你的开发 IAM secret
S3_BUCKET=你的 dev bucket
S3_DOCUMENT_PREFIX=documents
DOCUMENT_MAX_BYTES=31457280
DOCUMENT_TEXT_LIMIT=60000
DOCUMENT_TTL_HOURS=168
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
3. 当前阶段切换“文档阅读”，上传 PDF / DOCX / XLSX；后续统一入口完成后，在同一个 composer 上传附件并提问。
4. 确认 bucket 中出现 `documents/<user_id>/<document_id>/source.*` 和 `extracted.txt`。
5. 对 ready 文档提问，确认真实 LLM 回复、额度减少、管理后台用量可见。
6. 删除文档后，系统会 best-effort 删除 S3 原文件和文本对象。

边界说明：

- 上传和解析不扣额度；文档问答扣额度。
- 本阶段只做单文件上下文，不做向量库、多文档 RAG、团队文档库或 Local Host 本地文件读取。
- 提取文本只保留前 `DOCUMENT_TEXT_LIMIT` 字符，避免超长 prompt 失控。
- 文档默认 7 天过期；当前没有后台手工延长或恢复入口。

## Agentic Chat 运维边界

Phase 2 的目标不是让云端代替本地执行所有工具。运维上按两个平面理解：

- **Cloud Control Plane**：继续部署在现有 API/admin/postgres/redis/S3/Stripe/LLM provider 链路里，保存账号、账务、provider 配置、文档临时对象、LLM metadata、run 摘要和审计。
- **Local Agent Host**：后续运行在用户本机，只通过短期 token 调云端模型网关和计费接口；本地文件、shell、浏览器、IDE、MCP 结果默认留在本机。
- **Admin 可见性**：后台可以观察 run 摘要、工具错误、额度消耗和订单，不应提供浏览用户本地私有文件、完整本地 prompt 或完整工具输出的入口。
- **密钥边界**：provider key 仍只在云端环境变量中配置，不下发给 client 或 Local Host。

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
- `make test` 和 `make build` 通过；本地或预发环境跑过 `make smoke-real-llm` 和 `make smoke-stripe-webhook`。
- 管理员只能通过 `ADMIN_EMAILS` 创建/提权，生产后台域名只开放给可信运营人员。

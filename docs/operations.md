# Jiandanly 运维与管理手册

Updated: 2026-05-10

## 当前管理边界

Phase 1.6 提供独立管理后台 MVP。普通用户 client 与 admin web 分开构建、分开部署：

- 用户与额度：PostgreSQL 是唯一真实来源；后台可启用/禁用用户，可调整 `extra_credits_balance`。
- 模型调用：后端保存调用 metadata、provider、model、token 与 credits，不保存完整聊天正文；后台只读展示调用记录。
- 支付与订阅：后台只读展示订单；真实支付、退款、补单仍由 Stripe Dashboard 管理。
- 模型/provider：后台只读展示 fast/deep 当前 provider、base URL、model、mock/real 状态和 key 是否已配置，不显示也不修改 API key。
- 审计：账号状态变更和额外额度调整都会写入 `audit_logs`，额度调整还会写入 `wallet_transactions(type=admin_adjust)`。

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
- 模型状态：只读展示 provider、base URL、model、mock/real 状态、API key 是否配置。

当前不支持：

- 不在后台保存、展示或修改 provider API key。
- 不手工修改订单状态，不做退款、补单或支付对账写操作。
- 不修改月额度、已用额度、plan code、订阅状态。
- 不做团队/组织后台、成员邀请、团队额度池或发票管理。

Provider key 不进入后台，是为了降低浏览器泄露、日志泄露和误操作风险。密钥继续由 `.env`、部署平台 secret 和供应商控制台管理；后台只显示布尔状态，便于判断当前 API 是否可能走真实 provider。

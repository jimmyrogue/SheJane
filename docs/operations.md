# Jiandanly 运维与管理手册

Updated: 2026-05-10

## 当前管理边界

Phase 1.5 不新增独立后台管理 UI。当前系统的管理方式是“运维控制台 + 数据库查询 + Stripe/供应商控制台”：

- 用户与额度：PostgreSQL 是唯一真实来源。
- 模型调用：后端保存调用 metadata、provider、model、token 与 credits，不保存完整聊天正文。
- 支付与订阅：本地没有 Stripe 密钥时使用 mock checkout；真实支付仍由 Stripe Dashboard 管理。
- 管理后台 UI：按产品计划属于团队版能力，建议放到 Phase 2 后半或 Phase 3/5，先做只读运营面板，再做团队管理。

## 本地启动

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps
```

访问：

- Web: `http://localhost:5173`
- API: `http://localhost:8080`
- Postgres: `localhost:15432`
- Redis: `localhost:16379`

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

## 后台管理系统建议

建议先不在 Phase 1.5 做管理台 UI，而是在后续拆成三步：

1. Phase 2A：只读运营面板，查看用户数、调用数、模型成本、额度消耗、失败率。
2. Phase 2B：账号与额度管理，支持人工发放额度、封禁/解封用户、查看单用户账本。
3. Phase 3+：团队管理后台，组织、成员、团队额度池、邀请、报表和发票信息。

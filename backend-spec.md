# 简单（Jiandan）后端技术方案

**版本：** v1.6
**更新：** 2026-05-11
**适用阶段：** Phase 1-5 分阶段落地

> **v1.6 更新说明：** Phase 2 方向升级为 Local Agent Harness。长期架构锁定为 Local Agent Harness + Cloud Control Plane：后端负责账号、额度、支付、模型网关、文档服务、admin、审计和云端兼容 Agent Run；本地 Harness 负责 12 个 harness 组件、本地工具、权限、MCP、文件/终端/浏览器/IDE 执行、checkpoint 和 artifact。完整规格见 [`spec.md`](spec.md)。

> **v1.4 更新说明：** 架构改为 Hybrid Local-first：后端不默认保存完整 prompt、response、messages；长期聊天历史由客户端本地保存。后端只保存账号、订阅、钱包账本、轻量模型调用记录、支付事件、分享快照和临时文件元数据。

> **v1.3 更新说明：** 删除当前阶段 BYOK 支持；移除 MVP 中的用户 API Key / 断线续传 / RAG / Office / 图片生成等重功能；计费改为包月额度为主、额外充值为补充，并引入钱包账本、额度预留、幂等支付事件和审计日志。

> **v1.2 更新说明：** 新增 Tool Calling / Agentic Loop 架构；引入 Office 文件自研生成层：Excel（Go + excelize）、Word（Go + XML 模板填充）、PPT（Python FastAPI sidecar + python-pptx）；所有 Office 能力完全自主实现，零外部 Office API 依赖，用户完全无感知。

> **v1.1 更新说明：** 基于竞品对比（LibreChat / Open WebUI / Lobe Chat / Chatbox）补充遗漏功能：对话搜索、对话分享、对话导出、多模态（Vision）、断线续传（Resumable Stream）、用户 API Key、Webhook、RAG 提前到 Phase 2、个人 Prompt 收藏、文件元数据表完善。

---

## 目录

1. [整体架构](#一整体架构)
2. [项目结构](#二项目结构)
3. [数据库设计](#三数据库设计)
4. [API 接口设计](#四api-接口设计)
5. [核心模块实现](#五核心模块实现)
   - 5.1 认证模块
   - 5.2 LLM 代理层
   - 5.3 计费层
   - 5.4 团队管理层
   - 5.5 Skill / Prompt 运行时层
   - 5.6 流式生成与恢复策略
   - 5.7 多模态 / Vision 支持
   - 5.8 RAG 知识库（Phase 4+ opt-in 云能力）
   - 5.9 Agentic Chat / Local Host 协作
   - 5.10 Office 文件自研实现（Phase 4）
   - 5.11 图片生成（Phase 4）
6. [中间件设计](#六中间件设计)
7. [错误处理规范](#七错误处理规范)
8. [部署方案](#八部署方案)
9. [开发规范](#九开发规范)
10. [交付清单](#十交付清单)

---

## 一、整体架构

### 1.1 架构图

Local Agent Harness 总体规格见 [`spec.md`](spec.md)。前端客户端的模块划分、Web/Electron 差异和未来 Harness 边界见 [`frontend-spec.md`](frontend-spec.md)。本后端文档只描述客户端和 Local Harness 调用后端时依赖的 API、数据模型和服务流程。

```
┌─────────────────────────────────────────────────────────┐
│                  客户端（Electron / Web）                  │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTPS / SSE
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  Cloudflare CDN + WAF                    │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                  Caddy（TLS 反向代理）                     │
│           jiandanly.com → localhost:8080                 │
└───────────────────────────┬─────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│              Go API Gateway（单体二进制）                  │
│                                                          │
│  Router (chi)                                            │
│  ├── /api/v1/auth/*          认证路由                    │
│  ├── /api/v1/user/*          用户资料与安全设置           │
│  ├── /api/v1/chat/*          模型网关（含 SSE）           │
│  ├── /api/v1/shared-conversations/* 分享快照（主动上传） │
│  ├── /api/v1/billing/*       计费路由                    │
│  ├── /api/v1/team/*          团队路由（Phase 5）          │
│  ├── /api/v1/agent/*         Agent Run / LLM Gateway     │
│  ├── /api/v1/template/*      模板路由（非 Phase 2 主线） │
│  ├── /api/v1/file/*          文件路由                    │
│  ├── /api/v1/knowledge/*     云知识库 / RAG 路由（P4+）  │
│  ├── /api/v1/webhooks/*      Webhook 管理路由（Phase 5）  │
│  ├── /api/v1/images/*        图片生成路由（Phase 4）      │
│  ├── /api/v1/payment/*       支付路由（Stripe Webhook）   │
│  ├── /s/:token               对话分享公开访问（免登录）   │
│  └── /health                 健康检查                    │
│                                                          │
│  中间件链（按顺序执行）                                    │
│  RequestID → Logger → Recovery → RateLimit → Auth       │
│                                                          │
│  核心服务                                                 │
│  ├── AuthService             JWT + bcrypt + OAuth        │
│  ├── LLMProxyService         SSE 流式代理 + 模型路由      │
│  ├── BillingService          包月额度 + 账本结算          │
│  ├── TeamService             组织 / 团队 / 成员管理（P5） │
│  ├── AgentService            Run / Event / Tool Summary  │
│  ├── TemplateService         Prompt 模板管理（后置）     │
│  ├── FileService             S3 上传 / 预签名 URL         │
│  ├── ShareService            对话分享 / 导出             │
│  ├── RAGService              文档向量化 / 语义检索        │
│  ├── WebhookService          事件推送                    │
│  ├── OfficeService           Office 文件自研生成          │
│  ├── ImageService            三档图片生成（快/标/精）      │
│  └── PaymentService          Stripe 集成                 │
└──────┬──────────────┬────────────────────┬──────────────┘
       │              │                    │
       ▼              ▼                    ▼
┌────────────┐  ┌─────────────────┐  ┌────────────────────────┐
│ PostgreSQL │  │  Redis 7        │  │  PPT Python Sidecar    │
│    16      │  │                 │  │  (FastAPI + python-pptx)│
│ + pgvector │  │ 限流计数器       │  │  localhost:5001         │
│            │  │ 短期流式缓存     │  └────────────────────────┘
│ 用户表      │  │ 验证码缓存       │
│ 团队表      │  │ 临时任务进度     │
│ 钱包账本    │  │ RAG 查询缓存    │
│ 支付事件    │  └─────────────────┘
│ 调用记录    │
│ 分享快照    │
│ 临时文件元数据│
│ Agent摘要   │
│ 知识库分片  │
│ Webhook配置 │
│ file_jobs   │
│ audit_logs  │
└────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│               LLM Providers（对话生成）                    │
│        DeepSeek │ Claude │ GPT-4o │ Qwen │ ...           │
│         统一 Provider 接口，ParseChunk 归一化 SSE 格式      │
└──────────────────────────────────────────────────────────┘
```

### 1.2 设计原则

- **单体优先**：MVP 阶段不做微服务，一个 Go binary 包含所有逻辑，运维极简
- **接口标准化**：对外暴露 OpenAI 兼容接口，方便客户端和后续开放平台复用
- **账务优先**：请求前预留额度，结束后结算；PostgreSQL 账本是唯一真实来源，Redis 只做缓存
- **本地优先**：长期聊天历史默认由客户端保存，后端不作为 prompt / response / messages 主存储
- **Harness 优先**：本地工具、MCP、文件、终端、浏览器、IDE、checkpoint、artifact 和恢复最终由 Local Agent Harness 承担；云端只做兼容 run、模型网关、计费和审计摘要
- **统一入口**：Phase 2 不再以场景模板拆分产品入口，普通聊天、附件问答、网页研究和任务执行都进入 Agentic Chat
- **故障隔离**：LLM 供应商故障不影响主服务，熔断后自动降级
- **数据主权**：用户数据可随时导出 / 删除，跨境处理和供应商转发需要明确告知
- **可观测性**：结构化日志 + 请求链路 ID，方便排查问题
- **自研 Office 生成**：Excel / Word 纯 Go 实现（excelize + XML 模板），PPT 由极轻量 Python sidecar（python-pptx）处理；三种格式全部自主掌控，不依赖任何外部 Office API

---

## 二、项目结构

```
jiandanly-api/
├── cmd/
│   └── api/
│       └── main.go
├── internal/
│   ├── config/
│   │   └── config.go
│   ├── server/
│   │   ├── server.go
│   │   └── routes.go
│   ├── middleware/
│   │   ├── auth.go               # JWT 鉴权
│   │   ├── ratelimit.go
│   │   ├── logger.go
│   │   ├── recovery.go
│   │   └── requestid.go
│   ├── handler/
│   │   ├── auth.go
│   │   ├── user.go               # 用户信息 / 安全设置
│   │   ├── chat.go               # 模型网关 / SSE 流
│   │   ├── share.go              # 分享快照 / 公开访问
│   │   ├── billing.go
│   │   ├── team.go
│   │   ├── template.go
│   │   ├── file.go
│   │   ├── knowledge.go          # 云知识库管理（P4+）
│   │   ├── webhook.go            # Webhook CRUD
│   │   ├── image.go              # 图片生成（提交任务 / 查询状态 / 历史）
│   │   └── payment.go
│   ├── service/
│   │   ├── auth.go
│   │   ├── llm/
│   │   │   ├── proxy.go          # SSE 代理 + Agent LLM Gateway
│   │   │   ├── router.go
│   │   │   ├── providers.go      # LLM 供应商适配（DeepSeek/Claude/GPT）
│   │   │   ├── circuit.go        # 熔断器
│   │   │   ├── tools.go          # ToolDefinition + SkillTools 注册表
│   │   │   └── tool_executor.go  # OfficeToolExecutor（路由三种实现）
│   │   ├── office/
│   │   │   ├── provider.go       # OfficeProvider 接口定义
│   │   │   ├── excel.go          # ExcelProvider（Go + excelize）
│   │   │   ├── word.go           # WordProvider（Go + XML 模板填充）
│   │   │   └── ppt.go            # PPTSidecarProvider（HTTP → Python）
│   │   ├── image/
│   │   │   ├── provider.go       # ImageProvider 接口 + ImageRequest/Result
│   │   │   ├── router.go         # 按 quality 路由到对应 Provider
│   │   │   ├── gpt_image1.go     # 精品档：OpenAI gpt-image-1
│   │   │   ├── dalle3.go         # 标准档：OpenAI dall-e-3
│   │   │   ├── stability.go      # 快速档：Stability AI stable-image-core
│   │   │   └── service.go        # ImageService（任务入队 → 生成 → S3 → 结算）
│   │   ├── billing.go
│   │   ├── team.go
│   │   ├── template.go
│   │   ├── file.go
│   │   ├── share.go
│   │   ├── rag.go
│   │   ├── webhook.go
│   │   └── payment.go
│   ├── repository/
│   │   ├── user.go
│   │   ├── team.go
│   │   ├── billing.go
│   │   ├── template.go
│   │   ├── llm_call.go
│   │   ├── file.go
│   │   ├── knowledge.go
│   │   └── webhook.go
│   ├── model/
│   │   ├── user.go
│   │   ├── team.go
│   │   ├── billing.go
│   │   ├── template.go
│   │   ├── llm_call.go
│   │   ├── file.go
│   │   └── knowledge.go
│   └── pkg/
│       ├── jwt/
│       ├── password/
│       ├── response/
│       ├── validator/
│       ├── embed/                # 向量化接口封装
│       └── logger/
├── migrations/
│   ├── 001_init_users.sql
│   ├── 002_init_teams.sql
│   ├── 003_init_wallets.sql
│   ├── 004_init_llm_calls.sql
│   ├── 005_init_templates.sql
│   ├── 006_init_files.sql
│   ├── 007_init_shares.sql
│   ├── 008_init_payments.sql
│   ├── 009_init_audit_logs.sql
│   ├── 010_init_knowledge.sql    # pgvector 扩展 + 分片表
│   ├── 011_init_webhooks.sql
│   └── 012_init_file_jobs.sql    # Office / 图片生成任务记录
├── ppt-sidecar/
│   ├── main.py                   # FastAPI + python-pptx 服务
│   └── Dockerfile                # python:3.12-slim，仅 3 个依赖
├── word-templates/               # 预置 Word .docx 模板（6 种）
│   ├── business_report.docx
│   ├── proposal.docx
│   ├── notice.docx
│   ├── meeting_minutes.docx
│   ├── contract_simple.docx
│   └── job_description.docx
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── Makefile
```

---

## 三、数据库设计

### 3.1 用户表 `users`

```sql
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    name          VARCHAR(100) NOT NULL DEFAULT '',
    avatar_url    VARCHAR(512),
    role          VARCHAR(20) NOT NULL DEFAULT 'user',   -- user | admin
    status        VARCHAR(20) NOT NULL DEFAULT 'active', -- active | suspended

    -- 元数据
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_users_email ON users(email);
```

### 3.2 OAuth 绑定表 `oauth_accounts`

```sql
CREATE TABLE oauth_accounts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         VARCHAR(50) NOT NULL,   -- google | github | wechat
    provider_id      VARCHAR(255) NOT NULL,
    access_token_enc TEXT,
    refresh_token_enc TEXT,
    expires_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(provider, provider_id)
);
```

### 3.3 订阅计划、钱包与账本

计费以包月额度为主，额外充值额度为补充。所有钱包余额都只存在于 PostgreSQL；Redis 可以缓存展示值，但不能作为扣费依据。

```sql
CREATE TABLE subscription_plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            VARCHAR(50) UNIQUE NOT NULL, -- free_trial | pro | team
    name            VARCHAR(100) NOT NULL,
    owner_type      VARCHAR(20) NOT NULL,        -- user | organization
    monthly_price_cny INT NOT NULL DEFAULT 0,
    monthly_credit_limit BIGINT NOT NULL,
    max_members     INT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_type      VARCHAR(20) NOT NULL, -- user | organization
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    plan_code       VARCHAR(50) NOT NULL,

    -- 包月额度
    monthly_credit_limit BIGINT NOT NULL DEFAULT 0,
    monthly_credits_used BIGINT NOT NULL DEFAULT 0,
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,

    -- 额外充值额度：月额度用完后再消耗
    extra_credits_balance BIGINT NOT NULL DEFAULT 0,

    status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active | past_due | canceled
    stripe_subscription_id VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        (owner_type = 'user' AND user_id IS NOT NULL AND organization_id IS NULL) OR
        (owner_type = 'organization' AND organization_id IS NOT NULL AND user_id IS NULL)
    ),
    UNIQUE(owner_type, user_id),
    UNIQUE(owner_type, organization_id)
);

CREATE TABLE usage_reservations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    organization_id UUID REFERENCES organizations(id),
    client_conversation_id VARCHAR(80),
    client_message_id      VARCHAR(80),
    request_id      VARCHAR(80) NOT NULL,
    mode            VARCHAR(20) NOT NULL, -- fast | deep
    estimated_credits BIGINT NOT NULL,
    actual_credits    BIGINT,
    status          VARCHAR(20) NOT NULL DEFAULT 'reserved',
    -- reserved | settled | released | failed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at      TIMESTAMPTZ,
    UNIQUE(request_id)
);

CREATE TABLE wallet_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    reservation_id  UUID REFERENCES usage_reservations(id),
    type            VARCHAR(40) NOT NULL,
    -- subscription_grant | usage_reserve | usage_settle | usage_release | topup | refund | admin_adjust
    amount          BIGINT NOT NULL,
    monthly_used_after BIGINT NOT NULL,
    extra_balance_after BIGINT NOT NULL,
    description     VARCHAR(500),
    idempotency_key VARCHAR(255) UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wallets_user ON wallets(user_id);
CREATE INDEX idx_wallets_org  ON wallets(organization_id);
CREATE INDEX idx_reservations_wallet ON usage_reservations(wallet_id, created_at DESC);
CREATE INDEX idx_wallet_tx_wallet ON wallet_transactions(wallet_id, created_at DESC);
```

轻量模型调用记录用于客服排障、用量明细和风控，但不保存完整 prompt、response 或 messages 正文。`client_conversation_id` / `client_message_id` 由客户端本地数据库生成，只作为关联线索。

```sql
CREATE TABLE llm_call_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      VARCHAR(80) UNIQUE NOT NULL,
    user_id         UUID NOT NULL REFERENCES users(id),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    reservation_id  UUID REFERENCES usage_reservations(id),

    client_conversation_id VARCHAR(80),
    client_message_id      VARCHAR(80),

    mode            VARCHAR(20) NOT NULL, -- fast | deep
    scene           VARCHAR(50), -- legacy scene or runtime skill key; Phase 2+ prefers skill/agent metadata
    model           VARCHAR(100),
    provider        VARCHAR(50),

    input_tokens    INT NOT NULL DEFAULT 0,
    output_tokens   INT NOT NULL DEFAULT 0,
    credits_cost    BIGINT NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'streaming',
    -- streaming | done | interrupted | failed
    error_code      VARCHAR(80),
    error_message   VARCHAR(500),

    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX idx_llm_calls_user ON llm_call_records(user_id, started_at DESC);
CREATE INDEX idx_llm_calls_client_conv ON llm_call_records(user_id, client_conversation_id);
```

Phase 2.2 引入云端兼容 Agent Run。它用于 Web 过渡体验、Local Harness 计费关联、admin 排障和短期恢复，不作为长期聊天历史或本地文件内容主存储。

```sql
CREATE TABLE agent_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    origin          VARCHAR(20) NOT NULL DEFAULT 'cloud',
    -- cloud | local
    status          VARCHAR(30) NOT NULL DEFAULT 'queued',
    -- queued | running | waiting_permission | completed | failed | canceled | insufficient_credits
    mode            VARCHAR(20) NOT NULL DEFAULT 'fast',
    goal            TEXT NOT NULL DEFAULT '',
    -- cloud-compatible run execution input, short-lived only; admin API never returns it
    goal_summary    VARCHAR(240) NOT NULL DEFAULT '',
    client_conversation_id VARCHAR(80),
    client_message_id      VARCHAR(80),
    attachments      JSONB NOT NULL DEFAULT '[]',
    error_code      VARCHAR(80),
    error_message   VARCHAR(500),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agent_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq             BIGINT NOT NULL,
    event_type      VARCHAR(80) NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(run_id, seq)
);

CREATE INDEX idx_agent_runs_user ON agent_runs(user_id, created_at DESC);
CREATE INDEX idx_agent_events_run ON agent_events(run_id, seq);
```

云端 `agent_events.payload` 只能保存工具摘要、来源、状态、错误和必要引用；不得默认保存完整本地文件内容、完整 shell 输出、完整 prompt 或完整 response。

### 3.4 组织 / 团队表（Phase 5 预留）

团队能力后置。Phase 1-4 默认只实现个人钱包、个人文件库、个人知识库和个人 Agent；以下组织表用于 Phase 5 团队版，不进入早期迁移范围。

```sql
CREATE TABLE organizations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(255) NOT NULL,
    slug         VARCHAR(100) UNIQUE NOT NULL,
    owner_id     UUID NOT NULL REFERENCES users(id),
    plan         VARCHAR(50) NOT NULL DEFAULT 'team',  -- team | enterprise

    -- 配置
    max_members INT NOT NULL DEFAULT 20,
    settings    JSONB NOT NULL DEFAULT '{}',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE organization_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL DEFAULT 'member', -- owner | admin | member

    monthly_credits_limit BIGINT,
    monthly_credits_used  BIGINT NOT NULL DEFAULT 0,
    limit_reset_at        TIMESTAMPTZ,

    invited_by UUID REFERENCES users(id),
    joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(organization_id, user_id)
);

CREATE INDEX idx_org_members_org  ON organization_members(organization_id);
CREATE INDEX idx_org_members_user ON organization_members(user_id);
```

### 3.5 本地优先对话边界与后期云同步表

Phase 1-3 不创建云端 `conversations` / `messages` 主存储表。对话列表、详情、搜索、归档、删除、导入/导出都由客户端本地数据库负责。

只有以下场景可以把正文上传到后端：

- 用户主动创建分享链接，上传当时的对话快照
- 用户主动提交问题反馈，并选择附带片段
- 后期用户显式开启 Cloud Sync / 团队共享历史 / 企业归档

后期 Cloud Sync 如需落库，再单独引入 `cloud_conversations` / `cloud_messages`，并以端到端加密、同步冲突、删除策略作为独立设计，不进入 MVP。

### 3.6 对话分享快照表 `shared_conversations`

```sql
CREATE TABLE shared_conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_token     VARCHAR(64) UNIQUE NOT NULL,   -- URL 中的唯一标识
    created_by      UUID NOT NULL REFERENCES users(id),

    -- 用户主动上传的本地对话快照；创建后固定，避免本地继续修改影响公开链接
    client_conversation_id VARCHAR(80),
    title           VARCHAR(500) NOT NULL DEFAULT '分享对话',
    snapshot_data   JSONB NOT NULL,

    expires_at  TIMESTAMPTZ,         -- NULL 表示永不过期
    view_count  INT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shares_token ON shared_conversations(share_token);
CREATE INDEX idx_shares_user  ON shared_conversations(created_by, created_at DESC);
```

### 3.7 文件元数据表 `files`

```sql
CREATE TABLE files (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

    -- S3 存储信息
    s3_key      VARCHAR(512) NOT NULL,
    s3_bucket   VARCHAR(100) NOT NULL,
    filename    VARCHAR(500) NOT NULL,    -- 原始文件名
    content_type VARCHAR(100) NOT NULL,
    size_bytes  BIGINT NOT NULL,

    -- 留存策略
    purpose     VARCHAR(40) NOT NULL DEFAULT 'temporary_input',
    -- temporary_input | share_attachment | cloud_file_library | generated_output
    retention_expires_at TIMESTAMPTZ,

    -- 文件处理状态
    status      VARCHAR(20) NOT NULL DEFAULT 'uploaded', -- uploaded | processing | ready | failed
    extracted_text_ref VARCHAR(512), -- 提取文本存对象存储或临时缓存引用，默认不长期写入数据库
    page_count  INT,

    -- 关联信息
    client_conversation_id VARCHAR(80),
    knowledge_base_id UUID,     -- 归属云知识库（Phase 4+ opt-in）

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_files_user ON files(user_id, created_at DESC);
CREATE INDEX idx_files_org  ON files(organization_id);
```

### 3.8 支付与额外额度包

```sql
CREATE TABLE extra_credit_packages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    credits         BIGINT NOT NULL,
    price_cny       INT NOT NULL,
    stripe_price_id VARCHAR(255),
    is_popular      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payment_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id),
    package_id      UUID REFERENCES extra_credit_packages(id),
    type            VARCHAR(30) NOT NULL, -- subscription | topup
    amount_cny      INT NOT NULL,
    currency        VARCHAR(10) NOT NULL DEFAULT 'cny',
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    -- pending | paid | failed | canceled | refunded
    stripe_checkout_session_id VARCHAR(255) UNIQUE,
    stripe_payment_intent_id   VARCHAR(255),
    stripe_subscription_id     VARCHAR(255),
    idempotency_key VARCHAR(255) UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stripe_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
    event_type      VARCHAR(100) NOT NULL,
    payload         JSONB NOT NULL,
    processed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_orders_wallet ON payment_orders(wallet_id, created_at DESC);
```

### 3.9 Skill / Prompt 运行时配置表（后置）`prompt_templates`

Phase 2 不再把 Prompt 模板作为用户主入口。该表只作为后期内部 skill prompt、团队策略或个人收藏的配置来源；统一 Agentic Chat 的运行时由系统按意图选择 skill，不要求用户手动选择 scene/template。

```sql
CREATE TABLE prompt_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 归属：
    -- organization_id=NULL, created_by=NULL → 系统内置（对所有用户可见）
    -- organization_id=NULL, created_by=uid  → 个人收藏
    -- organization_id=org_id               → 团队 skill / policy
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    created_by      UUID REFERENCES users(id),

    skill_key   VARCHAR(80) NOT NULL,   -- web-research | document-analysis | source-grounded-answer | custom
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,

    -- 模板变量 [{"key":"tone","label":"语气","type":"select","options":["正式","轻松"]}]
    variables   JSONB NOT NULL DEFAULT '[]',

    is_public   BOOLEAN NOT NULL DEFAULT FALSE,
    version     INT NOT NULL DEFAULT 1,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_templates_skill ON prompt_templates(skill_key, is_public);
CREATE INDEX idx_templates_org   ON prompt_templates(organization_id);
CREATE INDEX idx_templates_user  ON prompt_templates(created_by) WHERE organization_id IS NULL;
```

### 3.10 用量统计聚合表 `usage_daily`

```sql
CREATE TABLE usage_daily (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date            DATE NOT NULL,
    user_id         UUID REFERENCES users(id),
    organization_id UUID REFERENCES organizations(id),

    model         VARCHAR(100) NOT NULL,
    request_count INT NOT NULL DEFAULT 0,
    input_tokens  BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    credits_used  BIGINT NOT NULL DEFAULT 0,

    UNIQUE(date, user_id, organization_id, model)
);

CREATE INDEX idx_usage_daily_org  ON usage_daily(organization_id, date DESC);
CREATE INDEX idx_usage_daily_user ON usage_daily(user_id, date DESC);
```

### 3.11 RAG 知识库表（Phase 4+ opt-in 云能力）

Phase 3 优先做客户端本地知识库和本地索引。以下云知识库表只在用户主动开启 Cloud Knowledge Base，或后续团队 / 企业共享知识库时启用，不进入早期 MVP 迁移。

```sql
-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 云知识库（个人 opt-in 或 Phase 5 团队共享）
CREATE TABLE knowledge_bases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES users(id),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_shared       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 文档分片（向量化单元）
CREATE TABLE knowledge_chunks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    file_id          UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,

    chunk_index  INT NOT NULL,       -- 同一文件的第 N 个分片
    content      TEXT NOT NULL,      -- 原始文本（用于返回引用）
    embedding_model VARCHAR(100) NOT NULL DEFAULT 'text-embedding-3-small',
    embedding_dim   INT NOT NULL DEFAULT 1536,
    embedding    vector(1536),       -- 首发固定 1536 维；更换模型需新建对应维度迁移
    metadata     JSONB NOT NULL DEFAULT '{}',  -- 页码、来源文件名等

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- IVFFlat 近似最近邻索引（100 个聚类中心，适合 10 万级数据）
CREATE INDEX idx_chunks_embedding ON knowledge_chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX idx_chunks_kb ON knowledge_chunks(knowledge_base_id);
```

### 3.12 Webhook 配置表（Phase 5）

```sql
CREATE TABLE webhooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES users(id),

    name    VARCHAR(100) NOT NULL,
    url     VARCHAR(512) NOT NULL,
    -- 订阅的事件类型
    events  TEXT[] NOT NULL,  -- ['user.joined', 'chat.completed', 'credits.low']
    secret  VARCHAR(255) NOT NULL,   -- HMAC-SHA256 签名密钥

    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    last_sent_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_org ON webhooks(organization_id);
```

### 3.13 审计日志表 `audit_logs`

```sql
CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id   UUID REFERENCES users(id),
    organization_id UUID REFERENCES organizations(id),
    action          VARCHAR(100) NOT NULL,
    target_type     VARCHAR(80),
    target_id       UUID,
    ip_address      INET,
    user_agent      TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_org ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
```

---

## 四、API 接口设计

### 4.1 统一响应格式

```json
// 成功
{"code": 0, "message": "ok", "data": {...}}

// 失败
{"code": 40001, "message": "邮箱或密码错误", "data": null}

// 分页
{
    "code": 0,
    "message": "ok",
    "data": {
        "items": [...],
        "total": 100,
        "page": 1,
        "page_size": 20
    }
}
```

### 4.2 错误码规范

| 范围 | 含义 |
|------|------|
| 0 | 成功 |
| 40001–40099 | 认证相关 |
| 40101–40199 | 权限相关 |
| 40201–40299 | 参数校验 |
| 42901–42999 | 限流 |
| 50001–50099 | 服务内部错误 |
| 50201–50299 | LLM 供应商错误 |
| 50301–50399 | 文件处理错误 |

### 4.3 认证接口

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
POST   /api/v1/auth/refresh
POST   /api/v1/auth/forgot-password
POST   /api/v1/auth/reset-password
GET    /api/v1/auth/oauth/:provider
GET    /api/v1/auth/oauth/:provider/callback
```

### 4.4 用户接口

```
GET    /api/v1/user/me
PATCH  /api/v1/user/me
PATCH  /api/v1/user/password
```

### 4.5 Chat / Agentic Chat / 分享接口（核心）

```
-- 发起模型调用
POST   /api/v1/chat/completions        OpenAI 兼容格式，支持 stream=true

-- Phase 2.2 云端兼容 Agent Run；Web 先用，Local Harness 后续复用同一事件模型
POST   /api/v1/agent/runs
GET    /api/v1/agent/runs/:id
GET    /api/v1/agent/runs/:id/events
GET    /api/v1/agent/runs/:id/stream
POST   /api/v1/agent/runs/:id/cancel
POST   /api/v1/agent/llm               Local Harness 调云端模型网关并统一扣费（Phase 2.4）
POST   /api/v1/agent/tool-events       Local Harness 上报工具摘要和错误（Phase 2.4）

-- 分享快照：用户从本地对话中显式选择内容后上传
POST   /api/v1/shared-conversations     创建分享链接
DELETE /api/v1/shared-conversations/:id 撤销分享

-- 公开访问（不需要登录）
GET    /s/:token                        查看分享的对话
```

Phase 1/2 不提供完整云端 conversation CRUD。对话列表、详情、搜索、重命名、归档、删除、导入/导出都由客户端本地数据库完成；后端只接收当次模型调用或 Agent Run 所需的输入，并在创建分享时保存用户主动上传的 snapshot。

**对话请求体（兼容 OpenAI，扩展 Agentic Chat metadata）：**

```json
{
    "model": "fast",
    "messages": [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "帮我分析这张截图"},
                {"type": "image_url", "image_url": {"url": "https://..."}}
            ]
        }
    ],
    "stream": true,
    "client_conversation_id": "local-conv-uuid",
    "client_message_id": "local-msg-uuid",
    "attachments": [{"document_id": "uuid"}],
    "agent_intent": "auto",
    "organization_id": "uuid"  // Phase 5 团队钱包场景必传；个人场景为空
}
```

`client_conversation_id` 和 `client_message_id` 只用于关联用量、错误排查和本地客户端状态，不代表后端保存了完整对话。`agent_intent=auto` 表示由系统决定直接回答、文档处理、网页工具或多步 run。

**Agent Run 创建请求体：**

```json
{
    "goal": "请阅读这个合同并列出风险点",
    "mode": "deep",
    "attachments": [{"document_id": "uuid"}],
    "client_conversation_id": "local-conv-uuid",
    "client_message_id": "local-msg-uuid",
    "origin": "cloud"
}
```

云端 `agent_runs` 和 `agent_events` 默认保存 7 天。Local Harness 创建的 run 只向云端登记摘要、计费关联和工具错误，不上传完整本地内容。

**分享快照请求体：**

```json
{
    "client_conversation_id": "local-conv-uuid",
    "title": "客户邮件润色",
    "snapshot_data": {
        "messages": [
            {"role": "user", "content": "用户选择分享的内容"},
            {"role": "assistant", "content": "对应回答"}
        ]
    },
    "expires_at": "2026-06-10T00:00:00Z"
}
```

### 4.6 计费接口

```
GET    /api/v1/billing/balance
GET    /api/v1/billing/transactions
GET    /api/v1/billing/subscription
POST   /api/v1/billing/subscription/checkout
GET    /api/v1/billing/topup-packages
POST   /api/v1/billing/topup/checkout
GET    /api/v1/billing/usage
```

### 4.7 团队接口（Phase 5）

```
POST   /api/v1/teams
GET    /api/v1/teams/:id
PATCH  /api/v1/teams/:id
GET    /api/v1/teams/:id/members
POST   /api/v1/teams/:id/members/invite
DELETE /api/v1/teams/:id/members/:uid
PATCH  /api/v1/teams/:id/members/:uid
GET    /api/v1/teams/:id/usage
GET    /api/v1/teams/:id/billing
POST   /api/v1/teams/:id/billing/recharge
```

### 4.8 Skill / 模板配置接口（后置）

该接口不进入 Phase 2 主入口，只用于后期管理内部 skill prompt、团队策略或个人偏好。

```
GET    /api/v1/templates               列表（系统 + 团队 + 个人，按 scope 筛选）
GET    /api/v1/templates/:id
POST   /api/v1/templates               创建（个人偏好 or 团队 skill/policy）
PATCH  /api/v1/templates/:id
DELETE /api/v1/templates/:id
POST   /api/v1/templates/:id/duplicate 复制一份到个人收藏
```

### 4.9 文件接口

```
POST   /api/v1/files/upload-url        获取 S3 预签名上传 URL，默认 temporary_input
POST   /api/v1/files/confirm           确认上传完成
GET    /api/v1/files/:id
DELETE /api/v1/files/:id
```

`upload-url` 响应必须返回 `file_id`、`upload_url`、`expires_at`。Phase 1/2 文件默认是临时处理输入，后端定期清理 `retention_expires_at` 已过期的对象、提取结果和元数据。

### 4.10 知识库接口（Phase 4+ opt-in 云知识库）

```
GET    /api/v1/knowledge               获取个人或团队知识库列表
POST   /api/v1/knowledge               创建知识库
GET    /api/v1/knowledge/:id
PATCH  /api/v1/knowledge/:id
DELETE /api/v1/knowledge/:id
POST   /api/v1/knowledge/:id/files     向知识库添加文件（触发向量化）
DELETE /api/v1/knowledge/:id/files/:fid 从知识库移除文件
GET    /api/v1/knowledge/:id/search    语义搜索测试（管理员用）
```

### 4.11 Webhook 接口（Phase 5）

```
GET    /api/v1/webhooks
POST   /api/v1/webhooks
PATCH  /api/v1/webhooks/:id
DELETE /api/v1/webhooks/:id
POST   /api/v1/webhooks/:id/test       发送测试事件
```

### 4.12 图片生成接口（Phase 4）

```
POST   /api/v1/images/generate         提交生图任务（异步，返回 job_id）
GET    /api/v1/images/:job_id          查询任务状态 + 获取下载 URL
GET    /api/v1/images                  用户生图历史列表
DELETE /api/v1/images/:job_id          删除记录（同步删除 S3 文件）
```

### 4.13 支付回调

```
POST   /api/v1/payment/webhook         Stripe Webhook（验签替代 JWT）
```

---

## 五、核心模块实现

### 5.1 认证模块

**Token 策略：**

| 类型 | 有效期 | 存储位置 |
|------|--------|----------|
| Access Token | 15 分钟 | 客户端内存 |
| Refresh Token | 30 天 | HTTPOnly Cookie |

```go
type Claims struct {
    UserID         string `json:"uid"`
    Email          string `json:"email"`
    Role           string `json:"role"`
    OrganizationID string `json:"org_id,omitempty"`
    jwt.RegisteredClaims
}
```

**鉴权中间件仅支持 JWT。开放平台 API Key 属于 Phase 5，不进入当前 MVP。**

```go
func AuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // 优先检查 Bearer JWT
        if token := extractBearerToken(r); token != "" {
            claims, err := parseJWT(token)
            if err == nil {
                ctx := context.WithValue(r.Context(), ctxUserID, claims.UserID)
                next.ServeHTTP(w, r.WithContext(ctx))
                return
            }
        }
        response.Error(w, 40001, "未登录或登录已过期")
    })
}
```

**Refresh Token 轮换：**
- 每次使用生成新 Refresh Token，旧的作废
- 旧 Token 二次使用 → 立即吊销所有 Token（检测盗用）
- Refresh Token 轮换状态存 PostgreSQL，Redis 只缓存短期会话状态，不能依赖可淘汰缓存承载安全语义

### 5.2 LLM 代理层

#### 5.2.1 Provider 接口（核心抽象）

所有供应商实现同一个接口，代理层完全不感知各家格式差异：

```go
// internal/service/llm/providers.go

type Chunk struct {
    Text         string
    InputTokens  int
    OutputTokens int
    FinishReason string // "stop" | "max_tokens" | ""（流式中为空）
}

type Provider interface {
    // 把统一内部请求翻译成供应商格式，返回可直接发送的 *http.Request
    BuildRequest(ctx context.Context, req InternalRequest) (*http.Request, error)
    // 解析供应商返回的一行 SSE 数据，转换为统一 Chunk
    // 返回 ok=false 表示此行不含内容（心跳、注释等），直接跳过
    ParseChunk(line []byte) (chunk Chunk, ok bool, err error)
}

// 统一内部请求格式（客户端 → 代理层使用此结构）
type InternalRequest struct {
    ModelID   string            // 供应商侧实际模型 ID
    Messages  []InternalMessage // 已包含 system prompt
    MaxTokens int
    Stream    bool
}

type InternalMessage struct {
    Role    string // "system" | "user" | "assistant"
    Content JSONB  // 统一多模态格式
}
```

#### 5.2.2 各供应商实现

**DeepSeek / Qwen / OpenAI（兼容 OpenAI 格式，几乎不需要转换）：**

```go
// internal/service/llm/provider_openai.go
type OpenAICompatProvider struct {
    BaseURL string
    APIKey  string
    Model   string
}

func (p *OpenAICompatProvider) BuildRequest(ctx context.Context, req InternalRequest) (*http.Request, error) {
    body := map[string]any{
        "model":      p.Model,
        "messages":   req.Messages, // 格式已兼容，直接传
        "max_tokens": req.MaxTokens,
        "stream":     req.Stream,
    }
    return newJSONRequest(ctx, "POST", p.BaseURL+"/v1/chat/completions", body,
        "Authorization", "Bearer "+p.APIKey)
}

func (p *OpenAICompatProvider) ParseChunk(line []byte) (Chunk, bool, error) {
    // data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}
    if !bytes.HasPrefix(line, []byte("data: ")) { return Chunk{}, false, nil }
    data := bytes.TrimPrefix(line, []byte("data: "))
    if string(data) == "[DONE]" { return Chunk{}, false, nil }

    var resp struct {
        Choices []struct {
            Delta        struct{ Content string `json:"content"` } `json:"delta"`
            FinishReason string `json:"finish_reason"`
        } `json:"choices"`
        Usage *struct {
            PromptTokens     int `json:"prompt_tokens"`
            CompletionTokens int `json:"completion_tokens"`
        } `json:"usage"`
    }
    if err := json.Unmarshal(data, &resp); err != nil { return Chunk{}, false, err }
    if len(resp.Choices) == 0 { return Chunk{}, false, nil }

    chunk := Chunk{
        Text:         resp.Choices[0].Delta.Content,
        FinishReason: resp.Choices[0].FinishReason,
    }
    if resp.Usage != nil {
        chunk.InputTokens  = resp.Usage.PromptTokens
        chunk.OutputTokens = resp.Usage.CompletionTokens
    }
    return chunk, true, nil
}
```

**Anthropic（格式差异最大，需要完整转换）：**

```go
// internal/service/llm/provider_anthropic.go
type AnthropicProvider struct {
    APIKey string
    Model  string
}

func (p *AnthropicProvider) BuildRequest(ctx context.Context, req InternalRequest) (*http.Request, error) {
    // ① 把 system 消息从 messages 中提取为顶层字段
    var system string
    var messages []map[string]any
    for _, msg := range req.Messages {
        if msg.Role == "system" {
            system = msg.Content.Text() // 提取纯文本
            continue
        }
        messages = append(messages, map[string]any{
            "role":    msg.Role,
            "content": translateContentToAnthropic(msg.Content),
        })
    }

    body := map[string]any{
        "model":      p.Model,
        "max_tokens": req.MaxTokens,
        "messages":   messages,
        "stream":     req.Stream,
    }
    if system != "" {
        body["system"] = system
    }

    return newJSONRequest(ctx, "POST", "https://api.anthropic.com/v1/messages", body,
        "x-api-key", p.APIKey,
        "anthropic-version", "2023-06-01")
}

func (p *AnthropicProvider) ParseChunk(line []byte) (Chunk, bool, error) {
    // Anthropic 有多种事件类型，只需要关心两种：
    // event: content_block_delta  → 包含文本内容
    // event: message_delta        → 包含结束原因和 token 统计
    // 其余（message_start / content_block_start / content_block_stop / message_stop）直接跳过

    if bytes.HasPrefix(line, []byte("event:")) {
        return Chunk{}, false, nil // 事件类型行，跳过
    }
    if !bytes.HasPrefix(line, []byte("data: ")) {
        return Chunk{}, false, nil
    }

    data := bytes.TrimPrefix(line, []byte("data: "))
    var envelope struct {
        Type  string          `json:"type"`
        Delta json.RawMessage `json:"delta"`
        Usage *struct {
            OutputTokens int `json:"output_tokens"`
        } `json:"usage"`
    }
    if err := json.Unmarshal(data, &envelope); err != nil { return Chunk{}, false, err }

    switch envelope.Type {
    case "content_block_delta":
        // {"type":"text_delta","text":"你好"}
        var delta struct{ Text string `json:"text"` }
        json.Unmarshal(envelope.Delta, &delta)
        return Chunk{Text: delta.Text}, true, nil

    case "message_delta":
        // {"stop_reason":"end_turn"}
        var delta struct{ StopReason string `json:"stop_reason"` }
        json.Unmarshal(envelope.Delta, &delta)
        chunk := Chunk{FinishReason: "stop"}
        if envelope.Usage != nil {
            chunk.OutputTokens = envelope.Usage.OutputTokens
        }
        return chunk, true, nil
    }

    return Chunk{}, false, nil
}

// Vision 格式转换：统一内部格式 → Anthropic 格式
func translateContentToAnthropic(content JSONB) any {
    // 纯文本：直接返回字符串
    if content.IsText() {
        return content.Text()
    }
    // 多模态：转换数组
    var blocks []map[string]any
    for _, item := range content.Items() {
        switch item.Type {
        case "text":
            blocks = append(blocks, map[string]any{"type": "text", "text": item.Text})
        case "image_url":
            // 内部格式：{"type":"image_url","image_url":{"url":"https://..."}}
            // Anthropic格式：{"type":"image","source":{"type":"url","url":"https://..."}}
            blocks = append(blocks, map[string]any{
                "type": "image",
                "source": map[string]any{
                    "type": "url",
                    "url":  item.ImageURL.URL,
                },
            })
        }
    }
    return blocks
}
```

#### 5.2.3 模型路由

```go
type ModelConfig struct {
    Provider      Provider // 实现了 Provider 接口的具体供应商实例
    ModelID       string
    InputCPM      float64  // 每百万 input token 成本（美元）
    OutputCPM     float64
    MaxTokens     int
    Priority      int
    SupportVision bool
}

var ModelRoutes = map[string][]ModelConfig{
    "fast": {
        {Provider: &OpenAICompatProvider{BaseURL: "https://api.deepseek.com", Model: "deepseek-chat"},   Priority: 1, SupportVision: false, InputCPM: 0.14,  OutputCPM: 0.28},
        {Provider: &OpenAICompatProvider{BaseURL: "https://dashscope.aliyuncs.com", Model: "qwen-plus"}, Priority: 2, SupportVision: false, InputCPM: 0.08,  OutputCPM: 0.08},
    },
    "deep": {
        {Provider: &AnthropicProvider{Model: "claude-sonnet-4-6"}, Priority: 1, SupportVision: true,  InputCPM: 3.0,  OutputCPM: 15.0},
        {Provider: &OpenAICompatProvider{BaseURL: "https://api.openai.com", Model: "gpt-4o"},           Priority: 2, SupportVision: true,  InputCPM: 2.5,  OutputCPM: 10.0},
    },
}

func (r *Router) Select(mode string, hasImage bool) ModelConfig {
    candidates := ModelRoutes[mode]
    if hasImage {
        candidates = filterVisionSupport(candidates) // 过滤掉不支持 Vision 的供应商
    }
    return pickByPriority(candidates) // 按 Priority 选，熔断后跳下一个
}
```

#### 5.2.4 SSE 流式代理（完整流程）

代理层调用 Provider 接口，不感知各家格式差异：

```
客户端（OpenAI 格式请求）
        │
        ▼
① 鉴权 + 选择钱包 + 创建额度预留（PostgreSQL 事务）
        │
② 检测是否含图片 → 选择模型（Router.Select）
        │
③ 注入 system prompt / skill instructions（云端 RAG 上下文仅 Phase 4+ opt-in 启用）
        │
④ 创建 llm_call_records（status=streaming），关联 reservation_id 与 client_*_id
        │
⑤ provider.BuildRequest()   ←─── 各家格式差异在此封装
        │                         DeepSeek/Qwen：直接用 OpenAI 格式
        │                         Anthropic：提取 system、转换 Vision 格式
        ▼
⑥ 发起 HTTP 流式请求到供应商
        │
⑦ goroutine：逐行读取供应商 SSE
        │
        ├── provider.ParseChunk(line)  ←─── 各家 SSE 格式在此统一解析
        │         DeepSeek/Qwen：解析 OpenAI SSE 格式
        │         Anthropic：只取 content_block_delta 和 message_delta
        │
        ├── 统一 Chunk → 转换为 OpenAI SSE 格式发送给客户端
        │   data: {"choices":[{"delta":{"content":"..."},"finish_reason":null}]}
        │
        ├── 客户端负责把增量写入本地 assistant message
        ├── 可选追加到 Redis 短期缓存（只用于体验，不作为可靠恢复，也不是历史存储）
        └── 累计 token 计数
        │
⑧ 流结束后（同一结算流程）：
        → 更新 llm_call_records status=done / failed / interrupted
        → 按实际 token / 工具成本结算 reservation
        → 写 wallet_transactions + usage_daily
        → 释放未使用的预留额度
        → Webhook 事件仅在 Phase 5 启用
```

**客户端永远收到 OpenAI 格式的 SSE，不感知后端路由到哪个供应商。**

**超时与熔断：**

| 场景 | 策略 |
|------|------|
| 供应商连接超时 | 3 秒，切换备选模型 |
| 流式响应无数据 | 30 秒无新 chunk，关闭并报错 |
| 供应商连续失败 | 熔断：5 次失败后开启，60 秒后半开探测 |
| 流中途中断 | 消息 status=interrupted，已收内容正常计费 |

#### 5.2.3 场景 System Prompt

```go
var SceneSystemPrompts = map[string]string{
    "write": `你是一名专业的中文商务写作助手。
直接输出完整的、可立即使用的文本，不要在正文前解释你在做什么。
写作要求：语言自然流畅、表达清晰、格式规范。`,

    "read": `你是一名专业的文档分析助手。
分析用户提供的文档，根据问题进行总结、提取关键信息或翻译。
回答简洁准确，优先使用结构化列表呈现。`,

    "translate": `你是一名专业翻译，精通中英日韩等多语言互译。
保持原文的语气、格式和专业术语。翻译自然流畅，不直译。
只输出翻译结果，不添加其他解释。`,

    "calculate": `你是一名数据分析助手，擅长从数据中提取商业洞察。
分析用户提供的数据，给出清晰结论，必要时用 Markdown 表格呈现。
优先给出可操作的建议，而非仅描述数据。`,

    "chat": `你是简单（Jiandan）AI 助手，专为职场人士设计的 AI 生产力工具。
回答简洁、专业、实用。`,
}
```

### 5.3 计费层

#### 5.3.1 包月额度设计

```
积分单位：1 积分 = ¥0.01
个人专业版：每月发放固定额度
团队版（Phase 5）：组织钱包每月发放额度池，成员可设置个人月上限
额外额度：月额度耗尽后再消耗，可通过一次性充值包补充
```

扣费顺序固定为：先扣当月额度，再扣额外额度。月额度周期结束后重置，额外额度不参与月度重置。

#### 5.3.2 额度预留与结算

```go
func (s *BillingService) Reserve(ctx context.Context, req ReserveRequest) (Reservation, error) {
    return s.db.WithTxResult(ctx, func(tx *sql.Tx) (Reservation, error) {
        wallet, err := s.repo.LockWalletForScope(tx, req.UserID, req.OrganizationID)
        if err != nil { return Reservation{}, err }

        estimate := s.estimateCredits(req.Mode, req.MaxTokens, req.ToolBudget)
        available := wallet.MonthlyLimit - wallet.MonthlyUsed + wallet.ExtraBalance
        if available < estimate {
            return Reservation{}, ErrInsufficientCredits
        }

        reservation := s.repo.CreateReservation(tx, wallet.ID, req, estimate)
        s.repo.InsertWalletTx(tx, wallet.ID, reservation.ID, "usage_reserve", -estimate)
        return reservation, nil
    })
}

func (s *BillingService) Settle(ctx context.Context, req SettleRequest) error {
    return s.db.WithTx(ctx, func(tx *sql.Tx) error {
        reservation, err := s.repo.LockReservation(tx, req.ReservationID)
        if err != nil { return err }
        if reservation.Status != "reserved" { return nil } // 幂等

        actual := s.calculateCredits(req.InputTokens, req.OutputTokens, req.ImageCount, req.Model)
        wallet, err := s.repo.LockWallet(tx, reservation.WalletID)
        if err != nil { return err }

        s.repo.ApplyActualUsage(tx, wallet.ID, actual)
        s.repo.MarkReservationSettled(tx, reservation.ID, actual)
        s.repo.InsertWalletTx(tx, wallet.ID, reservation.ID, "usage_settle", -actual)
        return nil
    })
}

func (s *BillingService) Release(ctx context.Context, reservationID string, reason string) error {
    return s.repo.ReleaseReservationIdempotently(ctx, reservationID, reason)
}
```

#### 5.3.3 Token → 积分换算

```go
func (s *BillingService) calculateCredits(inputTokens, outputTokens, imageCount int, model ModelConfig) int64 {
    costUSD := float64(inputTokens)/1e6*model.InputCPM +
               float64(outputTokens)/1e6*model.OutputCPM +
               float64(imageCount)*0.00085  // 图片处理固定成本

    credits := int64(costUSD * 3.0 * 7.2 * 100)  // 3x 利润 × 汇率 × 单位换算
    if credits < 1 { credits = 1 }
    return credits
}
```

### 5.4 团队管理层（Phase 5，后置）

团队管理不进入早期实现。Phase 1-4 只要求个人钱包、个人文件、个人知识库和个人 Agent 可用；团队相关 schema/API 保留为 Phase 5 扩展边界。

**权限矩阵：**

| 操作 | Owner | Admin | Member |
|------|-------|-------|--------|
| 查看成员列表 | ✅ | ✅ | ✅ |
| 邀请成员 | ✅ | ✅ | ❌ |
| 移除成员 | ✅ | ✅ | ❌ |
| 修改成员权限 | ✅ | ❌ | ❌ |
| 设置成员用量上限 | ✅ | ✅ | ❌ |
| 组织充值 | ✅ | ❌ | ❌ |
| 查看用量报表 | ✅ | ✅ | ❌ |
| 创建/修改团队 Agent 策略 | ✅ | ✅ | ❌ |
| 管理知识库 | ✅ | ✅ | ❌ |
| 管理 Webhook | ✅ | ✅ | ❌ |
| 修改组织信息 | ✅ | ❌ | ❌ |
| 解散组织 | ✅ | ❌ | ❌ |

**成员计费路由（个人 vs 组织）：**

团队场景必须显式传 `organization_id`。一个用户可以属于多个组织，不能用“默认 active membership”推断钱包，否则容易把个人对话扣到团队账上，或把 A 团队对话扣到 B 团队。

```go
func (s *BillingService) ResolveWallet(ctx context.Context, userID, organizationID string) (Wallet, error) {
    if organizationID == "" {
        return s.walletRepo.GetUserWallet(ctx, userID)
    }

    member, err := s.teamRepo.GetMembership(ctx, organizationID, userID)
    if err != nil || member == nil {
        return Wallet{}, ErrPermissionDenied
    }
    if member.MonthlyLimit > 0 && member.MonthlyUsed >= member.MonthlyLimit {
        return Wallet{}, ErrMemberQuotaExceeded
    }
    return s.walletRepo.GetOrganizationWallet(ctx, organizationID)
}
```

### 5.5 Skill / Prompt 运行时层

Prompt 模板不再是 Phase 2 的产品主入口。后端可以保留配置能力，但它服务于 Agentic Chat 运行时：系统根据用户输入、附件、URL、可用工具、权限和预算选择 skill，再把对应 instructions 注入本次 run。

**配置层级（后置能力）：**

```
系统内置 skill prompt（organization_id=NULL, created_by=NULL, is_public=TRUE）
    ↓ 团队管理员可以基于系统 skill 创建团队策略
团队 skill / policy（organization_id=org_id, is_public=FALSE）
    ↓ 用户可以保存个人偏好，但不需要手动选场景
个人偏好（organization_id=NULL, created_by=uid, is_public=FALSE）
```

```go
func (s *SkillPromptService) Render(skill SkillPrompt, vars map[string]string) string {
    result := skill.SystemPrompt
    for key, value := range vars {
        result = strings.ReplaceAll(result, "{{"+key+"}}", value)
    }
    return result
}
```

### 5.6 流式生成与恢复策略

Phase 1 只保证“云端流式转发 + 客户端本地持久化”。Phase 2.2 起，云端兼容 Agent Run 使用 `agent_events` 保存短期事件流，服务 Web 过渡体验、失败排查和 admin 观察。后端仍不作为长期聊天历史来源，也不默认保存完整本地文件、完整 shell 输出或完整对话正文。

```go
func (s *LLMProxyService) markInterrupted(ctx context.Context, requestID, reservationID string) {
    _ = s.callRepo.UpdateStatus(ctx, requestID, "interrupted")
    _ = s.billing.Release(ctx, reservationID, "client_disconnected")
}

// Phase 2.2 引入：
// agent_runs(id, user_id, origin, status, mode, goal_summary, expires_at, ...)
// agent_events(run_id, seq, event_type, payload, created_at)
func (h *ChatHandler) GetCallStatus(w http.ResponseWriter, r *http.Request) {
    call := h.repo.MustGetCallByRequestID(r.Context(), chi.URLParam(r, "request_id"))
    response.JSON(w, call)
}
```

### 5.7 多模态 / Vision 支持

消息 `content` 字段使用 JSONB，完全兼容 OpenAI 多模态格式：

```go
// 纯文本消息
type TextContent struct {
    Type string `json:"type"` // "text"
    Text string `json:"text"`
}

// 图片消息
type ImageContent struct {
    Type     string    `json:"type"`      // "image_url"
    ImageURL ImageURL  `json:"image_url"`
}
type ImageURL struct {
    URL    string `json:"url"`    // S3 预签名 URL 或公网 URL
    Detail string `json:"detail"` // "auto" | "low" | "high"
}

// content 可以是单个对象或数组（混合文本 + 图片）
// Phase 1 仅作为请求内存结构使用，不作为后端消息历史存储

// 路由层：检测是否含图片，自动选择支持 Vision 的模型
func hasImageContent(messages []Message) bool {
    for _, msg := range messages {
        if msg.Role == "user" {
            contents, _ := msg.Content.MarshalJSON()
            if bytes.Contains(contents, []byte("image_url")) {
                return true
            }
        }
    }
    return false
}
```

**图片上传流程：**
1. 客户端调用 `POST /api/v1/files/upload-url` 获取 S3 预签名 URL
2. 客户端直接上传到 S3
3. 客户端调用 `POST /api/v1/files/confirm` 确认
4. 后端生成有时效的预签名下载 URL，返回给客户端
5. 客户端将此 URL 放入消息 content 中发送对话请求
6. 后端转发给 LLM 时直接透传 URL（Claude / GPT-4o 会自行下载图片）

### 5.8 RAG 知识库（Phase 4+ opt-in 云能力）

```
文件上传 → 文本提取（PDF/Word/TXT）→ 分片（每片 500 token，50 token 重叠）
     → 向量化（首发 text-embedding-3-small）→ 写入 knowledge_chunks

对话时（指定 knowledge_base_ids）：
     → 校验用户对 knowledge_base_ids 的组织权限
     → 用户问题向量化 → pgvector 余弦相似度检索 Top-K 分片
     → 拼入 system prompt："以下是相关参考资料：\n{chunks}"
     → 正常走 LLM 代理流程
```

Phase 3 的个人知识库默认在客户端本地完成，不依赖这里的云端 RAG。云端 RAG 只用于用户主动开启云知识库、长任务 Agent 或 Phase 5 团队共享知识库。

```go
func (s *RAGService) Retrieve(ctx context.Context, kbIDs []string, query string, topK int) ([]Chunk, error) {
    if err := s.authz.EnsureKnowledgeAccess(ctx, kbIDs); err != nil { return nil, err }

    embedding, err := s.embed.Embed(ctx, query)
    if err != nil { return nil, err }

    // pgvector 向量检索
    rows, err := s.db.QueryContext(ctx, `
        SELECT content, metadata, 1 - (embedding <=> $1) AS similarity
        FROM knowledge_chunks
        WHERE knowledge_base_id = ANY($2)
        ORDER BY embedding <=> $1
        LIMIT $3
    `, pgvector.NewVector(embedding), pq.Array(kbIDs), topK)
    // ... 解析结果
}

func (s *RAGService) BuildContextPrompt(chunks []Chunk) string {
    var sb strings.Builder
    sb.WriteString("以下是与你的问题相关的参考资料，请基于此作答：\n\n")
    for i, chunk := range chunks {
        fmt.Fprintf(&sb, "【资料 %d】（来源：%s）\n%s\n\n", i+1, chunk.SourceFile, chunk.Content)
    }
    return sb.String()
}
```

### 5.9 Agentic Chat / Local Harness 协作

Phase 2 起，Agentic Chat 是用户入口，Local Agent Harness 是执行主线。云端先提供兼容 run/event/stream API；长期由本地 Harness 负责编排循环、工具、记忆、上下文、提示词构建、输出解析、状态、错误处理、护栏、验证、子智能体预留和生命周期管理。云端工具、Office、图片、文件处理等外部副作用工具仍必须走受控 job 或明确的权限/预算边界，并设置统一保护：

- 单次 Agent Run 必须有最大步骤数和预算上限，后台配置可调，默认低于模型最大能力
- 单个工具任务必须有超时、最大输入 JSON 大小、最大输出文件大小
- 云端不执行本地文件、shell、浏览器、IDE 或本地 MCP；这些能力只在 Local Harness 用户态 worker 内执行
- 本地工具输出默认不进入云端；云端只接收摘要、错误、耗时、费用和工具类型
- 文件类工具必须先创建 `file_jobs(status=queued)`，worker 执行后再结算额度
- Excel 公式、Word XML、PPT JSON 必须做结构校验和内容转义，防止公式注入或 XML 破坏
- 工具失败只返回可读错误，不让模型无限重试同一工具

#### 工具注册表

按 skill、意图和权限注入工具定义，避免无关工具浪费 token：

```go
// internal/service/llm/tools.go

// skill/intent → 启用的工具列表
// direct_chat 不注入工具，保持轻量
var SkillTools = map[string][]ToolDefinition{
    "document-analysis":      {AnalyzeFileTool, ExtractTableTool},
    "source-grounded-answer": {},
    "local-task-execution":   {},
    "office-generation":      {CreateExcelTool, CreateWordTool, CreatePPTTool},
}

var CreateExcelTool = ToolDefinition{
    Name: "create_excel",
    Description: `创建 Excel 文件。当用户需要生成表格、报表、数据分析结果时使用。
支持多个 sheet、公式、基础图表（柱状图/折线图/饼图）。`,
    InputSchema: json.RawMessage(`{
        "type": "object",
        "required": ["filename", "sheets"],
        "properties": {
            "filename": {"type": "string"},
            "sheets": {
                "type": "array",
                "items": {
                    "required": ["name","headers","rows"],
                    "properties": {
                        "name":     {"type": "string"},
                        "headers":  {"type": "array", "items": {"type": "string"}},
                        "rows":     {"type": "array", "items": {"type": "array"}},
                        "formulas": {"type": "array", "items": {
                            "properties": {
                                "cell":    {"type": "string"},
                                "formula": {"type": "string"}
                            }
                        }}
                    }
                }
            },
            "charts": {"type": "array", "items": {
                "properties": {
                    "type":       {"type": "string", "enum": ["bar","line","pie"]},
                    "sheet":      {"type": "string"},
                    "data_range": {"type": "string"},
                    "title":      {"type": "string"}
                }
            }}
        }
    }`),
}

// PPT / Word 工具定义类似，schema 描述幻灯片结构或文档章节
```

#### Agentic Loop（代理层核心循环）

```go
// internal/service/llm/proxy.go

func (s *LLMProxyService) Chat(ctx context.Context, req InternalRequest, w SSEWriter) error {
    messages := req.Messages
    tools    := SkillTools[req.SelectedSkill]
    const maxRounds = 4  // 防无限循环，默认保守

    for round := 0; round < maxRounds; round++ {
        model   := s.router.Select(req.Mode, hasImage(messages))
        httpReq, _ := model.Provider.BuildRequest(ctx, InternalRequest{
            Messages:  messages,
            Tools:     tools,
            MaxTokens: req.MaxTokens,
            Stream:    true,
        })

        result, err := s.streamResponse(ctx, httpReq, model.Provider, w)
        if err != nil { return err }

        if result.StopReason == "end_turn" { break }

        if result.StopReason == "tool_use" {
            messages = append(messages, InternalMessage{
                Role: "assistant", ToolCalls: result.ToolCalls,
            })

            var toolResults []ToolResult
            for _, tc := range result.ToolCalls {
                // 通知前端：工具开始执行
                w.WriteEvent("tool_start", map[string]any{
                    "tool": tc.Name, "message": toolProgressMsg(tc.Name),
                })

                output, err := s.toolRegistry.Execute(ctx, req.UserID, tc.Name, tc.Input)

                // 通知前端：执行结果
                w.WriteEvent("tool_done", map[string]any{
                    "tool":         tc.Name,
                    "success":      output.Success,
                    "file_id":      output.FileID,
                    "download_url": s.fileService.SignedURL(output.FileID),
                })

                toolResults = append(toolResults, ToolResult{
                    ToolID: tc.ID, Content: toolResultSummary(output),
                    IsError: err != nil || !output.Success,
                })
            }

            // 工具结果回传给 AI，继续下一轮
            messages = append(messages, InternalMessage{
                Role: "user", ToolResults: toolResults,
            })
            continue
        }
        break
    }
    return nil
}
```

### 5.10 Office 文件自研实现（Phase 4）

#### 三种文件类型的实现策略

| 文件类型 | 实现方案 | 原因 |
|---------|---------|------|
| Excel (.xlsx) | 纯 Go，`excelize` 库 | 库成熟，支持公式/图表/样式，零外部依赖 |
| Word (.docx) | 纯 Go，模板填充 | .docx 本质是 ZIP+XML，模板方式足够覆盖业务场景 |
| PPT (.pptx) | Python 微服务，`python-pptx` | Go 的 PPT 库能力严重不足，Python 生态是业界标准 |

整体思路：**Excel 和 Word 完全在 Go 主进程内完成，PPT 通过一个极轻量的 Python sidecar 服务处理，Go 通过 HTTP 调用它。**

```
AI tool_use 调用
        │
        ▼
OfficeToolExecutor
        │
        ├── create_excel → ExcelGenerator（Go + excelize）→ .xlsx
        ├── create_word  → WordGenerator（Go + 模板XML）→ .docx
        └── create_ppt   → PPTSidecar（HTTP → Python FastAPI）→ .pptx
                │
        统一落地：验证 → 上传 S3 → 记录 file_jobs → 返回 URL
```

#### OfficeProvider 接口（不变）

```go
// internal/service/office/provider.go

type OfficeRequest struct {
    Type     string          // "excel" | "word" | "ppt"
    Filename string
    Params   json.RawMessage // AI 生成的结构化参数
}

type OfficeResult struct {
    FileBytes   []byte
    ContentType string
}

type OfficeProvider interface {
    Name()     string
    Supports(fileType string) bool
    Generate(ctx context.Context, req OfficeRequest) (OfficeResult, error)
}
```

#### Excel 实现（Go + excelize）

AI 输出的 JSON schema 直接映射到 excelize API：

```go
// internal/service/office/excel.go

type ExcelProvider struct{}

func (e *ExcelProvider) Name()                   string { return "excel-go" }
func (e *ExcelProvider) Supports(t string)       bool   { return t == "excel" }

func (e *ExcelProvider) Generate(ctx context.Context, req OfficeRequest) (OfficeResult, error) {
    var p ExcelParams
    if err := json.Unmarshal(req.Params, &p); err != nil { return OfficeResult{}, err }

    f := excelize.NewFile()
    defer f.Close()

    for _, sheet := range p.Sheets {
        f.NewSheet(sheet.Name)

        // 写入表头（加粗样式）
        headerStyle, _ := f.NewStyle(&excelize.Style{
            Font: &excelize.Font{Bold: true, Color: "FFFFFF"},
            Fill: excelize.Fill{Type: "pattern", Color: []string{"4472C4"}, Pattern: 1},
        })
        for col, h := range sheet.Headers {
            cell, _ := excelize.CoordinatesToCellName(col+1, 1)
            f.SetCellValue(sheet.Name, cell, h)
            f.SetCellStyle(sheet.Name, cell, cell, headerStyle)
        }

        // 写入数据行
        for rowIdx, row := range sheet.Rows {
            for colIdx, val := range row {
                cell, _ := excelize.CoordinatesToCellName(colIdx+1, rowIdx+2)
                f.SetCellValue(sheet.Name, cell, val)
            }
        }

        // 写入公式
        for _, formula := range sheet.Formulas {
            f.SetCellFormula(sheet.Name, formula.Cell, formula.Formula)
        }

        // 自动列宽
        f.SetColWidth(sheet.Name, "A", "Z", 14)

        // 添加图表
        for _, chart := range sheet.Charts {
            chartType := map[string]excelize.ChartType{
                "bar":  excelize.Bar,
                "line": excelize.Line,
                "pie":  excelize.Pie,
            }[chart.Type]
            f.AddChart(sheet.Name, "H2", &excelize.Chart{
                Type:  chartType,
                Title: []excelize.RichTextRun{{Text: chart.Title}},
                Series: []excelize.ChartSeries{{
                    Name:       sheet.Name,
                    Categories: fmt.Sprintf("%s!%s", sheet.Name, chart.CategoryRange),
                    Values:     fmt.Sprintf("%s!%s", sheet.Name, chart.ValueRange),
                }},
            })
        }
    }

    // 删除默认 Sheet1（如果有自定义 sheet）
    if len(p.Sheets) > 0 { f.DeleteSheet("Sheet1") }

    buf, err := f.WriteToBuffer()
    if err != nil { return OfficeResult{}, err }

    return OfficeResult{
        FileBytes:   buf.Bytes(),
        ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }, nil
}
```

#### Word 实现（Go + 模板 XML）

Word 文档本质是一组 XML 文件打包成 ZIP。我们预置多套 `.docx` 模板，运行时用 AI 生成的内容填充：

```go
// internal/service/office/word.go
// 策略：读取预置模板 → 解压 → 替换 word/document.xml → 重新打包

type WordProvider struct {
    TemplatesDir string // 模板文件目录
}

func (w *WordProvider) Name()             string { return "word-go" }
func (w *WordProvider) Supports(t string) bool   { return t == "word" }

func (w *WordProvider) Generate(ctx context.Context, req OfficeRequest) (OfficeResult, error) {
    var p WordParams
    json.Unmarshal(req.Params, &p)

    // 选择模板（报告/方案/通知/合同等）
    templatePath := filepath.Join(w.TemplatesDir, p.Template+".docx")
    tmplBytes, err := os.ReadFile(templatePath)
    if err != nil { return OfficeResult{}, err }

    // 解压 → 找到 word/document.xml → 替换占位符 → 重新打包
    result, err := fillDocxTemplate(tmplBytes, p.Variables)
    if err != nil { return OfficeResult{}, err }

    return OfficeResult{
        FileBytes:   result,
        ContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }, nil
}

// AI 为 Word 生成的 JSON schema
// {
//   "template": "business_report",   // 模板名：business_report|proposal|notice|contract
//   "variables": {
//     "title":    "2026年Q1销售分析报告",
//     "author":   "销售部",
//     "sections": [
//       {"heading": "核心数据", "content": "..."},
//       {"heading": "问题分析", "content": "..."}
//     ]
//   }
// }
```

**预置 Word 模板列表（针对白领场景）：**

| 模板 ID | 用途 |
|---------|------|
| `business_report` | 工作报告 / 周报月报 |
| `proposal` | 方案书 / 策划案 |
| `notice` | 通知公告 |
| `meeting_minutes` | 会议纪要 |
| `contract_simple` | 简单合同 / 协议 |
| `job_description` | 岗位说明书（HR 场景）|

#### PPT 实现（Python 微服务 + python-pptx）

Python sidecar 是一个极轻量的 FastAPI 服务，只做一件事：接收 JSON → 返回 .pptx 文件二进制。

**Go 调用方：**

```go
// internal/service/office/ppt.go

type PPTSidecarProvider struct {
    SidecarURL string  // http://ppt-sidecar:5001
    HTTPClient *http.Client
}

func (p *PPTSidecarProvider) Name()             string { return "ppt-python" }
func (p *PPTSidecarProvider) Supports(t string) bool   { return t == "ppt" }

func (p *PPTSidecarProvider) Generate(ctx context.Context, req OfficeRequest) (OfficeResult, error) {
    body, _ := json.Marshal(req.Params)
    httpReq, _ := http.NewRequestWithContext(ctx, "POST",
        p.SidecarURL+"/generate/ppt", bytes.NewReader(body))
    httpReq.Header.Set("Content-Type", "application/json")

    resp, err := p.HTTPClient.Do(httpReq)
    if err != nil { return OfficeResult{}, fmt.Errorf("ppt sidecar 不可用: %w", err) }
    defer resp.Body.Close()

    if resp.StatusCode != 200 {
        errBody, _ := io.ReadAll(resp.Body)
        return OfficeResult{}, fmt.Errorf("ppt 生成失败: %s", errBody)
    }

    fileBytes, err := io.ReadAll(resp.Body)
    if err != nil { return OfficeResult{}, err }

    return OfficeResult{
        FileBytes:   fileBytes,
        ContentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }, nil
}
```

**Python sidecar（ppt-sidecar/main.py，约 120 行）：**

```python
# ppt-sidecar/main.py
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.chart.data import ChartData
from pptx.enum.chart import XL_CHART_TYPE
import json, io

app = FastAPI()

CHART_TYPE_MAP = {
    "bar":  XL_CHART_TYPE.COLUMN_CLUSTERED,
    "line": XL_CHART_TYPE.LINE,
    "pie":  XL_CHART_TYPE.PIE,
}

SLIDE_LAYOUTS = {
    "title":       0,   # 标题页
    "section":     1,   # 章节标题
    "bullet":      2,   # 标题 + 要点
    "two_column":  3,   # 双栏
    "blank":       6,   # 空白
}

@app.post("/generate/ppt")
async def generate_ppt(params: dict):
    try:
        prs = Presentation()
        prs.slide_width  = Inches(13.33)
        prs.slide_height = Inches(7.5)

        theme = params.get("theme", "blue")  # blue | green | gray
        apply_theme(prs, theme)

        for slide_data in params.get("slides", []):
            layout_name = slide_data.get("type", "bullet")
            layout = prs.slide_layouts[SLIDE_LAYOUTS.get(layout_name, 2)]
            slide = prs.slides.add_slide(layout)

            # 填充标题
            if slide_data.get("title") and slide.shapes.title:
                slide.shapes.title.text = slide_data["title"]

            # 填充要点（bullet 类型）
            if layout_name == "bullet" and slide_data.get("bullets"):
                tf = slide.placeholders[1].text_frame
                tf.clear()
                for i, bullet in enumerate(slide_data["bullets"]):
                    p = tf.add_paragraph() if i > 0 else tf.paragraphs[0]
                    p.text  = bullet
                    p.level = slide_data.get("levels", [0] * len(slide_data["bullets"]))[i]

            # 插入图表
            if slide_data.get("chart"):
                c = slide_data["chart"]
                chart_data = ChartData()
                chart_data.categories = c["categories"]
                for series in c["series"]:
                    chart_data.add_series(series["name"], series["values"])
                chart_type = CHART_TYPE_MAP.get(c.get("type", "bar"),
                             XL_CHART_TYPE.COLUMN_CLUSTERED)
                slide.shapes.add_chart(
                    chart_type, Inches(1), Inches(1.8), Inches(11), Inches(5),
                    chart_data
                )

            # 双栏布局
            if layout_name == "two_column":
                fill_two_column(slide, slide_data)

        buf = io.BytesIO()
        prs.save(buf)
        buf.seek(0)
        return Response(
            content=buf.read(),
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation"
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
def health(): return {"status": "ok"}
```

**ppt-sidecar/Dockerfile（极轻量）：**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN pip install fastapi uvicorn python-pptx --no-cache-dir
COPY main.py .
EXPOSE 5001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5001"]
```

#### OfficeToolExecutor（串联三种实现）

```go
// internal/service/llm/tool_executor.go

type OfficeToolExecutor struct {
    excel       *office.ExcelProvider
    word        *office.WordProvider
    ppt         *office.PPTSidecarProvider
    fileService *FileService
}

func (e *OfficeToolExecutor) Execute(ctx context.Context, userID string, input ToolInput) (ToolOutput, error) {
    var req office.OfficeRequest
    json.Unmarshal(input, &req)

    var result office.OfficeResult
    var err error

    switch req.Type {
    case "excel":
        result, err = e.excel.Generate(ctx, req)
    case "word":
        result, err = e.word.Generate(ctx, req)
    case "ppt":
        result, err = e.ppt.Generate(ctx, req)
        // PPT sidecar 不可用时降级：返回友好错误，不静默失败
        if err != nil {
            return ToolOutput{
                Success: false,
                Error:   "PPT 生成服务暂时不可用，请稍后重试或改用 Word 格式",
            }, nil
        }
    default:
        return ToolOutput{Error: "不支持的文件类型: " + req.Type}, nil
    }

    if err != nil { return ToolOutput{Error: "文件生成失败: " + err.Error()}, nil }

    // 统一落地：上传 S3 + 记录 file_jobs
    fileID, err := e.fileService.UploadBytes(ctx, userID,
        req.Filename, result.FileBytes, result.ContentType)
    if err != nil { return ToolOutput{}, err }

    return ToolOutput{Success: true, FileID: fileID}, nil
}
```

#### `file_jobs` 表（生成任务记录）

```sql
CREATE TABLE file_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    client_conversation_id VARCHAR(80),
    client_message_id      VARCHAR(80),
    request_id      VARCHAR(80),

    type            VARCHAR(20) NOT NULL,    -- excel | word | ppt | image
    provider        VARCHAR(50) NOT NULL,    -- excel-go | word-go | ppt-python
    status          VARCHAR(20) NOT NULL DEFAULT 'queued',
    -- queued | running | done | failed | canceled
    input_params    JSONB NOT NULL,          -- AI 参数原始数据（排查用）
    output_file_id  UUID REFERENCES files(id),
    error_message   TEXT,

    duration_ms     INT,                     -- 生成耗时（性能监控）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);
```

#### AI 为三种格式生成的 JSON 示例

**Excel（calculate 场景）：**
```json
{
  "type": "excel",
  "filename": "Q1销售报表",
  "sheets": [{
    "name": "销售数据",
    "headers": ["月份", "销售额", "目标", "完成率"],
    "rows": [
      ["1月", 120000, 100000, "=B2/C2"],
      ["2月", 95000,  100000, "=B3/C3"]
    ],
    "formulas": [{"cell": "B8", "formula": "=SUM(B2:B7)"}],
    "charts": [{
      "type": "line",
      "title": "月度销售趋势",
      "category_range": "A2:A7",
      "value_range": "B2:B7"
    }]
  }]
}
```

**Word（write 场景）：**
```json
{
  "type": "word",
  "filename": "Q1工作总结",
  "template": "business_report",
  "variables": {
    "title": "2026年第一季度工作总结",
    "author": "市场部  张三",
    "date": "2026年4月1日",
    "sections": [
      {"heading": "一、工作完成情况", "content": "本季度完成销售额..."},
      {"heading": "二、存在的问题", "content": "在客户维护方面..."},
      {"heading": "三、下季度计划", "content": "重点推进..."}
    ]
  }
}
```

**PPT（write 场景）：**
```json
{
  "type": "ppt",
  "filename": "Q1销售汇报",
  "theme": "blue",
  "slides": [
    {"type": "title",   "title": "2026年Q1销售汇报", "subtitle": "市场部 · 2026.04"},
    {"type": "section", "title": "核心数据"},
    {"type": "bullet",  "title": "Q1业绩亮点",
     "bullets": ["销售额同比增长 23%", "新客户获取 128 家", "续签率 91%"],
     "levels":  [0, 0, 0]},
    {"type": "bullet",  "title": "月度趋势",
     "chart": {"type": "line", "categories": ["1月","2月","3月"],
               "series": [{"name": "实际", "values": [120000, 95000, 138000]},
                          {"name": "目标", "values": [100000, 100000, 120000]}]}},
    {"type": "section", "title": "Q2 计划"},
    {"type": "bullet",  "title": "重点方向",
     "bullets": ["拓展华南区域渠道", "提升大客户服务质量", "上线新产品线"]},
    {"type": "title",   "title": "谢谢", "subtitle": ""}
  ]
}
```

### 5.11 图片生成（Phase 4）

用户可以在对话中直接要求生成图片，也可以通过独立的图片生成界面选择档位后提交。后端根据所选档位路由到对应的供应商，生成结果上传 S3，返回预签名 URL。

#### 三档模型策略

| 档位 | 对应模型 | 参考成本 | 积分消耗 | 适用场景 |
|------|---------|---------|---------|---------|
| **fast（快速）** | Stability AI `stable-image-core` | ~$0.003/张 | **20 积分** | 草图、配图、快速验证 |
| **standard（标准）** | OpenAI `dall-e-3` | ~$0.04/张 | **80 积分** | 营销配图、演示用图 |
| **premium（精品）** | OpenAI `gpt-image-1` | ~$0.17/张 | **200 积分** | 高质量商业图、产品展示 |

> 积分比例参考内部汇率（1 积分 ≈ ¥0.01），可在运营后台按成本动态调整，无需改代码。

#### ImageProvider 接口

```go
// internal/service/image/provider.go

type ImageRequest struct {
    Prompt  string
    Quality string // "fast" | "standard" | "premium"
    Size    string // "1024x1024" | "1024x1792" | "1792x1024"（宽屏/竖屏）
    Style   string // "natural" | "vivid"（仅 OpenAI 支持）
    UserID  string
}

type ImageResult struct {
    ImageBytes  []byte
    ContentType string // "image/png" | "image/webp"
    Width       int
    Height      int
    Provider    string // 记录实际用了哪个供应商
}

type ImageProvider interface {
    Name()     string // "gpt-image-1" | "dall-e-3" | "stability-core"
    Quality()  string // 该实现对应哪个档位
    Generate(ctx context.Context, req ImageRequest) (ImageResult, error)
}
```

#### 档位路由器

```go
// internal/service/image/router.go

type ImageRouter struct {
    providers map[string]ImageProvider // key: "fast" | "standard" | "premium"
}

func NewImageRouter(cfg *config.Config) *ImageRouter {
    return &ImageRouter{
        providers: map[string]ImageProvider{
            "fast":     &StabilityProvider{APIKey: cfg.StabilityAPIKey},
            "standard": &DallE3Provider{APIKey: cfg.OpenAIAPIKey},
            "premium":  &GptImage1Provider{APIKey: cfg.OpenAIAPIKey},
        },
    }
}

func (r *ImageRouter) Route(quality string) ImageProvider {
    if p, ok := r.providers[quality]; ok {
        return p
    }
    return r.providers["standard"] // 默认中档
}
```

#### 三种 Provider 实现

**GptImage1Provider（精品档）：**

```go
// internal/service/image/gpt_image1.go

type GptImage1Provider struct{ APIKey string }

func (p *GptImage1Provider) Name()    string { return "gpt-image-1" }
func (p *GptImage1Provider) Quality() string { return "premium" }

func (p *GptImage1Provider) Generate(ctx context.Context, req ImageRequest) (ImageResult, error) {
    payload := map[string]any{
        "model":   "gpt-image-1",
        "prompt":  req.Prompt,
        "size":    req.Size,
        "quality": "high",           // gpt-image-1 支持 low|medium|high
        "output_format": "png",
        "n": 1,
    }
    // POST https://api.openai.com/v1/images/generations
    // 响应: data[0].b64_json → base64 解码为 []byte
    return callOpenAIImages(ctx, p.APIKey, payload)
}
```

**DallE3Provider（标准档）：**

```go
// internal/service/image/dalle3.go

type DallE3Provider struct{ APIKey string }

func (p *DallE3Provider) Name()    string { return "dall-e-3" }
func (p *DallE3Provider) Quality() string { return "standard" }

func (p *DallE3Provider) Generate(ctx context.Context, req ImageRequest) (ImageResult, error) {
    payload := map[string]any{
        "model":   "dall-e-3",
        "prompt":  req.Prompt,
        "size":    req.Size,
        "quality": "standard",
        "style":   req.Style,   // "natural" | "vivid"
        "response_format": "b64_json",
        "n": 1,
    }
    return callOpenAIImages(ctx, p.APIKey, payload)
}
```

**StabilityProvider（快速档）：**

```go
// internal/service/image/stability.go

type StabilityProvider struct{ APIKey string }

func (p *StabilityProvider) Name()    string { return "stability-core" }
func (p *StabilityProvider) Quality() string { return "fast" }

func (p *StabilityProvider) Generate(ctx context.Context, req ImageRequest) (ImageResult, error) {
    // POST https://api.stability.ai/v2beta/stable-image/generate/core
    // multipart/form-data: prompt, aspect_ratio, output_format=png
    // 响应: image/* 二进制流，直接读取
    body := &bytes.Buffer{}
    writer := multipart.NewWriter(body)
    writer.WriteField("prompt", req.Prompt)
    writer.WriteField("aspect_ratio", sizeToAspectRatio(req.Size))
    writer.WriteField("output_format", "png")
    writer.Close()

    httpReq, _ := http.NewRequestWithContext(ctx, "POST",
        "https://api.stability.ai/v2beta/stable-image/generate/core", body)
    httpReq.Header.Set("Authorization", "Bearer "+p.APIKey)
    httpReq.Header.Set("Accept", "image/*")
    httpReq.Header.Set("Content-Type", writer.FormDataContentType())

    resp, err := http.DefaultClient.Do(httpReq)
    if err != nil { return ImageResult{}, err }
    defer resp.Body.Close()

    imgBytes, _ := io.ReadAll(resp.Body)
    return ImageResult{
        ImageBytes:  imgBytes,
        ContentType: "image/png",
        Provider:    p.Name(),
    }, nil
}

// 尺寸 → Stability aspect_ratio 参数映射
func sizeToAspectRatio(size string) string {
    switch size {
    case "1792x1024": return "16:9"
    case "1024x1792": return "9:16"
    default:          return "1:1"
    }
}
```

#### ImageService（统一入口）

图片生成统一使用异步任务。API 只负责创建 `file_jobs(status=queued)` 并预留额度，worker 完成生成、上传 S3、更新任务状态并结算额度。

```go
// internal/service/image/service.go

type ImageService struct {
    router      *ImageRouter
    fileService *FileService
    billing     *BillingService
}

// 积分消耗定义（可迁移到数据库运营后台配置）
var imageCreditCost = map[string]int64{
    "fast":     20,
    "standard": 80,
    "premium":  200,
}

func (s *ImageService) Enqueue(ctx context.Context, userID string, req ImageRequest) (string, error) {
    cost := imageCreditCost[req.Quality]

    reservation, err := s.billing.ReserveFixedCost(ctx, userID, cost, "image")
    if err != nil { return "", err }

    jobID, err := s.jobs.Create(ctx, FileJob{
        Type: "image", Status: "queued", UserID: userID,
        ReservationID: reservation.ID, InputParams: req,
    })
    if err != nil {
        _ = s.billing.Release(ctx, reservation.ID, "job_create_failed")
        return "", err
    }
    return jobID, nil
}
```

#### `create_image` 工具定义（Agentic Loop 集成）

AI 在对话中识别到生图需求时，通过工具调用触发生成：

```go
// internal/service/llm/tools.go（新增）

var CreateImageTool = ToolDefinition{
    Name: "create_image",
    Description: `根据用户的描述生成图片。
使用时机：用户明确要求生成、绘制、创作图片时。
不要自行决定档位，必须从用户消息中提取或在调用前询问用户。`,
    InputSchema: json.RawMessage(`{
        "type": "object",
        "required": ["prompt", "quality"],
        "properties": {
            "prompt": {
                "type": "string",
                "description": "详细的图片描述，英文效果更好，建议 AI 自动翻译优化"
            },
            "quality": {
                "type": "string",
                "enum": ["fast", "standard", "premium"],
                "description": "fast=快速(20积分) | standard=标准(80积分) | premium=精品(200积分)"
            },
            "size": {
                "type": "string",
                "enum": ["1024x1024", "1024x1792", "1792x1024"],
                "description": "图片尺寸：正方形 | 竖版 | 横版"
            },
            "style": {
                "type": "string",
                "enum": ["natural", "vivid"],
                "description": "风格：natural=真实自然 | vivid=鲜艳夸张（仅标准/精品档）"
            }
        }
    }`),
}

// 加入 SkillTools（由 Agentic Chat 运行时按意图选择）
var SkillTools = map[string][]ToolDefinition{
    "office-generation": {CreateExcelTool, CreateWordTool, CreatePPTTool},
    "image-generation":  {CreateImageTool},
    "document-analysis": {AnalyzeFileTool, ExtractTableTool},
}
```

#### `file_jobs` 扩展（type 新增 `image`）

`file_jobs` 表无需改结构，`type` 字段新增 `image` 枚举值，`input_params` 存储 prompt / quality / size：

```json
{
  "type": "image",
  "provider": "gpt-image-1",
  "input_params": {
    "prompt": "A clean minimalist office workspace with warm morning light",
    "quality": "premium",
    "size": "1792x1024",
    "style": "natural"
  }
}
```

#### 直接调用 API（非 Agentic Loop）

用户也可以通过独立的图片生成界面直接调用，不经过 AI 对话：

```
POST /api/v1/images/generate
{
  "prompt":  "用户输入的描述",
  "quality": "standard",
  "size":    "1024x1024",
  "style":   "vivid"
}

→ 202 Accepted
{
  "job_id":   "uuid",
  "status":   "processing"
}

GET /api/v1/images/:job_id
→ 200 OK
{
  "status":       "done",
  "download_url": "https://cdn.jiandanly.com/...",
  "credits_used": 80,
  "expires_at":   "2026-06-10T..."
}
```

> **为什么用异步接口？** `gpt-image-1` 精品档生成耗时可达 15–30 秒，同步 HTTP 会超时。`fast` 档通常 3–5 秒，也建议统一用异步，客户端轮询或 SSE 推送状态。

---

## 六、中间件设计

### 执行顺序

```
请求到达
  │
  ▼
RequestID（注入 X-Request-ID）
  │
  ▼
Logger（method / path / status / duration / request_id）
  │
  ▼
Recovery（捕获 panic，返回 500，记录堆栈）
  │
  ▼
RateLimit（IP + 用户 ID 双维度）
  │
  ▼
Auth（JWT 鉴权）
  │
  ▼
Handler
```

### 限流策略

| 维度 | 策略 | 限制 |
|------|------|------|
| IP 全局 | 滑动窗口 | 100 req/min |
| 用户对话（快速模式） | 令牌桶 | 20 req/min |
| 用户对话（深度模式） | 令牌桶 | 10 req/min |
| 登录/注册 | 计数器 | 5 次/min/IP |
| Stripe Webhook | 不限流，验签代替 |

---

## 七、错误处理规范

```go
var (
    ErrInsufficientCredits  = NewAppError(50201, "本月额度和额外额度不足，请升级或充值后继续使用")
    ErrModelUnavailable     = NewAppError(50202, "AI 服务暂时不可用，请稍后重试")
    ErrInvalidToken         = NewAppError(40001, "登录状态已过期，请重新登录")
    ErrPermissionDenied     = NewAppError(40101, "权限不足")
    ErrMemberQuotaExceeded  = NewAppError(50203, "本月用量已达上限，请联系管理员")
    ErrFileProcessingFailed = NewAppError(50301, "文件处理失败，请检查文件格式")
    ErrShareExpired         = NewAppError(40402, "分享链接已过期或已被撤销")
)

func handleError(w http.ResponseWriter, r *http.Request, err error) {
    var appErr *AppError
    if errors.As(err, &appErr) {
        response.Error(w, appErr.Code, appErr.Message)
        return
    }
    slog.ErrorContext(r.Context(), "unexpected error", "err", err,
        "request_id", r.Header.Get("X-Request-ID"))
    response.Error(w, 50001, "服务器内部错误")
}
```

---

## 八、部署方案

### 8.1 docker-compose.yml

```yaml
version: "3.9"
services:
  api:
    image: jiandanly-api:latest
    build: .
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      ppt-sidecar:
        condition: service_healthy

  ppt-sidecar:
    build: ./ppt-sidecar
    restart: unless-stopped
    ports:
      - "127.0.0.1:5001:5001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5001/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  postgres:
    image: pgvector/pgvector:pg16   # 内置 pgvector 扩展
    restart: unless-stopped
    environment:
      POSTGRES_DB: jiandanly
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD} --maxmemory 512mb --maxmemory-policy noeviction
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  postgres_data:
  redis_data:
  caddy_data:
  caddy_config:
```

> **注意：**
> - PostgreSQL 镜像使用 `pgvector/pgvector:pg16`，内置 pgvector，Phase 4+ 启用 opt-in 云知识库时无需重建数据库。
> - Redis 不承载真实余额和安全黑名单，`noeviction` 用来避免关键短期状态被静默淘汰；容量不足应暴露为错误并扩容。
> - `ppt-sidecar` 仅监听 127.0.0.1:5001，不对外暴露；`api` 服务通过内部 Docker 网络访问它（`http://ppt-sidecar:5001`）。

### 8.2 Caddyfile

```
jiandanly.com {
    reverse_proxy localhost:8080
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        X-XSS-Protection "1; mode=block"
    }
}
```

### 8.3 合规与数据边界

- 香港部署用于降低大陆访问延迟，但不能被写成“规避中国个人信息保护义务”的技术保证。
- Local-first 是早期默认：聊天历史、对话搜索、导入/导出由客户端本地负责；后端不默认保存完整 prompt、response、messages。
- 隐私政策需要明确：数据处理目的、LLM 供应商转发、临时文件存储位置、跨境处理、删除和导出方式。
- 模型调用、上传文件、生成文件、支付事件、成员管理都要写入审计日志；日志中不得记录完整密钥、支付卡信息或未脱敏的敏感正文。
- 后端转发给 LLM 供应商前，应尽量做文件类型、大小、内容长度和敏感字段过滤。
- 临时文件必须有 `retention_expires_at`，过期对象、提取结果和元数据由定时清理任务删除。

### 8.4 Dockerfile

```dockerfile
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o api ./cmd/api

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=builder /app/api .
EXPOSE 8080
CMD ["./api"]
```

### 8.5 环境变量（.env.example）

```bash
# 服务器
PORT=8080
ENV=production

# 数据库
DATABASE_URL=postgres://user:pass@localhost:5432/jiandanly?sslmode=disable
POSTGRES_USER=jiandanly
POSTGRES_PASSWORD=your_strong_password

# Redis
REDIS_URL=redis://:your_redis_password@localhost:6379/0
REDIS_PASSWORD=your_redis_password

# JWT
JWT_SECRET=your_32_byte_secret_here
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=720h

# LLM 供应商
DEEPSEEK_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
QWEN_API_KEY=sk-...

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# AWS S3
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=jiandanly-files
AWS_S3_REGION=ap-east-1

# 向量化（Phase 4+，opt-in 云知识库用）
# 选项 A：OpenAI ada-002（精度高，有成本）
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
# 选项 B：本地 BGE-large-zh（开源，零成本，需额外部署）
# EMBEDDING_PROVIDER=local
# EMBEDDING_API_URL=http://localhost:8001/embed

# Office 文件生成（Phase 4）
# Excel / Word 由 Go 进程内直接生成，无需额外配置
# PPT 由独立 Python sidecar 生成，通过 Docker 内部网络访问
PPT_SIDECAR_URL=http://ppt-sidecar:5001   # Docker Compose 内部地址
# PPT_SIDECAR_URL=http://localhost:5001   # 本地开发时使用此地址
WORD_TEMPLATES_DIR=./word-templates       # 预置 .docx 模板目录

# 图片生成（Phase 4）
# 标准档 / 精品档 复用上面的 OPENAI_API_KEY
STABILITY_API_KEY=sk-...                  # 快速档（Stability AI stable-image-core）
# 积分消耗可在代码中调整：fast=20 / standard=80 / premium=200
IMAGE_DEFAULT_QUALITY=standard            # 未指定时的默认档位

# 前端 URL（CORS）
FRONTEND_URL=https://jiandanly.com

# 邮件
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASSWORD=re_...
EMAIL_FROM=noreply@jiandanly.com
```

### 8.6 数据库迁移

```go
func runMigrations(db *sql.DB) error {
    driver, _ := postgres.WithInstance(db, &postgres.Config{})
    m, _ := migrate.NewWithDatabaseInstance("file://migrations", "postgres", driver)
    return m.Up()
}
```

---

## 九、开发规范

### 9.1 依赖选型

| 用途 | 库 |
|------|----|
| HTTP 路由 | `go-chi/chi/v5` |
| 数据库驱动 | `jackc/pgx/v5` |
| pgvector | `pgvector/pgvector-go` |
| Redis | `redis/go-redis/v9` |
| JWT | `golang-jwt/jwt/v5` |
| 密码哈希 | `golang.org/x/crypto/bcrypt` |
| 数据库迁移 | `golang-migrate/migrate/v4` |
| Stripe | `stripe/stripe-go/v79` |
| 参数校验 | `go-playground/validator/v10` |
| 日志 | `log/slog`（标准库） |
| 配置 | `joho/godotenv` |
| 测试 | `stretchr/testify` |
| **Excel 生成（Phase 4）** | **`360EntSecGroup-Skylar/excelize/v2`** |
| **Word 生成（Phase 4）** | Go 标准库 `archive/zip` + `encoding/xml`（无需第三方库） |
| **PPT 生成（Phase 4）** | Python sidecar：`python-pptx` + `fastapi` + `uvicorn` |
| 文档解析（Phase 2/4） | `ledongthuc/pdfcpu`（PDF）/ `unidoc/unioffice`（读取 Office） |

### 9.2 分层约定

- `handler`：解析请求 → 调用 service → 返回响应，不写业务逻辑
- `service`：业务逻辑，协调多个 repository，处理事务
- `repository`：只写 SQL，方法命名以 `Get/List/Create/Update/Delete` 开头
- `model`：纯数据结构，不含方法

### 9.3 测试策略

| 层级 | 策略 | 目标覆盖率 |
|------|------|-----------|
| Repository | 集成测试（真实 PostgreSQL） | 80%+ |
| Service | 单元测试（Mock Repository） | 70%+ |
| Handler | 集成测试（httptest） | 关键接口 100% |
| LLM 代理 | Mock 供应商 HTTP Server | 核心路径 100% |
| RAG | 固定 embedding 向量做快照测试 | 检索路径 100% |

### 9.4 Makefile

```makefile
.PHONY: dev build test migrate lint

dev:
	air -c .air.toml

build:
	go build -o bin/api ./cmd/api

test:
	go test ./... -v -race

migrate-up:
	migrate -path migrations -database ${DATABASE_URL} up

migrate-down:
	migrate -path migrations -database ${DATABASE_URL} down 1

lint:
	golangci-lint run ./...

docker-up:
	docker compose up -d

docker-logs:
	docker compose logs -f api
```

---

## 十、交付清单

### Phase 1：可收费聊天 MVP

- [ ] 项目脚手架（目录结构、依赖、配置加载）
- [ ] 数据库 Schema 及 Migration（users / wallets / llm_call_records / payments / audit_logs）
- [ ] 认证模块（注册 / 登录 / JWT / Refresh Token 轮换）
- [ ] JWT 鉴权中间件 + 限流中间件
- [ ] LLM 代理核心（SSE 流式转发、DeepSeek + Claude）
- [ ] 模型路由（快速 / 深度）
- [ ] 基础 skill/system instructions 注入（最小版本）
- [ ] 基础对话接口（`POST /api/v1/chat/completions`）
- [ ] 轻量调用记录：保存 request_id、client_conversation_id、模型、用量、状态，不保存正文
- [ ] 包月订阅钱包：月额度发放、额度预留、结算、释放
- [ ] Stripe 订阅 Checkout + Webhook 幂等处理
- [ ] 用户信息接口、账单余额接口、用量接口
- [ ] 结构化日志 + 请求 ID + 审计日志
- [ ] Docker Compose 一键部署
- [ ] AWS 香港服务器部署验证

### Phase 2：Local Agent Harness

- [x] Phase 2.0：新增 [`spec.md`](spec.md)，替换旧的场景模板路线，锁定 Local Agent Harness + Cloud Control Plane
- [x] Phase 2.1：合并普通聊天和文档阅读入口，现有 documents API 成为 Agentic Chat 的文档工具
- [x] Phase 2.2：新增云端兼容 Agent Run API：runs / events / stream / cancel
- [x] Phase 2.2：新增 `agent_runs` / `agent_events` 短期事件表，默认 7 天保留
- [x] Phase 2.2：Agent Run 复用现有 LLM provider 和额度预留/结算，并写 `llm_call_records(scene=agent)`
- [x] Phase 2.2：admin 只读观察 run 摘要、LLM 用量和工具错误，不展示私有本地内容
- [x] Phase 2.3a：新增 `local-host/` daemon foundation；云端不扩展成本地工具执行器
- [x] Phase 2.4：实现 `/api/v1/agent/llm` 和 `/api/v1/agent/tool-events`，让 Local Harness 通过云端统一计费和审计摘要
- [x] Phase 2.5：Local Host 支持 artifact、checkpoint resume、context compaction 和基础本地 memory；云端仍只接收计费和摘要
- [x] Phase 2.6：Local Host 支持规则验证事件、SSRF 防护 `web.fetch`、早期可选 Tavily `web.search` 和 MCP allowlist 护栏
- [x] Phase 2.22：Tavily `web.search` 从 Local Host 迁移到 Cloud Tool Gateway；Cloud API 持有 provider key、执行第三方调用、写 `external_tool_call_records`、使用 wallet credits 扣费，并通过 admin 只读接口观察工具调用
- [x] Phase 2.9：Local Host 支持 workspace 授权诊断、撤销和 client 本地项目引用；云端仍不保存本地私有文件内容
- [x] Phase 2.10：Local Host 支持最近 run 列表、基于 stream 的手动恢复和脱敏诊断导出；云端仍只接收计费和摘要
- [x] Phase 2.11：Local Host 支持真实 stdio MCP runtime adapter；`mcp.call` 仍必须经过 allowlist 和本地用户权限批准，云端不执行本地 MCP
- [x] Phase 2.12：Local Host 支持并发安全工具批处理；读类工具可并行执行，结果仍按原始 tool call 顺序回填模型上下文
- [x] Phase 2.13：Local Host 将模型网关异常转换为 durable `run.failed`，避免本地 run 卡在 `running`

### Phase 3：Local Agent Harness 深化

- [x] MVP TAO loop、本地 run 事件持久化、artifact、checkpoint 和基础恢复
- [x] 最近本地 run 列表、手动恢复入口和脱敏诊断导出
- [x] 真实本地 MCP runtime adapter
- [x] 并发安全工具批处理和稳定 observation 顺序
- [x] 模型网关失败的 durable run failure
- [ ] 浏览器、IDE 工具；写操作和危险命令默认需要确认
- [x] MVP verification 生命周期
- [ ] 更强上下文压缩、Playwright/视觉验证和 LLM-as-judge
- [ ] 本地工具事件只向云端同步计费、审计和摘要

### Phase 4：生成任务与多工具编排

- [ ] Opt-in 云知识库增强（pgvector + 文档分片 + 语义检索 + 权限校验）
- [ ] 多工具任务编排、artifact 管理、上下文压缩和来源追踪
- [ ] 异步 job worker + 文件大小 / 耗时 / 输入 JSON 大小限制
- [ ] OfficeProvider 接口 + Excel / Word / PPT 三种实现
- [ ] file_jobs 表扩展为 Office / 图片统一任务记录
- [ ] Office 文件生成计费（预留额度 + 任务完成结算）
- [ ] ImageProvider 接口 + 三档路由器 + 图片生成异步接口
- [ ] 熔断器（供应商故障自动降级）

### Phase 5：团队版、开放平台与自动化

- [ ] 团队管理（组织 / 成员 / 角色 / 成员月上限）
- [ ] 团队钱包：组织月额度池 + 成员月上限
- [ ] 请求必须显式传 `organization_id` 才能使用团队钱包
- [ ] 团队管理后台：成员用量、账单、发票、Agent run 摘要和工具失败观察
- [ ] 团队共享知识库：权限、引用来源、跨成员使用
- [ ] Webhook 管理（配置 + 事件推送 + HMAC 签名）
- [ ] 低余额告警（Webhook + 邮件通知）
- [ ] 定时任务 / 自动化工作流
- [ ] 飞书 / 钉钉 / 企业微信集成
- [ ] MCP 协议支持
- [ ] 移动端 API 优化（PWA / Capacitor）
- [ ] 开放平台 API Key（企业系统调用本平台接口）
- [ ] BYOK 作为最后阶段的可选评估项，不进入当前核心架构

---

*文档版本: v1.3*
*最后更新: 2026-05-10*

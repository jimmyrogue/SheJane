# 简单（Jiandan）后端技术方案

**版本：** v1.1  
**更新：** 2026-05-10  
**适用阶段：** Phase 1 MVP + Phase 2 核心功能

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
   - 5.5 Prompt 模板层
   - 5.6 断线续传（Resumable Stream）
   - 5.7 多模态 / Vision 支持
   - 5.8 RAG 知识库（Phase 2）
6. [中间件设计](#六中间件设计)
7. [错误处理规范](#七错误处理规范)
8. [部署方案](#八部署方案)
9. [开发规范](#九开发规范)
10. [交付清单](#十交付清单)

---

## 一、整体架构

### 1.1 架构图

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
│  ├── /api/v1/user/*          用户路由（含 API Key 管理）  │
│  ├── /api/v1/chat/*          对话路由（含 SSE）           │
│  ├── /api/v1/conversations/* 对话管理（搜索/分享/导出）   │
│  ├── /api/v1/billing/*       计费路由                    │
│  ├── /api/v1/team/*          团队路由                    │
│  ├── /api/v1/template/*      模板路由                    │
│  ├── /api/v1/file/*          文件路由                    │
│  ├── /api/v1/knowledge/*     知识库 / RAG 路由           │
│  ├── /api/v1/webhooks/*      Webhook 管理路由            │
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
│  ├── BillingService          异步计费 + 余额管理          │
│  ├── TeamService             组织 / 团队 / 成员管理       │
│  ├── TemplateService         Prompt 模板管理             │
│  ├── FileService             S3 上传 / 预签名 URL         │
│  ├── ShareService            对话分享 / 导出             │
│  ├── RAGService              文档向量化 / 语义检索        │
│  ├── WebhookService          事件推送                    │
│  └── PaymentService          Stripe 集成                 │
└──────┬──────────────┬───────────────────────────────────┘
       │              │
       ▼              ▼
┌────────────┐  ┌─────────────────────────────┐
│ PostgreSQL │  │  Redis 7                    │
│    16      │  │                             │
│ + pgvector │  │ 限流计数器                   │
│            │  │ 余额缓存                     │
│ 用户表      │  │ Refresh Token 黑名单         │
│ 团队表      │  │ Resumable Stream 消息缓存    │
│ 计费记录    │  │ 验证码缓存                   │
│ 对话历史    │  │ RAG 查询结果缓存             │
│ 文件元数据  │  └─────────────────────────────┘
│ Prompt模板  │
│ 知识库分片  │
│ 分享链接    │
│ 用户APIKey  │
│ Webhook配置 │
└────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│          LLM Providers（对用户不可见）      │
│  DeepSeek │ Claude │ GPT-4o │ Qwen │ ... │
└──────────────────────────────────────────┘
```

### 1.2 设计原则

- **单体优先**：MVP 阶段不做微服务，一个 Go binary 包含所有逻辑，运维极简
- **接口标准化**：对外暴露 OpenAI 兼容接口，方便客户端迁移和 BYOK 用户接入
- **异步计费**：计费不阻塞对话链路，先响应用户，后台异步完成扣费
- **故障隔离**：LLM 供应商故障不影响主服务，熔断后自动降级
- **数据主权**：用户数据可随时导出，增强信任感（职场用户的强需求）
- **可观测性**：结构化日志 + 请求链路 ID，方便排查问题

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
│   │   ├── auth.go               # JWT + API Key 双模式鉴权
│   │   ├── ratelimit.go
│   │   ├── logger.go
│   │   ├── recovery.go
│   │   └── requestid.go
│   ├── handler/
│   │   ├── auth.go
│   │   ├── user.go               # 用户信息 / API Key 管理
│   │   ├── chat.go               # 对话 / SSE 流 / 断线续传
│   │   ├── conversation.go       # 对话列表 / 搜索 / 分享 / 导出
│   │   ├── billing.go
│   │   ├── team.go
│   │   ├── template.go
│   │   ├── file.go
│   │   ├── knowledge.go          # RAG 知识库管理
│   │   ├── webhook.go            # Webhook CRUD
│   │   ├── share.go              # 公开分享页（免登录）
│   │   └── payment.go
│   ├── service/
│   │   ├── auth.go
│   │   ├── llm/
│   │   │   ├── proxy.go
│   │   │   ├── router.go
│   │   │   ├── providers.go
│   │   │   └── circuit.go
│   │   ├── billing.go
│   │   ├── team.go
│   │   ├── template.go
│   │   ├── file.go
│   │   ├── share.go              # 分享链接生成 / 验证
│   │   ├── rag.go                # 文档解析 / 向量化 / 检索
│   │   ├── webhook.go            # 事件触发 / HMAC 签名
│   │   └── payment.go
│   ├── repository/
│   │   ├── user.go
│   │   ├── team.go
│   │   ├── billing.go
│   │   ├── template.go
│   │   ├── conversation.go
│   │   ├── file.go
│   │   ├── knowledge.go
│   │   └── webhook.go
│   ├── model/
│   │   ├── user.go
│   │   ├── team.go
│   │   ├── billing.go
│   │   ├── template.go
│   │   ├── conversation.go
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
│   ├── 003_init_billing.sql
│   ├── 004_init_conversations.sql
│   ├── 005_init_templates.sql
│   ├── 006_init_files.sql
│   ├── 007_init_shares.sql
│   ├── 008_init_api_keys.sql
│   ├── 009_init_knowledge.sql    # pgvector 扩展 + 分片表
│   └── 010_init_webhooks.sql
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

    -- BYOK
    byok_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    byok_provider    VARCHAR(50),
    byok_api_key_enc TEXT,                -- AES-256 加密

    -- 积分余额
    credits_balance    BIGINT NOT NULL DEFAULT 0,
    credits_total_used BIGINT NOT NULL DEFAULT 0,

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

### 3.3 用户 API Key 表 `user_api_keys`

允许用户生成 API Key，通过程序调用我们平台的 AI 接口（企业内部集成场景）。

```sql
CREATE TABLE user_api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         VARCHAR(100) NOT NULL,        -- 用途描述，如"公司 OA 集成"
    key_hash     VARCHAR(255) NOT NULL UNIQUE, -- SHA-256(raw_key)，原始 key 不存储
    key_prefix   VARCHAR(12) NOT NULL,         -- 展示用前缀，如 "jd_sk_a1b2..."
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,                  -- NULL 表示永不过期
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_user ON user_api_keys(user_id);
CREATE INDEX idx_api_keys_hash ON user_api_keys(key_hash);
```

### 3.4 组织 / 团队表

```sql
CREATE TABLE organizations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(255) NOT NULL,
    slug         VARCHAR(100) UNIQUE NOT NULL,
    owner_id     UUID NOT NULL REFERENCES users(id),
    plan         VARCHAR(50) NOT NULL DEFAULT 'team',  -- team | enterprise

    -- 统一积分池
    credits_balance          BIGINT NOT NULL DEFAULT 0,
    credits_alert_threshold  BIGINT NOT NULL DEFAULT 1000,

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

### 3.5 对话与消息表

```sql
CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

    title           VARCHAR(500) NOT NULL DEFAULT '新对话',
    mode            VARCHAR(20) NOT NULL DEFAULT 'fast',  -- fast | deep
    scene           VARCHAR(50),  -- write | read | translate | calculate | chat
    template_id     UUID,

    message_count   INT NOT NULL DEFAULT 0,
    total_tokens    INT NOT NULL DEFAULT 0,
    total_credits   BIGINT NOT NULL DEFAULT 0,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    pinned_at   TIMESTAMPTZ        -- 置顶功能
);

CREATE INDEX idx_conversations_user   ON conversations(user_id, created_at DESC);
CREATE INDEX idx_conversations_search ON conversations USING GIN(to_tsvector('simple', title));

-- 消息（content 为 JSONB 支持多模态）
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL,  -- user | assistant | system

    -- JSONB 格式，兼容 OpenAI 多模态
    -- 纯文本：{"type": "text", "text": "..."}
    -- 图片：  {"type": "image_url", "image_url": {"url": "s3://..."}}
    -- 混合：  [{"type":"text","text":"..."}, {"type":"image_url",...}]
    content         JSONB NOT NULL,

    -- 模型信息
    model    VARCHAR(100),
    provider VARCHAR(50),

    -- Token 统计
    input_tokens  INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    credits_cost  BIGINT NOT NULL DEFAULT 0,

    -- 断线续传状态
    stream_status VARCHAR(20) NOT NULL DEFAULT 'done', -- streaming | done | interrupted

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

-- 消息全文搜索索引（从 JSONB content 中提取文本部分）
CREATE INDEX idx_messages_fts ON messages
    USING GIN(to_tsvector('simple', content::text));
```

### 3.6 对话分享表 `shared_conversations`

```sql
CREATE TABLE shared_conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    share_token     VARCHAR(64) UNIQUE NOT NULL,   -- URL 中的唯一标识
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES users(id),

    -- 快照（分享时固定内容，避免对话修改后影响已分享链接）
    snapshot_data   JSONB NOT NULL,  -- 消息列表快照

    expires_at  TIMESTAMPTZ,         -- NULL 表示永不过期
    view_count  INT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shares_token ON shared_conversations(share_token);
CREATE INDEX idx_shares_conv  ON shared_conversations(conversation_id);
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

    -- 文件处理状态
    status      VARCHAR(20) NOT NULL DEFAULT 'uploaded', -- uploaded | processing | ready | failed
    text_content TEXT,          -- 提取的文本内容（用于 RAG 和 Vision 场景）
    page_count  INT,

    -- 关联信息
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    knowledge_base_id UUID,     -- 归属知识库（Phase 2）

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_files_user ON files(user_id, created_at DESC);
CREATE INDEX idx_files_org  ON files(organization_id);
```

### 3.8 计费表

```sql
CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id),
    organization_id UUID REFERENCES organizations(id),

    type         VARCHAR(30) NOT NULL, -- purchase | usage | refund | gift | admin_adjust
    amount       BIGINT NOT NULL,      -- 正数=增加，负数=扣减
    balance_after BIGINT NOT NULL,

    description              VARCHAR(500),
    stripe_payment_intent_id VARCHAR(255),
    message_id               UUID REFERENCES messages(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_tx_user ON credit_transactions(user_id, created_at DESC);
CREATE INDEX idx_credit_tx_org  ON credit_transactions(organization_id, created_at DESC);

CREATE TABLE credit_packages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    credits         BIGINT NOT NULL,
    price_cny       INT NOT NULL,
    price_usd       INT NOT NULL,
    stripe_price_id VARCHAR(255),
    is_popular      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3.9 Prompt 模板表 `prompt_templates`

```sql
CREATE TABLE prompt_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 归属：
    -- organization_id=NULL, created_by=NULL → 系统内置（对所有用户可见）
    -- organization_id=NULL, created_by=uid  → 个人收藏
    -- organization_id=org_id               → 团队模板
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    created_by      UUID REFERENCES users(id),

    scene       VARCHAR(50) NOT NULL,   -- write | read | translate | calculate | custom
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

CREATE INDEX idx_templates_scene ON prompt_templates(scene, is_public);
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

    UNIQUE(date, user_id, model)
);

CREATE INDEX idx_usage_daily_org  ON usage_daily(organization_id, date DESC);
CREATE INDEX idx_usage_daily_user ON usage_daily(user_id, date DESC);
```

### 3.11 RAG 知识库表（Phase 2）

```sql
-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 知识库（一个团队可以有多个知识库，例如"产品手册"、"销售话术"）
CREATE TABLE knowledge_bases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES users(id),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_shared       BOOLEAN NOT NULL DEFAULT TRUE,  -- 是否对团队所有成员可见
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
    embedding    vector(1536),       -- 向量（OpenAI ada-002 或 BGE-large-zh）
    metadata     JSONB NOT NULL DEFAULT '{}',  -- 页码、来源文件名等

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- IVFFlat 近似最近邻索引（100 个聚类中心，适合 10 万级数据）
CREATE INDEX idx_chunks_embedding ON knowledge_chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX idx_chunks_kb ON knowledge_chunks(knowledge_base_id);
```

### 3.12 Webhook 配置表（Phase 2）

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
GET    /api/v1/user/byok
PUT    /api/v1/user/byok
DELETE /api/v1/user/byok

-- 用户 API Key 管理（供程序调用平台接口）
GET    /api/v1/user/api-keys           获取 API Key 列表
POST   /api/v1/user/api-keys           创建新 API Key（返回完整 key，仅此一次）
DELETE /api/v1/user/api-keys/:id       删除 API Key
```

### 4.5 对话接口（核心）

```
-- 发起对话
POST   /api/v1/chat/completions        OpenAI 兼容格式，支持 stream=true

-- 对话管理
GET    /api/v1/conversations           列表（分页 + 筛选）
GET    /api/v1/conversations/search    全文搜索（?q=关键词）
GET    /api/v1/conversations/:id       详情 + 消息列表
PATCH  /api/v1/conversations/:id       更新（标题/置顶/归档）
DELETE /api/v1/conversations/:id       删除

-- 断线续传
GET    /api/v1/conversations/:id/messages/:mid/stream  恢复中断的流

-- 分享与导出
POST   /api/v1/conversations/:id/share  创建分享链接
DELETE /api/v1/conversations/:id/share  撤销分享
GET    /api/v1/conversations/:id/export 导出（?format=markdown|json|pdf）

-- 公开访问（不需要登录）
GET    /s/:token                        查看分享的对话
```

**对话请求体（兼容 OpenAI，扩展场景字段）：**

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
    "conversation_id": "uuid",
    "resume_message_id": "uuid",  // 断线续传：从此消息继续
    "scene": "read",
    "template_id": "uuid",
    "knowledge_base_ids": ["uuid1", "uuid2"]  // RAG：指定检索的知识库
}
```

### 4.6 计费接口

```
GET    /api/v1/billing/balance
GET    /api/v1/billing/transactions
GET    /api/v1/billing/packages
POST   /api/v1/billing/checkout
GET    /api/v1/billing/usage
```

### 4.7 团队接口

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

### 4.8 模板接口

```
GET    /api/v1/templates               列表（系统 + 团队 + 个人，按 scope 筛选）
GET    /api/v1/templates/:id
POST   /api/v1/templates               创建（个人收藏 or 团队模板）
PATCH  /api/v1/templates/:id
DELETE /api/v1/templates/:id
POST   /api/v1/templates/:id/duplicate 复制一份到个人收藏
```

### 4.9 文件接口

```
POST   /api/v1/files/upload-url        获取 S3 预签名上传 URL
POST   /api/v1/files/confirm           确认上传完成
GET    /api/v1/files/:id
DELETE /api/v1/files/:id
```

### 4.10 知识库接口（Phase 2）

```
GET    /api/v1/knowledge               获取团队知识库列表
POST   /api/v1/knowledge               创建知识库
GET    /api/v1/knowledge/:id
PATCH  /api/v1/knowledge/:id
DELETE /api/v1/knowledge/:id
POST   /api/v1/knowledge/:id/files     向知识库添加文件（触发向量化）
DELETE /api/v1/knowledge/:id/files/:fid 从知识库移除文件
GET    /api/v1/knowledge/:id/search    语义搜索测试（管理员用）
```

### 4.11 Webhook 接口（Phase 2）

```
GET    /api/v1/webhooks
POST   /api/v1/webhooks
PATCH  /api/v1/webhooks/:id
DELETE /api/v1/webhooks/:id
POST   /api/v1/webhooks/:id/test       发送测试事件
```

### 4.12 支付回调

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
| 用户 API Key | 永久 / 自定义 | 仅哈希值存 DB |

```go
type Claims struct {
    UserID         string `json:"uid"`
    Email          string `json:"email"`
    Role           string `json:"role"`
    OrganizationID string `json:"org_id,omitempty"`
    jwt.RegisteredClaims
}
```

**鉴权中间件支持双模式：**

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
        // 其次检查 X-API-Key 头（用户程序调用）
        if apiKey := r.Header.Get("X-API-Key"); apiKey != "" {
            userID, err := validateAPIKey(apiKey)
            if err == nil {
                ctx := context.WithValue(r.Context(), ctxUserID, userID)
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
- Refresh Token 存 Redis 黑名单（退出登录后立即失效）

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
① 鉴权 + 余额预检（Redis，< 1ms）
        │
② 检测是否含图片 → 选择模型（Router.Select）
        │
③ 注入 system prompt（场景 / 模板 / RAG 上下文）
        │
④ 创建 message 记录（status=streaming），写 Redis 空缓存
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
        ├── 追加到 Redis（断线续传）
        └── 累计 token 计数
        │
⑧ 流结束后（异步）：
        → 更新 message status=done
        → 扣费 + 写 usage_daily
        → Redis 缓存 5 分钟后过期
        → 触发 Webhook（chat.completed）
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

#### 5.3.1 积分设计

```
积分单位：1 积分 = ¥0.01
快速模式：1-5 积分/次（约 ¥0.01–0.05）
深度模式：10-50 积分/次（约 ¥0.10–0.50）
Vision 请求：额外加收图片处理积分

充值套餐：
¥9.9  → 1,100 积分（含 10% 赠送）
¥29   → 3,500 积分（含 20% 赠送）
¥99   → 13,000 积分（含 30% 赠送）
```

#### 5.3.2 余额检查与扣费

```go
// 请求前：Redis 快速预检
func (s *BillingService) PreCheck(ctx context.Context, userID string, mode string) error {
    balance := s.redis.Get(ctx, "balance:"+userID)
    if balance < s.minCreditsForMode(mode) {
        return ErrInsufficientCredits
    }
    return nil
}

// 响应完成后：异步精确扣费
func (s *BillingService) DeductAsync(ctx context.Context, req DeductRequest) {
    go func() {
        credits := s.calculateCredits(req.InputTokens, req.OutputTokens, req.ImageCount, req.Model)
        _ = s.db.WithTx(ctx, func(tx *sql.Tx) error {
            balance, err := s.repo.LockBalance(tx, req.UserID)
            if err != nil { return err }
            newBalance := max(0, balance-credits)
            s.repo.UpdateBalance(tx, req.UserID, newBalance)
            s.repo.InsertTransaction(tx, req.UserID, -credits, newBalance, req.MessageID)
            return nil
        })
        s.redis.Set(ctx, "balance:"+req.UserID, newBalance, 5*time.Minute)
        s.repo.UpsertUsageDaily(ctx, req)

        // 余额低于阈值时触发 Webhook
        if newBalance < s.alertThreshold(req.UserID) {
            s.webhookSvc.Emit(ctx, "credits.low", req.UserID)
        }
    }()
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

### 5.4 团队管理层

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
| 创建/修改团队模板 | ✅ | ✅ | ❌ |
| 管理知识库 | ✅ | ✅ | ❌ |
| 管理 Webhook | ✅ | ✅ | ❌ |
| 修改组织信息 | ✅ | ❌ | ❌ |
| 解散组织 | ✅ | ❌ | ❌ |

**成员计费路由（个人 vs 组织）：**

```go
func (s *BillingService) ResolveWallet(ctx context.Context, userID string) (walletOwner, walletType string) {
    member, _ := s.teamRepo.GetActiveMembership(ctx, userID)
    if member != nil {
        if member.MonthlyLimit > 0 && member.MonthlyUsed >= member.MonthlyLimit {
            panic(ErrMemberQuotaExceeded)
        }
        return member.OrganizationID, "organization"
    }
    return userID, "user"
}
```

### 5.5 Prompt 模板层

**三级模板体系：**

```
系统内置模板（organization_id=NULL, created_by=NULL, is_public=TRUE）
    ↓ 团队管理员可以基于系统模板创建团队版本
团队模板（organization_id=org_id, is_public=FALSE）
    ↓ 任何用户可以复制到个人收藏
个人收藏（organization_id=NULL, created_by=uid, is_public=FALSE）
```

```go
func (s *TemplateService) Render(tmpl Template, vars map[string]string) string {
    result := tmpl.SystemPrompt
    for key, value := range vars {
        result = strings.ReplaceAll(result, "{{"+key+"}}", value)
    }
    return result
}
```

### 5.6 断线续传（Resumable Stream）

```go
// 消息创建时在 Redis 写入空缓存
func (s *LLMProxyService) initStream(ctx context.Context, msgID string) {
    s.redis.Set(ctx, "stream:"+msgID, "", 5*time.Minute)
}

// 每收到一个 chunk 追加到 Redis
func (s *LLMProxyService) appendChunk(ctx context.Context, msgID, chunk string) {
    s.redis.Append(ctx, "stream:"+msgID, chunk)
    s.redis.Expire(ctx, "stream:"+msgID, 5*time.Minute)
}

// 客户端断线重连后调用此接口
// GET /api/v1/conversations/:id/messages/:mid/stream
func (h *ChatHandler) ResumeStream(w http.ResponseWriter, r *http.Request) {
    msgID := chi.URLParam(r, "mid")
    cached := h.redis.Get(r.Context(), "stream:"+msgID)

    msg, _ := h.repo.GetMessage(r.Context(), msgID)
    if msg.StreamStatus == "done" {
        // 已完成，直接返回完整内容
        response.JSON(w, msg)
        return
    }
    // 仍在流式中，先返回已缓存部分，再接着转发剩余流
    w.Header().Set("Content-Type", "text/event-stream")
    fmt.Fprintf(w, "data: %s\n\n", cached)  // 先发已有内容
    h.proxyRemainingStream(w, r, msgID)       // 再续传剩余
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
// 存储时统一序列化为 JSONB

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

### 5.8 RAG 知识库（Phase 2）

```
文件上传 → 文本提取（PDF/Word/TXT）→ 分片（每片 500 token，50 token 重叠）
     → 向量化（BGE-large-zh 或 OpenAI ada-002）→ 写入 knowledge_chunks

对话时（指定 knowledge_base_ids）：
     → 用户问题向量化 → pgvector 余弦相似度检索 Top-K 分片
     → 拼入 system prompt："以下是相关参考资料：\n{chunks}"
     → 正常走 LLM 代理流程
```

```go
func (s *RAGService) Retrieve(ctx context.Context, kbIDs []string, query string, topK int) ([]Chunk, error) {
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
Auth（JWT 或 API Key 鉴权）
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
| API Key 调用 | 令牌桶 | 60 req/min（可配置）|
| Stripe Webhook | 不限流，验签代替 |

---

## 七、错误处理规范

```go
var (
    ErrInsufficientCredits  = NewAppError(50201, "积分余额不足，请充值后继续使用")
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
    command: redis-server --requirepass ${REDIS_PASSWORD} --maxmemory 512mb --maxmemory-policy allkeys-lru
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

> **注意：** PostgreSQL 镜像改为 `pgvector/pgvector:pg16`，内置 pgvector，Phase 2 直接用，无需重建数据库。Redis maxmemory 从 256mb 提升到 512mb（断线续传缓存需要更多空间）。

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

### 8.3 Dockerfile

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

### 8.4 环境变量（.env.example）

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

# AES（BYOK API Key 加密）
AES_KEY=your_32_byte_aes_key_here

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

# 向量化（Phase 2，RAG 用）
# 选项 A：OpenAI ada-002（精度高，有成本）
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
# 选项 B：本地 BGE-large-zh（开源，零成本，需额外部署）
# EMBEDDING_PROVIDER=local
# EMBEDDING_API_URL=http://localhost:8001/embed

# 前端 URL（CORS）
FRONTEND_URL=https://jiandanly.com

# 邮件
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASSWORD=re_...
EMAIL_FROM=noreply@jiandanly.com
```

### 8.5 数据库迁移

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
| 文档解析（Phase 2） | `ledongthuc/pdfcpu` / `unidoc/unioffice` |

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

### Phase 1（MVP）

- [ ] 项目脚手架（目录结构、依赖、配置加载）
- [ ] 数据库 Schema 及 Migration（001-008）
- [ ] 认证模块（注册 / 登录 / JWT / Refresh Token 轮换）
- [ ] **双模式鉴权中间件**（JWT + X-API-Key）
- [ ] LLM 代理核心（SSE 流式转发、DeepSeek + Claude）
- [ ] 模型路由（快速 / 深度 / Vision 自动升级）
- [ ] 场景 System Prompt 注入
- [ ] **多模态支持**（messages.content 为 JSONB，图片透传）
- [ ] **断线续传**（Redis 缓存 + /stream 恢复接口）
- [ ] 积分余额系统（Redis 预检 + 异步扣费）
- [ ] 基础对话接口（`POST /api/v1/chat/completions`）
- [ ] **对话搜索**（`GET /api/v1/conversations/search`）
- [ ] **对话分享链接**（创建 / 撤销 / 公开访问）
- [ ] **对话导出**（Markdown / JSON）
- [ ] **用户 API Key 管理**（创建 / 列表 / 删除）
- [ ] Stripe 支付（创建会话 + Webhook 回调）
- [ ] 用户信息接口
- [ ] BYOK 配置接口
- [ ] 限流中间件
- [ ] 结构化日志 + 请求 ID
- [ ] Docker Compose 一键部署
- [ ] AWS 香港服务器部署验证

### Phase 2

- [ ] 团队管理（组织 / 成员 / 权限 / 用量上限）
- [ ] 文件上传（S3 预签名 + 元数据记录 + 文本提取）
- [ ] **RAG 知识库**（pgvector + 文档分片 + 语义检索）
- [ ] Prompt 模板 CRUD（系统 / 团队 / 个人三级体系）
- [ ] 用量报表（管理员后台，按人 / 按日）
- [ ] **Webhook 管理**（配置 + 事件推送 + HMAC 签名）
- [ ] 邮件服务（邀请 / 重置密码）
- [ ] OAuth 登录（Google / GitHub）
- [ ] 熔断器（供应商故障自动降级）
- [ ] 低余额告警（Webhook + 邮件通知）

### Phase 3（持续迭代）

- [ ] 共享知识库跨团队权限
- [ ] 定时任务 / 工作流模板
- [ ] 飞书 / 钉钉 / 企业微信集成
- [ ] MCP 协议支持
- [ ] 移动端 API 优化（PWA / Capacitor）

---

*文档版本: v1.1*  
*最后更新: 2026-05-10*

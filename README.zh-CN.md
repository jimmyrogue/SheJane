<div align="center">

# 石间 · SheJane

**一个带「本地 agent harness」的 Agentic Chat 产品。**

一个输入框 —— 提问、丢文件、贴 URL,或描述一个任务。
石间会自动决定:解析文档、调用工具、加载 skill、请求权限、验证结果,
还是进入多步 agent loop。

[English](./README.md) · 简体中文

</div>

---

> **状态:** 1.0 之前,持续开发中。API 和数据结构可能变动。
>
> **命名:** 产品名是 **石间(SheJane)**。`shejane` 是遗留代号,仍用于
> 包名、`SHEJANE_*` 环境变量前缀和本地路径,出于向后兼容保留。

## 这是什么

石间把 agent loop 跑在**用户本机**(一个本地 LangGraph daemon),同时把
鉴权、计费、以及所有平台付费的 provider key 留在**云端控制面**。桌面 App
通过 loopback 与本地 daemon 通信处理 agent 流程,直接走 HTTPS 与云端 API
通信处理鉴权/计费/文档。

```
┌──────────────────────────────────────────────────────────────┐
│  Electron + React 客户端  (本地优先的聊天历史)                  │
└───────┬───────────────────────────────────────────┬──────────┘
        │ /local/v1/* (loopback, bearer)            │ HTTPS
        ▼                                            ▼
┌─────────────────────────────┐        ┌─────────────────────────┐
│  本地 agent harness         │ ─────▶ │  Go API(云端)          │
│  Python · FastAPI · uvicorn │        │  Postgres · S3          │
│  LangGraph 1.2 + deepagents │        │  Stripe 计费            │
│  AsyncSqlite checkpoints    │        │                         │
│  工具本地执行,或把计费类     │        │  持有所有平台付费       │
│  工具通过云端 Tool Gateway   │        │  provider key —         │
│  代理                       │        │  daemon 永不持有。      │
└─────────────────────────────┘        └─────────────────────────┘
```

独立的**管理后台**(`admin/`)负责模型注册表、积分费率、用户、订单和审计日志。

## 当前实现与方案

| 领域 | 当前实现 |
|---|---|
| 产品形态 | 本地优先桌面聊天 + 云端账号、计费、模型控制面。 |
| 模型 | `Auto`、`auto.fast`、`auto.smart` 由 Go API 基于后台启用的 chat 模型解析；daemon 不再做 fast/deep 分层判断。 |
| 计费 | LLM 与云端工具统一 credits,走 reserve -> settle -> release；Stripe Checkout 是一次性充值。 |
| 文档 | Composer 支持多文件 PDF/DOCX/XLSX/图片附件；文档问答使用短期 S3 对象,不是团队向量库。 |
| 本地 agent | LangGraph/deepagents run loop,含 HITL 审批、checkpoint、subagent、skills、MCP、本机定时 run、verification loop 和 progress ledger。 |
| 业务平台集成 | 不再内置飞书连接器。未来统一通过标准工具或 MCP 接入，不增加平台专用运行链路。 |
| 安全开源状态 | `main` 已合入开源硬化：`.env*` 忽略并被 hook 拦截,生产 Postgres 缺 `POSTGRES_PASSWORD` 会 fail closed,本地工具受工作区/审批约束,provider key 只在 Go API。 |

刻意暂缓：embedding 语义记忆/摘要、跨失败类型的一键恢复 orchestrator、
跨设备聊天同步、admin 退款/手工改订单、应用签名与公证。

## 功能

- **统一 composer** —— 问题、文件附件(PDF / DOCX / XLSX / 图片)、URL、
  复杂任务,全走一个输入入口。
- **本地 agent harness** —— LangGraph + deepagents 中间件栈:规划、工具
  调用、记忆、上下文压缩、验证、以及 human-in-the-loop 权限确认。
- **Auto 模型目录** —— 管理员配置模型 ID、provider、厂商信息、能力档位、
  token 成本价和生图价格；用户端看到 Auto 与已启用 chat 模型。
- **工具**
  - 授权工作区内的文件系统读写
  - Office 读**写** —— `.docx` / `.xlsx` / `.pptx`(copy-on-write,原文件不动)
  - PDF:服务端文本 + 元数据抽取(Poppler),外加按需 `pdf.inspect` 工具
  - 代码执行跑在隔离的 **E2B microVM** 沙箱(matplotlib 图表内联渲染)
  - 网页抓取 + 云端计费的网页搜索(Tavily)
  - 图片生成 / 编辑(云端计费)
  - Playwright 托管浏览器(搜索 / 阅读 / 截图 / 点击 / 输入)
  - 记忆、skills、MCP server(stdio / HTTP / SSE)
- **应用内文档预览** —— 右侧面板渲染 `.docx` / `.xlsx` / `.pptx` 大纲和
  PDF(Chromium 阅读器),支持下载。
- **云端控制面** —— JWT 鉴权、积分账本(预留 → 结算 → 释放)、模型路由
  (DeepSeek / OpenAI 兼容 / Anthropic)、Stripe 一次性充值、S3 文档存储。
- **本地优先历史** —— 聊天存在浏览器(IndexedDB);后端只存用量元数据 +
  计费,不存完整聊天正文。
- **天然的密钥边界** —— 平台付费 provider key 只在 Go API;daemon 把计费类
  工具通过云端 Tool Gateway 代理。hook、CI 和运行时配置检查共同强制校验。

## 快速开始

前置:**Go 1.25+**、**Node 22+**、**Python 3.12+ 带 [uv](https://docs.astral.sh/uv/)**、**Docker**。

```bash
make setup-hooks            # 安装 lefthook git hooks(一次性)
cp .env.example .env        # 默认 MOCK_LLM=true —— 不需要任何 provider key
make dev-electron           # Docker(Postgres/API)+ daemon + Vite + Electron
```

`MOCK_LLM=true` 返回预设的 LLM 响应,整套栈零外部凭证即可跑通。要接真实
模型,在 `.env` 里设 `MOCK_LLM=false` 和一个 provider key(一个 DeepSeek
key 基本够用)。完整带注释的配置项见 [`.env.example`](./.env.example)。

出问题?`make doctor` 会诊断常见的「为什么 dev 跑不起来」。
不要提交 `.env`;仓库只跟踪 `.env.example`。

## 技术栈

| 层 | 技术 |
|---|---|
| 客户端 | Electron · React 18 · Vite · TypeScript · Tailwind 4 · shadcn/ui |
| Daemon | Python 3.12 · FastAPI · uvicorn · LangGraph 1.2 · deepagents |
| API | Go 1.25 · Postgres · S3 · Stripe |
| 后台 | React · Vite · shadcn/ui |

## 目录结构

```
api/             Go API:鉴权、积分账本、模型路由、Tool Gateway、Stripe、文档、后台
local-host/      Python LangGraph daemon(本地 agent harness)+ 工具 + 中间件
client/          Electron + React 用户端
admin/           独立管理后台
docs/            架构、run-loop、SSE 协议、运维
e2e/             Playwright 端到端测试
```

## 文档

- **[CLAUDE.md](./CLAUDE.md)** —— 架构、关键不变量、代码位置、常用命令。
- **[docs/harness-runtime-stages.md](./docs/harness-runtime-stages.md)** —— 目标运行时唯一的 P1-P12 阶段编号和修改前检查顺序。
- **[docs/harness-stage-improvement-notes.md](./docs/harness-stage-improvement-notes.md)** —— P1-P12 的保留、替换、删除、迁移和验收决定。
- **[docs/run-loop.md](./docs/run-loop.md)** —— 当前实现中一次任务从提交到结束的真实流程。
- **[docs/client-sse-protocol.md](./docs/client-sse-protocol.md)** —— 客户端与本地运行时之间的 SSE 接口。
- **[docs/document-tool-policy.md](./docs/document-tool-policy.md)** —— 附件与工具组合规则。
- **[docs/operations.md](./docs/operations.md)** —— 部署 + 运维手册。
- **[docs/roadmap.md](./docs/roadmap.md)** —— 当前优先级和暂缓事项。
- **[spec.md](./spec.md)** —— 本地 agent harness 规格。

## 测试

```bash
make lint        # ruff + gofmt + go vet + 密钥边界校验
make test        # 四个栈(Go + Python + client + admin)
make build       # API + client + admin + daemon 依赖的生产构建
make test-e2e    # Playwright 模拟端到端
```

默认测试是确定性的 —— 不依赖真实 LLM、Stripe、S3、Tavily 或公网。真实服务
的 smoke 测试需显式触发(`make smoke-*`)。

## 贡献

欢迎 PR —— 设置和流程见 **[CONTRIBUTING.md](./CONTRIBUTING.md)**,后端/前端/
测试规则见 **[AGENTS.md](./AGENTS.md)**。请友善:**[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)**。

安全问题:请走 **[SECURITY.md](./SECURITY.md)**(私密上报),不要开公开 issue。

## 许可证

[Apache License 2.0](./LICENSE) · Copyright 2026 ColdFlameUs LLC。

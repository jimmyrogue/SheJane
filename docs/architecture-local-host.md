# Local Agent Harness 详细架构

> ⚠️ **历史文档（Node 版本）**
>
> 本文档描述的是 **Node.js + TypeScript** 实现的 local-host —— `refactor/infrastructure`
> 分支起点（commit `28e0b8a`）的状态。Phase 5'+ 完成后，local-host **已经全部
> 重写为 Python + LangGraph**：
>
> - 技术栈：`Python 3.12 + LangGraph 1.2 + langchain.agents.create_agent` /
>   `deepagents.create_deep_agent`
> - 入口：`local-host/python/local_host/server.py`（FastAPI + uvicorn）
> - 当前架构 & run lifecycle：见 **[run-loop.md](run-loop.md)** —— 那份文档跟代码同步
> - SSE 协议：**[client-sse-protocol.md](client-sse-protocol.md)** —— `data:` 体改为
>   AgentRunEvent envelope，事件名 `llm.delta` / `tool.completed`（不再是 `llm.token` / `tool.end`）
> - 迁移进度：**[migration-langgraph.md](migration-langgraph.md)**
>
> 保留这份文档是为了：(a) 给翻 git history 看老 commit 的人提供上下文；
> (b) 记录 Node→Python 迁移前的对照基线。除此之外的所有目的——**请看 run-loop.md**。

> 范围：`local-host/` 目录
> 技术栈：Node.js + TypeScript
> 入口：HTTP 服务 `127.0.0.1:17371`（默认）
> 生成时间：2026-05-21（基于 `refactor/infrastructure` 分支起点 commit `28e0b8a`）

本文档作为基础架构改造的起点参考，描述当前 local-host 的入口、Run 生命周期、Harness 12 阶段、工具层、LLM 网关、存储与回推流。

---

## 一、整体分层（先看大图）

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                          🖥️  前端 (Frontend)                                         ║
╠══════════════════════════════════════════════════════════════════════════════════════╣
║   ┌─────────────────────────────────┐   ┌────────────────────────────────┐          ║
║   │  client/                        │   │  admin/                        │          ║
║   │  React 18 + Vite + Electron 壳  │   │  React 18 + Vite               │          ║
║   │  Tailwind · shadcn/ui · Lexical │   │  shadcn/ui  ·  管理后台        │          ║
║   │  ┌───────────────────────────┐  │   │                                │          ║
║   │  │ IndexedDB                 │  │   │                                │          ║
║   │  │ 聊天历史 / Artifact       │  │   │                                │          ║
║   │  └───────────────────────────┘  │   │                                │          ║
║   └──────┬────────────────────┬─────┘   └──────────────┬─────────────────┘          ║
╚══════════│════════════════════│════════════════════════│═════════════════════════════╝
           │                    │                        │
           │ 配对 + run 流      │ HTTPS / SSE            │ HTTPS
           │ (HTTP, 本机)       │ /api/v1/chat           │ /api/v1/admin
           │                    │ auth · billing         │
           ▼                    │                        │
╔══════════════════════════════════════════╗             │
║      💻  本地 (Local Agent Harness)      ║             │
╠══════════════════════════════════════════╣             │
║  ┌────────────────────────────────────┐  ║             │
║  │  local-host/                       │  ║             │
║  │  Node.js + TS  ·  HTTP :17371      │  ║             │
║  │  12 组件 Agent 循环                │  ║             │
║  └─┬────────┬─────────┬─────────┬─────┘  ║             │
║    │        │         │         │        ║             │
║  ┌─▼────┐ ┌─▼──────┐ ┌▼─────┐ ┌─▼─────┐  ║             │
║  │ 工具 │ │Playwrt │ │ MCP  │ │ 本地  │  ║             │
║  │执行器│ │Chromium│ │stdio │ │文件系 │  ║             │
║  │file/ │ │ 浏览器 │ │运行时│ │workspc│  ║             │
║  │shell │ └────────┘ └──────┘ └───────┘  ║             │
║  │web/  │                                ║             │
║  │brows │  ┌──────────────────────────┐  ║             │
║  └──────┘  │ SQLite                   │  ║             │
║            │ runs/events/checkpoints  │  ║             │
║            │ artifacts/memory         │  ║             │
║            └──────────────────────────┘  ║             │
╚══════════════════╤═══════════════════════╝             │
                   │                                     │
                   │ HTTPS  /api/v1/agent/llm            │
                   │ (LLM 推理 → 云端计费)               │
                   │                                     │
                   ▼                                     ▼
╔══════════════════════════════════════════════════════════════════════════════╗
║                   ☁️  后端 (Cloud Control Plane)                             ║
╠══════════════════════════════════════════════════════════════════════════════╣
║   ┌─────────────────────────────────────────────────────────────────────┐   ║
║   │  api/   Go 1.25 + chi  ·  :8080  ·  JWT / SSE                       │   ║
║   │ ┌────────┬─────────┬─────────┬──────────┬─────────┬───────────────┐ │   ║
║   │ │  Auth  │LLMProxy │ Billing │ AgentSvc │ Payment │  FileSvc      │ │   ║
║   │ │JWT/刷新│SSE路由  │钱包/订阅│run/event │ Stripe  │  S3 凭证      │ │   ║
║   │ └────────┴─────────┴─────────┴──────────┴─────────┴───────────────┘ │   ║
║   └───────┬──────────────┬──────────────────────────┬──────────────────┘   ║
║           │              │                          │                      ║
║   ┌───────▼───────┐  ┌───▼─────────┐    ┌───────────▼────────────┐         ║
║   │ PostgreSQL 16 │  │  Redis 7    │    │  Caddy 反向代理        │         ║
║   │ + pgvector    │  │ 限流/缓存/  │    │  jiandanly.com         │         ║
║   │   :15432      │  │   队列      │    │  admin.jiandanly.com   │         ║
║   └───────────────┘  └─────────────┘    └────────────────────────┘         ║
╚═══════╤══════════════╤══════════════════╤═════════════════╤═════════════════╝
        │              │                  │                 │
        ▼              ▼                  ▼                 ▼
   ┌─────────┐   ┌───────────┐      ┌──────────┐      ┌──────────┐
   │   LLM   │   │  Stripe   │      │  AWS S3  │      │  Tavily  │
   │DeepSeek │   │  订阅     │      │  文档    │      │ Web搜索  │
   │ Claude  │   │ Webhook   │      │  存储    │      │   API    │
   │ OpenAI  │   │           │      │          │      │          │
   └─────────┘   └───────────┘      └──────────┘      └──────────┘
                          🌐  外部服务 (External)
```

---

## 二、Local Agent Harness 详细分解

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                💻  LOCAL AGENT HARNESS  —  详细架构                                  ║
║                local-host/  ·  Node.js + TypeScript  ·  HTTP :17371                  ║
╚══════════════════════════════════════════════════════════════════════════════════════╝

  Electron Client (前端)                                              Cloud API (后端)
       │  Bearer  JIANDANLY_LOCAL_HOST_TOKEN                                  ▲
       │  (或 X-Jiandanly-Local-Token)                                        │
       ▼                                                                      │
┌──────────────────────────────────────────────────────────────────────┐      │
│ ①  HTTP 入口     index.ts → server.ts                                │      │
│                                                                      │      │
│  ┌─ 健康/能力 ────────┐  ┌─ 会话 / 工作区 ───────────────────────┐   │      │
│  │ GET  /v1/health    │  │ GET|POST|DEL  /v1/session            │   │      │
│  │ GET  /v1/tools     │  │ GET|POST|DEL  /v1/workspaces         │   │      │
│  └────────────────────┘  └──────────────────────────────────────┘   │      │
│  ┌─ Run 管理 ────────────────────┐  ┌─ 人在回路 ──────────────────┐  │      │
│  │ GET  /v1/runs                 │  │ POST /v1/permissions/:id    │  │      │
│  │ POST /v1/runs                 │  │ POST /v1/questions/:id      │  │      │
│  │ GET  /v1/runs/:id             │  │ GET  /v1/artifacts/:id      │  │      │
│  │ GET  /v1/runs/:id/stream  SSE │  └─────────────────────────────┘  │      │
│  │ POST /v1/runs/:id/cancel      │  ┌─ 技能 ──────────────────────┐  │      │
│  └───────────────────────────────┘  │ GET|POST /v1/skills*        │  │      │
│   CORS: *   ·   认证: 共享 pairing token (无多客户端身份)            │      │
└────────────────────────────────┬─────────────────────────────────────┘      │
                                 │ startManagedRun()                          │
                                 ▼                                            │
┌──────────────────────────────────────────────────────────────────────┐      │
│ ②  Run 生命周期 状态机       types.ts:3-10  ·  server.ts:455         │      │
│                                                                      │      │
│   queued ──▶ running ──┬──▶ waiting_permission ─┐                    │      │
│                        │                         │  POST 决议 → 恢复 │      │
│                        ├──▶ waiting_input ───────┤                    │      │
│                        │                         ▼                    │      │
│                        ├──▶ canceled        ┌─────────────────────┐  │      │
│                        ├──▶ failed          │ 进入等待前会落盘     │  │      │
│                        └──▶ completed       │ createCheckpoint    │  │      │
│                                             └─────────────────────┘  │      │
└────────────────────────────────┬─────────────────────────────────────┘      │
                                 │ runHarness()                               │
                                 ▼                                            │
┌──────────────────────────────────────────────────────────────────────┐      │
│ ③  Harness 12 阶段           src/harness/runner.ts                   │      │
│                                                                      │      │
│  ┌─ 入循环之前 ───────────────────────────────────────────────────┐  │      │
│  │ P1  Input Guard      screenInput()     :802  注入/越狱拦截     │  │      │
│  │ P2  Routing          routeRun()        :269  简单/复杂分流     │  │      │
│  │ P3  Planning         planRun()         :108  多步分解          │  │      │
│  │ P11 Checkpoint Load  latestCheckpoint  :73   断点恢复          │  │      │
│  └─────────────────────────┬──────────────────────────────────────┘  │      │
│                            ▼                                         │      │
│  ┌─ P5  主循环  runLoop()  :943 ──────────────────────────────────┐  │      │
│  │                                                                │  │      │
│  │   ┌──────────┐   ┌────────────┐   ┌──────────┐                 │  │      │
│  │   │ compact  │──▶│  call LLM  │──▶│  parse   │                 │  │      │
│  │   │ messages │   │  (④ 网关)  │   │ toolCalls│                 │  │      │
│  │   └──────────┘   └────────────┘   └────┬─────┘                 │  │      │
│  │        ▲                                │                      │  │      │
│  │        │                                ▼                      │  │      │
│  │        │                          ┌──────────┐                 │  │      │
│  │        │                          │ execute  │── ⑤ 工具层       │  │      │
│  │        │                          │  tools   │                 │  │      │
│  │        │                          └────┬─────┘                 │  │      │
│  │        │                                │                      │  │      │
│  │        │                                ▼                      │  │      │
│  │        │                          ┌──────────┐                 │  │      │
│  │        └──────────────────────────│ append   │                 │  │      │
│  │                                   │  events  │                 │  │      │
│  │                                   └──────────┘                 │  │      │
│  │                                                                │  │      │
│  │   穿插在循环里的策略 / 守卫：                                  │  │      │
│  │   P8  Research Policy   :1032  限搜索次数 (默认 3)             │  │      │
│  │   P9  Output Guardrail  :988   最终答案/来源检查               │  │      │
│  │   P10 Permission Gate   :1065  破坏性工具 → 暂停 + 询问        │  │      │
│  │   P12 Error / Cancel    :943   max_steps · 失败上限 · 取消    │  │      │
│  └────────────────────────────────────────────────────────────────┘  │      │
│                            │                                         │      │
│                            ▼                                         │      │
│  ┌─ 出循环之后 ───────────────────────────────────────────────────┐  │      │
│  │ P4  Reflection       reflectOnFinal()  :609  critic-reviser    │  │      │
│  │ P6  Memory           memoryWriteBack() :361  长记忆回写        │  │      │
│  │ P7  Skills           ensureSkillAdapter:438  技能注入          │  │      │
│  └────────────────────────────────────────────────────────────────┘  │      │
└──────────┬─────────────────────────────────────┬─────────────────────┘      │
           │ ④ LLM 调用                           │ ⑤ 工具调用                 │
           ▼                                     ▼                            │
┌────────────────────────────┐   ┌─────────────────────────────────────────┐  │
│ ④ LLM Gateway              │   │ ⑤ Tool Layer  (src/tools/)              │  │
│   src/llm/                 │   │                                         │  │
│                            │   │ ┌─ registry.ts  · 48 个工具 ──────────┐ │  │
│ ┌─ 接口 ─────────────────┐ │   │ │ fs.read / write / search / list     │ │  │
│ │ LLMGateway.call({      │ │   │ │ shell.run                           │ │  │
│ │   runId, mode,         │ │   │ │ browser.open/search/snapshot/read   │ │  │
│ │   messages, tools })   │ │   │ │         /click/input/scroll/shot    │ │  │
│ └───────────┬────────────┘ │   │ │ time.now · environment.observe      │ │  │
│             │              │   │ │ clipboard.read/write · open.url/file│ │  │
│  ┌──────────▼──────────┐   │   │ │ user.ask · memory.search · skill.use│ │  │
│  │ CloudLLMGateway     │───┼─┐ │ │ task.verify · mcp.call              │ │  │
│  │ → /api/v1/agent/llm │   │ │ │ └────────────────┬────────────────────┘ │  │
│  │ + Bearer 用户 token │   │ │ │                  │                      │  │
│  │ (无 stream，整包返) │   │ │ │ ┌─ executor.ts ──▼──────────────────────┐│  │
│  └─────────────────────┘   │ │ │ │ 权限策略  allow / ask / deny         ││  │
│  ┌─────────────────────┐   │ │ │ │ 工作区路径校验 (workspace 白名单)    ││  │
│  │ StaticLLMGateway    │   │ │ │ │ 只读工具 → 并发批处理                ││  │
│  │  (离线 fallback)    │   │ │ │ │ 失败重试 / 失败上限                  ││  │
│  └─────────────────────┘   │ │ │ └─┬──────┬──────┬──────┬───────────────┘│  │
│                            │ │ │   │      │      │      │                │  │
│  cloudSession.ts           │ │ │   ▼      ▼      ▼      ▼                │  │
│  setSession / clear        │ │ │ ┌────┐ ┌────┐ ┌────┐ ┌──────────┐       │  │
│  Bearer + baseURL          │ │ │ │本地│ │MCP │ │浏览│ │CloudTool │       │  │
│                            │ │ │ │工具│ │ rt │ │器  │ │Gateway   │       │  │
└────────────────────────────┘ │ │ └─┬──┘ └─┬──┘ └─┬─┘ └────┬─────┘       │  │
                               │ │   │      │      │        │              │  │
                               │ │   ▼      ▼      ▼        ▼              │  │
                               │ │ ┌──────────────────────────────────────┐│  │
                               │ │ │ ⑥ 外部副作用                          ││  │
                               │ │ │  • Workspace FS (路径校验)            ││  │
                               │ │ │  • child_process / shell.run         ││  │
                               │ │ │  • Playwright Chromium (浏览器)      ││  │
                               │ │ │  • spawn MCP server (stdio JSON-RPC) ││  │
                               │ │ │  • → /api/v1/agent/tool (web.search) ││──┘
                               │ │ └──────────────────────────────────────┘│
                               │ └─────────────────────────────────────────┘
                               │
                               │   每步都 append events ↓
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ ⑦  Storage  —  SQLite  (state/sqliteStore.ts · PRAGMA WAL)           │
│                                                                      │
│  ┌────────────────────┬───────────────────┬───────────────────────┐  │
│  │ local_runs         │ local_events      │ local_checkpoints     │  │
│  │ goal, workspace,   │ run_id, seq,      │ run_id, step,         │  │
│  │ status, history,   │ event_type,       │ reason,               │  │
│  │ parent_run_id      │ payload_json      │ messages_json         │  │
│  ├────────────────────┼───────────────────┼───────────────────────┤  │
│  │ local_permissions  │ local_questions   │ local_artifacts       │  │
│  │ tool, args, scope, │ questions_json,   │ kind, title, content, │  │
│  │ status, resolved   │ answers_json      │ content_type, bytes   │  │
│  ├────────────────────┼───────────────────┼───────────────────────┤  │
│  │ local_memory       │ local_workspaces  │                       │  │
│  │ kind, title, TTL,  │ id, path, label,  │                       │  │
│  │ expires_at         │ last_used_at      │                       │  │
│  └────────────────────┴───────────────────┴───────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 同一份 events 同时被…
                                ▼
                  ┌─────────────────────────────────────┐
                  │ ⑧  SSE 实时回推  → 前端                │
                  │  GET /v1/runs/:id/stream            │
                  │  Content-Type: text/event-stream    │
                  │  100ms 轮询 events 表 + cursor      │
                  │  event: local.event                 │
                  │  data:  { SerializedEvent JSON }    │
                  │  [DONE] 收尾                          │
                  └─────────────────────────────────────┘
```

---

## 三、关键点速查（图里看不出来的）

### 子代理 / 父子 Run

`types.ts:52` 有 `parentRunId`，但**只用于多轮会话续接**（把父 run 的最终 transcript 当上下文回放），**没有原生的并发 subagent spawn**。

### 权限决策路径（与 P10 配套）

```
tool.requiresPermission?
   ├─ 已有"run 级"授权 → 直接执行
   └─ 无 → store.createPermission()
          → emit permission.required 事件
          → run.status = waiting_permission
          → createCheckpoint
          → 等前端 POST /v1/permissions/:id  { decision, scope: 'once'|'run' }
          → startManagedRun(resumePermissionID)
```

### 配对模型的两个缺口（改造时可一起想）

1. **token 是进程级共享**，没有 per-client 身份，所有连同一个 daemon 的客户端权限一样。
2. **工作区白名单是全局**的，没有「按客户端」或「按 run」再收紧的层。

### LLM gateway 当前是非流式

`cloudGateway.ts` 拿到整包再返回，循环内每步都是一次完整请求/响应。如果改造里要做「中间 token 流式回推前端」，这一层和 ⑧ 的 SSE 都要动。

---

## 四、关键文件索引

| 主题 | 路径 | 备注 |
|---|---|---|
| 入口 | `local-host/src/index.ts` | 读 env、起 server |
| HTTP 服务 | `local-host/src/server.ts` | 所有路由 + SSE 推流 |
| 类型 | `local-host/src/types.ts` | RunStatus / Event / Workspace 定义 |
| Harness 主循环 | `local-host/src/harness/runner.ts` | 12 阶段全部在这里 |
| LLM 接口 | `local-host/src/llm/gateway.ts` | `LLMGateway` 接口 |
| LLM 云实现 | `local-host/src/llm/cloudGateway.ts` | 调 `/api/v1/agent/llm` |
| 云会话 | `local-host/src/llm/cloudSession.ts` | Bearer + baseURL |
| 工具注册 | `local-host/src/tools/registry.ts` | 48 个工具定义 |
| 工具执行 | `local-host/src/tools/executor.ts` | 权限/路径/并发/重试 |
| MCP 运行时 | `local-host/src/tools/mcpRuntime.ts` | stdio JSON-RPC 2.0 |
| 云工具网关 | `local-host/src/tools/cloudToolGateway.ts` | web.search 等转发 |
| SQLite 存储 | `local-host/src/state/sqliteStore.ts` | 8 张表 + WAL |
| 内存存储 | `local-host/src/state/memoryStore.ts` | 测试用 |
| 技能加载 | `local-host/src/skills/skillLoader.ts` | 从文件系统发现 |

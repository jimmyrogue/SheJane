# Pure-Python LangGraph 迁移方案（最终版）

**分支**: `refactor/infrastructure`
**关联**: [架构起点](architecture-local-host.md) · [Phase 0 spike 报告](spike-phase0-langgraph.md) · [`~/.claude/plans/langgraph-local-memoized-abelson.md`](原方案，已被本文取代)
**日期**: 2026-05-21（在 commit `d944b25` Phase 1 完成后）

---

## Context — 为什么从"Node 主进程 + Python sidecar"改成"纯 Python"

原方案保留 Node 是为了**沉没成本**（~6,500 行 TS 代码 + ~6,200 行测试）。用户确认 dev 阶段数据可丢、可全栈重写后，沉没成本不再是约束。

进一步交叉验证 LangChain v1 / LangGraph v1.2 官方文档（2026 年），发现：

1. **`langgraph.prebuilt.create_react_agent` 已 deprecated**，[官方推荐](https://docs.langchain.com/oss/python/releases/langgraph-v1) 迁移到 `langchain.agents.create_agent`
2. **`create_agent` 自带 middleware 系统**，提供 6 个生命周期钩子（`before_agent`/`before_model`/`wrap_model_call`/`after_model`/`after_agent`/`wrap_tool_call`） + `@dynamic_prompt` 装饰器
3. **官方现成 16 个 built-in middleware**，其中 5 个直接覆盖我们 12 个 phase 中的 5 个（permission gate / step 上限 / 工具重试 / 上下文压缩 / 子 agent）
4. **官方还有 2 个 middleware 替代我们要自写的工具**：`ShellToolMiddleware`（带 execution_policy / redaction）、`FilesystemFileSearchMiddleware`（含 ripgrep）

这意味着：**runtime + tool 层加起来从 ~3,000 行 → ~1,260 行**，且大部分是配置而非逻辑。这是个比"Node 主 + Python sidecar"更干净的方案，且**完全不需要外层 StateGraph 嵌套**——middleware 组合就够了。

---

## TL;DR

1. **进程模型**：唯一进程是 Python，运行 FastAPI on `127.0.0.1:17371`，**没有 Node 本地进程**
2. **Agent 主循环**：`langchain.agents.create_agent` + middleware 列表，**零自写循环**
3. **12 阶段**：5 个用官方 built-in middleware，5 个自写 ~30 行 middleware，2 个是框架内置（checkpoint / 主循环）
4. **工具层**：14 个 trivial（每个 5–15 行）+ 6 个自写 + 10+ 通过 toolkit/middleware/MCP 间接得到
5. **后端 Phase 1 端点不变**（`POST /api/v1/agent/llm/stream`）：作为 Python agent 的 LLM 入口
6. **Electron**：唯一改动是 spawn 命令从 `node …` 改成 `python …`，HTTP 协议保持

---

## 目标架构

```
Electron client (React + Vite + electron-main)
        │ HTTP + SSE  (Bearer pairing token)
        ▼
local-host (Python, FastAPI :17371)
   ├── store/sqlite     ── runs / events / permissions / artifacts / memory / workspaces
   ├── llm/             ── ChatModel adapter → backend Phase 1 SSE
   ├── tools/           ── 6 自写 + 14 trivial + toolkit 接入 + MCP + browser-use
   ├── middleware/      ── 5 自写 + 11 built-in
   └── agent/           ── create_agent(...) 装配 + AsyncSqliteSaver
        │
        │ httpx → POST /api/v1/agent/llm/stream
        ▼
Cloud Go API（不变，credit reserve/settle 沿用 d944b25）
```

---

## Agent 装配核心代码（目标态）

```python
from langchain.agents import create_agent
from langchain.agents.middleware import (
    HumanInTheLoopMiddleware,
    ToolCallLimitMiddleware,
    ModelCallLimitMiddleware,
    ToolRetryMiddleware,
    SummarizationMiddleware,
    TodoListMiddleware,
    ShellToolMiddleware,
    FilesystemFileSearchMiddleware,
    ContextEditingMiddleware,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.store.sqlite import SqliteStore

from pyjiandanly.middleware.input_guard import InputGuardMiddleware       # P1
from pyjiandanly.middleware.router import FastDeepRouterMiddleware        # P2
from pyjiandanly.middleware.skills import SkillInjectionMiddleware        # P7
from pyjiandanly.middleware.output_guard import OutputGuardMiddleware     # P9
from pyjiandanly.middleware.reflect import ReflectMiddleware              # P4
from pyjiandanly.middleware.memory import MemoryWritebackMiddleware       # P6
from pyjiandanly.tools.registry import all_tools
from pyjiandanly.llm.backend import BackendChatModel

agent = create_agent(
    model=BackendChatModel(...),     # 直连 Phase 1 SSE 端点
    tools=all_tools(),
    middleware=[
        InputGuardMiddleware(),                                  # P1
        FastDeepRouterMiddleware(),                              # P2
        SkillInjectionMiddleware(),                              # P7
        TodoListMiddleware(),                                    # P3 ★官方
        ToolCallLimitMiddleware(                                 # P8 ★官方
            tool_name="web.search", run_limit=3
        ),
        HumanInTheLoopMiddleware(                                # P10 ★官方
            interrupt_on={
                "shell.run": True,
                "fs.write": True,
                "open.url": True,
            }
        ),
        OutputGuardMiddleware(),                                 # P9
        ToolRetryMiddleware(max_retries=2),                      # P12 ★官方
        ModelCallLimitMiddleware(run_limit=20),                  # P12 ★官方
        ShellToolMiddleware(                                     # 替代 shell.run ★官方
            workspace_root=workspace_path,
            execution_policy=...,
            redaction_rules=...,
        ),
        FilesystemFileSearchMiddleware(                          # 替代 fs.search ★官方
            root_path=workspace_path,
            use_ripgrep=True,
        ),
        SummarizationMiddleware(...),                            # ★官方
        ContextEditingMiddleware(...),                           # ★官方
        ReflectMiddleware(),                                     # P4
        MemoryWritebackMiddleware(),                             # P6
    ],
    checkpointer=AsyncSqliteSaver.from_conn_string("./data/agent.db"),
    store=SqliteStore.from_conn_string("./data/store.db"),
)
```

---

## 12 阶段映射表

| Phase | 实现 | 自写 LOC |
|---|---|---|
| P1 input_guard | `@before_agent` 自定义 middleware | ~30 |
| P2 routing | `@wrap_model_call` 自定义 middleware（切模型） | ~25 |
| P3 planning | `TodoListMiddleware`（官方） | 0 |
| P4 reflection | `@after_agent` 自定义 middleware | ~40 |
| P5 主循环 | `create_agent` 本身 | 0 |
| P6 memory_writeback | `@after_agent` 自定义 middleware | ~30 |
| P7 skills | `@dynamic_prompt` 装饰器 | ~25 |
| P8 research_policy | `ToolCallLimitMiddleware`（官方） | 0 |
| P9 output_guard | `@after_model` + `jump_to`（官方钩子） | ~35 |
| P10 permission | `HumanInTheLoopMiddleware`（官方） | 0 |
| P11 checkpoint | `checkpointer=AsyncSqliteSaver(...)` | 0 |
| P12 error/cancel | `ToolRetryMiddleware` + `ModelCallLimitMiddleware` + asyncio | 0 |
| **合计自写** | | **~185** |

---

## 工具层映射表（21 个工具概念）

| 工具 | 来源 | 类型 | 自写 LOC |
|---|---|---|---|
| `time.now` | stdlib datetime | trivial | ~10 |
| `environment.observe` | stdlib platform | trivial | ~15 |
| `workspace.open` | 自写 | 自定义 | ~50 |
| `fs.list` | `langchain-community` `ListDirectoryTool`（薄包装授权） | toolkit | ~15 |
| `fs.read` | `langchain-community` `ReadFileTool`（2026 版自动解析 PDF/图/音视频） | toolkit | ~15 |
| `fs.write` | `langchain-community` `WriteFileTool`（薄包装授权） | toolkit | ~15 |
| `fs.search` (Glob + Grep) | `FilesystemFileSearchMiddleware`（**含 ripgrep**） | middleware | 0 |
| `open.url` | stdlib `webbrowser` | trivial | ~10 |
| `open.file` | stdlib subprocess | trivial | ~15 |
| `clipboard.read/write` | `pyperclip` | trivial | ~20 |
| `task.verify` | 自写（断言文件/退出码/URL） | 自定义 | ~80 |
| `memory.search` | `BaseStore.asearch` 薄包装 | framework | ~25 |
| `skill.use` | 自写（读 md skill + prompt 注入） | 自定义 | ~40 |
| `browser`（10 个旧工具压成 1 个） | `browser-use`（视觉+ARIA agent） | 整体替换 | ~30 |
| `shell.run` | `ShellToolMiddleware`（含 execution_policy） | middleware | 0 |
| `web.fetch` | 自写（SSRF guard） | 自定义 | ~80 |
| `web.search` | `langchain-tavily` `TavilySearch` | toolkit | ~10 |
| `image.generate` | 自写（OpenAI SDK `images.generate`） | 自定义 | ~40 |
| `image.edit` | 自写（OpenAI SDK `images.edit`） | 自定义 | ~40 |
| MCP 工具集 | `MultiServerMCPClient`（stdio/SSE/HTTP 三 transport） | adapter | ~40 |
| `user.ask` | `interrupt()` 内置 | framework | 0 |
| **合计自写** | | | **~550** |

---

## 代码量预测

| 模块 | LOC |
|---|---|
| FastAPI 路由 + auth + pairing | ~150 |
| SSE 适配（sse-starlette） | ~80 |
| BackendChatModel（与 Phase 1 SSE 互通） | ~120 |
| SQLite store（runs/events/permissions/...） | ~200 |
| 5 个自写 middleware | ~185 |
| 6 个自写工具 + 14 trivial | ~550 |
| 配置 / 启动序列 / PID / 信号处理 | ~100 |
| pytest 测试 | ~400 |
| **合计** | **~1,785**（含测试） |

对比当前 `local-host/` ~6,500+ 行非测试 + ~6,200 行测试 = ~12,700 行。**总缩减约 86%。**

---

## 修订后的 Phase 路径

| # | 阶段 | 工期 | 关键交付 |
|---|---|---|---|
| **2'** | **FastAPI 骨架 + 工具适配 + 基本配对** | 5–7 天 | `local-host/python/` 起好；HTTP 端点对齐；workspace auth；store；14 trivial + 6 custom + 4 toolkit/middleware 工具；MCP；浏览器（browser-use）；pytest 烟测 |
| **3'** | **`create_agent` + middleware 全装配** | 5–7 天 | 5 自写 middleware；11 built-in middleware 接入；BackendChatModel；AsyncSqliteSaver；end-to-end 一个 run 跑通；interrupt/resume 双通 |
| **4'** | **流式 push 链路** | 3–5 天 | `astream(stream_mode=["updates","messages","custom"])` → sse-starlette → 客户端事件类型升级；token p50 < 50ms |
| **5'** | **Electron spawn 切换 + 老 Node 删除** | 3–5 天 | Electron main 改 spawn Python；删 `local-host/src/`；macOS / Windows / Linux CI matrix 三平台跑通 |
| **6'** | **Subagent（`Send` + 子图 / `SubAgentMiddleware`）** | 5–7 天 | 并行研究子图 + agent-tree UI |
| **7'** | **可观测性 + cleanup** | 2–3 天 | 自写 `BaseCallbackHandler` + structlog；可选 Langfuse / OTel；删 `python-spike` |

**总工期 23–34 人天。** 比原混合方案再缩短一些，且**永远只维护一种语言**。

---

## 关键决策（已敲定）

1. **`fs.*` 官方版的 PDF/媒体自动解析行为**：✅ 接受。Agent 拿到的就是文本，无需自己写 reader。
2. **浏览器整体换 `browser-use`**：✅ 接受。10 个工具压成 1 个 agentic 浏览器，视觉+ARIA 双驱动。如果未来需要细颗粒度 click 序列，可单独写补充工具。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `langchain.agents.create_agent` 还在 v1.1.0 早期，API 可能微调 | pin 版本；middleware 自定义部分都用 `@before_*`/`@after_*` 装饰器（最稳定的形式） |
| `browser-use` 是社区项目（非 LangChain 一手） | 接入处保留 abstraction，必要时回退到 PlayWrightBrowserToolkit 子集 |
| Python 启动延迟 + Electron 三平台打包 | daemon 启动期一次性付出；`python-build-standalone` via `uv` |
| `langchain-community` 部分包正在拆分（如 Tavily 已独立成 `langchain-tavily`） | 优先选独立包；预留迁移空间 |
| 自写 middleware 的钩子顺序歧义 | 用 `@hook_config(can_jump_to=[...])` 显式声明；用 pytest 跑 middleware 集成测试 |
| 自写 middleware 之间互相依赖 | 顺序记在 `agent/builder.py` 一处；写 docstring 说明 |
| MCP server 启动失败 | `MultiServerMCPClient` 自带超时；启动失败时报告但不阻塞 agent 启动 |

---

## 验证策略

### Phase 2' 验收
```bash
# 起 daemon
cd local-host/python && uv run pyjiandanly

# 基本健康
curl http://127.0.0.1:17371/v1/health

# 工具列表
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17371/v1/tools

# pytest
uv run pytest -v
```

### Phase 3' 端到端 run（验证 interrupt + 流式）
```bash
curl -N -X POST http://127.0.0.1:17371/v1/runs \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"goal": "什么时间", "scenario": "time"}'
# 期望：流式 token 输出 + 工具调用日志 + 完成事件
```

### Phase 5' 平台 CI
- macOS arm64 + x64
- Windows x64
- Linux x64

每平台跑 `pytest` + `uv run pyjiandanly --health-check`。

---

## 决策门

| Phase 后 | 中止/转向 | 继续 |
|---|---|---|
| 2' | FastAPI 接不通 / MCP adapter 不稳定 | 健康端点 + 5 个工具样本跑通 |
| 3' | `create_agent` middleware 顺序问题严重 | end-to-end 单 run 干净完成 |
| 4' | token 端到端 p50 > 100ms | < 50ms p50 |
| 5' | 三平台打包任一失败 | 三平台都 health-check 过 |
| 6' | subagent 子图状态污染父图 | 隔离干净，UI 渲染 OK |
| 7' | callback handler 性能影响主链路 | < 1ms overhead per event |

---

## 与 Phase 0/1 已落地工作的关系

| 已完成 | 在新方案中的处理 |
|---|---|
| `docs/architecture-local-host.md`（起点架构图） | 保留作为对比基线，Phase 5' 后追加一份"目标态架构" |
| `local-host/python-spike/`（Phase 0 spike） | **保留作为参考**，直到 Phase 7' 删除（最关键的 RPC / IPC 模式不再需要，但 LangGraph 用法验证仍有价值） |
| `local-host/src/agent-spike/`（Node 侧 spike） | **Phase 5' 删除**（Node 端整体退役） |
| `api/internal/httpapi/agent_stream.go` + 测试（Phase 1） | **完全保留**——Python 通过 `BackendChatModel` 直连此端点 |

---

## 下一步：立即开 Phase 2'

1. 创建 `local-host/python/`（与 `python-spike/` 并存，后续替换）
2. `pyproject.toml` 锁定所有依赖
3. FastAPI 骨架 + sse-starlette + 健康端点 + pairing token
4. SQLite store 基础表
5. 14 个 trivial 工具
6. workspace.open 授权机制
7. MCP / Tavily / FileManagementToolkit 接入
8. browser-use 集成（替代 10 个 browser.* 工具）
9. pytest 基础测试

Phase 2' 完成后单独 commit。

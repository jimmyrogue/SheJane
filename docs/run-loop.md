# Run Loop —— 当前能力实现态

> **范围**：`local-host/python/` 中一个 run 从 `POST /local/v1/runs` 到终态的完整路径。
> **关联**：[migration-langgraph.md](migration-langgraph.md) · [architecture-local-host.md](architecture-local-host.md) · [client-sse-protocol.md](client-sse-protocol.md)
> **状态**：截至 `refactor/infrastructure` 分支 head（189 测试全过 — Python 单元 + 客户端 + bash smoke）

---

## 全景图

```
╔════════════════════════════════════════════════════════════════════════════════════════════╗
║                  🔁  RUN LOOP  —  当前能力实现态（189 测试全验证）                            ║
╚════════════════════════════════════════════════════════════════════════════════════════════╝

  ┌─ 1. 入口与状态机 ────────────────────────────────────────────────────────────────┐
  │                                                                                  │
  │  POST /local/v1/runs                                                              │
  │       │                                                                          │
  │       ▼                                                                          │
  │  RunCoordinator.start_run(goal, workspace_path, mode)                            │
  │       ├─ store.create_run(...)              state = queued                       │
  │       ├─ asyncio.Queue 分配（事件流）                                             │
  │       └─ asyncio.create_task(_drive_run)    state = running                      │
  │                                                                                  │
  │       状态机：                                                                    │
  │       ┌──────┐                                                                   │
  │       │queued│──▶┌───────┐──┬──▶┌──────────────────┐                            │
  │       └──────┘   │running│  │   │waiting_permission│──┐                          │
  │                  │       │  │   └──────────────────┘  │                          │
  │                  │       │  │   ┌──────────────────┐  │ POST /resume             │
  │                  │       │  ├──▶│waiting_input     │──┤ 或 /permissions/:id      │
  │                  │       │  │   └──────────────────┘  │  Command(resume=)        │
  │                  │       │  ├──▶canceled              │                          │
  │                  │       │  ├──▶failed                │                          │
  │                  │       │  └──▶completed             │                          │
  │                  └───────┘ ◀──────────────────────────┘                          │
  └──────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼

  ┌─ 2. driver loop（每个 run 一份） ─────────────────────────────────────────────────┐
  │                                                                                   │
  │   agent = build_agent(per-run rebuild)                                            │
  │     ├─ FilesystemBackend(workspace_root)   ← FS 工具 + execute + 子代理 共享沙箱   │
  │     ├─ SkillsMiddleware sources = [skills_dir]   ← 渐进披露 md skills              │
  │     ├─ MemoryMiddleware  sources = [AGENTS.md]   ← system prompt 注入 ✅ cap 6     │
  │     ├─ SubAgentMiddleware subagents = [researcher, writer]                        │
  │     ├─ HumanInTheLoopMiddleware interrupt_on = {write_file, execute, …}           │
  │     ├─ checkpointer = AsyncSqliteSaver           ← thread_id = run_id              │
  │     ├─ agent_store  = AsyncSqliteStore           ← P6 memory writeback ✅ fix      │
  │     └─ model = BackendChatModel(mode)            ← 走 Go 后端 SSE                 │
  │                                                                                   │
  │   ┌─ agent.astream(stream_mode=["updates","messages","custom"]) ─────────────┐    │
  │   │                                                                          │    │
  │   │   每个 LangGraph 事件                                                     │    │
  │   │      │                                                                   │    │
  │   │      ▼                                                                   │    │
  │   │   event_translator.translate(kind, payload)                              │    │
  │   │      │     → llm.delta / llm.reasoning / llm.tool_call_chunk /          │    │
  │   │      │       tool.completed / tool.failed /                              │    │
  │   │      │       subagent.spawned / subagent.completed /                     │    │
  │   │      │       graph.node / agent.custom                                   │    │
  │   │      ▼                                                                   │    │
  │   │   store.append_event  →  AgentRunEvent envelope                          │    │
  │   │      │                   {event_type, payload, id, run_id, seq, ts}      │    │
  │   │      ▼                          ▼                                       │    │
  │   │  SQLite 持久化            sse-starlette 推流（sep="\n"）                  │    │
  │   │                                /local/v1/runs/:id/stream                 │    │
  │   │                                每帧 data: <envelope JSON>                │    │
  │   │                                最后 data: [DONE] sentinel                │    │
  │   └──────────────────────────────────────────────────────────────────────────┘    │
  │                                                                                   │
  └───────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼

  ┌─ 3. 单次 LLM 调用穿过的能力管道（27 个能力按发火位置画在时间轴上） ──────────────────┐
  │                                                                                     │
  │   ❶ 入循环前一次性                                                                   │
  │     ┌─────────────────────────────────────────────────────────────────────────┐     │
  │     │ before_agent (顺序)                                                      │     │
  │     │  • TodoListMiddleware                  ┐  ✅ cap 7  写 write_todos 工具  │     │
  │     │  • SkillsMiddleware                    ├  ✅ cap 6  md skills 注入        │     │
  │     │  • FilesystemMiddleware                ├  注入 ls/read_file/write_file/  │     │
  │     │                                        │   edit_file/glob/grep/execute    │     │
  │     │  • SubAgentMiddleware + AsyncSubAgent  ┤  ✅ cap 2  注入 task 工具         │     │
  │     │  • SummarizationMiddleware             │  上下文压缩                       │     │
  │     │  • PatchToolCallsMiddleware            │  orphan tool_call 自愈            │     │
  │     │  • InputGuardMiddleware (P1)           │  注入/越狱启发式                  │     │
  │     │  • FastDeepRouterMiddleware (P2)       │  fast/deep 路由                   │     │
  │     │  • PIIMiddleware × N (opt-in)          ┘  ✅ cap 5  email/credit/ip 脱敏   │     │
  │     │                                                                          │     │
  │     │ MemoryMiddleware                          AGENTS.md → system prompt        │     │
  │     │ HumanInTheLoopMiddleware                  绑 interrupt_on                  │     │
  │     └─────────────────────────────────────────────────────────────────────────┘     │
  │                                                                                     │
  │   ❷ 每一轮 LLM 调用                                                                  │
  │     ┌─────────────────────────────────────────────────────────────────────────┐     │
  │     │ before_model                                                             │     │
  │     │  • ToolCallLimitMiddleware(tavily, run_limit=3)  ← P8 research 收敛       │     │
  │     │  • ToolRetryMiddleware       transient 工具失败重试                       │     │
  │     │  • ModelRetryMiddleware      模型 rate-limit/5xx 重试                     │     │
  │     │  • ModelFallbackMiddleware   (opt-in) 主模型挂时切 vendor 备用            │     │
  │     │  • ModelCallLimitMiddleware  step 上限                                    │     │
  │     │  • ContextEditingMiddleware  旧 tool 输出剪枝                             │     │
  │     │                                                                          │     │
  │     │ wrap_model_call (栈式 nested)                                             │     │
  │     │       ↓                                                                  │     │
  │     │ BackendChatModel.ainvoke()                                                │     │
  │     │       ↓                                                                  │     │
  │     │   POST /api/v1/agent/llm/stream   (Go 后端 SSE)                          │     │
  │     │       │  ├─ 信用 reserve（前置扣额度）                                    │     │
  │     │       │  ├─ AnthropicPromptCachingMiddleware 加 cache_control 标记 ✅cap3 │     │
  │     │       │  ├─ vendor LLM stream                                            │     │
  │     │       │  └─ 信用 settle（实际 token 结算）                                 │     │
  │     │       ▼                                                                  │     │
  │     │   返回 llm.delta × N  +  llm.tool_call  +  llm.done                      │     │
  │     │       ↓                                                                  │     │
  │     │ after_model (逆序) ← jump_to="end" 能直接终止                              │     │
  │     │  • OutputGuardMiddleware (P9)   空答/裸拒答 nudge                          │     │
  │     │                                                                          │     │
  │     │ 有 tool_calls?                                                            │     │
  │     │   no → 出循环 → after_agent                                                │     │
  │     │   yes ↓                                                                  │     │
  │     │                                                                          │     │
  │     │ wrap_tool_call (per call)                                                │     │
  │     │  ┌─ HumanInTheLoopMiddleware 检测 ─┐                                     │     │
  │     │  │   tool ∈ DESTRUCTIVE_TOOLS?       │  ✅ cap 1                          │     │
  │     │  │   YES → interrupt(value)          │  state = waiting_permission       │     │
  │     │  │         emit run.waiting          │  退出循环，等 resume              │     │
  │     │  │   NO  → 继续                       │                                  │     │
  │     │  └────────────────────────────────────┘                                  │     │
  │     │                                                                          │     │
  │     │  ┌─ 工具分派 ─────────────────────────────────────────────────┐         │     │
  │     │  │  task(subagent_name=...)  → 子 agent 隔离 context + LLM    │         │     │
  │     │  │       │                       (researcher / writer)        │         │     │
  │     │  │       └─ 跑完 → ToolMessage(name="task") → subagent.completed │       │     │
  │     │  │                                                            │         │     │
  │     │  │  其他 tool → ToolNode 并发批处理（read-only 并行）          │         │     │
  │     │  │              失败 → ToolRetryMiddleware 拦                  │         │     │
  │     │  │              超 ToolCallLimit → 返 "已达上限" 不再调        │         │     │
  │     │  └────────────────────────────────────────────────────────────┘         │     │
  │     │                                                                          │     │
  │     │  ToolMessage 进 messages → 回到 before_model                              │     │
  │     └─────────────────────────────────────────────────────────────────────────┘     │
  │                                                                                     │
  │   ❸ 出循环一次性（终态前）                                                            │
  │     ┌─────────────────────────────────────────────────────────────────────────┐     │
  │     │ after_agent (逆序)                                                       │     │
  │     │  • MemoryWritebackMiddleware (P6)  await runtime.store.aput(...)        │     │
  │     │                                    ← 存 goal + final_answer ✅ fix       │     │
  │     │  • ReflectMiddleware (P4)         默认：stats 写入 state                  │     │
  │     │                                   opt-in (SHEJANE_LOCAL_CRITIC=1):     │     │
  │     │                                   真 LLM critic（coverage/clarity/grounding）│  │
  │     │  • 其他 middleware 反向 cleanup                                          │     │
  │     └─────────────────────────────────────────────────────────────────────────┘     │
  │                                                                                     │
  │   ❹ 终态分支（while-loop with auto-approve）                                          │
  │     while True:                                                                     │
  │       snapshot = await agent.aget_state(config)                                     │
  │       if snapshot.next is empty:                                                    │
  │           state = completed                                                         │
  │           event: run.completed { final_text }                                       │
  │           break                                                                     │
  │                                                                                     │
  │       interrupts = snapshot.tasks[0].interrupts                                     │
  │                                                                                     │
  │       ┌─ scope=run 自动审批检测（RunCoordinator._try_auto_approve） ────┐            │
  │       │   该 run 之前已 grant 该 tool 的 scope=run 权限？                │            │
  │       │   YES → emit permission.auto_approved per action                │            │
  │       │         input_payload = Command(resume={"decisions": [...]})    │            │
  │       │         continue                       ← 重新进 astream 循环    │            │
  │       │   NO  → 真正暂停 ↓                                              │            │
  │       └─────────────────────────────────────────────────────────────────┘           │
  │                                                                                     │
  │       state = waiting_permission                                                    │
  │       for each interrupt:                                                           │
  │         if value.kind == "question":                                                │
  │           store.create_question(...)                                                │
  │           event: question.asked { request_id, questions }                          │
  │         else (HITL permission gate):                                                │
  │           for each action_request:                                                  │
  │             store.create_permission(run_id, tool_name, args)                       │
  │             event: permission.required { request_id, tool, arguments }              │
  │       event: run.waiting { next, interrupts[].value }                              │
  │       break       ← 退出主循环；等 POST /permissions/:id 或 /questions/:id          │
  │                                                                                     │
  │     POST /permissions/:id 流程：                                                     │
  │       store.resolve_permission(status="approved"|"denied", scope)                  │
  │       if scope == "run": coordinator.grant_tool_scope(run_id, tool_name)           │
  │       resume_payload = {"decisions": [{"type": "approve"|"reject"}]}               │
  │       coordinator.resume_run(decision=resume_payload)                              │
  │       coordinator.emit_for_run("permission.resolved", {request_id, decision})      │
  │                                                                                     │
  │     CancelledError                                                                  │
  │       state = canceled  + event: run.canceled                                       │
  │                                                                                     │
  │     Exception                                                                       │
  │       state = failed    + event: run.failed { error, type }                        │
  │                                                                                     │
  │     finally:                                                                        │
  │       queue.put(None)   ← stream sentinel                                          │
  │       self._queues.pop(run_id)   ← 后续 stream 走 events_since replay 路径           │
  │       SSE 生成器 finally 写 data: [DONE]                                            │
  └─────────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼

  ┌─ 4. 横切：观测层 ─────────────────────────────────────────────────────────────────┐
  │   DaemonObserver(AsyncCallbackHandler) 通过 config["callbacks"] 注入 agent       │
  │                                                                                  │
  │   on_chat_model_start  → llm.start  {model_name, message_count, tags}            │
  │   on_llm_end           → llm.end    {input_tokens, output_tokens, elapsed_ms}    │
  │   on_llm_error         → llm.error  {error_type, error_message}                  │
  │   on_tool_start        → tool.start {tool, input_preview≤200}                    │
  │   on_tool_end          → tool.end   {output_preview≤200, elapsed_ms}             │
  │   on_tool_error        → tool.error                                              │
  │   on_agent_action      → agent.action                                            │
  │   on_agent_finish      → agent.finish                                            │
  │                                                                                  │
  │   每条经过 structlog → JSON (无 TTY) 或 console (TTY) → stderr                    │
  │   可选 + Langfuse（LANGFUSE_*）/ OpenTelemetry                                     │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 能力清单（189 测试覆盖）

### e2e 直接验证（`tests/test_e2e_capabilities.py`）

| # | 能力 | 触发位置 | 测试 case |
|---|---|---|---|
| 1 | **HumanInTheLoop 中断** | `wrap_tool_call` 检测 DESTRUCTIVE_TOOLS | `cap_1_humanintheloop` ✅ |
| 1b | HITL 审批 resume 不崩 | `POST /permissions/:id` 翻译成 `{"decisions": [...]}` | `cap_1b_permission_approve_resumes` ✅ |
| 1c | `permission.resolved` 清空审批卡 | 审批后 `coordinator.emit_for_run(...)` | `cap_1c_permission_resolved_event_clears_card` ✅ |
| 1d | **`scope=run` 自动批准持久化** | `_try_auto_approve` + while-loop | `cap_1d_scope_run_skips_subsequent_approvals` ✅ |
| 2 | **SubAgent 派发** | LLM 返 `task` tool_call | `cap_2_subagent_spawned` ✅ |
| 3 | Anthropic prompt 缓存 | `before_model` 加 cache_control | `cap_3_anthropic_caching` ✅ |
| 4 | Model fallback | 主模型失败后逐 vendor 切 | `cap_4_modelfallback_parsed` ✅ |
| 5 | **PII 脱敏** | `before_agent` 替换 user content | `cap_5_pii_redacts` ✅（出站 prompt 不含原 email） |
| 6 | **AGENTS.md 注入** | `MemoryMiddleware` → system prompt | `cap_6_memory_md` ✅（出站 system 含 marker） |
| 7 | TodoList | `before_agent` 注入 write_todos 工具 | `cap_7_write_todos` ✅ |
| 8 | 快路径 happy run | 全链 | `cap_8_happy_path` ✅ |

### 平台付费工具 — cloud Tool Gateway 代理（`tests/test_image_tool.py` + `test_web_search_tool.py`）

| 工具 | 路径 | 代理 |
|---|---|---|
| `image.generate` / `image.edit` | daemon → `POST /api/v1/agent/tools/execute` | OpenAI key 在 API 的 model registry，不入 daemon env |
| `web.search` | 同上（tool="web.search"） | Tavily key 在 API .env，不入 daemon env |
| 共享代理实现 | `local_host/tools/_gateway.py:call_tool_gateway` | 同一套 idempotency + reserve/settle 计费 |

防回归测试断言：`OPENAI_API_KEY` / `TAVILY_API_KEY` 即使被恶意注入 daemon env，**也不会**触发对 openai.com / tavily.com 的直连请求。

### SSE wire 契约（`tests/test_sse_envelope.py` + `test_session_http.py`）

| 契约 | 验证 |
|---|---|
| `data:` 体是 AgentRunEvent envelope（含 `event_type` + `payload` + `id` + `seq`） | `test_each_event_has_envelope_shape` ✅ |
| 终止 sentinel 是 `data: [DONE]`，不是 `event: stream.end` | `test_stream_emits_done_sentinel` ✅ |
| `seq` 单调递增（dedupe） | `test_seq_monotonic_per_run` ✅ |
| run 完成后 stream replay 也用 envelope | `test_replay_after_run_completion_has_same_envelope` ✅ |
| `POST/GET/DELETE /local/v1/session` 返 `LocalCloudSession` shape | 7 case ✅ |

### 间接 / 单测覆盖

| 能力 | 触发位置 | 主要 test 模块 |
|---|---|---|
| 工具重试 | `wrap_tool_call` 内 | `test_middleware` |
| 模型重试 | `wrap_model_call` 内 | `test_middleware` |
| 步上限 | `before_model` 计数 | `test_middleware` |
| research 收敛 | `before_model` per-tool 计数 | `test_middleware` |
| 上下文压缩 | `wrap_model_call` 转 messages | `test_middleware` |
| orphan tool_call 自愈 | `before_agent` 扫 messages | `test_middleware` |
| Input guard | `@before_agent` | `test_middleware` |
| Fast/deep 路由 | `@before_model` | `test_middleware` |
| Output guard | `@after_model + jump_to` | `test_middleware` |
| Reflect（stats / critic） | `@after_agent` | `test_memory_reflection` ✅ |
| Memory writeback | `@after_agent` + `runtime.store.aput` | `test_memory_reflection` ✅ |
| Skills 渐进披露 | `SkillsMiddleware` | `test_agent_builder` |
| Filesystem sandbox | `FilesystemMiddleware` + backend | `test_agent_builder` |
| Shell execute | `FilesystemMiddleware` execute tool | `test_agent_builder` |
| **流式 token** | `messages` 模式 → `llm.delta` | `test_streaming_latency` ✅ **p50 24.8ms** |
| 取消 | `task.cancel()` → CancelledError | `test_runs_http` |
| Resume | POST /resume → Command(resume=) | `test_runs_http` |
| 检查点持久化 | `AsyncSqliteSaver` per superstep | `test_agent_builder` |
| 观测层 | `DaemonObserver` callback | `test_observability` ✅ 9 case |

---

## 关键源码位置

| 概念 | 文件 |
|---|---|
| 入口 + 路由 | [`local_host/server.py`](../local-host/python/local_host/server.py) |
| RunCoordinator + driver loop | [`local_host/runs.py`](../local-host/python/local_host/runs.py) |
| build_agent + middleware 装配 | [`local_host/agent/builder.py`](../local-host/python/local_host/agent/builder.py) |
| Subagent 定义 | [`local_host/agent/subagents.py`](../local-host/python/local_host/agent/subagents.py) |
| 6 个自写 middleware | [`local_host/middleware/`](../local-host/python/local_host/middleware/) |
| BackendChatModel | [`local_host/llm/backend.py`](../local-host/python/local_host/llm/backend.py) |
| LangGraph → 客户端事件翻译 | [`local_host/event_translator.py`](../local-host/python/local_host/event_translator.py) |
| structlog + DaemonObserver | [`local_host/observability.py`](../local-host/python/local_host/observability.py) |
| 工具注册 | [`local_host/tools/registry.py`](../local-host/python/local_host/tools/registry.py) |
| 持久化 store | [`local_host/store/sqlite.py`](../local-host/python/local_host/store/sqlite.py) |

---

## 未覆盖（留作 live-credentials 验证）

| 维度 | 为什么 mock 不够 |
|---|---|
| Anthropic prompt cache 真命中率 | 需看 `usage.cache_read_input_tokens` —— 只有真 Anthropic API 才返回 |
| ModelFallback 真切到备用 vendor | 需 2 个真工作的 vendor model + 主模型真故障 |
| TodoList 真分解复杂任务 | 需真 LLM 推理决定 todos 内容 |
| SubAgent 真完成研究 | 需真 LLM 推理在 researcher 子 agent 里跑完 |
| Memory AGENTS.md 真被遵守 | 验证规则真改变模型输出，需真 LLM |

这五项是"会不会真跑通"的问题，框架接入正确性已被本图所示的 mock e2e 覆盖。

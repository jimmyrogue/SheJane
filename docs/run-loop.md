# Run Loop —— 当前能力实现态

创建 Run 前，daemon 现在会先检查协议版本、客户端所需能力、资源归属和当前模型绑定。接纳成功后保存版本化的有效设置快照与模型凭据引用；真实密钥不进入 Run 或作业记录。`local:<供应商编号>:<模型编号>` 会直连 Runtime 本地供应商，当前支持 OpenAI 兼容接口；旧模型编号仍走 Go 中转。两条路径都是显式选择，不会在失败时互相回退。快照还会记录接纳时是否真实绑定云工具；没有云会话的任务不会看到 `web.search`、图片、云端 PDF 和云端代码执行。作业开始或恢复时会重新核对工作区、设置快照、供应商版本、凭据引用和当前云会话，然后才进入下面的模型循环。

> **范围**：`local-host/python/` 中一个 run 从 `POST /local/v1/runs` 到终态的完整路径。
> **关联**：[harness-runtime-stages.md](harness-runtime-stages.md) · [harness-stage-improvement-notes.md](harness-stage-improvement-notes.md) · [client-sse-protocol.md](client-sse-protocol.md) · [operations.md](operations.md) · [roadmap.md](roadmap.md)
> **状态**：本文只记录当前代码如何运行，不定义 P1-P12 目标编号。目标阶段以 [harness-runtime-stages.md](harness-runtime-stages.md) 为准，待优化项以 [harness-stage-improvement-notes.md](harness-stage-improvement-notes.md) 为准。
> **边界**：飞书连接器、消息同步、待办提取和“今日待办”不再属于当前实现，也不在本运行链路中。

---

## 全景图

```
╔════════════════════════════════════════════════════════════════════════════════════════════╗
║                         RUN LOOP — 当前能力实现态                                          ║
╚════════════════════════════════════════════════════════════════════════════════════════════╝

  ┌─ 1. 入口与状态机 ────────────────────────────────────────────────────────────────┐
  │                                                                                  │
  │  POST /local/v1/runs                                                              │
  │       ├─ Electron Main 为 Runtime 请求注入 Bearer Token；Renderer 只持有地址和会话标记 │
  │       ├─ 配对 Token 映射为稳定 Runtime 身份 local:owner                          │
  │       ├─ 认证后、JSON 解析前限制请求体为 1 MiB                                   │
  │       ├─ command_id 与 client_message_id 必填                                    │
  │       ├─ 幂等命中先返回原回执；新命令在接纳事务内检查工作区和父任务               │
  │       ├─ Run、事件、产物、审批和定时任务的读写都按身份过滤                       │
  │       │                                                                          │
  │       ▼                                                                          │
  │  RunCoordinator.start_run(principal_id, command_id, client_message_id, ...)      │
  │       ├─ store.accept_run_command(...)                                            │
  │       │    同一事务写命令 + 对话消息 + Run + pending 作业 + 线程变化              │
  │       │    已有对话的 history 从 Runtime 消息生成；客户端历史只用于一次旧数据迁入 │
  │       │    同编号同内容返回原 run；同编号不同内容返回 409                         │
  │       └─ 返回“已持久化”回执，不在 HTTP 请求中启动 Agent                          │
  │                                                                                  │
  │  Runtime dispatcher                                                              │
  │       ├─ 先取得本机并发槽位                                                       │
  │       ├─ 原子领取 pending job，写 owner / generation / expiry / attempt          │
  │       ├─ 每次开始或恢复前重新检查 Run 所属工作区仍然有效                          │
  │       ├─ Run.id、graph_thread_id 和 graph_checkpoint_id 分别表示产品任务、图线程和分支头 │
  │       ├─ asyncio.create_task(_drive_run)                                          │
  │       ├─ 状态、事件、Artifact 和 LangGraph checkpoint 写入前校验 generation      │
  │       └─ 心跳续租；过期后安全失败；完成时按 owner + generation 结束 job          │
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
  │   agent = build_agent(按结构指纹复用或编译)                                       │
  │   execution_resources = AsyncExitStack      ← 本次执行结束时关闭模型客户端         │
  │     ├─ RuntimeContext                    ← P7 注入身份、任务和本次执行依赖          │
  │     ├─ backend factory → FilesystemBackend(授权工作区或本次执行临时目录)            │
  │     │                                      ← 文件工具和子代理共享当前执行边界      │
  │     ├─ SkillsMiddleware sources = [skills_dir]   ← 只读挂载，渐进披露 md skills    │
  │     ├─ MemoryMiddleware  sources = [AGENTS.md]   ← 只读挂载，注入 system prompt    │
  │     ├─ SubAgentMiddleware subagents = [general-purpose, researcher, writer]       │
  │     ├─ ToolReviewMiddleware + ToolExecutionMiddleware                            │
  │     │   ← 主 Agent 和子 Agent 共用参数校验、人工确认和持久工具回执                │
  │     ├─ checkpointer = lease-fenced AsyncSqliteSaver ← 当前任务租约保护写入          │
  │     ├─ agent_store  = AsyncSqliteStore           ← 显式 memory 工具的持久存储      │
  │     ├─ RuntimeContext.model = 本次模型连接        ← 主模型、摘要和子 Agent 共用代理  │
  │     └─ RuntimeContext.dynamic_tools = 本次 MCP 工具 ← 图内只保留无密钥结构代理      │
  │                                                                                   │
  │   ┌─ agent.astream(version="v2", durability="sync",                            │    │
  │   │                 context=RuntimeContext,                                       │    │
  │   │                 stream_mode=["updates","messages","custom","checkpoints"]) ┐ │
  │   │                                                                          │    │
  │   │   每个 LangGraph 事件                                                     │    │
  │   │      │                                                                   │    │
  │   │      ▼                                                                   │    │
  │   │   event_translator.translate(kind, payload)                              │    │
  │   │      │     → llm.delta / llm.reasoning / llm.tool_call_chunk /          │    │
  │   │      │       tool.completed / tool.failed /                              │    │
  │   │      │       subagent.spawned / subagent.completed /                     │    │
  │   │      │       agent.custom                                                │    │
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

  ┌─ 3. 单次 LLM 调用穿过的能力管道（按发火位置画在时间轴上） ──────────────────┐
  │                                                                                     │
  │   ❶ 入循环前一次性                                                                   │
  │     ┌─────────────────────────────────────────────────────────────────────────┐     │
  │     │  • Runtime identity + safety         ← 主 Agent/子 Agent、所有供应商共用 │     │
  │     │ before_agent (顺序)                                                      │     │
  │     │  • TodoListMiddleware                  ┐  ✅ cap 7  写 write_todos 工具  │     │
  │     │  • SkillsMiddleware                    ├  ✅ cap 6  md skills 注入        │     │
  │     │  • FilesystemMiddleware                ├  注入 ls/read_file/write_file/  │     │
  │     │                                        │   edit_file/glob/grep/execute    │     │
  │     │  • SubAgentMiddleware + AsyncSubAgent  ┤  ✅ cap 2  注入 task 工具         │     │
  │     │  • SummarizationMiddleware             │  上下文压缩                       │     │
  │     │  • PatchToolCallsMiddleware            │  orphan tool_call 自愈            │     │
  │     │  • InputGuardMiddleware (P1)           ┘  注入/越狱启发式                  │     │
  │     │                                                                          │     │
  │     │ MemoryMiddleware                          AGENTS.md → system prompt        │     │
  │     │ ToolReviewMiddleware                      按调用参数和风险生成等待候选      │     │
  │     └─────────────────────────────────────────────────────────────────────────┘     │
  │                                                                                     │
  │   ❷ 每一轮 LLM 调用                                                                  │
  │     ┌─────────────────────────────────────────────────────────────────────────┐     │
  │     │ before_model                                                             │     │
  │     │  • ToolCallLimitMiddleware(tavily, run_limit=3)  ← P8 research 收敛       │     │
  │     │  • ToolRetryMiddleware       transient 工具异常重试（max_tool_retries）    │     │
  │     │  • ToolResultRetryMiddleware retryable tool envelope 重试                 │     │
  │     │  • 模型自动重试已禁用；产生输出后不得从头重试               │     │
  │     │  • 本地 direct model fallback 已禁用；没有静默供应商切换             │     │
  │     │  • local_model_calls 原子预留持久调用预算                                │     │
  │     │  • OutboundPolicy 只处理出站副本：强制过滤凭据，外部供应商按策略脱敏   │     │
  │     │  • 按模型 max_input_tokens 、工具结构和安全余量建立硬上下文边界     │     │
  │     │  • CompletionRouter 是唯一完成候选路由：验证失败时有界返回 model       │     │
  │     │                                                                          │     │
  │     │ wrap_model_call (栈式 nested)                                             │     │
  │     │       ↓                                                                  │     │
  │     │ LedgerChatModel 记录首次输出 → 已绑定的唯一供应商模型               │     │
  │     │       ↓                                                                  │     │
  │     │   可选 POST /api/v1/agent/llm/stream   (runtime-v1 标记后只转发并计费)    │     │
  │     │       │  ├─ 信用 reserve（前置扣额度）                                    │     │
  │     │       │  ├─ Anthropic gateway 对长 request 加顶层 cache_control ✅cap3 │     │
  │     │       │  ├─ vendor LLM stream                                            │     │
  │     │       │  └─ 信用 settle（实际 token 结算）                                 │     │
  │     │       ▼                                                                  │     │
  │     │   返回 llm.delta × N  +  llm.tool_call  +  llm.done                      │     │
  │     │       ↓ 完整结束时结算 token/费用；中断或重启标记结果不明       │     │
  │     │       ↓ 顶层完整 AIMessage 按版本写入 local_assistant_drafts               │     │
  │     │       ↓                                                                  │     │
  │     │ after_model：仅 CompletionRouter 可决定最终候选、修复或明确失败          │     │
  │     │                                                                          │     │
  │     │ 有 tool_calls?                                                            │     │
  │     │   no → 出循环 → after_agent                                                │     │
  │     │   yes ↓                                                                  │     │
  │     │                                                                          │     │
  │     │ after_model 的 ToolReviewMiddleware 先解析完整工具批次                   │     │
  │     │  • 校验工具是否存在、参数结构、图定义版本和撤销状态                      │     │
  │     │  • 计算 operation_id、arguments_hash 和风险等级                         │     │
  │     │  • 任一调用需确认时，整批执行前 interrupt 并保存等待候选                 │     │
  │     │  • approve / edit / reject 必须与 SQLite 中的同一决定相符               │     │
  │     │                                                                          │     │
  │     │ wrap_tool_call 的 ToolExecutionMiddleware                               │     │
  │     │  • prepared → running → completed / failed / outcome_unknown            │     │
  │     │  • 已完成回执直接复用；结果不明进入人工核对，不自动重跑                  │     │
  │     │  • 纯读取可并行；冲突调用按模型批次原始顺序通过公平读写门                │     │
  │     │  • 大结果保存为有配额的工作产物，只把短预览和引用交给模型                │     │
  │     │                                                                          │     │
  │     │  ┌─ 工具分派 ─────────────────────────────────────────────────┐         │     │
  │     │  │  task(subagent_name=...)  → 子 agent 隔离 context + LLM    │         │     │
  │     │  │       │                       (researcher / writer)        │         │     │
  │     │  │       └─ 跑完 → ToolMessage(name="task") → subagent.completed │       │     │
  │     │  │                                                            │         │     │
  │     │  │  其他 tool → ToolNode 只并行明确只读调用                     │         │     │
  │     │  │              只读暂时错误 → ToolRetryMiddleware 有界重试     │         │     │
  │     │  │              超 ToolCallLimit → 返 "已达上限" 不再调        │         │     │
  │     │  └────────────────────────────────────────────────────────────┘         │     │
  │     │                                                                          │     │
  │     │  ToolMessage 进 messages → 回到 before_model                              │     │
  │     └─────────────────────────────────────────────────────────────────────────┘     │
  │                                                                                     │
  │   ❸ 出循环一次性（终态前）                                                            │
  │     ┌─────────────────────────────────────────────────────────────────────────┐     │
  │     │ 不执行隐藏的 after_agent 业务：                                           │     │
  │     │  • 不调用反思模型                                                         │     │
  │     │  • 不自动写入长期记忆                                                     │     │
  │     │  • memory.write 只能由主任务使用本轮真实用户输入授予的事实能力调用         │     │
  │     │  • 统计、最终回答和用量从助手草稿、模型账本和工具回执读取                  │     │
  │     └─────────────────────────────────────────────────────────────────────────┘     │
  │                                                                                     │
  │   ❹ 完成或等待分支                                                                  │
  │     while True:                                                                     │
  │       snapshot = await agent.aget_state(config)                                     │
  │       if snapshot.next is empty:                                                    │
  │           return 候选结果：completed + run.completed { final_text }                 │
  │                                                                                     │
  │       interrupts = snapshot.interrupts + 每个 snapshot.task.interrupts              │
  │                                                                                     │
  │       waiting_status = waiting_input if all interrupts are user.ask questions,       │
  │                        otherwise waiting_permission                                  │
  │       若 next 非空但 interrupts 为空：明确失败，不提交无法恢复的等待状态             │
  │       for each interrupt:                                                           │
  │         if value.kind == "question":                                                │
  │           store.create_question(...)                                                │
  │           event: question.asked { request_id, questions }                          │
  │         else (tool_review):                                                         │
  │           for each action_request:                                                  │
  │             保存调用编号、操作编号、参数指纹、风险和完整等待候选                    │
  │             event: permission.required { request_id, tool, arguments, risk }        │
  │       return 候选结果：waiting + run.waiting { next, interrupts, handoff }          │
  │                                                                                     │
  │     执行器收到候选结果后：                                                           │
  │       退出 AsyncExitStack，关闭本次模型客户端和其他执行资源                         │
  │       若清理无法确认：写 run.cleanup_required 并封存当前执行代次，不允许自动重试    │
  │       若租约过期：旧执行者完成清理并提交证明后，才把隔离任务结算为 failed           │
  │       LocalStore.commit_run_result(...)                                             │
  │         普通执行必须持有属于当前 Run、未过期且未隔离的租约                         │
  │         无租约默认拒绝；启动恢复显式授权且确认无 pending / leased 作业后才可提交    │
  │         同一事务：更新 Run + 助手消息 + 线程版本 + 结果事件 + 结束旧执行作业        │
  │       事务提交后只唤醒 SSE；每个订阅者按自己的数据库游标读取结果事件                │
  │       客户端随后读取 /threads/{id}；漏掉 SSE 也能得到相同结果                       │
  │                                                                                     │
  │     POST /permissions/:id 流程：                                                     │
  │       幂等保存 approve / edit / reject 决定和统一等待候选                           │
  │       scope=run 只允许同一参数指纹、同一风险和同一图版本，24 小时且最多复用 20 次   │
  │       event: permission.resolved { request_id, decision, scope }                   │
  │       current_batch = permission.required since latest run.started/run.resumed     │
  │       if any current_batch permission still pending: return {resumed:false}        │
  │       resume_payload = {"decisions": [...]} 按 permission.required 原顺序          │
  │       coordinator.resume_run(decision=resume_payload)                              │
  │                                                                                     │
  │     CancelledError                                                                  │
  │       return 候选结果：canceled + run.canceled                                      │
  │                                                                                     │
  │     Exception                                                                       │
  │       return 候选结果：failed + run.failed { error, type, retryable,                │
  │                                               action_kind, recovery_action }         │
  │                                                                                     │
  │     finally:                                                                        │
  │       唤醒订阅者并删除进程内唤醒信号；数据库事件日志仍是唯一事实来源                │
  │       每个 SSE 订阅者读到终态且作业结束后退出，生成器最后写 data: [DONE]            │
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

## 能力清单（测试覆盖）

### e2e 直接验证（`tests/test_e2e_capabilities.py`）

| # | 能力 | 触发位置 | 测试 case |
|---|---|---|---|
| 1 | **参数化工具确认** | `ToolReviewMiddleware` 在整批执行前生成等待候选 | `capability_1_humanintheloop_pauses_on_destructive_tool` ✅ |
| 1b | 审批恢复 | `POST /permissions/:id` 幂等保存决定，再翻译成 `{"decisions": [...]}` | `capability_1b_permission_approve_resumes_the_run` ✅ |
| 1b2 | HITL 多 action 批次审批 | 当前 pause 批次全部 resolved 后按 `permission.required` 顺序 resume | `test_multi_permission_batch_waits_for_all_decisions_before_resume` ✅ |
| 1c | `permission.resolved` 清空审批卡 | HTTP 决策事件持久化，并在恢复流先于 `run.resumed` 重放 | `cap_1c_permission_resolved_event_clears_card` ✅ |
| 1d | **有限运行级授权** | 同参数、同风险、同图版本，24 小时且最多复用 20 次 | `capability_1d_scope_run_does_not_widen_to_new_arguments` ✅ |
| 1e | **拒绝回执** | 拒绝不进入工具，保存 `rejected` 回执 | `capability_1e_denied_tool_is_not_executed_and_has_rejected_receipt` ✅ |
| 1f | **整批先暂停** | 混合只读和写入调用时，确认前一个也不执行 | `capability_1f_review_pauses_the_entire_mixed_tool_batch` ✅ |
| 1g | **参数前置校验** | 无效参数不询问用户、不进入工具 | `capability_1g_invalid_tool_arguments_fail_before_review` ✅ |
| 2 | **SubAgent 派发** | LLM 返 `task` tool_call | `cap_2_subagent_spawned` ✅ |
| 2c | **子 Agent 同一执行边界** | 子 Agent 内工具也经过确认和回执 | `capability_2c_subagent_tools_share_review_and_receipt_boundary` ✅ |
| 3 | Anthropic prompt 缓存 | Go Anthropic gateway 对长 request 加顶层 `cache_control`；daemon wire contract 不带 provider-specific cache 标记 | `cap_3_prompt_caching_is_gateway_owned` ✅ |
| 4 | 自动模型回退禁用 | `SHEJANE_LOCAL_FALLBACK_MODELS` 被兼容性忽略；daemon 直连和可选 Go 中转都不会在失败后自行换模型 | `cap_4_local_direct_modelfallback_ignored` / `TestAgentLLMStreamDoesNotSwitchModelOnProviderFailure` ✅ |
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
| 多个实时订阅者各自收到完整、有序的同一事件日志 | `test_each_live_stream_subscriber_receives_the_complete_ordered_event_log` ✅ |
| `POST/GET/DELETE /local/v1/session` 返 `LocalCloudSession` shape | 7 case ✅ |

### 间接 / 单测覆盖

| 能力 | 触发位置 | 主要 test 模块 |
|---|---|---|
| 工具异常重试 | `wrap_tool_call` 内，白名单工具的 transient exception 按 `max_tool_retries` 重试 | `test_middleware` |
| 工具结果重试 | `wrap_tool_call` 内，白名单工具返回 `{ok:false,retryable:true}` envelope 时走 `failure_policy.build_retry_decision`，按 `max_tool_retries` 做有界退避；用户/配置/账单/工作区/校验/实现类错误即使误带 `retryable:true` 也 fail-fast | `test_middleware` / `test_agent_builder` |
| Run budget clamps | Settings/env 和 per-run Advanced 覆盖都限制 model calls、tool retries 和 search limit 的安全范围 | `test_advanced_overrides` |
| 模型重试防重复 | 不装配通用 `ModelRetryMiddleware`，错误直接交给运行时结束路径 | `test_agent_builder` |
| 步上限 | `before_model` 计数 | `test_middleware` |
| 上下文压缩 | Runtime 把已接纳历史原样交给 Deep Agents 的令牌感知摘要；不再按消息数二次截断或生成关键词摘要。P2 完成前，client 只保留 256 条 / 750000 字符的传输安全边界 | `test_runs_http` / `conversationHistory.test` |
| 工具结构可见性 | 完整工具集固定属于图定义；Runtime 只在模型请求副本中按当前目标、保留历史和既有工具调用确定性隐藏无关的 Office 工具结构，并在供应商边界覆盖所有子 Agent，不改变 checkpoint 或图指纹 | `test_tool_visibility` / `test_model_ledger` / `test_agent_builder` |
| 供应商上下文硬限制 | 每次真实模型调用前按声明窗口扣除工具结构并裁剪请求副本；剩余空间不足最小合法请求时在预留调用账本和联系供应商之前明确失败 | `test_model_ledger` |
| 输出、时间与费用边界 | 模型资料限制最大输出，所有供应商调用有硬超时；中转服务预留并按真实用量结算额度，BYOK 记录 token 并用调用次数、输出和时间限制资源 | `test_backend_llm` / `agent_stream_test` / provider tests |
| research 收敛 | `before_model` per-tool 计数 | `test_middleware` |
| 大工具结果转存与摘要 | Deep Agents `FilesystemMiddleware` + `SummarizationMiddleware` | `test_agent_builder` / `test_runs_http` |
| orphan tool_call 自愈 | `before_agent` 扫 messages | `test_middleware` |
| Input guard | `@before_agent` | `test_middleware` |
| Output guard | `@after_model` observe-only flag for empty/refusal finals | `test_middleware` |
| 验证回环 | `@after_model + jump_to="model"`，`task.verify` 失败后最多按 `SHEJANE_LOCAL_VERIFY_REPAIR_MAX` 重做 | `test_middleware` / `test_agent_builder` |
| 用户确认 retry workflow | `metadata.intent=retry` → `<state>` 重试上下文；普通恢复重试携带 source run/message、attempt 和失败分类，帮助模型避免盲目重复失败路径 | `test_runs_http` / `App.test` |
| Billing recovery observer | quota 失败打开 checkout 时，client 按 `{conversation_id, assistant_message_id}` 给 checkout 创建请求加 in-flight guard，避免同一失败消息连续点击创建多个 Stripe session；打开后静默做有界 wallet polling，只有后端余额/套餐容量改善后才刷新显式 retry 提示，不自动创建替换 run | `App.test` |
| Auth/session recovery observer | auth 类失败点击刷新会话但尚未连上时，client 保留失败 turn 的 recovery target；后续重新登录或 token 修复触发自动 session sync 成功后，只刷新显式 retry 提示，不自动创建替换 run | `App.test` |
| 用户触发 repair workflow | `metadata.intent=repair` → `<state>` 修复上下文 + `repair.workflow` started/completed/failed/rejected/canceled；client 按 `{conversation_id, assistant_message_id}` 给 repair action 加 in-flight guard，避免同一失败消息被连续点击创建重复替换 run；attempt 超过 `SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX` 时 fail-fast，不调用模型 | `test_runs_http` / `test_context_builder` / `test_run_recovery` / `App.test` |
| 结束前进展账本 guard | `@after_model + jump_to="model"`，有非 `task.progress` 工具工作且最后一次工具后没有刷新账本时，最多要求模型调用一次 `task.progress` | `test_middleware` / `test_agent_builder` |
| 执行结算与资源清理 | 所有结束方式先关闭执行级 `AsyncExitStack`，再从助手草稿、模型账本、工具回执和验证记录生成结构化结果；清理不明时进入不可自动重试的隔离态 | `test_run_jobs` / `test_model_ledger` |
| 显式长期记忆 | 主任务入口从真实用户输入提取精确记忆事实；`memory.write` 只能写入该能力允许的原文，子 Agent 不拥有写权限；读写按所有者与工作区双重隔离 | `test_memory` / `test_memory_http` / `test_subagents` |
| Skills 渐进披露 | `SkillsMiddleware` | `test_agent_builder` |
| Filesystem sandbox | `FilesystemMiddleware` + backend | `test_agent_builder` |
| Shell execute | `FilesystemMiddleware` execute tool | `test_agent_builder` |
| 进展账本与交接新鲜度 | `task.progress` 写入 `progress_ledger` artifact，diagnostics 暴露最新 ledger，并在 handoff 标记 `not_required` / `fresh` / `missing` / `stale`；`run.waiting` 也携带同样的轻量 pause snapshot，client timeline 会保留 missing/stale 状态并在等待中的聊天进度行提示暂停交接风险 | `test_smoke` / `test_runs_http` / `test_user_ask` / `chatStore.test` / `AgentProgress.test` |
| 错误分类诊断 | `handoff.failure` 将最近 `run.failed` / `tool.failed` 归类并标记 recoverable / retryable / action_kind / recovery_action / suggested action；同一模块也输出 runtime retry decision（`should_retry` / `delay_s` / fail-fast reason） | `test_runs_http` / `test_failure_policy` |
| 模型错误 durable failure | 云端 `llm.error` 抛 `BackendLLMError`，模型重试和 `handoff.failure` 共用 `failure_policy.build_retry_decision`；重试耗尽后写入结构化 `run.failed` | `test_backend_llm` / `test_runs_http` / `test_agent_builder` / `test_failure_policy` |
| 验证结果诊断 | `handoff.verification` 暴露最新 `task.verify` 结构化结果；最新验证通过时不再把更早的 `task.verify` 失败作为当前 failure/blocker | `test_runs_http` / `DiagnosticsPanel.test` |
| 工具 envelope 失败翻译 | `ToolMessage` content 为 `ok:false` JSON/dict envelope 时翻译成 `tool.failed`，并保留 error_code / recoverable / retryable | `test_event_translator` / `test_runs_http` |
| Cloud Tool Gateway 网关层退避 | `web.search` / `image.*` / `pdf.inspect` / `code.execute` 的 gateway transport error 和非 JSON 瞬态 HTTP 响应（429/500/502/503/504）通过统一 retry decision 做有界指数退避，复用 idempotency key；结构化 tool result envelope 缺省 `retryable:false`，只有显式 `retryable:true` 且通过共享 failure policy 才进入工具结果重试 | `test_web_search_tool` / `test_image_tool` / `test_tools_code` / `test_tools_pdf` |
| **流式 token** | `messages` 模式 → `llm.delta` | `test_streaming_latency` ✅ **p50 24.8ms** |
| 取消 | `task.cancel()` → CancelledError | `test_runs_http` |
| Resume | POST /resume → Command(resume=) | `test_runs_http` |
| 检查点持久化 | `durability="sync"` 保证每个 superstep 在下一步前提交；`checkpoints` 流用租约保护的比较交换更新当前 Run 分支头；diagnostics 只读取该明确分支头 | `test_agent_builder` / `test_runs_http` / `test_run_jobs` |
| 观测层 | `DaemonObserver` callback | `test_observability` ✅ 9 case |

### Failure recovery contract

SheJane follows the same split as LangGraph's fault-tolerance model:

- **Runtime layer** decides retryability and recovery shape. `failure_policy` maps structured failure payloads to `category`, `action_kind`, `retryable`, and the UI-facing `recovery_action`.
- **Persistent layer** stores failure provenance in `run.failed` / `tool.failed` events and diagnostics handoff. Checkpoints remain the resume anchor for interrupted work; failed runs remain inspectable.
- **UI layer** derives CTAs from persisted events. It may deduplicate clicks and show restart reminders, but it must not invent recovery semantics or auto-run after restart.

`waiting_permission` and `waiting_input` are pause states produced by LangGraph interrupts. They are intentionally not `run.failed`, and recovery buttons must not replace the permission/question/plan-approval resume flow.

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
| Anthropic prompt cache 真命中率 | Go gateway 已加自动 `cache_control`，但命中率需看 `usage.cache_read_input_tokens` —— 只有真 Anthropic API 才返回 |
| ModelFallback 真切到备用 vendor | 需 2 个真工作的 vendor model + 主模型真故障 |
| TodoList 真分解复杂任务 | 需真 LLM 推理决定 todos 内容 |
| SubAgent 真完成研究 | 需真 LLM 推理在 researcher 子 agent 里跑完 |
| Memory AGENTS.md 真被遵守 | 验证规则真改变模型输出，需真 LLM |

这五项是"会不会真跑通"的问题，框架接入正确性已被本图所示的 mock e2e 覆盖。

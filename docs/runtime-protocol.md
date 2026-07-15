# Runtime HTTP 与 SSE 协议

> 本文记录当前公开协议。线程快照返回每个 Run 的安全事件高水位，客户端通过 `?after=<seq>` 恢复持久状态；游标超出保留窗口时重新读取权威快照。逐字文本、推理、临时用量和未完成调用片段只通过有界实时通道发送，断线后不重放。P4 的阶段边界见 [`harness-runtime-stages.md`](harness-runtime-stages.md)。

适用于 `GET /local/v1/runs/{run_id}/stream`（`Content-Type: text/event-stream`）。

> **文档版本**：对应 `@shejane/runtime-sdk` 的 SSE 解析、Runtime `RunCoordinator.stream` 与 `event_translator.translate`。
>
---

## Wire 格式

每条事件如下：

```
event: <event_type>
data: <JSON object — AgentRunEvent envelope>

```

**关键点**：
- `event:` 行只是装饰（给 `curl -N` 看的）。**客户端只读 `data:` 里 JSON 的 `event_type` 字段** —— `parseAgentSSEChunk` 在 `sse.ts:58-72` 完全不解析 `event:` 行。
- 帧之间用 **LF** 双换行分隔（`\n\n`）。Runtime 使用 sse-starlette 的 `sep="\n"` 覆盖默认的 `\r\n`，因为客户端的 `split(/\n\n/)` 不匹配 CRLF。
- 终止信号是单独一行 `data: [DONE]`（没有 `event:`）。客户端识别到 `[DONE]` 后才会 resolve stream Promise。`event: stream.end` 已**废弃**。

## AgentRunEvent envelope

```ts
interface AgentRunEvent {
  event_type: string                       // 必填 — UI switch 入口
  payload?: Record<string, unknown>        // 事件特定 payload
  id?: string                              // dedupe 用，evt_<hex>
  run_id?: string
  seq?: number                             // 仅持久事件；同 run 内单调递增
  created_at?: string                      // ISO8601
}
```

状态变化持久化在 `local_events` 表，每条都有 `seq`；replay 路径只返回这些持久事件。临时事件仍有唯一 `id`，但没有 `seq`，不会写入数据库或在重连后重放。Runtime 升级时会清理旧版本曾错误持久化的临时事件，序号空洞不影响后续游标。

完整 TS 类型见 `packages/runtime-sdk/src/sse.ts`。

---

## 事件类型

### 生命周期

| event_type | 触发时机 | payload 关键字段 |
|---|---|---|
| `run.started` | run 进入 `running` 状态 | `goal` |
| `run.resumed` | resume_run 后第一个 frame | `payload`（resume 时传入的 dict） |
| `run.waiting` | 卡在 HITL interrupt（**通常伴随 `permission.required` 或 `question.asked`**，UI 优先听后者） | `next`, `interrupts`, `handoff` |
| `run.completed` | 终态 completed | `final_text`, `input_tokens`, `output_tokens`, `model_calls`, `unmetered_calls`, `outcome_unknown_calls` |
| `run.failed` | 终态 failed | `error`, `type`, `category?`, `recoverable?`, `retryable?`, `action_kind?`, `suggested_action?` |
| `run.cleanup_required` | 清理尚未确认，执行代次已隔离 | `error`, `type`, `category`, `retryable=false`, `cleanup` |
| `run.canceled` | 终态 canceled | _(空)_ |
| `repair.workflow` | 用户触发的 repair run 进入/结束/失败/被上限拒绝/取消 | `status`, `attempt`, `max_attempts`, `source_run_id?`, `source_message_id?`, `failure_category?`, `reason?` |

`run.waiting.handoff` 是暂停点的轻量交接快照，包含
`ledger_state`（`not_required` / `fresh` / `missing` / `stale`）、
`ledger_message` 和最新 `feature_ledger` 摘要。它不包含 artifact 正文或
checkpoint messages。`permission.required` / `question.asked` / `run.waiting`
这类被动等待信号不会单独让 ledger 变脏；真正的工具结果、权限决策、
run 失败/取消等状态变化才会触发 `missing` 或 `stale`。

### LLM 流

| event_type | 触发时机 | payload |
|---|---|---|
| `llm.delta` | 每个 streamed token（assistant content） | `content: string` |
| `llm.reasoning` | DeepSeek-style thinking-mode chunk | `content: string` |
| `llm.tool_call_chunk` | 工具调用 args 的部分 JSON 流 | `id, name, args_delta, index` |
| `llm.usage` | 供应商返回的临时用量，只用于实时显示 | `input_tokens`, `output_tokens` |
| `llm.error` | 流中报错（非致命） | `message` |

以上四类 `llm.*` 增量和 `subagent.spawned` 都是临时事件，断线或慢客户端背压时可以丢失。`llm.usage` 不是结算事实来源；`run.completed` 中的用量由
Runtime 持久模型调用账本聚合；重复 SSE 事件不会改变该结果。

### 工具

| event_type | 触发时机 | payload |
|---|---|---|
| `tool.completed` | 一次工具调用完成 | `tool_call_id, name, tool, content, status: "ok"` |
| `tool.failed` | 工具完成但 `ToolMessage.status == "error"`，或工具结果 envelope 明确 `ok:false` | `tool_call_id, name, tool, content, status: "error", error_code?, recoverable?, retryable?` |
| `subagent.spawned` | deepagents `task` 子代理被派遣 | `id, args_delta, index` |
| `subagent.completed` | 子代理完成 | `tool_call_id, name, content` |

### 人在回路（HITL）

| event_type | 触发时机 | payload |
|---|---|---|
| `permission.required` | 参数化工具确认在整批执行前暂停；同一批可连续多条 | `request_id, tool, tool_name, tool_call_id, operation_id, arguments_hash, arguments, risk, description, allowed_decisions` |
| `permission.resolved` | `permission.resolve` 命令成功后持久化，并在恢复流中先于 `run.resumed` 出现 | `request_id, tool, tool_name, decision, scope` |
| `question.asked` | `user.ask` 工具触发 interrupt | `request_id, questions: [{question, options, id}]` |
| `question.answered` | `question.answer` 命令成功后持久化，并在恢复流中先于 `run.resumed` 出现 | `request_id, answers` |
| `plan.approval_required` | 计划模式生成待确认计划 | `request_id, tool_call_id, todos, summary` |
| `plan.approval_resolved` | `plan.resolve` 命令成功后持久化，并在恢复流中先于 `run.resumed` 出现 | `request_id, decision, instructions` |

### 中间件 / 框架内部

| event_type | 触发时机 | payload |
|---|---|---|
| `agent.custom` | middleware 通过 `get_stream_writer()` 推送 | _(任意)_ |

LangGraph 原始节点更新不进入产品 SSE；它们保留在 checkpoint 和 tracing 诊断层。

---

## 客户端消费骨架

```ts
import { parseAgentSSEBuffer } from '@shejane/runtime-sdk'

const resp = await fetch(`/local/v1/runs/${runID}/stream`, { signal })
const reader = resp.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''
let assistantText = ''

while (true) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const { events, rest } = parseAgentSSEBuffer(buffer)
  buffer = rest
  for (const ev of events) {
    if (ev.type === 'done') return            // ← data: [DONE]
    if (ev.type !== 'agent') continue
    const { event_type, payload = {} } = ev.event
    switch (event_type) {
      case 'llm.delta':
        assistantText += String(payload.content ?? '')
        render(assistantText)
        break
      case 'llm.reasoning':
        appendReasoningPanel(String(payload.content ?? ''))
        break
      case 'tool.completed':
      case 'tool.failed':
        renderToolCard(payload)
        break
      case 'permission.required':
        showApprovalCard({
          requestId: payload.request_id,
          tool: payload.tool,
          args: payload.arguments,
        })
        break
      case 'permission.resolved':
      case 'tool.reconciliation_resolved':
        clearApprovalCard(payload.request_id)
        break
      case 'question.asked':
        showQuestionPrompt(payload)
        break
      case 'run.completed':
        finalize({
          text: payload.final_text,
          inputTokens: payload.input_tokens,
          outputTokens: payload.output_tokens,
        })
        break
    }
  }
}
```

EventSource API 也能用，但不能传 Authorization 头；fetch + ReadableStream 是 Electron 渲染进程的标准做法。

---

## 控制面端点

事件流是只读的；状态变更靠这些 HTTP 端点：

| 方法 + 路径 | body | 触发的 SSE |
|---|---|---|
| `POST /local/v1/runs` | `{command_id, client_message_id, goal, permission_mode?, attachment_paths?, history?, settings?, ...}` | `permission_mode` 为 `ask`、`auto` 或 `full_access`，省略时使用 `ask`；附件必须是本机现有文件，最多 10 个、单个不超过 10 MiB；创建后开 stream → `run.started` |
| `POST /local/v1/runs/:id/fork` | `{command_id, client_message_id, assistant_message_id, thread_id, protocol_version, required_capabilities, checkpoint_id, ...}` | 创建分支后开 stream → `run.started` |
| `GET /local/v1/runs/:id/stream` | — | （本协议） |
| `POST /local/v1/commands` | `run.cancel`、`permission.resolve`、`question.answer`、`plan.resolve` 或 `tool.reconcile` 的严格联合类型 | 对应状态事件；同一等待周期全部解决后才有 `run.resumed` |

权限批准的 happy path：

```
[user types] → POST /runs (id=R)
   GET /runs/R/stream
   → run.started
   → llm.reasoning / llm.delta...
   → permission.required {request_id: P, tool: "write_file", args: {...}}
   → run.waiting {handoff: {ledger_state, ledger_message, feature_ledger}}
   → [DONE]   ← stream 暂时关闭

[user clicks "allow same arguments in this run"] → POST /commands {type: "permission.resolve", permission_id: P, decision: "approve", scope: "run"}
   (Runtime：幂等保存决定；授权只绑定同参数指纹、同风险和稳定图定义，并有时限与次数上限)
   GET /runs/R/stream?after=<last_seq>  ← 客户端从快照高水位继续订阅
   → permission.resolved {request_id: P, decision: "approve", scope: "run"}
   → run.resumed
   → tool.completed {tool: "write_file", content: "..."}
   → llm.delta...
   → run.completed
   → [DONE]
```

如果一次 HITL 暂停同时包含多个 `action_requests`，Runtime 会在同一个
`run.waiting` 前发多条 `permission.required`。每次提交 `permission.resolve`
只 resolve 对应的一张卡；只要当前批次还有 `pending` permission，响应为
`resumed:false`，不会发 `run.resumed`。最后一个同批权限 resolved 后，
Runtime 按 LangGraph `interrupt_id` 和动作顺序构造恢复映射并继续执行。

权限模式在 Run 接纳时冻结进 `settings_json`，由 Runtime 的工具审查层执行：

- `ask`：工作区写入、剪贴板读取和外部或未知工具需要确认。
- `auto`：工作区写入自动执行；剪贴板读取及外部或未知工具仍需确认。
- `full_access`：不产生普通工具确认，但仍受工作区授权、路径校验、操作系统权限、工具参数校验和回执审计约束。

权限模式决定“何时询问”；`permission.resolve.scope` 决定一次明确批准可以复用多久，两者互不替代。分支任务继承源 Run 冻结的权限模式；定时任务在创建时同样冻结该字段。

后续 turn 再触发同一个工具且参数指纹、风险和图定义完全相同时，可消耗有界运行级授权直接执行，不再产生额外事件。若副作用工具结果不确定，则进入显式核对：

```
   → llm.tool_call_chunk
   → tool.reconciliation_required {operation_id, tool_name}
   ← POST /local/v1/commands {type: "tool.reconcile", command_id, operation_id, decision}
   → tool.reconciliation_resolved {decision}
```

---

## 设计原则

Runtime 的线程快照是界面事实来源：

- `GET /local/v1/threads` 使用稳定游标分页列出对话，并返回全局变化高水位。
- `GET /local/v1/threads/{thread_id}` 按消息位置分页；后续页携带线程版本，版本变化返回冲突并由客户端重读。
- 助手消息投影在写入正文时原子记录它已覆盖的事件序号；线程快照返回这个安全高水位，客户端把该序号保存到可丢弃缓存。
- `GET /local/v1/threads/changes?after=<cursor>` 用于发现其他客户端或后台任务提交的变化。
- `GET /local/v1/runs/{run_id}/stream?after=<seq>` 只回放更大的事件序号，并在 SSE `id` 字段携带序号。SSE 提供低延迟增量，不承担最终一致性。
- 如果 `after` 大于最新序号，或落在已删除事件形成的缺口之前，Runtime 返回 `409 event_cursor_reset_required`。客户端重新读取完整线程快照，再从快照高水位与首个保留序号前一位中的较大值继续订阅。当前版本尚未主动裁剪事件，但该检查同时覆盖数据库恢复或未来保留策略造成的窗口变化。
- 正文消息可以完整分页；过程事件只是辅助时间线，达到上限时返回截断标记。

1. **加性兼容**：新增 event_type 不破坏老客户端。Switch 用 fall-through default 忽略未知 type。
2. **窄 schema**：不暴露 LangGraph 内部类（`AIMessageChunk` / `StateGraph` / ...）；payload 字段都是普通 JSON 标量 + 字典。
3. **Persist + stream 同源**：每条业务 SSE 事件同时写 `local_events` 表，重连可重放完整事件序列；等待和终态事件与运行状态在同一事务提交，提交后才通知实时订阅者；`[DONE]` 是传输层结束标记，不写库。
4. **失败可观测**：`run.failed` 一定带 `error` + `type`，并尽量附带 `category` / `recoverable` / `retryable` / `action_kind` / `suggested_action`，让事件流消费者无需再请求 diagnostics 也能先判断是重试、用户处理、修复、运维处理还是继续排查；客户端普通失败文案会保留原始错误并追加本地化的短策略标签；`tool.failed` 一定带 `content` + `status="error"`，结构化工具 envelope 失败还会尽量带 `error_code` / `recoverable` / `retryable`；用户触发的 repair run 另有 `repair.workflow`，避免 UI 把修复尝试误读成普通 retry 或裸露内部事件名。
5. **HITL 双轨**：`run.waiting` 是兜底（curl 友好），`permission.required` / `question.asked` 是窄信号 — UI 永远听窄的；同一 pause 批次内的多张 permission 卡必须全部 resolved 后才 resume。

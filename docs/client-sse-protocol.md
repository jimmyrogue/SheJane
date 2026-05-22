# Client ⇄ local-host SSE 协议

适用于 `GET /local/v1/runs/{run_id}/stream`（`Content-Type: text/event-stream`）。

> **文档版本**：post-Phase-5'+，对应客户端 `parseAgentSSEBuffer`（`client/src/shared/api/sse.ts`）+ daemon `RunCoordinator.stream` + `event_translator.translate`。
>
> **历史**：Phase 4' 之前使用 `llm.token` / `tool.end` 等命名，且 `data:` 体直接放裸 payload；2026-05-22 重写后改为 `llm.delta` / `tool.completed` + AgentRunEvent envelope。如果你看到代码里还有旧名，那是漂移，请按本协议为准。

---

## Wire 格式

每条事件如下：

```
event: <event_type>
data: <JSON object — AgentRunEvent envelope>

```

**关键点**：
- `event:` 行只是装饰（给 `curl -N` 看的）。**客户端只读 `data:` 里 JSON 的 `event_type` 字段** —— `parseAgentSSEChunk` 在 `sse.ts:58-72` 完全不解析 `event:` 行。
- 帧之间用 **LF** 双换行分隔（`\n\n`）。daemon 用 sse-starlette 的 `sep="\n"` 覆盖了默认的 `\r\n`，因为客户端的 `split(/\n\n/)` 不匹配 CRLF。
- 终止信号是单独一行 `data: [DONE]`（没有 `event:`）。客户端识别到 `[DONE]` 后才会 resolve stream Promise。`event: stream.end` 已**废弃**。

## AgentRunEvent envelope

```ts
interface AgentRunEvent {
  event_type: string                       // 必填 — UI switch 入口
  payload?: Record<string, unknown>        // 事件特定 payload
  id?: string                              // dedupe 用，evt_<hex>
  run_id?: string
  seq?: number                             // 同 run 内单调递增
  created_at?: string                      // ISO8601
}
```

事件持久化在 `local_events` 表，每条都有完整 envelope；replay 路径（daemon 重启或 stream 重连后）同样发完整 envelope。

完整 TS 类型见 `client/src/shared/api/sse.ts:6-13`。

---

## 事件类型

### 生命周期

| event_type | 触发时机 | payload 关键字段 |
|---|---|---|
| `run.started` | run 进入 `running` 状态 | `goal` |
| `run.resumed` | resume_run 后第一个 frame | `payload`（resume 时传入的 dict） |
| `run.waiting` | 卡在 HITL interrupt（**通常伴随 `permission.required` 或 `question.asked`**，UI 优先听后者） | `next`, `interrupts` |
| `run.completed` | 终态 completed | `final_text` |
| `run.failed` | 终态 failed | `error`, `type` |
| `run.canceled` | 终态 canceled | _(空)_ |

### LLM 流

| event_type | 触发时机 | payload |
|---|---|---|
| `llm.delta` | 每个 streamed token（assistant content） | `content: string` |
| `llm.reasoning` | DeepSeek-style thinking-mode chunk | `content: string` |
| `llm.tool_call_chunk` | 工具调用 args 的部分 JSON 流 | `id, name, args_delta, index` |
| `llm.error` | 流中报错（非致命） | `message` |

### 工具

| event_type | 触发时机 | payload |
|---|---|---|
| `tool.completed` | 一次工具调用完成 | `tool_call_id, name, tool, content, status: "ok"` |
| `tool.failed` | 工具完成但 ToolMessage.status == "error" | `tool_call_id, name, tool, content, status: "error"` |
| `subagent.spawned` | deepagents `task` 子代理被派遣 | `id, args_delta, index` |
| `subagent.completed` | 子代理完成 | `tool_call_id, name, content` |

### 人在回路（HITL）

| event_type | 触发时机 | payload |
|---|---|---|
| `permission.required` | HITL middleware 拦到一个 destructive 工具 | `request_id, tool, tool_name, arguments, description` |
| `permission.resolved` | `POST /local/v1/permissions/:id` 成功后立刻发 | `request_id, tool, tool_name, decision, scope` |
| `permission.auto_approved` | 同 run 内之前授权过 `scope=run`，本次跳过提示 | `tool, tool_name, arguments` |
| `question.asked` | `user.ask` 工具触发 interrupt | `request_id, questions: [{question, options, id}]` |
| `question.answered` | `POST /local/v1/questions/:id` 成功后 | `request_id, answers` |

### 中间件 / 框架内部

| event_type | 触发时机 | payload |
|---|---|---|
| `graph.node` | LangGraph 节点状态更新（中间件 before/after hooks） | `node, delta` |
| `agent.custom` | middleware 通过 `get_stream_writer()` 推送 | _(任意)_ |

> ⚠️ `graph.node` 量大但客户端 UI 通常不需要 —— 用作 LangSmith / 诊断面板的素材。`chatStore.ts` 默认忽略。

---

## 客户端消费骨架

```ts
import { parseAgentSSEBuffer } from '@/shared/api/sse'

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
      case 'permission.auto_approved':
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
          creditsCost: payload.credits_cost,
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
| `POST /local/v1/runs` | `{goal, history?, settings?, ...}` | 创建后开 stream → `run.started` |
| `GET /local/v1/runs/:id/stream` | — | （本协议） |
| `POST /local/v1/runs/:id/cancel` | _(空)_ | 当前 stream 收到 `run.canceled` |
| `POST /local/v1/permissions/:id` | `{decision: "approve"\|"deny", scope?: "once"\|"run"}` | `permission.resolved` + `run.resumed` |
| `POST /local/v1/questions/:id` | `{answers: {<question_id>: [text]}}` | `question.answered` + `run.resumed` |
| `POST /local/v1/session` | `{cloud_base_url, access_token}` | _(无 SSE)_ — 设置 daemon 的云端会话 |

权限批准的 happy path：

```
[user types] → POST /runs (id=R)
   GET /runs/R/stream
   → run.started
   → llm.reasoning / llm.delta...
   → permission.required {request_id: P, tool: "write_file", args: {...}}
   → run.waiting
   → [DONE]   ← stream 暂时关闭

[user clicks Approve "always"] → POST /permissions/P {decision: "approve", scope: "run"}
   (daemon: grant_tool_scope, resume_run)
   GET /runs/R/stream  ← 客户端重新订阅
   → permission.resolved {request_id: P, decision: "approve", scope: "run"}
   → run.resumed
   → tool.completed {tool: "write_file", content: "..."}
   → llm.delta...
   → run.completed
   → [DONE]
```

后续 turn 再触发同一个 tool 时：

```
   → llm.tool_call_chunk
   → permission.auto_approved {tool: "write_file"}   ← 跳过用户提示
   → tool.completed
   → ...
```

---

## 设计原则

1. **加性兼容**：新增 event_type 不破坏老客户端。Switch 用 fall-through default 忽略未知 type。
2. **窄 schema**：不暴露 LangGraph 内部类（`AIMessageChunk` / `StateGraph` / ...）；payload 字段都是普通 JSON 标量 + 字典。
3. **Persist + stream 同源**：每条 SSE 事件同时写 `local_events` 表，重连可重放完整序列（含 `[DONE]` sentinel）。
4. **失败可观测**：`run.failed` 一定带 `error` + `type`；`tool.failed` 一定带 `content` + `status="error"`。
5. **HITL 双轨**：`run.waiting` 是兜底（curl 友好），`permission.required` / `question.asked` 是窄信号 — UI 永远听窄的。

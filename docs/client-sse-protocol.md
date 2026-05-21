# Client ⇄ local-host SSE 协议（Phase 4'）

适用于 `GET /local/v1/runs/{run_id}/stream` 返回的 `text/event-stream`。
所有事件**格式统一**：

```
event: <name>
data: <JSON object>
```

终止：服务器写入 `event: stream.end\ndata: {}` 后关闭连接。

> 旧客户端无需改造也能消费——未知 `event` 类型直接忽略即可。本协议
> **加性兼容**，不会删除或重命名既有事件类型。

---

## 事件类型一览

| 事件名 | 触发时机 | 关键字段 |
|---|---|---|
| `run.started` | run 进入 running 状态 | `goal` |
| `run.resumed` | resume 后立即 | `payload` |
| `run.waiting` | 卡在 HumanInTheLoop interrupt | `next`, `interrupts` |
| `run.completed` | 终态 completed | `final_text` |
| `run.failed` | 终态 failed | `error`, `type` |
| `run.canceled` | 终态 canceled | _(空)_ |
| `llm.token` | LLM 流式生成 1 个 token | `content` |
| `llm.reasoning` | DeepSeek-style 推理 token | `content` |
| `llm.tool_call_chunk` | 工具调用参数 JSON 增量 | `id`, `name`, `args_delta`, `index` |
| `llm.error` | 后端在流中报错（非致命） | `message` |
| `tool.end` | 一次工具调用完成 | `tool_call_id`, `name`, `content` |
| `graph.node` | 图节点 / 中间件状态更新 | `node`, `delta` |
| `agent.custom` | 自定义 middleware 用 `get_stream_writer()` 推送 | _(任意)_ |
| `stream.end` | 流结束 sentinel | _(空)_ |

---

## 客户端渲染建议

### Streaming 聊天气泡

```js
const es = new EventSource(`/local/v1/runs/${runId}/stream`, { withCredentials: false });
let assistantText = "";

es.addEventListener("llm.token", (e) => {
  const { content } = JSON.parse(e.data);
  assistantText += content;
  render(assistantText);   // 累积渲染
});

es.addEventListener("llm.reasoning", (e) => {
  const { content } = JSON.parse(e.data);
  appendReasoningPanel(content);
});

es.addEventListener("llm.tool_call_chunk", (e) => {
  const { id, name, args_delta } = JSON.parse(e.data);
  showToolCallProgress(id, name, args_delta);   // 工具调用面板
});

es.addEventListener("tool.end", (e) => {
  const { tool_call_id, name, content } = JSON.parse(e.data);
  completeToolCallCard(tool_call_id, name, content);
});

es.addEventListener("run.completed", (e) => {
  const { final_text } = JSON.parse(e.data);
  finalize(final_text);
  es.close();
});

es.addEventListener("run.failed", (e) => {
  const { error } = JSON.parse(e.data);
  showError(error);
  es.close();
});

es.addEventListener("stream.end", () => es.close());
```

### 人在回路（permission interrupt）

当收到 `run.waiting`，客户端展示用户决策 UI（approve / deny / once-vs-run-scope），然后：

```
POST /local/v1/runs/{run_id}/resume
{
  "action": "approve"   // 或 "deny"，自定义 schema
}
```

服务器恢复 graph 后会再次推送 `run.resumed`，然后继续 `llm.token` / `tool.end` 等。

### 取消

```
POST /local/v1/runs/{run_id}/cancel
```

→ 服务器 `task.cancel()` 触发 `asyncio.CancelledError`，graph 中断后 SSE 流推 `run.canceled` 收尾。客户端关 EventSource 即可。

---

## Phase 4' 实测延迟

TestClient + httpx.MockTransport 量化（mac arm64）：

```
samples = [24.1ms, 24.8ms, 24.8ms, 25.3ms, 26.6ms]
p50     = 24.8ms
max     = 26.6ms
```

目标：p50 < 50ms，p95 < 200ms。**当前完成度：p50 余量 2x**。

注意：TestClient 自带 thread+eventloop 开销；真 uvicorn + 真客户端套接字的数字通常更低（5–10ms p50 是常见基线）。Phase 5' 切到 Electron 时会跑同样的基准在真实链路上。

---

## 字段示例

### `llm.token`

```json
{ "content": "你好" }
```

或带空白：

```json
{ "content": " " }
```

### `llm.tool_call_chunk`

部分 JSON 流（多个 chunk 拼成最终 args）：

```json
{ "id": "call_abc", "name": "fs.read", "args_delta": "{\"path\":", "index": 0 }
```

```json
{ "id": "call_abc", "name": null, "args_delta": " \"/tmp/x\"}", "index": 0 }
```

### `tool.end`

```json
{
  "tool_call_id": "call_abc",
  "name": "fs.read",
  "content": "file contents here..."
}
```

### `run.waiting`

```json
{
  "next": ["tools"],
  "interrupts": [
    {
      "id": "<langgraph interrupt id>",
      "value": {
        "kind": "permission",
        "tool_name": "shell.run",
        "tool_args": { "cmd": "rm -rf ..." }
      }
    }
  ]
}
```

### `run.completed`

```json
{ "final_text": "Done. The file has been written." }
```

### `agent.custom`

任意 dict，由 middleware 通过 `get_stream_writer()` 推送：

```json
{ "phase": "planning", "step": 2, "subtask": "fetch sources" }
```

---

## 设计原则

1. **加性兼容**：只新增事件类型，不删不改。
2. **窄字段，少 LangGraph 内部**：客户端不需要懂 `StateGraph` 或 `AIMessageChunk`。
3. **persist + stream 同源**：每个 SSE 事件同时 `store.append_event` 持久化，重连可重放。
4. **失败可观测**：`run.failed` 一定带 `error` + `type`，`llm.error` 在流中不致命。

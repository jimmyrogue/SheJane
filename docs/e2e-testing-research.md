# SheJane 强健 E2E 测试研究

> 研究日期：2026-07-18
>
> 范围：Electron/React Client、FastAPI/LangGraph Runtime、Runtime SDK、内置 Tool、MCP、Plugin/Managed Worker、SSE 与持久恢复。
>
> 本文只定义测试策略和可执行增量，不把尚未实现的测试描述成现有能力。现状以 [`runtime-e2e-testing.md`](runtime-e2e-testing.md)、[`run-loop.md`](run-loop.md) 和当前测试代码为准。

## 运行时阶段定位

```text
主要阶段：P10 工具执行或等待用户
上游输入：P9 产生的已验证 Tool 批次、最终候选或失败
下游输出：P11 消费的 Tool Receipt、等待候选和静止执行结果
状态所有者：Runtime 的 Tool Receipt 与等待候选；Client 只持有投影
替换的当前路径：不替换产品路径；扩展 scripts/test-contract.sh 驱动的公开 HTTP/SSE E2E 证据
```

本研究同时审计 P1-P12，但只把 P10 作为主要阶段。P4 的 SSE、P7 的 checkpoint/resume 和 P11-P12 的恢复/提交是必须联测的跨阶段边界。

## 结论

“完整”不能定义为覆盖所有自然语言输入，那是不可穷举的。SheJane 可以得到一个严格、可审计的完成定义：

1. 每个公开 P1-P12 状态转换至少有一个从公开边界观察到的成功或失败证据。
2. 每个公开 Tool 都进入清单门禁，并按它的能力特征覆盖适用的边缘矩阵；不适用项必须明确写出原因。
3. Tool 不只证明“被调用过”，还要证明权限、参数、作用域、副作用、错误回传、取消、重启和最终投影彼此一致。
4. PR 套件完全确定、无真实供应商网络；进程故障与有限网络扰动进入独立的 resilience 套件；真实 BYOK/第三方服务只做发布前 smoke。
5. 失败必须留下能复现的 Runtime 日志、SSE 事件记录、Playwright trace 和隔离目录，而不是只留下通过率。

这比追求一个代码覆盖率百分比更接近用户手工操作时遇到的真实故障。

## 当前基线：已经做对的部分

- [`scripts/test-contract.sh`](../scripts/test-contract.sh) 会以临时 HOME、临时数据目录、固定 fake LLM 和真实 TCP 端口启动 Runtime；这是真进程黑盒测试，不是 FastAPI `TestClient`。FastAPI 官方也提醒，HTTPX `ASGITransport` 不会自动触发生命周期事件，因此进程级测试仍然不可替代：[FastAPI async tests](https://fastapi.tiangolo.com/advanced/async-tests/)、[HTTPX ASGI transport](https://www.python-httpx.org/advanced/transports/#asgi-transport)。
- [`runtime-tools.contract.test.ts`](../client/src/runtime/runtime-tools.contract.test.ts) 已经把 `/v1/tools` 与已执行 Tool 列表做反向相等检查。新增公开 Tool 没有 E2E 路径时会失败；这条 inventory gate 应保留。
- [`runtime-agent.contract.test.ts`](../client/src/runtime/runtime-agent.contract.test.ts) 已经纵向覆盖附件、Skill、Subagent、Todo、一次权限批准、一次结构化问答和运行中取消。
- [`client.contract.test.ts`](../client/src/runtime/client.contract.test.ts) 已经检查命令幂等冲突、SSE envelope、durable cursor replay 和错误形状。
- [`test-packaged-client-runtime.mjs`](../scripts/test-packaged-client-runtime.mjs) 已经验证 macOS/Windows 打包应用能拉起 Runtime、交付 loopback token 并在退出时关闭子进程；macOS arm64 还先由包内冻结 Runtime 对 VM manifest 和全部资产做生产 preflight，避免“路径注入成功但资产 schema 已过期”的假绿。
- 2026-07-18 本轮已把 Tool inventory 扩展为 `family/effect/risk/traits/outcome` 可执行门禁，补齐 edit/stale/multi-decision、Unicode/symlink/大 Artifact、真实 MCP failure/crash/reconciliation/reconfigure 和真实 WASI install-to-artifact。
- 同轮已增加 Runtime SIGKILL 后从持久 permission wait 恢复且副作用恰好一次、首个 `llm.delta` 后 SIGKILL 并安全收敛到 `cleanup_required`、SSE 细碎分帧/断线游标恢复/并发订阅/超过 1 MiB burst 的暂停读取恢复，以及 13 条真实 Electron 路径（聊天与重启持久、SSE half-close 后无刷新续流、approve、deny、`user.ask`、瞬态失败后 retry 成功且用户消息不重复、validation 失败后从 CTA 启动 repair Run 并显示完成步骤、HTTPS Markdown 外链通过 Main allowlist 且危险协议/OS 错误被包含、真实 OS clipboard 写入与拒绝、真实 PPTX 的授权/文件按钮/Runtime outline/系统打开与权限错误、workspace 失败 CTA 选择目录后自动 retry、等待期间从设置页关闭子代理并验证旧/新 Run 的配置冻结边界、可见 active run 中 Runtime SIGKILL 后无需重载主动显示离线、诊断 JSON 真下载、从同一 data dir 重启、窗口投影收敛并继续新任务）。窗口门禁还实际捕获并修复了 `user.ask` 刚显示时点击过快、持久投影未追上可见投影而静默丢失回答的竞态。
- Tool trait matrix 现在会真实制造 `execute` timeout 和 cancel：旧实现留下的两个孤儿 `sleep` 进程先使 E2E 失败，Runtime 改用独立异步进程组后，两条路径都在提交终态前确认完整命令树已回收；非零退出还验证 workspace cwd、stdout、stderr 标签和 exit code 没有丢失。
- 官方 `@modelcontextprotocol/conformance` 已固定为 `0.1.16`，通过生产 MCP supervisor 验证 `initialize`、`tools_call` 和 `sse-retry`，包括规范 retry 时序与 `Last-Event-ID`，不使用 expected-failures baseline。当前精确范围以 [`runtime-e2e-testing.md`](runtime-e2e-testing.md) 为准。
- 真实 WASI fixture 现会先返回 guest 结构化失败，再用合法 7 MiB 高压缩输入与 100 ms fuel 预算确定性触发 Wasmtime trap；两者都必须结算为 `tool.failed`、Run 继续且零错误 Artifact，随后健康调用仍成功并产生 Artifact。测试先后发现并修复了 `PluginActionError` 直接导致 `run.failed`、原生 Wasmtime trap 击穿 Agent loop，以及异常归一化分支缺失导入三个 P10 组合缺陷。
- MCP 配置漂移 E2E 实际发现了“等待批准时删除并重建 server，旧批准会静默执行新 server”的 P10 身份缺陷。MCP Tool version 现在绑定非秘密配置 fingerprint；旧 receipt 与新实现不一致时 Run 以 `tool_receipt_conflict` 安全失效且零 Tool 副作用，新 Run 才能使用新配置。Plugin 也已用 v1 等待审批、期间更新到新增拒绝 capability 的 v2、旧 Run 成功且新 Run 失败，证明接纳版本冻结。Skill 现在绑定完整发现树内容指纹：旧 Run 等待期间变更后在 Tool 执行前安全失败，新 Run 使用新版本，checkpoint fork 仍继承源 Run 绑定。Client 可见配置冻结也已补齐：旧 Run 完成子代理，新 Run 禁止 `task`；该场景实际发现并修复了关闭开关后默认 `general-purpose` 子代理仍可用的问题。
- stdio MCP fixture 现在以真实 opaque cursor 证明完整分页发现，以 structured output 与单调 progress 证明扩展结果/通知投影，并在首个 progress 后取消 Run，验证旧 PID 被回收、新 session 自动建立且旧调用保持 `outcome_unknown`；crash/timeout 与 Streamable HTTP session 404 仍分别证明 reconciliation 和重新 initialize 边界。
- 真实 Runtime kill-point 现在会在 `execute` 写出一次副作用且 durable receipt 为 running 后 SIGKILL 进程；复用同一 data dir 重启，等待真实租约过期，断言 `run.cleanup_required`、`execution_lease_expired`、`outcome_unknown`、attempt 1 和副作用仍恰好一次。它补的是关键提交窗口，不是普通“重启后还能用”。
- 模型 in-flight kill-point 会在收到首个临时 `llm.delta` 后 SIGKILL，按最后 durable cursor 重连；Runtime 不重放未知模型调用，而是以唯一 `run.cleanup_required` 收敛，且 seq 单调无重复、无假 completed/failed、无 Tool receipt，diagnostics 与 thread snapshot 状态一致。Electron 同时从可见“正在思考”状态制造崩溃，并验证窗口无重载收敛到同一隔离结果。
- SDK black-box 现在通过真实 TCP 代理分别制造 SSE 帧中途 half-close 与 RST，断言 incomplete/error、精确 cursor replay、seq 单调无重复和唯一终态；Electron 也通过代理主动 half-close 一次，并证明页面不重载即可自动续流。该测试实际复现并修复了 Client 忽略 `completed:false`、永久停在旧批准栏的缺陷。
- 真实 WASI package 另有一个请求 `network.http` 的变体；从公开命令安装/启用到 Agent Tool 调用完整验证结构化 `capability_denied`、failed receipt、Run 继续和零 Artifact，而不是只测 manifest parser。
- 原生 macOS arm64 packaged gate 实际发现旧 `build/vm-assets-arm64` 缺少当前 schema 必需的 `rootfs`，而旧 smoke 仍然绿色。Runtime 现在提供只校验并退出的 VM asset preflight，packaged smoke 必须先通过包内 Runtime 的 schema/架构/asset-set ID/逐文件摘要与权限校验。本轮按 lock 重建 rootfs 与 VM 资产后，当前源码 unsigned `--dir` 包通过 lifecycle，VM 的 14 个模式全部通过，其中包括 worker crash、Runtime `SIGKILL` 和 launcher `SIGKILL` 后 staging lease 回收。

这些是应当扩展的骨架，不需要另建一套重复 harness。

## 当前主要缺口

### 1. Client 用户关键路径已进入真实窗口门禁

当前 `make test-e2e` 已通过 Playwright 启动真实 Electron，并覆盖 13 条关键路径：启动/聊天/重启持久、SSE 断线续传、Tool approve/deny、`user.ask`、retry/repair CTA、外链 allowlist、系统 clipboard、真实 PPTX、workspace 恢复、设置冻结，以及 Runtime 真实进程崩溃后无需窗口重载即主动呈现离线、同 data dir 重启后恢复在线和新任务。该 crash 流程同时断言被杀 PID 就是真实 health endpoint 所有者，避免只杀启动包装进程形成假故障；它还实际发现并修复了旧 Run 进入 `cleanup_required` 后全局发送状态仍把新对话锁成“停止生成”的跨 thread 泄漏。真实 quit 后的 bundled Runtime 清理由 packaged smoke 负责：它触发应用正常 quit、等待 Client 退出，再等待 runtime PID 消失；不在开发态外接 Runtime 的窗口套件重复一个更弱版本。

Playwright 官方提供 Electron 启动、首窗口等待、Main process `evaluate` 和普通 Page 自动化，但仍标记为 experimental，应以一个很薄的 SheJane fixture 封装，不扩散 `_electron` 调用：[Playwright Electron API](https://playwright.dev/docs/api/class-electron)、[ElectronApplication API](https://playwright.dev/docs/api/class-electronapplication)。

### 2. “每个 Tool 调过一次”不等于 Tool 强健

当前 Tool inventory gate 是优秀的第一步，但多数 Tool 只有一个 happy path 或一个预期失败。尤其：

- `execute` 已覆盖 cwd、stdout/stderr、非零退出、超时、取消、完整进程组回收、大输出 Artifact、非法 UTF-8 输出和带空格/单引号路径；同一 workspace 的同路径双写现在还会按模型顺序结算，第一个结果不能被竞态覆盖；
- filesystem 已覆盖 symlink 越界、空文件、Unicode、分页窗口、edit 的零匹配/多匹配和同路径写冲突；仍缺确定性 symlink swap/TOCTOU、只读权限、磁盘/配额不足和超长路径；
- `open.url`、`open.file` 已在隔离系统 handler 中同时覆盖允许路径和危险输入；`web.fetch` 的黑盒链路覆盖 SSRF 拒绝，生产 Tool 集成层覆盖受控成功、真正的流式 2 MB 上限、超长 header 丢弃、303 method 转换、超时和重定向耗尽，真实公网只留给 release/live smoke；
- Office/Plugin Worker 多数证明格式 happy path，没有统一验证超时、worker crash、畸形返回、大结果 artifact 化和重启对账；
- Tool 批次已经覆盖整批审批前零执行、混合决定、部分失败、同路径写冲突串行和 receipt 原始顺序；仍缺能稳定测量的纯只读并行时序与更大批次压力。

MCP 规范把未知 Tool/畸形请求的 protocol error 与可供模型自我修复的 `isError: true` 执行错误明确分开，并要求输入校验、访问控制、超时与审计；测试矩阵也应保留这一区别：[MCP Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)。

### 3. HITL 已覆盖核心决定，恢复竞态仍有空白

公开边界现已覆盖 approve、reject、edit 兼容协议、同批多审批、部分解决后仍等待、重复/冲突决定、`scope=run` 对合格同工具不同参数的有界复用、不可恢复工具拒绝 Run scope，以及等待状态下进程重启。仍缺过期/撤销图版本、迟到决定和恢复期间取消。

LangGraph 的 interrupt 恢复会从发生 interrupt 的 node 开头重新执行；同一 thread ID 才能恢复，并且多 interrupt 的匹配依赖稳定顺序。因此 E2E 必须证明 interrupt 前副作用幂等、resume 不重复执行 Tool、顺序不漂移：[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)。LangGraph 自身的测试同时检查中断后的 `next` 节点与 checkpoint 数量，而不只断言最终文本：[LangGraph interruption tests](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/tests/test_interruption.py)。

### 4. SSE 已覆盖分帧与游标恢复，真实网络压力仍不足

现已覆盖 UTF-8/JSON/SSE 细碎分帧、durable cursor replay、未来 cursor 的稳定 reset、错误 run ID 的稳定 `run_not_found`、客户端主动 abort、订阅者断开后续传、两个并发订阅者、temporary delta 无 cursor、消费者暂停读取期间 Runtime 独立完成、恢复后收到超过 1 MiB 的完整 256-delta burst、唯一 terminal/`[DONE]`，以及 Runtime 在首个 delta 后 SIGKILL/同 data dir 重启并安全收敛。仍缺：

- 在 JSON 半帧、事件分隔符之前、delta 中间、`[DONE]` 前断线；
- 超出持久保留窗口的过旧 cursor；
- terminal 与 `[DONE]` 恰好一次的更多网络故障断点；
- 事件到了但 Client 窗口重载，随后 snapshot 是否收敛到相同结果。

HTTPX 官方的 async streaming API支持按 bytes/text/lines 消费，且明确要求正确关闭 response，适合做断开与资源泄漏断言：[HTTPX async streaming](https://www.python-httpx.org/async/#streaming-responses)。LangGraph 的 v3 E2E 同时检查投影、事件顺序、单调序号、interrupt flags 与 partial state，是比“最终收到 done”更完整的范例：[LangGraph streaming E2E](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/tests/test_stream_events_v3_e2e.py)。

优秀 agent 项目还会把协议正确性与负载证明放在同一个测试里：OpenHands 分别覆盖 reconnect storm 后的连接泄漏、慢消费者和高容量 shell 输出，测试不会因为服务提前断开而“假通过”：[reconnect storm](https://github.com/OpenHands/software-agent-sdk/blob/4fe565663af2b4f1130a6e0dac7566b002bfe9b4/tests/agent_server/stress/test_websocket_reconnect_storm.py)、[slow consumer](https://github.com/OpenHands/software-agent-sdk/blob/4fe565663af2b4f1130a6e0dac7566b002bfe9b4/tests/agent_server/stress/test_slow_websocket_consumer.py)、[high-volume bash output](https://github.com/OpenHands/software-agent-sdk/blob/4fe565663af2b4f1130a6e0dac7566b002bfe9b4/tests/agent_server/stress/test_high_volume_bash_output.py)。SheJane 的 SSE resilience 测试也应同时断言“负载真的到达”和“Runtime 仍响应 health/snapshot”。

### 5. recovery 已跨进程，提交边界仍需继续扩展

当前已真正杀掉 Runtime 并覆盖 permission wait、Tool 外部副作用已发生但 receipt 未完成、首个模型 delta 已发出，以及 packaged VM 的 worker/Runtime/launcher crash。仍应继续增加以下命名杀点：

- command 已接纳但 job 未领取、lease 已领取但模型未输出；
- waiting candidate 已提交、用户决定接纳期间；
- cleanup 开始/结束与 terminal commit 前后。

重启后必须从公开 API 证明：没有重复副作用、旧 lease 不能提交、结果不明确进入 reconcile、SSE 可从 durable cursor 继续、thread snapshot 与 terminal event 一致。

LangGraph persistence 的目标正是从最后成功 checkpoint 恢复，并保留同一 super-step 中其他成功节点的 pending writes；测试必须验证“哪些工作没有重跑”，而非只验证最后成功：[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)。其 fault-tolerance 还区分 retryable 异常、attempt 计数、超时、重试耗尽与 resume-safe failure provenance，适合直接映射到 SheJane 的 `retryable/action_kind/recovery_action`：[LangGraph fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance)。

### 6. MCP 核心 client conformance 已接入，扩展协议边缘仍不足

当前已有 stdio opaque cursor 分页 catalog/search、echo、structured output、参数 schema 在进入 server 前失败、`isError`/执行异常、单调 progress、首个 progress 后 Run cancel、真实阻塞 Tool 超时后的 outcome-unknown reconciliation、进程崩溃后的 outcome-unknown reconciliation 与同配置自动新 PID；cancel、timeout 和 crash 都证明旧 session/进程被回收。Streamable HTTP 还覆盖 session 404、重新 initialize 和新 Run 恢复。官方 conformance runner 会启动规范场景 server，并通过生产 `_MCPServerSupervisor` 完成 `initialize`、`tools/list`、`tools/call` 与断流后的 SSE retry；三个已选场景均无未登记失败或 warning，也没有 baseline。至少仍缺：

- initialize 版本/能力不兼容、超时、stderr 噪声、stdout 非 JSON；
- 空 catalog、`tools/list_changed`、同名 Tool 冲突、多 server；
- 无效 JSON Schema、未知 Tool、protocol error；
- timeout/cancel 同时到达的竞态；
- image/audio/resource link、大结果；
- stdio 进程优雅退出、SIGTERM 超时后 SIGKILL、孤儿进程；
- Streamable HTTP 的连接 reset/half-close、连续 session 失效和服务端不可恢复错误。

这些不是任意扩张。MCP 规范明确规定 `tools/list` pagination 与 `listChanged`、progress token 的唯一性与单调性、取消竞态、请求 timeout 和 stdio shutdown 顺序：[Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)、[Cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)、[Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)。

官方 MCP conformance runner 能启动场景 server、捕获协议交互并按规范校验，还提供“已知失败必须失败、已修复后 baseline 也必须删除”的严格 baseline 语义：[MCP conformance framework](https://github.com/modelcontextprotocol/conformance)、[SDK integration guide](https://github.com/modelcontextprotocol/conformance/blob/main/SDK_INTEGRATION.md)。SheJane 已复用该 runner 检查核心 MCP client 和 `sse-retry` 边界；后续只应按实际声明能力扩展新的官方场景，不自行重写协议一致性套件，也不把 auth/elicitation 未声明能力伪装成通过。

### 7. Plugin 已有 WASI 纵向流，隔离与 Managed Worker 仍不足

当前真实 `.shejane-plugin` fixture 已覆盖打包、导入、启用、Tool 暴露、capability 拒绝、guest 结构化失败、确定性 fuel trap、failed receipt、错误调用零 Artifact、失败后的健康 Agent 执行、Artifact 读取、审批等待期间版本冻结和删除。manifest/schema/digest 的罕见拒绝分支继续由内部集成测试覆盖；公共黑盒仍需补 Managed Worker crash、平台资源恢复和 release-gated packaged roundtrip。WASI 与 Managed Worker 应共享相同语义断言，只把平台 confinement 分到 OS-specific 套件。

不需要把所有格式测试复制到 E2E。每个 Plugin Action 保留一个小型真实 fixture，证明 Runtime 绑定、隔离、receipt 和 artifact 边界；复杂解析/渲染组合继续留在 worker integration tests。

WASI fixture 还应覆盖无 capability 时的文件/网络/env 拒绝、`..` 与 symlink 逃逸、缺失 export/错误 ABI、trap、无限循环、host call 大内存分配、超大输出，以及失败后 Runtime 仍能执行下一个健康 Plugin。Wasmtime 的 WASI 模型以预打开目录授予能力，fuel/epoch deadline 用于中断失控 guest，`Store` 还提供 fuel、epoch deadline 和 host-call allocation 限制：[WASI tutorial](https://github.com/bytecodealliance/wasmtime/blob/main/docs/WASI-tutorial.md)、[interrupting Wasm](https://docs.wasmtime.dev/examples-interrupting-wasm.html)、[Wasmtime Store](https://docs.rs/wasmtime/latest/wasmtime/struct.Store.html)。这些隔离断言不能因为“每个 Action 已有一个 happy path”而省略。

## 目标测试分层

| 层 | 真实边界 | 负责发现 | 不负责 |
|---|---|---|---|
| unit | 单函数/单组件 | 参数校验、纯转换、UI 小状态 | 进程、HTTP、真实 Tool |
| integration | FastAPI/LangGraph/store/worker 进程内或单子系统 | 故障注入、罕见内部 branch、数据库迁移 | Client 用户流程 |
| Runtime black-box E2E | 真实 Runtime 进程 + 公共 HTTP/SSE + SDK | P1-P12 协议、Tool/HITL/恢复、持久状态 | Renderer 可用性 |
| Client E2E | Electron Main + Renderer + 真实 Runtime | 用户能否完成聊天、审批、问答、失败恢复、设置 | 第三方互联网可靠性 |
| packaged smoke | 安装/打包产物 | 资源打包、签名后启动、子进程生命周期、OS 集成 | 全量行为矩阵 |
| live provider smoke | 真实 BYOK/第三方 MCP，受控账号 | 上游 API/凭据/供应商兼容 | PR 回归门禁 |

只在边界恰好匹配时使用 mock。FastAPI/HTTPX 官方把 `MockTransport` 定义为返回预设响应的 transport；它适合外部服务适配器测试，不应算作 SheJane Runtime black-box E2E：[HTTPX MockTransport](https://www.python-httpx.org/advanced/transports/#mock-transports)。

## 分类与命名

不要再维护一份手写“覆盖率数字”。分类直接进入测试收集结果，并允许按两个主轴过滤。

### 主轴 A：流程

```text
flow_p1_connection
flow_p2_command
flow_p3_acceptance
flow_p4_snapshot_stream
flow_p5_lease
flow_p6_binding
flow_p7_resume
flow_p8_model_turn
flow_p9_routing
flow_p10_tool_hitl
flow_p11_cleanup
flow_p12_commit_projection
```

### 主轴 B：能力/Tool family

```text
tool_filesystem   tool_shell       tool_web_open
tool_memory       tool_office      tool_subagent
tool_mcp          tool_plugin      tool_attachment
tool_clipboard    tool_scheduler   tool_question
```

### 辅助标签

```text
tier_pr / tier_resilience / tier_packaged / tier_live
fault_disconnect / fault_timeout / fault_crash / fault_corruption
risk_read / risk_write / risk_external / risk_destructive
os_linux / os_macos / os_windows
```

pytest 原生支持 custom marker、`-m` 过滤与 parametrization；Playwright 原生支持 group、tag 与 `--grep`：[pytest markers](https://docs.pytest.org/en/latest/how-to/mark.html)、[pytest parametrization](https://docs.pytest.org/en/stable/example/parametrize.html)、[Playwright annotations/tags](https://playwright.dev/docs/test-annotations)。

建议稳定测试 ID 同时表达流程和场景，例如：

```text
FLOW.P10.HITL.approve_once
FLOW.P7.P10.permission_resume_after_restart
TOOL.filesystem.write_file.symlink_escape_denied
TOOL.shell.execute.cancel_kills_process_tree
MCP.tools_call.execution_error_reaches_model
SSE.disconnect_after_partial_frame.replays_once
PLUGIN.managed_worker.crash_requires_reconcile
```

目录只按拥有 fixture/lifecycle 的边界拆分，不为每个标签再造目录：

```text
client/e2e/                 # Playwright Electron 用户流程
client/src/**.contract.test.ts  # 现有 Runtime SDK 黑盒测试
runtime/tests/           # 进程内 integration/fault policy
runtime/tests/fixtures/  # fake LLM、MCP、Plugin/Worker 故障 fixture
```

## 每个 Tool 的最低行为矩阵

inventory gate 对每个 Tool 至少要求一条适用的 case；以下列按 Tool traits 自动适用，不要求无意义地笛卡尔积爆炸。

| 维度 | 所有 Tool | 有副作用 Tool | 长时 Tool | 外部/MCP/Plugin | filesystem/shell |
|---|---:|---:|---:|---:|---:|
| 成功与结果 schema | 必须 | 必须 | 必须 | 必须 | 必须 |
| 缺字段/错类型/多余字段/边界值 | 必须 | 必须 | 必须 | 必须 | 必须 |
| Tool 不存在或版本漂移 | 必须 | 必须 | 必须 | 必须 | 必须 |
| approve/reject/edit | 依风险 | 必须 | 依风险 | 必须 | 必须 |
| 相同 operation 幂等重放 | 依能力 | 必须 | 必须 | 必须 | 必须 |
| timeout/cancel/resource cleanup | 依能力 | 依能力 | 必须 | 必须 | 必须 |
| transient retry / permanent no-retry | 依能力 | 谨慎 | 必须 | 必须 | 依能力 |
| crash 后 completed/unknown/reconcile | 依能力 | 必须 | 必须 | 必须 | 必须 |
| 大结果/Unicode/空结果 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 并发顺序与冲突 | 依能力 | 必须 | 必须 | 必须 | 必须 |
| workspace/secret/network 边界 | 依能力 | 必须 | 依能力 | 必须 | 必须 |

“依能力”必须在 case 表中写 `not_applicable` 的稳定原因，不能默默缺失。

### 文件与 shell 的必测边缘集合

- 路径：根目录、`..`、绝对路径、symlink 指向 workspace 外、symlink swap、Unicode/空格、超长路径、不存在父目录、文件与目录类型混淆。
- 内容：空、只换行、UTF-8、无效字节、超大输出、分页边界、old string 出现 0/1/多次。
- 资源：只读文件、无权限、磁盘/配额不足、进程树、stdout/stderr 同时大量写、timeout、cancel、非零退出、signal exit。
- 副作用：permission 前绝不发生；approve 后恰好一次；reject 后为零；崩溃后不能盲重试；最终 receipt 与磁盘事实一致。

### Web/browser-like Tool 的必测边缘集合

- URL scheme、loopback/private/link-local、DNS rebinding、redirect 到私网、credential in URL、超大/无限 body、错误 MIME/charset、gzip bomb、超时与取消。
- 成功路径只访问测试进程启动的受控 HTTP server；第三方网站必须 route/stub。Playwright 官方也建议只测试自己控制的系统与数据：[Playwright best practices](https://playwright.dev/docs/best-practices)。
- 若未来提供真正 browser Tool，再加入 popup、download、dialog、新 tab、导航失败、DOM 改变、截图/文件 artifact；不要把 `open.url` 的 shell handoff 伪装成浏览器 E2E。

## 确定性 Agent 驱动

保留 `SHEJANE_FAKE_LLM=1`，但从“prompt 中嵌入一个 Tool 指令”扩展为按 run fixture 排队的多 turn script：

```text
turn 1: emit tool A + tool B
turn 2: observe A success + B execution error, emit corrected B
turn 3: emit final text
```

script 必须能逐 turn 返回：text delta、多个 tool call、无效 JSON arguments、未知 Tool、provider exception、stream 中断、usage、最终文本，并记录 Runtime 实际传入模型的 messages/tools。这样既确定，又能覆盖“错误回给模型后自我修复”。

OpenAI Agents SDK 官方测试的 `FakeModel` 正是维护 `turn_outputs` 队列，允许每回合返回输出或异常，并记录 first/last turn args：[FakeModel source](https://github.com/openai/openai-agents-python/blob/main/tests/fake_model.py)。其 HITL scenario 还断言批准前后 session 中 user/call/output 的数量、call ID 对齐和 Tool 恰好执行一次，而不只断言 final output：[HITL session scenario](https://github.com/openai/openai-agents-python/blob/main/tests/test_hitl_session_scenario.py)。MCP runner tests 把 streaming/non-streaming 参数化，并覆盖缺失 Tool、多 server、命名冲突、参数与执行错误：[MCP runner tests](https://github.com/openai/openai-agents-python/blob/main/tests/mcp/test_runner_calls_mcp.py)。

LangGraph 官方也用 scripted model 驱动完整 `user -> model -> tools -> model -> final` 轨迹，并逐条断言 state/messages，而不是让真实模型碰巧选中工具：[完整 Tool loop 测试](https://github.com/langchain-ai/langgraph/blob/49ae27c2ae983cfb92091b0dea9f7bc37a716479/libs/langgraph/tests/test_large_cases.py#L1263-L1435)。其 ToolNode 测试把错误参数、未知 Tool、异常策略、`GraphInterrupt`、ToolMessage ID、injected state/store 和 UTF-8 分成明确边缘用例：[ToolNode tests](https://github.com/langchain-ai/langgraph/blob/49ae27c2ae983cfb92091b0dea9f7bc37a716479/libs/prebuilt/tests/test_tool_node.py#L269-L1526)。这正是 SheJane Tool trait matrix 应复制的粒度。

不要把真实 LLM 当成 PR E2E oracle。真实模型只验证供应商适配；Tool 选择和流程回归用 scripted model 才可重复。LangChain 官方也建议把会访问网络的 integration tests 与快速单元测试分开，并提供录制/回放和 secret 过滤：[LangChain integration testing](https://docs.langchain.com/oss/python/langchain/test/integration-testing)。

## 故障注入方式

优先在现有 test fixture 加稳定 kill-point，而不是靠随机 sleep 猜时机：

1. Runtime/Tool fixture 在到达命名 kill-point 时写 readiness file/event。
2. 测试等待该信号，再 kill Runtime/MCP/worker。
3. 使用同一 data dir 重启相同版本 Runtime。
4. 只通过 HTTP/SSE 查询恢复结果和副作用。

需要真实 TCP 断包、延迟、reset、half-close 时，独立 resilience job 可使用 Toxiproxy；它专为测试/CI 的确定性 connection tampering 提供 latency、timeout、reset_peer、limit_data 等 toxic：[Shopify Toxiproxy](https://github.com/Shopify/toxiproxy)。PR 主套件不必为了两三个固定断点引入常驻 chaos 服务，先用一个小型受控 test proxy fixture，只有场景增长后再引入 Toxiproxy。

## Client E2E 的最小纵向集合

使用 `@playwright/test` fixture 启动 Electron 和隔离 Runtime；每个测试得到独立 userData/data/workspace。第一批只需要覆盖以下用户关键路径：

1. 启动 -> Runtime online -> 创建 thread -> 发送 -> streaming -> completed -> 重启窗口后消息仍在。
2. Tool permission card -> 检查 Tool/arguments/risk -> reject；另一个测试 approve -> 文件恰好写一次。
3. `user.ask` -> 选择/输入答案 -> resume -> completed。
4. 模型/Tool 失败 -> recovery CTA -> retry/resume/copy diagnostics。
5. SSE 中断 -> UI 显示重连 -> snapshot 收敛，无重复消息。
6. MCP/Skill/Plugin 设置改变 -> 新 Run 使用冻结后的配置，旧 Run 不漂移。
7. Client quit -> Runtime/worker 子进程全部退出；Runtime crash -> Client 明确离线并可重启。

定位器优先 role/accessible name，断言使用自动重试，不写固定 `sleep`。Playwright 的 locator 与 web-first assertions 会等待 actionability/最终状态：[auto-waiting](https://playwright.dev/docs/actionability)、[assertions](https://playwright.dev/docs/test-assertions)、[locators](https://playwright.dev/docs/locators)。

## Flakiness 纪律

- 禁止 `sleep(1)` 作为同步条件；等待公开状态、事件、文件或进程信号。
- 每个 case 独立 data dir/workspace/port/userData；不依赖顺序和前一个测试的 catalog。
- 默认随机端口；只有产品契约要求固定端口时才固定。
- 时间相关 UI 使用 Playwright Clock；它可固定/快进 `Date`、timer 和 animation frame：[Playwright Clock](https://playwright.dev/docs/clock)。Runtime lease/TTL 仍使用 injectable clock 的 integration test，不能假装浏览器 clock 会改变 runtime 时间。
- PR 首次失败即失败，不用 retry 把回归洗成绿色。CI 可以配置一次诊断 retry 来收 trace，但 `flaky` 仍视为失败门禁；Playwright 能区分 passed/flaky/failed，并会在失败后丢弃 worker 隔离后续测试：[Playwright retries](https://playwright.dev/docs/test-retries)。
- `trace: on-first-retry`、失败截图/视频、Runtime 最后日志、SSE JSONL、临时目录清单全部上传；Playwright trace 可查看 DOM、network、console 和每步前后状态：[Trace Viewer](https://playwright.dev/docs/trace-viewer-intro)。
- 所有 timeout 明确分层：locator/action、单测试、Tool、Run、job；错误中打印当前 run ID、command ID、stage、最后 seq，不只打印“timed out”。

## CI 分组

| 触发 | 套件 | 目标时长 | 环境 |
|---|---|---:|---|
| 每个 PR | unit + integration + Runtime black-box E2E + 13 条 Client critical flows | 10-15 分钟 | Ubuntu；scripted LLM；无外网 |
| 每晚 | resilience + 完整 Tool edge matrix + MCP conformance + Plugin crash | 30-60 分钟 | Ubuntu；可并行分片 |
| 每晚/合并后 | Client OS matrix | 20-40 分钟 | macOS/Windows/Linux，按平台能力条件化 |
| release | packaged smoke + 真安装包关键路径 | 每 OS 10-20 分钟 | 签名/打包产物 |
| release/manual | live BYOK + 受控第三方 MCP | 小样本 | 专用测试账号与预算 |

Playwright project 能表达 OS/packaged/dev 等环境项目，project dependency 可保留 setup 的独立报告与 trace：[Playwright projects](https://playwright.dev/docs/test-projects)。

## 分阶段执行顺序

### Phase 0：先让现状可审计

- 为当前 contract tests 增加上述 flow/tool/tier 标签与稳定 ID。
- 让 CI 输出按流程和 Tool family 分类的 collected test 清单。
- 保留 `/tools == executed tools` 门禁；把 Tool case 增加 `family/risk/traits`，不另建抽象框架。
- 修正文档措辞：区分 Runtime black-box E2E、Client E2E、integration 和 packaged smoke。

完成标准：任何人能回答“P10、filesystem、crash 各有哪些测试”，而不是只看到总数。

### Phase 1：补最常遇到的用户链路

- 引入最薄的 Playwright Electron fixture。
- 完成 13 条 Client critical flows。
- 在失败时上传 trace + Runtime log + SSE JSONL。

完成标准：用户手工能完成的核心聊天/HITL/recovery 流程有真实点击证据。

### Phase 2：把 Tool 从单点变成 trait matrix

- 扩展现有 `TOOL_CASES`，先覆盖 filesystem、shell、web/open、MCP。
- scripted fake model 支持多 turn、错误、自我修复和多 Tool batch。
- 每个有副作用 Tool 证明 permission 前 0 次、完成后 1 次、重放仍 1 次。

完成标准：每个公开 Tool 的适用矩阵无空白；新增 Tool 未声明 traits/cases 会失败。

### Phase 3：进程级恢复

- 增加命名 kill-point fixture。
- 覆盖 Runtime、MCP server、Managed Worker 在关键提交边界被杀。
- 验证 outcome unknown/reconcile、lease fencing、cursor replay 和 thread projection。

完成标准：不是“重启后还能用”，而是重启前后的副作用、receipt、事件和最终 snapshot 全部一致。

### Phase 4：MCP/Plugin 一致性与 OS 矩阵

- 扩展已接入的官方 MCP conformance client suite（`initialize` / `tools_call` / `sse-retry` 已完成）。
- 增加真实 Plugin package import-to-artifact E2E。
- macOS/Windows/Linux 跑各自适用的 packaged lifecycle 与 confinement smoke。

完成标准：标准协议和平台边界不再依赖手工发布验证。

## 不建议做的事

- 不新增第二套 P1-P12 或第二个 Runtime client；复用 Runtime SDK。
- 不用真实 LLM 替代确定性 Tool 流程测试。
- 不把所有内部异常都塞进慢 E2E；能在 integration 层稳定注入且不跨公开边界的继续留在那里。
- 不先造通用 YAML DSL、page-object 层级或测试平台。先扩展现有 `TOOL_CASES` 与一个 Electron fixture，重复达到三处后再提取。
- 不把 retry 后通过当作绿色；flaky 是需要修的测试或产品竞态。
- 不追求“100% E2E 覆盖率”数字；追求 inventory/transition/trait matrix 无未解释空白。

## 最终验收表

- [x] P1-P12 每个公开状态转换有 black-box test ID（测试收集名直接使用 canonical stage；精确映射见 `runtime-e2e-testing.md`）。
- [x] `/v1/tools` 每个 Tool 都有 family/risk/traits、真实成功或 guarded-failure 路径；目录中所有声明 required input 的 Tool 都由 schema 反向门禁删除一个必填项，证明 permission 前、attempt 0 失败；无 required input 的 Tool 显式归为 not-applicable。
- [ ] 每个 Tool trait 的其余适用 edge matrix 都有证据或稳定 `not_applicable` 原因。
- [x] filesystem/shell/web/open 的核心高风险矩阵完成（真实 permission 前零副作用、路径/大小/编码/分页/冲突、shell process tree timeout/cancel/大输出、Web SSRF/redirect/流式上限、OS allowlist/错误 containment）。
- [ ] MCP/Plugin 的扩展协议矩阵完成（核心 timeout/crash/reconciliation/session drift、pagination/progress/cancel/structured output、WASI capability/fuel/path traversal/output-schema violation 已有证据；MCP rich content 与 Managed Worker 平台恢复仍待补齐）。
- [x] approve/reject/edit/multi/stale/duplicate/restart HITL 完成。
- [x] SSE partial frame/reconnect/multi-subscriber/slow consumer/restart 完成（含 partial frame、half-close、RST、cursor replay、multi-subscriber、slow consumer、Client 自动续流，以及首个 `llm.delta` 后进程重启的安全 snapshot 收敛）。
- [x] Runtime/MCP/worker 命名 kill-point recovery 完成（Runtime 外部提交后 kill、模型首 delta 后 kill、MCP stdio crash/HTTP session 失效、WASI fuel trap，以及 macOS arm64 packaged VM 的 worker/Runtime/launcher crash 已完成；未开放 target 继续 fail-closed）。
- [x] Client 13 条 critical flows 用真实 Electron 窗口完成。
- [x] MCP 官方 conformance 无未登记失败（`initialize` / `tools_call` / `sse-retry` 已满足且 0 warning；session 404 与自动 restart 有独立 black-box E2E；尚未声明的 auth/elicitation 不冒充支持）。
- [x] macOS/Windows/Linux packaged smoke 以实际支持能力分类（macOS arm64 VM + Client、macOS x64/Windows x64 Client lifecycle、Linux arm64 packaged Runtime+cgroup/systemd；没有 Linux Client 时明确不声称）。
- [x] PR 无供应商外网、无用户 HOME、无真实 secret、无用固定 sleep 猜结果（仅保留有上限的公开状态轮询间隔）。
- [x] 任一 Electron 失败产出 trace、Runtime log、SSE JSONL、run/command/seq 诊断信息；shell 入口失败也会打印 Runtime log。

# Self-Correction Stack

> 面向用户、评估者和运营同学的能力说明。底层时序和测试矩阵见 [`run-loop.md`](run-loop.md)。

SheJane Local Agent Harness 不只把模型输出直接转给用户。每个本地 run 会经过一组可配置的 middleware，让 agent 在动手前计划、在工具结果可疑时重新审视、在验证失败时修复、在结束前留下可交接的进展账本，并把关键状态写入 diagnostics。

这套栈的目标是确定性和可解释：尽量用结构化事件、明确上限和可开关策略约束模型，而不是把所有“自我反思”都交给一次更强模型调用。

## 能力分层

| 层 | 作用 | 触发点 | 用户价值 |
|---|---|---|---|
| Plan-first | 让复杂任务先写计划，再逐步执行 | run 开始前的 `before_agent` | 降低直接动手造成的遗漏，尤其适合跨文件、研究和多工具任务 |
| Plan approval | 计划模式下先暂停给用户审批 | `write_todos` 准备执行前 | 用户可批准、要求修改或拒绝计划，再继续 run |
| Tool critic | 对高风险或易脏的工具结果做中途评审 | 每次 watched tool 返回后 | 避免 404、登录墙、空结果、跑偏搜索或无效编辑被模型当成可靠事实 |
| Verification loop | 结构化验证失败时有上限地跳回模型修复 | 最终回答前的 `after_model` | `task.verify` 明确失败时，不会静默把失败结果当完成 |
| Progress ledger | 结束前要求刷新持久进展账本 | 最终回答前的 `after_model` | 长任务中断、失败或交接时，用户能看到验收标准、关键决策、涉及文件、验证命令和下一步 |
| Reflect | run 结束后生成轻量摘要，可选 LLM critic | `after_agent` | diagnostics 面板能展示本次 run 的工具使用和可选质量评分 |

## 运行方式

1. **先约束流程**：`PlanFirstMiddleware` 可按 `off`、`auto`、`always` 工作。复杂任务会被注入 plan-first protocol，模型需要先调用 `write_todos`。
2. **再让用户掌握计划**：开启 Plan Mode 时，`PlanApprovalMiddleware` 会把计划执行暂停为 `plan.approval_required`。批准后继续；要求修改或拒绝会把用户反馈回给模型。
3. **工具结果进入前先体检**：`ToolResultCriticMiddleware` 只看配置过的 lossy tools，例如 `web.search`、`web.fetch`、`task`、`execute`、`read_file`、`edit_file`。默认关闭；开启后可只记录、加警告，或阻断不可用结果。
4. **验证失败不会直接收尾**：当 `task.verify` 返回结构化 `ok:false`，`VerificationLoopMiddleware` 会追加修复指令并 `jump_to="model"`。尝试次数由配置限制，耗尽后记录 exhausted 状态。
5. **长任务必须留下交接点**：如果 run 使用过实际工作工具，而最后一次工具之后没有成功写 `task.progress`，`ProgressLedgerGuardMiddleware` 会最多要求模型补写一次进展账本。
6. **结束后沉淀诊断**：`ReflectMiddleware` 默认写轻量 stats；开启 critic 后，会对最终回答的 coverage、clarity、grounding 做一次 best-effort 评分。

## 配置开关

| 配置 | 默认 | 可选值 / 含义 |
|---|---:|---|
| `SHEJANE_PLAN_FIRST` | `off` | `off` 关闭；`auto` 只对复杂任务开启；`on` / `always` 对每个 run 开启 |
| Plan Mode | UI / per-run | 计划审批入口，适合高风险修改或需要用户先确认路线的任务 |
| `SHEJANE_LOCAL_TOOL_CRITIC` | `off` | `watch` 只记录；`nudge` 给模型加警告；`block` 替换不可用工具结果并要求换路线 |
| `SHEJANE_LOCAL_VERIFY_REPAIR_MAX` | 配置默认值 | `task.verify` 失败后的最大修复跳回次数 |
| Critic reflection | per-run / env | 开启后 run 结束多一次 LLM critic，增加成本，因此默认不强制 |

这些开关可以由环境变量或 Advanced agent settings 覆盖。生产默认偏保守：高成本 critic 默认关闭；verification 和 progress ledger 使用小上限，避免无限自我循环。

## 用户可见信号

- `write_todos` 计划会进入聊天进度和事件流。
- 计划审批会产生 `plan.approval_required` / `plan.approval_resolved`。
- 工具失败、结构化 envelope 失败和重试会进入 `tool.failed`、diagnostics 和 handoff failure。
- `task.verify` 的最新结果会出现在 diagnostics 的 verification 区域；后续验证通过后，旧失败不再作为当前 blocker。
- `task.progress` 写出的 progress ledger 会成为 handoff 的核心摘要，并标记 `fresh`、`missing` 或 `stale`。

## 边界

- Tool critic 不是安全边界。它是质量控制层，真正的破坏性操作仍由 Human-in-the-Loop permission gate 处理。
- Verification loop 只响应结构化 `task.verify` 失败，不会根据模糊的 LLM critic 分数自动重做。
- Progress ledger 不保存大段文件内容或敏感数据，只保存交接所需的摘要字段。
- Reflect critic 是 best-effort：失败会 fail-open，不阻塞用户拿到结果。
- 这套栈提升可恢复性和可解释性，但不能保证每次模型都会做出最佳工程判断；重要发布仍需要测试、review 和人工确认。

## 关键源码

| 能力 | 文件 |
|---|---|
| Agent 装配顺序 | [`local-host/python/local_host/agent/builder.py`](../local-host/python/local_host/agent/builder.py) |
| Plan-first | [`local-host/python/local_host/middleware/plan_first.py`](../local-host/python/local_host/middleware/plan_first.py) |
| Plan approval | [`local-host/python/local_host/middleware/plan_approval.py`](../local-host/python/local_host/middleware/plan_approval.py) |
| Tool critic | [`local-host/python/local_host/middleware/tool_critic.py`](../local-host/python/local_host/middleware/tool_critic.py) |
| Verification loop | [`local-host/python/local_host/middleware/verification_loop.py`](../local-host/python/local_host/middleware/verification_loop.py) |
| Progress ledger guard | [`local-host/python/local_host/middleware/progress_ledger_guard.py`](../local-host/python/local_host/middleware/progress_ledger_guard.py) |
| Reflection | [`local-host/python/local_host/middleware/reflect.py`](../local-host/python/local_host/middleware/reflect.py) |

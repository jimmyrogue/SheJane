# Agent Loop 的 Reflection 与验证边界

> 结论记录，不是运行时提示词。产品行为由 P9 路由、工具回执和测试约束。

## 一手资料结论

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 建议从最简单的可行系统开始，只在结果可被明确评价且迭代能带来可测收益时使用 evaluator-optimizer。
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) 区分 Agent harness 与 evaluation harness；确定性 code grader 更稳定，model grader 适合语义判断，但需要校准且有非确定性和成本。
- [ReAct](https://arxiv.org/abs/2210.03629) 的核心是让推理与环境动作/观察交替，以外部结果抑制幻觉和错误传播。
- [Reflexion](https://arxiv.org/abs/2303.11366) 依赖明确的任务反馈信号，再把语言反馈用于后续尝试；它不是无反馈地审查每一轮对话。
- [Self-Refine](https://arxiv.org/abs/2303.17651) 证明同一模型可生成反馈并修订输出，但不构成正确性保证。
- [Plan-and-Solve](https://arxiv.org/abs/2305.04091) 支持先拆分再逐个执行，主要降低遗漏步骤；语义误解仍需环境证据或审查。
- Anthropic 的[长任务 Agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)与[长时应用开发 harness](https://www.anthropic.com/engineering/harness-design-long-running-apps)都强调按功能增量推进、保持可恢复状态；后者也记录了 evaluator 会自我说服、增加时延与成本，因此应逐项验证其净收益。

## SheJane 的修订决策

不增加“每次模型回合后再调用一次通用反思模型”。改为三层约束：

1. **确定性验证优先**：消息结构、停止原因、工具回执、`task.verify` 和环境结果仍是完成判断的主要证据。
2. **关键边界语义审查**：在 `user.ask` 即将暂停 Run，以及有工具/子 Agent 回执的最终候选即将提交时，使用当前冻结模型做结构化、限时、独立记账的语义审查。
3. **有界修复与可见降级**：历史已回答的问题最多触发一次 P9 修复；问题审查不可用时放行可见问题卡。最终答案最多修复一次，仍遗漏明确交付物则受阻而不是假装成功；审查不可用时退回确定性完成判定。

复杂任务采用小步闭环：拆成可独立验收的小任务，每步执行、取得环境证据、更新进度，再进入下一步。提示词只解释工具语义；流程状态、预算和路由必须由 Runtime 持有。

## 当前接缝

- `P8 → P9`：模型输出进入唯一 `CompletionRouter`。
- `P9 → P10`：`user.ask` 通过必要性审查后才可进入等待。
- `P9 → P12`：包含当前轮工具证据的最终候选通过交付完整性审查后才可提交。
- 状态所有者：LangGraph 的 `clarification_review_state`、`completion_review_state` 与模型调用账本。
- 替换的旧路径：模型生成 `user.ask` 或工具后最终答案后，无语义检查地直接等待或提交。

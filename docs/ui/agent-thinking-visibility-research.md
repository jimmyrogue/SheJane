# Agent 思考与活动可见性调研

> 调研日期：2026-07-19
>
> 范围：ChatGPT / Codex、Claude / Claude Code、Gemini / Gemini CLI、Cursor、GitHub Copilot。只采用官方文档、官方帮助、官方博客或官方源码仓库。

## 结论先行

成熟 Agent 产品并不把“每一次内部事件”都做成同等醒目的永久卡片。共同方向是：

1. **不展示原始思维链**，最多展示模型生成的 reasoning / thinking 摘要。
2. **运行中突出当前状态**，允许用户中断、纠偏或处理审批，而不是要求用户阅读完整日志。
3. **完成后默认收起成功活动**，保留 Tool、命令、Diff 与错误作为可展开、可回看的审计证据。
4. **重复、低风险的成功 Tool 活动采用紧凑或汇总视图**；审批、失败、等待用户输入保持显眼。
5. **最终结果和执行轨迹分层**：结果面向多数用户，轨迹面向核查与调试。

截图中的主要问题不是“展示了 Tool”，而是**十余条成功 Tool 事件被渲染成同等视觉权重的独立大卡片**，并且出现在最终答复之后。它们包含多次针对同一文件的写入、读取和列目录，审计价值存在，但默认展示价值很低。

## 先统一三个概念

| 概念 | 内容 | 是否应默认展示 |
| --- | --- | --- |
| 原始思维链（raw chain of thought） | 模型内部逐 token 推理、犹豫、尝试和安全推断 | 否。不是可靠的产品解释，也可能包含敏感内容 |
| 思考摘要 / 状态（reasoning summary / status） | “正在检查冲突”“准备验证生成文件”这类模型生成摘要或宿主状态 | 运行中显示短状态；完成后收起 |
| Tool 活动（tool activity） | 读写文件、执行命令、搜索、浏览器操作、审批、返回值与错误 | 保留；成功项紧凑汇总，异常项展开 |

OpenAI 明确说明不会向用户展示原始思维链，o1 系列展示的是模型生成摘要；原因包括安全、用户体验及保留对未受约束 CoT 的监控能力。[OpenAI：Hiding the Chains of Thought](https://openai.com/index/learning-to-reason-with-llms/#hiding-the-chains-of-thought) Anthropic 当前 API 同样把面向用户的内容定义为 summarized thinking，并允许省略；Google 也明确区分 raw thoughts、加密 thought signature 与输出的 thought summary。[Anthropic：Extended thinking](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking#summarized-thinking) · [Google：Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking#thought-summaries)

因此，SheJane 不应把 UI 中的 Tool 记录称为“思考过程”。它们是**活动 / 执行记录**；真正可展示的 thinking 也应标为**思考摘要**。

## 产品对比

| 产品 | Reasoning / Thinking | Tool 与进度 | 完成后、错误与历史 | 对 SheJane 最有用的模式 |
| --- | --- | --- | --- | --- |
| ChatGPT | 手动选择 Thinking 时会显示 Thinking trace；自动路由且推理很短时可能不显示。开始前可先给短 preamble。trace 不是原始 CoT。[官方帮助](https://help.openai.com/en/articles/11909943-gpt-53-and-54-in-) | Deep research 先给可编辑计划，运行时可实时查看进度、打断并调整方向。[Deep research 帮助](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt) | 完成后进入面向阅读的全屏报告；活动历史和来源仍可回看，但不与报告正文争夺注意力。[同上](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt#download-and-review-your-results) | “当前进度”与“完成报告”分层；活动历史作为次级入口 |
| Codex | OpenAI 对 raw CoT 采取隐藏、摘要化原则；Codex 对复杂工作使用可见的进度计划，而不是把原始 CoT 当日志。[CoT 原则](https://openai.com/index/learning-to-reason-with-llms/#hiding-the-chains-of-thought) | 复杂任务用 todo 跟踪进度；工具调用和 Diff 在终端中被专门格式化，便于跟随。[Codex 更新](https://openai.com/index/introducing-upgrades-to-codex/#updates-to-codex) | App 以 thread 保存任务，支持切换后继续、在线查看改动和 Diff；Automation 完成后进入 review queue。[Codex App](https://openai.com/index/introducing-the-codex-app/) | 进度用计划表达；证据通过 Diff / Tool 明细按需查看；完成态进入 review |
| Claude / Claude Code | Claude Chat 显示带计时器的 Thinking 指示器，正文上方有可展开 Thinking 区域；官方称其内容为 thought process summary。高风险内容可能只显示“不提供剩余过程”。[Claude 帮助](https://support.anthropic.com/en/articles/10574485-using-extended-thinking) Claude Code 交互模式默认不显示摘要，只显示折叠 stub；`showThinkingSummaries` 才打开摘要。[Settings](https://code.claude.com/docs/en/settings#available-settings) | Claude Code Agent View 用 waiting / working / done 三种高层状态管理并行 Agent。[Agent View](https://claude.com/blog/agent-view-in-claude-code) | Client 的 Normal 把 Tool 折叠为摘要，Verbose 显示每个 Tool / 读文件 / 中间步骤，Summary 只显示最终回复和改动。[Desktop view modes](https://code.claude.com/docs/en/desktop#switch-view-modes) VS Code 中 thinking block 也默认折叠，可单个或全部展开；会话历史可搜索并恢复完整消息。[VS Code](https://code.claude.com/docs/en/ide-integrations#use-the-prompt-box) | 三档密度是最直接参考；正常模式不必逐条铺满 Tool |
| Gemini / Gemini CLI | Gemini API 默认只返回最终结果；thinking summary 需显式开启，也可设为 `none`，summary 可能为空。它不是 raw thought。[Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking#thought-summaries) CLI 的 inline thinking 默认 `off`，窗口标题可只显示 Ready / Action Required / Working 高层状态。[CLI Settings](https://geminicli.com/docs/cli/settings/#ui) | CLI 自动调用 Tool；修改文件或执行命令前展示 Diff / 精确命令并请求确认。[Tools reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md#automatic-execution-and-security) `ui.compactToolOutput` 默认开启，目录列表和文件读取等输出以紧凑结构展示。[CLI Settings](https://geminicli.com/docs/cli/settings/#ui) | 可恢复错误默认以低详细度隐藏，`ui.errorVerbosity=full` 才完整显示。历史自动保存全部 Tool 输入输出和可用 reasoning summary，`/resume` 可搜索恢复。[CLI Settings](https://geminicli.com/docs/cli/settings/#ui) · [Session management](https://geminicli.com/docs/cli/session-management/) | Tool 数据仍在，但默认压缩输出；历史回看与当前对话分开 |
| Cursor | Thinking block 支持流式期间展开 / 折叠；官方变更记录把该能力视为正常交互。[Cursor 3](https://cursor.com/changelog/3-0) | Tool call 可折叠；Compact chat 会隐藏 Tool 图标、默认折叠 Diff、空闲时隐藏输入框。[Changelog 1.0](https://www.cursor.com/en/changelog?v=1.0) · [Compact mode](https://cursor.com/changelog/1-4#compact-chat-mode) | Agent 历史可打开完整对话、重命名、删除、导出 Markdown；Background Agent 另有独立入口。[History](https://docs.cursor.com/en/agent/chat/history) | 对长会话提供全局“紧凑模式”，而不是让每张 Tool 卡自己抢占空间 |
| GitHub Copilot | VS Code 可调 reasoning effort；可单独复制 final response，明确跳过 thinking steps 与 Tool calls。[VS Code 更新](https://github.blog/changelog/2026-04-08-github-copilot-in-visual-studio-code-march-releases/) | 连续 Tool 默认折叠，折叠区有摘要和 AI 标题；`collapsedTools` 可选分离、仅随 thinking 分组或始终分组，默认 `always`。[VS Code 1.107](https://code.visualstudio.com/updates/v1_107/#_collapsible-reasoning-and-tools-output-experimental) · [AI settings](https://code.visualstudio.com/docs/agents/reference/ai-settings#_chat-settings) | Subagent 活动默认收起，只显示正在做什么的 HUD；需要时展开完整输出。Coding Agent session log 保存 reasoning、Tool、进度和 setup 输出，便于历史审计与错误诊断。[Session visibility](https://github.blog/changelog/2026-03-19-more-visibility-into-copilot-coding-agent-sessions/) · [Session logs](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents) | “默认收起 + 当前工作 HUD + 可展开完整日志”最贴近截图问题 |

### 可确认的行业共识

- **摘要优于原始 CoT**：OpenAI、Anthropic、Google 都把用户可见内容定义为摘要、trace 或状态，不等于原始推理。
- **运行时和完成后采用不同密度**：运行时显示当前动作、时间或计划；完成后转为报告、Diff、review 或折叠日志。
- **Tool 透明度可调**：Claude 有三档视图，Cursor 有 Compact mode，Gemini CLI 默认 compact output，Copilot 将 subagent activity 默认收起。
- **审计能力不等于默认展开**：Copilot session log、Cursor chat history、Gemini resume / rewind 都保留回看能力，但不会把完整历史永久铺在主答案上。
- **例外优先于常规成功**：官方产品普遍把确认、权限、等待输入与失败作为需要用户注意的交互；普通成功调用则可以折叠或紧凑化。

## 针对当前截图的建议

### 建议的默认层级

```text
执行中
● 正在生成并验证游戏…                 8 / 11
  └─ 展开活动

完成后
✓ 已完成 · 创建并打开 贪吃蛇.html       12 项活动  ›

展开后
  发现文件名冲突                       1
  写入文件 · snake.html                6
  读取文件                             3
  列出目录                             1
  打开文件 · 贪吃蛇.html               1
```

这不是删除事件，而是把同一 Run 的事件从“卡片列表”变成“一条活动摘要 + 按需展开的审计明细”。

### 默认规则

1. **最终答复是主内容**。Tool 活动在时间线上应位于最终答复之前；Run 完成后只保留一条紧凑摘要，不在答复下方追加十几张大卡。
2. **运行中只突出一个当前动作**。旧的成功动作收进同一个 Activity disclosure；不要一边 streaming 一边无限增加全宽卡片。
3. **连续相同 Tool + 相同目标合并计数**。截图中多次 `写入文件 · snake.html` 应显示为 `写入文件 · snake.html × 6`。底层事件、参数、时间和返回值仍逐条保留。
4. **按语义阶段分组，而非只按 Tool 名分组**。例如“检查现有文件”“生成游戏”“验证并打开”，比“read / write / list”更适合普通用户；展开第二层后再显示具体 Tool。
5. **成功默认收起，异常默认展开**：
   - 普通成功：收起；
   - 正在运行：显示当前项；
   - 等待审批 / 用户输入：置顶并展开；
   - 失败 / 部分失败：展开错误摘要和重试入口；
   - 涉及外部发送、支付、删除等高风险动作：即使成功也保留醒目标记。
6. **思考摘要与 Tool 活动分成两个 disclosure**。`思考摘要`回答“为何采用这个方向”；`活动`回答“实际执行了什么”。不要把 Tool 行为包装成“思考”。
7. **提供三档密度，但先只实现必要两档**：默认“标准”（摘要 + 异常），可切换“详细”（逐条事件）。Claude 的 Summary / Normal / Verbose 证明三档有效，但 SheJane 当前不需要同时实现三套；等用户确实需要极简模式再加“仅结果”。
8. **历史可回看**。折叠只是展示策略，不应删掉 Runtime 拥有的事件，也不应改变导出、重放、诊断和审批证据。

### 视觉处理

遵循现有 SheJane 设计系统：

- Activity 容器使用一层 `--sj-paper-sunken` 或 hairline，不再给每个成功事件独立白色浮层和阴影。
- 当前执行用 seal red 小点；完成使用 moss；普通历史使用 `--sj-ink-faint`。
- 单行摘要包含：状态、语义动作、关键对象、数量、展开箭头。完整路径、参数和 stdout 放入展开层。
- 相同状态不要重复使用图标、圆点、阴影、边框四种提示；保留圆点和文字即可。

## 不建议做的事

- 不显示或保存所谓“完整原始思维链”作为用户功能；它不等于可信解释。
- 不用 LLM 在前端临时重新总结每一批 Tool 事件。优先根据已有事件类型、Tool 名、目标和状态做确定性分组，避免增加延迟、成本和新的不稳定层。
- 不在第一版引入复杂的可配置规则引擎。两种展示密度、确定性合并和异常展开已经能解决截图中的主要问题。
- 不隐藏审批、错误或需要用户接管的信息。压缩常规噪声不能牺牲可控性。

## 推荐决策

SheJane 可以采用 **“标准模式默认 + 详细模式可选”**：

- 运行中：一个当前状态行，下面是收起的累计活动数；
- 完成后：一条完成摘要，默认收起所有成功 Tool；
- 展开：先按语义阶段分组，再查看逐条 Tool；
- 审批、等待输入、错误：自动展开；
- 思考：仅展示 provider 提供的 summary / trace，单独折叠，永远不把 Tool activity 命名为 thinking。

这是对现有信息架构的收敛，不需要改变 Runtime 事件协议，也不需要删除审计数据。先在 Client 投影视图中做确定性分组即可；只有当现有事件缺少目标、阶段或状态字段时，才需要补协议。

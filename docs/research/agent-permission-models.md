# Agent 工具权限与批准范围调研

> 调研日期：2026-07-21。主要阶段：P10 工具执行与人工审批；相邻阶段：P9 风险判断、P11 清理与审计；状态所有者：Runtime。

## 结论

SheJane 的 `auto` 表示“普通低风险操作不打扰用户”，而不是“任何操作都不再询问”。确认卡只保留 **允许一次 / 不再询问 / 拒绝**；“不再询问”只持续当前任务，只对 Runtime 判定合格的同一工具生效，并且不能跳过每次调用的参数校验、能力/工作区边界、工具版本、硬性拒绝与风险重算。

不要在确认卡第一版加入永久的工具级允许。永久规则应放进独立权限管理页，能查看来源、约束、撤销和失效原因。

## 本次案例诊断

- 该 Run 已使用 `permission_mode=auto`，但 26/26 个 `permission.required` 都来自 `tool=execute`、`risk=external_or_unknown`、`source=fallback`，并带相同的“审查器不可用”通用原因。
- 26 次调用的参数指纹全部不同；用户 23 次选择了 Run 范围，现有“相同参数”授权因此一次也没有命中。这里同时存在审查器全量失败与授权粒度不匹配，不能只靠加宽授权解决。
- 修复前 [`execute`](../../runtime/src/shejane_runtime/agent/backends.py) 直接以 `cwd`/`env` 调用宿主 shell，没有能证明只读或限制副作用的强制沙箱。修复后它必须通过 SRT 进入无网络、工作区只读、仅私有临时目录可写的 OS 沙箱；启动器缺失时 fail closed。

本次修复不再让沙箱内普通命令依赖模型审查器，因此审查器不可用不会制造连续弹窗。删除工具和外部未知能力继续由 Runtime 强制询问；前端即使被绕过，接口也拒绝把它们保存为任务级授权。

## 一手资料比较

| 系统 | 官方机制 | 对 SheJane 的启示 |
| --- | --- | --- |
| OpenAI Codex | 沙箱决定“技术上能做什么”，审批策略决定“何时询问”；Auto 预设可在工作区内读写和运行命令，越出工作区或访问网络仍询问。[Agent approvals & security](https://learn.chatgpt.com/codex/agent-approvals-security) Codex 还支持按参数向量匹配的命令前缀规则，冲突时取更严格的 `forbidden > prompt > allow`，并允许为规则写正反例测试。[Rules](https://learn.chatgpt.com/docs/agent-configuration/rules) App/MCP 可按单个工具设置审批模式，并独立禁用带 `destructive` 或 `open_world` 标记的工具。[Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) | 审批复用与沙箱必须分层；适合长期保存的是可检查的窄规则，不是一次对话里产生的无限授权。 |
| Claude Code | 工作区内只读工具默认无需批准；Shell 的“不再询问”按仓库和具体命令持久化，文件修改授权只持续到会话结束。[Permissions](https://code.claude.com/docs/en/permissions) 规则支持 `Tool` 和 `Tool(specifier)`，并由运行时按 `deny → ask → allow` 执行；MCP 可精确到服务器和工具。[Permissions](https://code.claude.com/docs/en/permissions) Auto 仍保留显式 `ask` 与受保护操作，且会丢弃可执行任意代码的宽泛 Shell 允许规则。[Permission modes](https://code.claude.com/docs/en/permission-modes) | 生命周期应随风险变化；工具级允许有价值，但 Shell、通用执行器和外部写操作需要参数级规则或强制询问。 |
| VS Code | 工具批准可选单次、当前会话、当前工作区或未来全部调用，并能集中管理到单个工具或整个来源；组织可把敏感工具标记为永远不具备自动批准资格。[Approvals and permissions](https://code.visualstudio.com/docs/agents/approvals) VS Code 明确指出终端工具能力过宽，因此按命令而不是按整个终端工具批准；URL 请求与返回内容也分开批准，以防数据外传和提示注入。[Approvals and permissions](https://code.visualstudio.com/docs/agents/approvals) | 需要工具级范围，但必须有 `eligible_for_auto_approval` 门禁；通用工具改用参数约束，外部读取还要区分“允许请求”和“信任结果”。 |
| MCP | 标准提供 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`；缺省分别按非只读、可能破坏、非幂等、开放世界处理。标准明确规定这些只是提示，不能基于不可信 Server 的注解作安全决定。[Schema reference](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations) MCP 也建议客户端保留可拒绝工具调用的人类控制。[Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | 注解适合作为风险词汇和保守默认值；只有 Runtime 自有工具或已建立信任的固定 Server/工具版本才能用它们驱动自动批准。 |

## 工具级允许为什么有用、又为什么危险

它适合“同一结构化低风险动作、参数不断变化”的场景，可以消除当前精确参数授权必然无法命中的重复提示。风险在于真正的目标和副作用通常由参数决定，而不是方法名决定；通用 Shell 就是最明显的例子，VS Code 也因此按命令而非整个终端工具批准。[Approvals and permissions](https://code.visualstudio.com/docs/agents/approvals#automatically-approve-terminal-commands)

MCP 的 `tools/call` 只是传输方法，实际能力由 `params.name` 指定，Server 还可以通知客户端工具目录已经变化。[Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 因此授权键不能是裸 JSON-RPC 方法或整个 Server；至少要绑定可信 Server 身份、具体工具名和版本，并在目录/schema 变化时失效。

## 安全自动批准条件

仅当以下条件全部成立时，Runtime 才应确定性自动允许，或向用户提供工具级 Run 授权：

1. 工具来源可信，服务器身份、工具名、schema 与 `tool_version` 已冻结；未知或变化立即失效。
2. 参数已通过 schema、规范化、路径解析和能力检查；目标仍在授权工作区/资源范围内。
3. 调用不读取受保护凭据，不更改身份、权限或安全策略，不触及受保护路径。
4. 调用不是破坏性操作，也不会产生付款、发送消息、发布、部署、生产变更等外部承诺。
5. 工具是闭合世界；开放网络或外部实体默认继续按调用判断。只读不等于安全：读取密钥或把内容送往外部仍然危险。
6. 复用相同参数时，工具必须明确幂等；否则“参数相同”仍可能重复发送、重复扣款或重复创建资源。
7. 任一字段未知、注解不可信、审查失败或风险升级时，单调回退到 `ask`，不得沿用宽授权。

## 建议批准范围

| 范围 | 绑定内容 | 何时提供 |
| --- | --- | --- |
| `once` | 当前 `operation_id` | 默认；破坏性、非幂等、外部写入、凭据/权限操作只提供这一项。 |
| `tool_run`（界面文案“不再询问”） | Run + Server/工具身份 + schema/版本 + 风险上限 + 强制 effect/capability + 工作区 | 仅对满足上述全部条件的工具显示。每次新参数仍重新校验；风险升高就询问；授权持续到当前 Run 结束。 |
| `constrained_rule`（以后） | 工具 + 路径、域名、命令前缀等参数约束 + 用户/项目作用域 | 在独立权限页显式创建、测试和撤销；用于稳定重复工作，不从一次确认静默升级而来。 |

不建议提供 `server_run` 或永久裸 `Tool` 作为普通确认选项：信任一个 MCP Server 不等于其当前和未来所有工具都低风险；通用 Shell/浏览器/执行器的方法名也无法表达真实目标。

## 对当前实现的最小建议

1. `execute` 先进入无网络、工作区只读的 OS 沙箱，再由 P9/P10 把它作为 `sandboxed_command` 处理；沙箱不可用则拒绝执行。
2. `tool_run` 只给 Runtime 判定为合格的工具；授权最多持续当前 Run，并沿用现有时间/次数上限。MCP 注解只能参与可信工具的资格判断，不能单独授予资格。
3. 继续让 `Tool Receipt` 记录每次调用及其实际来源；任务级授权不合并不同调用的回执。
4. 删除、外部未知、凭据/权限及其他不可恢复操作不显示“不再询问”，服务端也拒绝伪造的 Run 范围决定。

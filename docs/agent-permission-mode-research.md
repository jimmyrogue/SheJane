# Agent 权限模式调查

## 结论

SheJane 已提供 `ask`、`auto`、`full_access` 三种任务级权限模式。Client 只负责选择、展示和提交，Runtime 在 Run 接纳时冻结模式并执行策略，客户端不能直接跳过审批。

`auto` 已升级为“确定性规则优先、当前模型只审查灰区、失败回退人工确认”。详细决策见 [ADR-0002](./adr/0002-model-assisted-auto-approval.md)。

## 当前实现

- Client 新对话默认选择 `auto`，输入框盾牌菜单可以切换三种模式。
- Runtime 支持 `once` 和 `run` 两种人工批准范围；界面显示为“允许一次”和“不再询问”。`run` 只对合格普通工具按同一风险和工具版本持续到当前 Run 结束，每次新参数仍重新校验；删除等不可恢复工具不具备该范围。
- 自动决定按 operation 写入 Tool Receipt，恢复和重放不会重复调用审查模型。
- `permission.auto_approved` 会携带 `rule` 或 `llm` 来源；人工确认继续使用 `permission.required`。

## 其他 Agent 的做法

OpenAI Codex 曾公开提供 Suggest、Auto Edit 和 Full Auto 三种审批模式。它把自动执行限制在沙箱和当前目录中，说明“少询问”不等于“取消安全边界”。

- [OpenAI Codex CLI 入门](https://help.openai.com/en/articles/11096431)

Claude Code 目前提供 Manual、Accept Edits、Plan、Auto、Don't Ask 和 Bypass Permissions 等模式。官方文档明确区分权限规则、工作区边界和操作系统沙箱，并说明权限由运行时而非模型执行。

- [Claude Code 权限模式](https://code.claude.com/docs/en/permission-modes)
- [Claude Code 权限规则](https://code.claude.com/docs/en/permissions)
- [Claude Code 安全边界](https://code.claude.com/docs/en/security)
- [Claude Code 沙箱](https://code.claude.com/docs/en/sandboxing)

## 已实施方案

第一版提供三个稳定模式，不引入可编程策略语言：

| 模式 | 行为 |
| --- | --- |
| 请求批准 | 读取工作区可直接执行；写入、外部访问和危险操作需要确认。 |
| 自动审批 | Runtime 先按规则批准低风险操作；外部或未知灰区由当前模型判断 `allow/ask`，失败或不明确时仍需确认。 |
| 完全访问 | 在已经授权的工作区和操作系统权限内自动执行；仍不能绕过硬性禁令、身份验证、审计和系统边界。 |

“完全访问”不应在普通主机上等价于无限权限。将来只有 Runtime 具备可靠沙箱或隔离虚拟机后，才应考虑提供真正的绕过审批模式。

## 所有权与链路

- 主要阶段：P10 工具执行与人工审批。
- 相邻阶段：P9 风险判断；P11 退出、快照和审计。
- 状态所有者：Runtime。
- Client：在输入框附近显示当前模式，并将选择随任务请求提交。
- Runtime SDK：传递并暴露模式，不自行解释策略。
- Runtime：冻结本次运行的模式，通过“硬性拒绝 → 必须询问 → 模式策略 → 允许”顺序裁决。

权限模式和审批复用范围必须并存：前者决定何时询问，后者决定用户作出的批准可以复用多久。

## 生命周期建议

- Client 新对话默认“自动审批”；Runtime API 在调用方省略模式时仍采用保守默认值。
- 当前模式随 Run 冻结，不因 Client 后续选择改变。
- “完全访问”只对当前运行或本次应用会话有效，不默认永久保存；首次选择时明确确认。
- 运行开始后先禁止修改模式，避免同一运行的安全语义变化。以后如有必要，再增加显式的 Runtime 命令切换。

## 不受模式影响的硬性边界

- 操作系统文件与凭据权限。
- 已授权工作区范围及路径穿越检查。
- Runtime 的回环认证和命令验证。
- 对密钥、凭据库和受保护系统路径的限制。
- 每次工具调用的事件、回执和审计记录。
- Runtime 自我保护，例如禁止关闭安全机制或删除自身数据。

## 实施状态

1. Runtime 已增加权限模式、策略矩阵和真实工具链路测试。
2. 模式已冻结进 Run 设置快照；分支继承源 Run，定时任务在创建时冻结。
3. OpenAPI 和 Runtime SDK 类型已经更新。
4. Client 输入框已增加盾牌按钮和三档菜单，运行期间禁止切换。
5. 现有单次审批条继续处理“请求批准”和自动模式中的敏感操作。
6. 已覆盖三种模式的工具执行与 Client/SDK 交互；恢复、重试继续复用 Run 的冻结快照。

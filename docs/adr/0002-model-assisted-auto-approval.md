# ADR-0002：模型辅助的自动审批

- 状态：Accepted
- 日期：2026-07-16
- 决策范围：Runtime P9-P12、Runtime SDK/SSE、Client
- 主要阶段：P10 工具执行与人工审批
- 相邻阶段：P9 工具批次与风险分类；P11/P12 结算、快照与审计
- 状态所有者：Runtime
- 实施计划：[模型辅助自动审批实施计划](../plans/model-assisted-auto-approval.md)

## 背景

`auto` 原先只是固定规则：工作区操作和受限插件自动执行，外部或未知操作全部询问。这种方式可靠，但会把许多与当前任务明确一致的操作也交给用户，交互仍然繁琐。

另一方面，不能把权限直接交给主 Agent 自己决定。模型输出具有不确定性，也不能扩大插件 capability、工作区授权、操作系统权限或沙箱边界。

## 决策

保留 `ask`、`auto`、`full_access` 三种 Run 级模式。Client 新对话默认选择 `auto`；Runtime 在接纳 Run 时冻结具体模式，并继续对省略字段的非 Client 调用采用保守默认值。

`auto` 使用两层裁决：

1. 确定性规则先返回 `allow`、`ask`、`deny` 或 `review`。
2. 只有 `review` 灰区才调用本 Run 已冻结的当前模型，模型只能返回 `allow` 或 `ask`。

当前策略矩阵：

| 条件 | 决定 |
|---|---|
| 参数无效、能力未授予、路径越界、沙箱或系统权限拒绝 | 硬性拒绝，模型不能覆盖 |
| 删除等不可恢复工具 | 所有模式下询问，且不能获得 Run grant |
| `ask` 下的工作区写入、沙箱命令、插件和外部/未知操作 | 询问 |
| `auto` 下的工作区操作、工作区只读且无网络的沙箱命令和受限插件 | 规则允许 |
| `auto` 下的外部/未知操作 | 模型审查 |
| 剪贴板读取等受保护 Runtime 状态 | 询问 |
| `full_access` 下的普通审批 | 规则允许，但硬边界保持不变 |

## P10 流程

```text
完整工具批次
  → 参数、版本、撤销状态和硬边界检查
  → 生成稳定 operation_id 并准备 Tool Receipt
  → 读取已持久化审批或有界 Run grant
  → 确定性规则
      allow  → 持久化决定 → 执行
      ask    → 持久化决定 → 整批执行前暂停
      review → 一次批量模型审查
                   allow → 持久化决定 → 执行
                   ask   → 持久化决定 → 整批执行前暂停
                   失败  → fallback=ask → 整批执行前暂停
```

审批和执行必须使用同一个 canonical operation scope。它移除 LangGraph 的节点局部命名空间，但保留父级子代理路径和工具批次摘要，避免同一调用生成两张回执，也避免并发子代理互相合并。

## 模型审查器契约

- 使用当前 Run 已冻结的具体模型，不自动切换供应商或模型。
- 使用独立的逻辑角色和系统提示，不提供任何工具。
- 只接收当前任务目标，以及标准化后的 `operation_id`、工具名、风险和参数。
- 参数按敏感键递归脱敏，并明确作为不可信数据处理。
- 一次审查完整灰区批次，返回严格 JSON；operation 数量和 ID 必须完全匹配。
- 只接受 `allow` 或 `ask`，不接受 `deny`、修改参数、授予 capability 或创建长期规则。
- 单次调用超时 8 秒；超时、供应商失败、空响应、无效 JSON 或不完整结果一律回退为 `ask`。

模型审查调用写入同一个持久模型账本，但使用 `purpose=approval_review` 和独立的每 Run 调用预算。这样不会消耗主 Agent 的调用次数，也不会成为绕过全局审计的隐藏模型调用。

## 持久化与事件

Tool Receipt 保存：

- `review_decision`
- `review_source`：`rule`、`llm`、`fallback`、`user` 或 `run_grant`
- `review_reason`
- `review_model`
- `reviewed_at`

相同 `operation_id` 的决定只能幂等重放；冲突更新必须失败。Run 恢复、checkpoint 重放和进程重启均复用已保存决定，不重复调用模型。

自动允许会发出临时产品事件：

```json
{
  "event_type": "permission.auto_approved",
  "payload": {
    "request_id": "toolop_...",
    "operation_id": "toolop_...",
    "tool": "execute",
    "risk": "sandboxed_command",
    "source": "rule",
    "reason": "runtime_safe",
    "scope": "run"
  }
}
```

Client 将 `source=rule` 显示为“规则自动允许”，将 `source=llm` 显示为“智能自动允许”。模型失败后的 `ask` 继续走现有 `permission.required` 卡片，并明确提示已切换为人工确认；完整原因同时保存在 Tool Receipt 中。

## 安全不变量

- 模型不能扩大工作区、文件、网络、凭据、插件 capability 或操作系统权限。
- 模型不能绕过参数 schema、撤销状态、沙箱门禁或 Tool Receipt。
- `execute` 无沙箱启动器时 fail closed；沙箱只读工作区、禁止网络，只允许私有临时目录写入。
- 删除等不可恢复工具即使在 `full_access` 下也逐次询问，且服务端拒绝 Run 范围授权。
- 一个批次只要有任何调用需要询问，就在所有调用执行前暂停。
- 不静默切换模型，不因审查失败自动放行。
- `full_access` 只减少普通询问，不等于关闭系统与沙箱边界。

## 放弃的方案

### 让主 Agent 在工具参数中声明是否需要审批

拒绝。调用者和审批者不能是同一信任主体，也无法形成可靠审计。

### 所有自动审批都调用模型

拒绝。确定性安全操作不需要增加延迟、成本和不稳定性。

### 模型失败后按风险猜测并放行

拒绝。失败回退必须单调趋向更保守的 `ask`。

### 新建独立插件审批协议

拒绝。插件 Action 继续复用 P10、Tool Receipt、Artifact 和现有 SSE，不形成第二条执行链。

## 结果

自动模式减少了明确任务中的重复审批，同时保留 Runtime 的最终裁决权、可恢复性和审计性。代价是灰区操作多一次模型调用，并需要维护严格输出解析、独立预算和失败回退测试。

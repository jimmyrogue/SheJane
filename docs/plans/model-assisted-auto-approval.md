# 模型辅助自动审批实施计划

对应决策：[ADR-0002](../adr/0002-model-assisted-auto-approval.md)

## 目标

让 Client 默认的 `auto` 模式先使用确定性规则，只把外部或未知灰区交给当前模型审查；任何模型失败都回退到现有人工审批。整个方案复用 Runtime P10、Tool Receipt、模型账本和 SSE，不引入第二套权限系统。

## 阶段与交付物

| 阶段 | 交付物 | 完成条件 |
|---|---|---|
| 1. 策略 | `allow/ask/deny/review` 的 Runtime 决策对象 | 三种模式和关键风险均有单元测试 |
| 2. 审查器 | 无工具、严格 JSON、批量、脱敏、超时的模型调用 | allow 正常返回；无效/缺失/超时统一失败关闭 |
| 3. 持久化 | Tool Receipt 审批字段和幂等写入 | 重放不重复审查；冲突决定失败 |
| 4. 账本 | `agent` 与 `approval_review` 调用目的 | 同一持久账本、独立预算、无供应商 fallback |
| 5. P10 接入 | 完整批次先审查再执行 | 任一 ask 在整批执行前暂停；硬边界不受影响 |
| 6. 产品事件 | `permission.auto_approved` | Runtime 翻译稳定，Client 可区分 rule/llm |
| 7. 文档 | ADR、run loop、协议、运维说明 | 当前行为与失败回退可被开发者直接查到 |
| 8. 验证 | 单元、集成、Client、全量测试和构建 | `make test`、`make build`、`git diff --check` 通过 |

## 关键测试矩阵

| 场景 | 期望 |
|---|---|
| `auto` + 工作区写入 | 规则允许，不调用审查模型 |
| `auto` + 受限插件 | 规则允许，发 `source=rule` 事件 |
| `auto` + 外部/未知工具 + 模型 allow | 自动执行，发 `source=llm` 事件 |
| `auto` + 外部/未知工具 + 模型 ask | 产生 `permission.required` |
| 审查超时、异常、无效 JSON、不完整 ID | fallback ask，不执行 |
| checkpoint/进程恢复 | 复用 Tool Receipt，不再次调用模型 |
| 同一批存在 ask 和 allow | 所有调用都在执行前暂停 |
| 参数无效、路径越界、未授予 capability | 仍由确定性边界拒绝 |
| 主 Agent 调用预算耗尽 | 不污染审查器独立预算；两者均可审计 |
| Client 事件投影 | 显示规则/智能来源并保留 reason/request ID |

## 发布与回滚

该变更不新增公开 HTTP 命令或数据库版本开关。SQLite 使用加性列迁移；旧数据的审批字段为空时按当前策略重新裁决。

如果线上需要保守回滚，可将 Client 默认模式切回 `ask`，或把 `auto` 的灰区规则改为直接 `ask`。不得通过忽略模型解析错误、删除 Tool Receipt 决策或绕过硬性 capability 检查来回滚。

# Agent Architecture Work Summary - 2026-06-11

本文件总结本轮围绕 SheJane Local Agent Harness / LangGraph 架构补缺完成的工作，以及下一步可以继续推进的方向。

## 已完成

- 梳理了当前活文档与实现边界，重点对齐 `docs/run-loop.md`、`docs/operations.md`、`docs/roadmap.md`、`CLAUDE.md`、`AGENTS.md` 和新增的 `docs/agent-architecture-gap-review.md`。
- 对照 LangGraph 的 durable execution、checkpoint、interrupt/resume、thread identity 模型，明确 SheJane 的恢复动作应绑定原 run / conversation / assistant message，而不是依赖当前 UI 状态。
- 补强了失败后的用户恢复流：
  - retry 恢复确认绑定原失败 `{conversation_id, assistant_message_id}`，并有 per-target in-flight guard。
  - repair 恢复动作绑定原失败消息，写入 source run/message、attempt、failure category/action kind，并避免连续点击创建重复 repair run。
  - quota checkout 恢复动作绑定原失败消息，连续点击同一个失败消息的“充值”不会创建多个 Stripe checkout session。
  - billing checkout observer 会在打开 checkout 后做有界 wallet polling，余额或订阅容量生效后只刷新显式“重试”提示，不自动重跑任务。
  - auth/session 恢复失败时保留 pending recovery target，后续登录或 token 修复让 Local Host cloud session 重新 connected 后，只刷新同一个失败 turn 的显式重试提示。
  - workspace 绑定恢复会固定到原失败 conversation，避免用户在 OS 目录选择器期间切换对话导致写错会话。
- 补强了 long-running agent 的上下文与交接能力：
  - client/daemon 双层 history truncation 现在保留 deterministic omission summary。
  - daemon 二次截断会保护 client omission marker，不把它当作普通最旧消息丢掉。
  - `run.waiting` 会携带 handoff / ledger snapshot，client 在等待状态中显示 missing/stale progress ledger 风险。
  - `task.progress` 进展账本进入 diagnostics / handoff，用于长任务交接。
- 补强了 failure policy 和诊断：
  - model/tool/gateway retry 统一经过 `failure_policy.build_retry_decision`。
  - auth/quota/configuration/workspace/validation/fatal 不会因为误带 `retryable:true` 被自动重试。
  - tool result envelope 的 `ok:false` 会进入 `tool.failed` 和 `handoff.failure`。
  - model gateway error 会以结构化 `run.failed` 进入 durable failure。
- 补强了 memory 的基础可靠性：
  - workspace namespace 隔离。
  - explicit `remember` / `记住` 生成 `kind=user_fact`。
  - `memory.search` 会 bounded overfetch，再按 user fact 优先和同类 recency 排序。
- 更新了相关文档：
  - `docs/run-loop.md`
  - `docs/operations.md`
  - `docs/roadmap.md`
  - `docs/specs/universal-tool-primitives.md`
  - `docs/agent-architecture-gap-review.md`
  - 其它架构、客户端、运维相关文档随实现同步调整。

## 已验证

- `cd client && npm test -- --run src/App.test.tsx -t "opens only one checkout session"`
- `cd client && npm test -- --run src/App.test.tsx`
- `make test`
- `make build`
- `git diff --check`

以上命令均已通过。当前仍有两个已知非阻断 warning：

- admin 测试里的 Radix ref warning。
- Vite build 的 client large chunk warning。

## 本轮没有继续做的事

- 没有把整个 `/goal` 标记为完成；当前只是阶段性收尾。
- 没有创建 release tag，因为 release 流程需要显式 `VERSION=vX.Y.Z`，且会触发 CI 构建与镜像发布。
- 没有提交 `client/dist`、`admin/dist` 或 Go 编译产物。
- 未跟踪的 `api/migrate` 是本地 Mach-O 可执行构建产物，已加入 `.gitignore`。

## 接下来可以做什么

1. 统一 recovery orchestrator

   现在 auth、billing、workspace、diagnostics、repair 都各自有恢复入口和部分 observer。下一步可以抽出统一 recovery orchestrator，集中管理 target、required fix、observer、confirmation、retry budget、notice 状态，减少 App 层分散逻辑。

2. 配置修复后的恢复闭环

   configuration/operator_action 当前主要是打开 diagnostics 并提示“修复后重试”。下一步可以观察 admin/provider config 状态变化，在配置修复后给同一失败 turn 提供明确 retry confirmation。

3. 语义级长期记忆

   当前 memory 是规则写入、namespace 隔离、recency 排序。下一步可以做 LLM fact extraction、semantic merge、stale fact verification 和向量检索。

4. 语义上下文压缩

   当前 long history summary 是 deterministic excerpt。下一步可以引入 pre-run semantic summary，并和 deepagents in-run summarization 协调，避免长任务丢失关键约束或带入过多无关上下文。

5. Critic / verification 自动修复策略

   `task.verify` 已有 bounded repair loop，但 fuzzy tool critic 和 reflection 仍是 advisory。下一步可以明确哪些 critic verdict 足够可靠，可以进入低风险自动修复或强制二次验证。

6. 发布版本

   如果要发布服务端镜像版本，按当前运维文档需要在干净工作区和 `main` 上执行：

   ```bash
   make release VERSION=vX.Y.Z
   ```

   该命令会创建 annotated tag 并 push，触发 GitHub Actions 构建和推送 GHCR 镜像。建议发布前先决定版本号，例如下一个 patch 版本。

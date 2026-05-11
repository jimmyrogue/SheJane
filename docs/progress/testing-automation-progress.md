# Jiandanly 自动化测试体系进度

Updated: 2026-05-11

## Goal

建立“本地确定性优先”的测试体系：默认测试不依赖真实 LLM、Stripe、S3、Tavily 或公网；真实服务只通过显式 smoke 验证。

## Completed

- [x] 新增 `e2e/` 独立 Playwright 包，使用 Chromium 和 Vite webServer 启动 client/admin。
- [x] Playwright E2E 默认使用隔离端口 `55173/55174`，避免误复用 Docker 或手动开发栈的 `5173/5174`。
- [x] 新增 Playwright route mocking，模拟 API、S3 PUT、Agent Run SSE、Local Host loopback API 和 Electron bridge。
- [x] 覆盖普通用户关键路径：注册、统一 composer、普通 Agent Run、附件文档 Agent Run、附件上传、本地 Harness 权限批准、artifact 预览、最近 run 恢复和诊断导出。
- [x] 覆盖 admin 关键路径：tab 切换、用户详情、额度调整 reason 校验、订单/provider 只读、Agent Runs 可见、非 admin 阻断。
- [x] 新增 `make test-e2e` 和 `make test-ci`。
- [x] 新增 `make smoke-local-host`，启动真实 Local Host daemon 并验证 health、401、tools 和 mock run stream。
- [x] 新增 `make smoke-docker-local`，使用 disposable Docker Compose project 验证 API/client/admin 基础闭环。
- [x] 新增 `make smoke-s3-document` 和 `make smoke-external`，真实服务 smoke 必须显式 opt-in。
- [x] 新增 GitHub Actions `ci.yml`，PR 默认运行 deterministic suite。
- [x] 新增 GitHub Actions `external-smoke.yml`，手动触发真实服务 smoke。
- [x] 更新 README 和 `docs/operations.md`，说明测试分层、命令、CI 和真实服务边界。

## Current Verification

- [x] `cd e2e && npm test -- --reporter=list`
- [x] `make smoke-local-host`
- [x] `make test`
- [x] `make build`
- [x] `make test-ci`
- [x] `bash -n scripts/smoke-local-host.sh scripts/smoke-docker-local.sh scripts/smoke-s3-document.sh scripts/smoke-external.sh`
- [x] `make smoke-docker-local`

## Boundaries

- 默认 CI 不跑 Docker smoke，避免本机 Docker 状态、镜像拉取和端口冲突影响 PR 门禁。
- 默认 CI 不跑 external smoke，避免消耗真实额度、创建 Stripe test object 或写入 S3。
- Playwright simulated E2E 只验证用户可见行为和关键网络契约；底层分支继续由 Go test / Vitest 覆盖。

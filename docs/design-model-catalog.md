# 设计:扁平模型目录(去掉 fast/deep)

> 状态:已定稿,准备实施。
> 目标:删除 `fast`/`deep` 层级概念。模型选择变成 **Manual**(用户选一个具体模型)或 **Auto**(云端 router 跑一次,从目录里挑一个模型)。
> 核心变更:**路由键从层级 `Mode∈{fast,deep}` 变成 `model_id`;`"auto"` 是一个由云端解析成 `model_id` 的特殊值。**

## 已定决策(5)

1. **Auto 解析统一放云端。** daemon 和 web 都只传 `model="auto"`,由 Go API 跑一次分类器解析成 `model_id`。一处逻辑,消除 daemon/web 分裂。
2. **所有 enabled 模型都参与 auto 候选**,admin 给每个模型配 **priority**(整数,越大越优先),用于:auto-router 的偏好/平局打破、选择器排序、默认模型。
3. **目录里不允许不支持工具的模型。** 删除 per-model `supports_tools` 标记 —— 目录天生工具可用;admin 写入时校验 provider/model 工具能力。**推论:Claude 必须等 Phase 2 实现 Anthropic 工具调用后才能加入目录。**
4. **直接 break 旧的 `mode`。** 不做 `fast→model` 翻译垫片。但未知/缺失的 `model` 值 → 回退到 `is_default` 那一行(这是合理兜底,不是层级翻译)。
5. **每模型一行,reasoning 设置冻结在该行 `params`。** 无隐藏 effort 维度。"DeepSeek 高推理" vs "低推理" = 目录两行。理由:与扁平目录一致、模型自描述、auto 只在行间选、计费按行 multiplier 清晰。

---

## 数据模型:`model_configs`(任意多行 chat 目录)

今天:每 tier 一个槽(`chat.fast`/`chat.deep`),单一赢家。
改成:**任意多行 chat 模型,每行是一个用户可选模型。**

复用/新增列(additive 迁移,SQLite `_ensure_columns` 模式 + Postgres migration):
- 复用 `slot` 作 stable id/slug(chat 行不再有 fast/deep 语义);`capability`(chat/image)保留;**image 仍是单独 `image.default` 槽,本次不动**。
- `label` TEXT — 用户可见名(如 "DeepSeek V4"、"Claude Sonnet"、"GPT-5.5")。
- `description` TEXT — 选择器 tooltip / auto 分类器的用途提示。
- `priority` INTEGER DEFAULT 0 — admin 配,越大越优先。
- `is_default` BOOL — 未指定 / 未知 model 时的兜底行(恰好一行 true)。
- ~~`supports_tools`~~ — **不加**(决策 #3:目录天生工具可用)。
- `credit_multiplier`(已有)、`params`(已有,放 reasoning_effort 等)、`enabled`(已有)。

`registry`:`bySlot` 单赢家 map → 按 id 的**多行目录**;`Resolve(mode)`→`Resolve(model_id)`;新增 `ListChatModels()`(返回 enabled chat 行,按 priority 降序);`DefaultChatModelID()`。

## Router(`llm/router.go`)

- `Select` / `MultiplierFor` / `ResolveFunc` 全部 rekey 成 `model_id`。
- **删除**:`Mode` 类型(`llm/types.go`)、`NormalizeMode`、`SlotForMode`、静态 fast/deep provider、`NewRouterWithModels`。
- 未知/空 `model_id` → `DefaultChatModelID()`。

## 新增对外接口:`GET /api/v1/models`(user-scoped 鉴权)

今天客户端没有"模型列表"来源(三个 mode 硬编码在 `ModeSelector.tsx`)。新增:
- 返回 enabled chat 行:`[{id, label, description, priority}]`,按 priority 降序。**不暴露** provider_kind/base_url/api_key 等敏感字段。
- 消费者:客户端 `ModeSelector`(Auto + 动态列表)、云端 auto 分类器(目录作为候选)。

## ⭐ Auto 解析(云端统一)

- 请求 `model="auto"` 时,云端先跑一次分类器:输入 = 目录(id+label+description+priority)+ 当前 goal/history,输出 = 一个 `model_id` + reason。
- 落点:Go API。`/agent/llm/stream` 在 `model=="auto"` 时先解析(或抽一个 `resolveModel(ctx, user, "auto", goal)` helper)。daemon 和 web **都传 `auto`**,云端解析。
- 分类 prompt:从"二选一难度"改成"从候选模型里选最合适的一个 + 理由",priority 作偏好/平局打破。
- daemon 的 `auto_router.py:classify_mode` **退役**(auto 不再在 daemon 解析);`mode.selected` 事件 → `model.selected {resolved_model_id, label, reason}`,由云端 emit(或云端回传、daemon 转发)。
- 分类那次小 LLM 调用:**免费**(不 reserve/settle),用最便宜的 default 模型跑,避免给"选模型"这件事计费。

## Provider 层 + 工具(正解 #2)

- profiles 已按 `ProviderKind`(每行)决定,基本不动。
- **Phase 2 实现 Anthropic `CompleteWithTools` + 去掉 `max_tokens=2048` 硬编码** —— 因为用户能显式选 Claude,且决策 #3 要求目录里的模型都支持工具。这是"把 Claude 加进目录"的前置。
- admin 写入校验:provider/model 必须工具可用(Anthropic 在 Phase 2 前不可加)。

## 计费

- `EstimateCredits`/`UsageCredits` 从 `(mode)` → `(model_id)`:用 `Resolve(model_id).multiplier`。
- **删除 legacy `deep=2x` 兜底**;每行 `CreditMultiplier` 已有;markup 不变;image 计费路径不变。

## 客户端 UX

- `ChatMode = 'auto' | <model_id>`(动态 union)。
- `ModeSelector`:静态三项 → **Auto(默认)+ 从 `/api/v1/models` 拉的 N 行**(label + description tooltip)。
- 持久化:存 `model_id`/`'auto'`;storage key bump `v2`;读时对照 live 目录校验,失效回退 `auto`。
- `model.selected` → 显示 "Auto → <label> · <reason>"。
- daemon schema `CreateRunRequest.mode` → `model`,**`make schemas` 重新生成** openapi.json + generated.d.ts(契约 invariant #2);SSE 事件改名要同步 `chatStore.ts` + `App.tsx`(SSE invariant #3)。
- local run 路径 + web cloud loop 都传 `model`。

## 迁移 & 兼容

- DB:additive 加列(label/description/priority/is_default)。SQLite 走 `_ensure_columns`;Postgres 走迁移文件。
- seed:现有 `chat.fast`/`chat.deep` → 目录两行(label "快速"/"深度"或具体模型名),一行 `is_default`,都 enabled,priority 区分。
- **break 旧 mode**:不翻译 `fast/pro`;未知/缺失 `model` → default 行。桌面随版本走;web 与镜像一起发,不存在版本错配。

## 分阶段落地

1. **后端目录 + 接口 + router**(✅ 已完成):加列 + 迁移 013;`ResolveModel(id)` + `ListChatModels` + `DefaultChatModelID`;`GET /api/v1/models`;router `SelectModel`/`MultiplierForModel`;计费 rekey 成 model_id;Go 各 handler `mode`→`model`(strict-decode 硬 break 旧字段);seed 改成带 label/description/priority 的目录行;daemon `backend.py` 转发 `model` 给云端。`auto` 暂解析为默认模型(highest-priority);任务感知分类器留作后续。store 双实现 lockstep + conformance。
2. **provider 工具正解**:Anthropic `CompleteWithTools` + 每模型校验 + 2048 修复。
3. **客户端 + 客户端契约**:`ModeSelector` 动态化(拉 `/api/v1/models`)+ `ChatMode` union + SSE `model.selected` + 持久化 v2;**daemon `CreateRunRequest.mode`→`model` + `make schemas`** + 客户端 `createLocalRun`/`createAgentRun`/web loop 发 `model`(这几项与客户端选择器耦合,放在一起做,避免中途回归)。
4. **admin + 收尾**:admin UI 加 label/description/priority 字段 + 工具能力校验;删 `Mode` 类型 / `auto_router.py` 旧 fast/deep 分类 / 死代码;`auto` 升级为云端任务感知分类器。

## 关键不变量(实施时必须守)
- store `memory*.go` + `postgres*.go` 双实现 lockstep(+ conformance 测试)。
- `api_schemas.py` 改动 → `make schemas` 提交 openapi.json + generated.d.ts。
- SSE 事件改名 → 同步 `chatStore.ts` + `App.tsx` 的 case。
- 平台密钥仍只在 Go API;daemon 仍走网关。
- 计费 reserve→settle/release 每条路径不漏。

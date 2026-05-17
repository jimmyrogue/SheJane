# Jiandanly Onboarding — 动态模型配置 + 统一 Credit 计费 + 生图

Updated: 2026-05-17 · 适用范围：Phase 4（动态模型配置 / 计费倍率 / 生图）已落地

这份文档是团队在「模型怎么配、费用怎么算、生图怎么接」上的**唯一对齐口径**。设计长篇见 `backend-spec.md`，运维步骤见 `docs/operations.md`，本文件讲清**为什么这样设计 + 怎么用**。

---

## 1. 一句话心智模型

- 用户余额、扣费**只有一种单位：credits**（即「token 额度」）。
- 模型配置（provider / 模型名 / key / 成本倍率 / 生图每次金额）**存 Postgres，管理后台可改，保存即时生效**，不再依赖 `.env` 重启。
- 扣费 = `用量 × 模型成本倍率 × 全局加价系数`。利润是**一个全局旋钮**，不混进每个模型。

```
文本：credits = (input + output tokens) × 成本倍率 × 加价系数      下限 1（估算下限 300）
生图：credits/张 = ceil(每次金额 ÷ 基准每token成本 × 加价系数)   再 × 张数
```

---

## 2. 两个概念，别混

| 概念 | 是什么 | 谁设 | 默认 |
|---|---|---|---|
| **成本倍率** `credit_multiplier`（每模型） | 该模型相对 **DeepSeek-V4-Pro** 的**纯成本比**，不含利润 | 按各家真实报价填，基本不动 | Pro=1.0 / Flash=0.1 |
| **全局加价系数** `markup_factor`（全局，一个数） | 产品固定毛利旋钮，全线统一加价 | 业务随时调（限 1.0–3.0） | **1.15**（加价 15%） |
| **基准每 token 成本**（全局，¥/token） | 「1 credit ≈ 1 个 Pro token 成本」的锚点，**仅生图按次换算用**；文本不需要 | 按 Pro 原价定 | **0.00002**（≈¥20/1M） |

> 1.15 = 「加价 15%」，对应毛利率 ≈ 13%（0.15 ÷ 1.15）。要 20% 毛利改成 ≈1.25。

为什么这样拆：如果对所有模型都用同一个「1.1」而不让倍率反映真实成本——用便宜模型时你超额获利、用贵模型时你亏钱。所以**成本倍率反映相对成本，利润只由全局加价系数决定**，调利润只动一个数。

---

## 3. DeepSeek 价格分析与推荐值

DeepSeek 最新价（每 1M tokens，CNY）→ 每 token = ÷1,000,000：

| | 输入(命中) | 输入(未命中) | 输出 |
|---|---|---|---|
| **Pro 原价** | ¥0.1/1M | **¥12/1M = 1.2e-5** | **¥24/1M = 2.4e-5** |
| Pro 促销(2.5折,至 2026-05-31) | ¥0.025/1M | ¥3/1M | ¥6/1M |
| **Flash**（无促销） | ¥0.02/1M | ¥1/1M = 1.0e-6 | ¥2/1M = 2.0e-6 |

我们的计费把 `input+output` 同等计、不分缓存，取「未命中 + 输入输出各半」的保守混合：

- Pro 原价混合 ≈ **1.8e-5 元/token** → 取整 **基准 = 0.00002**
- Flash 混合 ≈ 1.5e-6 → Flash/Pro ≈ 0.083 → **成本倍率取 0.1**（略保守）

**关键决策：基准锚定「Pro 原价」，不要锚促销价。** 促销只打 Pro、Flash 不打折，且 5/31 后 Pro 成本翻 4 倍；若锚促销价，到期后真实成本暴涨而扣费不变，1.15 兜不住会亏。锚原价 → 促销期白赚缓冲，到期利润依然 ~15%。缓存命中（便宜 10 倍）按未命中算同理只多赚，安全。

**推荐配置（admin → 模型配置 / 计费参数）**

| 项 | 值 |
|---|---|
| 全局加价系数 | `1.15`（10–20% 区间内随调） |
| 基准每 token 成本 | `0.00002` cny |
| chat.deep | `deepseek-v4-pro` · provider `deepseek-v4` · `https://api.deepseek.com` · 成本倍率 **1.0** |
| chat.fast | `deepseek-v4-flash` · provider `deepseek-v4` · `https://api.deepseek.com` · 成本倍率 **0.1** |
| image.default | 你的生图模型 · provider `openai-compatible` · 每次金额=供应商每张价(¥) |

对账直觉（加价 1.15）：Pro 1000 tokens → 1150 credits；Flash 1000 tokens → 115 credits；生图 ¥0.2/张、基准 2e-5 → 0.2/2e-5×1.15 = 11,500 credits/张 ≈ 10 次 Pro 千 token 对话（高消耗自然涌现，无需手动 10x/20x）。默认 `MONTHLY_CREDITS=20000` ≈ 2 万 Pro token ≈ 真实成本 ¥0.4 的免费额度，可据此设计套餐。

---

## 4. 生图（image.generate）

- 暴露为 **Agent 工具 `image.generate`**（agent 经 Cloud Tool Gateway `/api/v1/agent/tools/execute` 调用）+ 纯 REST `POST /api/v1/images/generations`，两者共用同一计费函数。
- 计费**复用外部工具账本** `external_tool_call_records`（reserve→生成→settle/release，幂等键），不污染 `llm_call_records`。
- Provider：OpenAI 兼容 `POST {base_url}/images/generations`（`MockImageProvider` 兜底）。结果当前**透传** provider 返回的 url / b64（暂不落 S3，后续可加）。
- 未配「基准每 token 成本」或无启用 `image.default` → 直接拒绝（`image_billing_not_configured` / `image_generation_disabled`），不会乱扣。

---

## 5. 关键约束 / 易踩坑

- **改模型配置或计费参数是 Go 后端无关、纯 DB**，但首次部署/改 Go 代码后要**重启 API 进程**。配置本身改完保存即时生效，无需重启。
- **种子只对空库生效**：`EnsureSeed` 仅当 `model_configs` 为空才写默认值。已有库（如现网）需在 admin **手动**把旧 `chat.deep` 倍率 2→1、`chat.fast` 1→0.1，并确认计费参数。
- **API key 加密**：必须设 `CONFIG_ENCRYPTION_KEY`（AES-GCM）；未设则明文存库 + 启动 WARN。key 永不回显，编辑时留空=保持原值。
- **CORS**：admin 走 PATCH/PUT/DELETE，已在允许方法内；新加后端方法记得同步 `Access-Control-Allow-Methods`。
- **DTO 必须与前端 payload 对齐**：`decodeJSON` 开了 `DisallowUnknownFields()`，后端结构体漏字段会整体 400 `40201`。新增可配置项要同时改：迁移 / `store.ModelConfig` / 前端 `ModelConfigInput` / 后端 `modelConfigInput` DTO + `buildModelConfigFromInput`。
- **槽位**=逻辑角色，后端按角色路由；每槽位仅一个「启用」生效（DB 部分唯一索引保证）。换模型=新建同槽位并启用，旧的自动停用。

---

## 6. 验收清单（真机）

1. 重启 API → admin「计费参数」：加价系数 1.15、基准 0.00002、cny，保存。
2. 模型配置：chat.deep 倍率→1.0、chat.fast→0.1；按需新增 image.default + 每次金额 + key。
3. 跑文本快/深对话、跑一次生图，核对 `llm_call_records` / `external_tool_call_records` 的 `credits_cost` 与公式一致；钱包按预期扣减；失败时 reservation 释放。
4. 改任一倍率/加价系数保存 → 下一次请求即时生效（无需重启）。

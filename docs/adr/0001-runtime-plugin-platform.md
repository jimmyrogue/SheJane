# ADR-0001：Runtime 原生插件平台

- 状态：Accepted
- 日期：2026-07-15
- 决策范围：Runtime、Runtime SDK、Client、插件能力包
- 实施计划：[Runtime 插件平台实施计划](../plans/runtime-plugin-platform.md)
- 调研依据：
  - [Agent 插件系统调研](../agent-plugin-systems-research.md)
  - [插件系统案例与方案调研](../plugin-system-landscape-research.md)
  - [Phase 0 Runtime 能力调研](../plugins/phase0-runtime-capability-research.md)
- Phase 0 Gate：2026-07-15 通过；68 项契约、Executor、包签名与 Office 基线测试通过
- Phase 1 Gate：2026-07-16 通过；PluginRegistry、Command/API、SDK 和只读 Plugin Tab 已完成，冻结 Runtime 启动冒烟通过

## 1. 决策摘要

SheJane 将新增一个 Runtime 原生插件平台。

插件不是新的 Agent 协议，也不是 Skill 或 MCP 的改名。它是一个可安装、可版本化、可校验、可回滚的“能力产品包”，其中最核心的执行单位是 **Action**：

- Action 使用静态 JSON Schema 描述输入和输出。
- Action 声明读取的 MIME 类型、产出的 MIME 类型、资源预算和所需权限。
- Action 只通过 Runtime 提供的受控 Interface 访问文件、产物和未来的系统能力。
- Runtime 负责版本冻结、权限判断、幂等收据、超时、隔离和产物提交。
- 插件可以同时携带 Skill、对话命令、静态资源和 MCP 绑定，但 v1 要作为“插件”展示和安装，必须至少提供一个 Action。

用户可以在输入框中直接选择插件：

- `@插件名`：将该插件作为本次 Run 的必需能力。
- `/插件:命令`：选择该插件提供的一个明确工作流。

这两种选择都以结构化字段提交给 Runtime，不通过在提示词中拼接隐藏指令实现。

按执行类型，SheJane 支持两类插件。它们共用一个 ActionExecutor Interface，并分别使用两个 Adapter：

1. WASI Adapter：适合简单、可移植、容易沙箱化的插件，默认无网络、无宿主文件系统访问。
2. Managed Worker Adapter：适合需要 Python、Node.js、原生库或重型依赖的插件，在独立进程中运行。

两个 Adapter 共享同一份 Action 契约、权限模型、收据模型和产物提交协议。Runtime 不在主进程内直接导入第三方 Python、Node.js 或原生代码。

“独立进程”只表示故障边界，不自动构成权限沙箱。Managed Worker 只有在当前平台的 OS isolation adapter 能强制文件、网络、凭据、进程和资源策略时，才可标记为 `sandboxed`；否则非受信任 Worker 必须 fail closed。

插件开发者在 manifest 中选择执行类型。SheJane 不根据“官方”或“社区”身份替开发者决定 Adapter，也不把任何 Adapter 设为特定发行者专属。包签名、发行者信息、能力授权和用户确认是独立于执行类型的安全维度。

## 2. 背景

当前 Runtime 内置了文件、Office、Skills、MCP、子 Agent 等能力。继续把 Word、Excel、PPT、PDF、图片、音视频、OCR、转写等功能逐个加入 Runtime 核心，会带来三个长期问题：

1. Runtime 体积和依赖持续膨胀，任一格式库都可能影响 Agent 主循环的稳定性。
2. 能力的安装、更新和回滚与应用版本绑定，用户无法只更新某项能力。
3. 第三方扩展只能落入 Skill、MCP 或直接修改 Runtime，缺少一个适合本地确定性工作的受控扩展面。

现有 Agent 产品中的插件通常解决“打包和分发”，而工具框架通常解决“如何把函数交给模型”。SheJane 需要把两者连接起来：既能安装和组合能力，又要由 Runtime 对执行结果负责。

## 3. 目标

本决策追求以下结果：

- Runtime 核心保持小而稳定，格式和领域能力可以独立发布。
- 同一个 Run 在重试、恢复和回放时使用完全相同的插件版本与 Action 定义。
- 用户可以显式指定插件，同时保留 Agent 自动选择已启用插件的能力。
- 简单插件可以选择低成本、高隔离的 WASI；复杂插件可以选择能力更完整的 Managed Worker。
- Office 能力按最佳长期结构迁出核心，而不是把现有代码简单套壳。
- 插件能够处理文档、表格、演示文稿、PDF、图片、音频和视频，但不改变模型选择规则。
- 控制面变更和 Action 执行都具有清晰的幂等语义。

## 4. 非目标

v1 不包含：

- 任意插件 WebView、前端脚本或自定义 Client UI。
- 任意生命周期 Hook、后台常驻任务或插件自启动。
- 把插件可执行文件加入系统 `PATH`。
- 插件之间的依赖解析。Managed Worker 对宿主管理的精确 Runtime Asset 引用不属于插件依赖：Asset 没有 Action、入口点或传递依赖。
- 插件直接修改输入文件或任意工作区路径。
- 插件未经明确授权访问网络、Shell、系统密钥或操作系统 API。
- 自动静默更新。
- 用插件替代 MCP；外部 SaaS、远程数据源和动态连接仍优先使用 MCP。
- 新建第二套 Agent Run Loop，或让斜杠命令绕过现有 P1-P12。
- 自动切换模型或静默降级到其他提供方。

## 5. Runtime 阶段归属

### 5.1 primary_stage

本功能的 `primary_stage` 是 **P6：绑定资源并取得 Agent 定义**。

P6 负责根据已冻结的选择加载精确插件版本、取得执行资源租约、生成固定 Action 目录，并把插件目录摘要纳入 Agent definition fingerprint。

### 5.2 相邻阶段

- 上游 P5：从权威存储恢复只读 execution context，其中包含 P3 已冻结的插件绑定。
- 下游 P7：使用固定 Agent definition 启动或恢复 LangGraph；插件定义不兼容时拒绝静默恢复。

同时受影响的阶段：

- P2：Client 将 `@插件` 和 `/插件:命令` 编译为结构化 Command 字段。
- P3：校验选择、兼容性与摘要前置条件，并原子冻结精确插件绑定。
- P10：执行 Action，计算 operation identity，复用审批、收据、重试和产物协议。
- P11：释放 WASI 实例、Worker、临时目录与能力租约。
- P12：原子提交 Action 收据、产物、事件和终态。

### 5.3 状态所有权

- Runtime Plugin Registry 是安装包、版本、摘要、签名状态、执行类型、能力授权和启用状态的权威状态所有者。
- Run 是本次执行所绑定插件版本和目录摘要的权威状态所有者。
- Client 只保存 Runtime 投影与待提交命令，不拥有插件安装真相。

### 5.4 被替换的旧路径

当前旧路径由 `runtime/src/shejane_runtime/agent/builder.py` 直接装配静态工具和 MCP 目录，Office 工具由 `runtime/src/shejane_runtime/tools/registry.py` 静态注册，并在 tool visibility 中存在 Office 专属规则。

迁移完成后：

- Office 不再由 Runtime 核心静态注册。
- Agent builder 通过 PluginCatalog 取得固定 Action 工具视图。
- Office 专属 visibility 规则被通用的 Action 能力与 MIME 元数据替代。
- 现有 ToolReviewMiddleware、ToolExecutionMiddleware、收据和 Artifact 流程继续作为唯一执行路径。

本 ADR 不增加新的 P 阶段编号。

## 6. 统一术语

### 6.1 Plugin

可安装、可版本化的能力产品包。它提供元数据和若干 contribution。

### 6.2 Action

插件中确定性较强、可由 Runtime 调用和校验的执行单位。Action 最终适配成 Agent 可见工具，但它的生命周期和安全边界由 Runtime 管理。

### 6.3 Skill

面向模型的过程知识和工作方法。Skill 可以教 Agent 如何组合 Action，但本身不是受控执行单元。

### 6.4 MCP

连接外部进程、服务或数据源的开放协议。插件可以声明一个 MCP 绑定，但 MCP Server 仍遵循 MCP 自身的信任和生命周期模型。

### 6.5 Plugin Command

插件提供的、可由用户通过斜杠直接选择的命名工作流。它由说明、默认参数和必需 Action 集合组成，仍通过正常 Agent Run Loop 执行。

## 7. 插件包契约

### 7.1 包格式

- 文件扩展名：`.shejane-plugin`
- 包内清单：`.shejane-plugin/plugin.json`
- 包内容采用内容寻址存储，主键为整个规范化包的 SHA-256 摘要。
- 安装后复制到 Runtime 数据目录；普通模式不从原始路径原地执行。

建议目录：

```text
example.shejane-plugin/
├── .shejane-plugin/
│   └── plugin.json
├── actions/
├── skills/
├── commands/
├── assets/
└── payload/
```

### 7.2 清单最小形态

```json
{
  "schema_version": 1,
  "id": "com.shejane.documents",
  "version": "1.0.0",
  "name": "Documents",
  "publisher": {
    "id": "shejane",
    "name": "SheJane"
  },
  "runtime": {
    "min_version": "0.2.0",
    "execution": {
      "kind": "managed_worker",
      "entrypoint": "payload/worker"
    }
  },
  "contributions": {
    "actions": [
      {
        "id": "document.render",
        "input_schema": "actions/document.render.input.json",
        "output_schema": "actions/document.render.output.json",
        "consumes": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        "produces": ["application/pdf", "image/png"],
        "effects": ["read", "artifact"],
        "determinism": "input_stable",
        "limits": {
          "timeout_ms": 60000,
          "memory_mb": 512,
          "output_mb": 128
        }
      }
    ],
    "skills": [],
    "commands": []
  }
}
```

正式 schema 在 Phase 0 冻结。清单中的路径必须是包内相对路径，禁止绝对路径、父目录穿越和符号链接逃逸。

### 7.3 Action 必需声明

每个 Action 必须声明：

- 插件内稳定 `id`。
- 输入和输出 JSON Schema。
- `consumes` 和 `produces` MIME 类型。
- effect：v1 仅允许 `read` 和 `artifact`。
- determinism 等级。
- 超时、内存和输出上限。
- 所需 capability。
- 对应的执行入口。

插件不能自行决定最终工具名。Runtime 使用插件 ID、Action ID 和版本摘要生成无冲突的内部身份，并提供稳定的模型可见名称。

每个插件包必须选择一种 `runtime.execution.kind`：

- `wasi`
- `managed_worker`

v1 不允许一个插件包混用两种执行类型。需要同时使用时拆成两个可独立安装、版本化和授权的插件。

### 7.4 contribution 规则

插件包可以贡献：

- Actions
- Skills
- Plugin Commands
- 静态资源
- MCP 绑定

v1 中，只有至少包含一个 Action 的包才进入“插件”Tab。仅包含 Skill 的内容继续作为 Skill 分发；仅包含 MCP 配置的内容继续作为 MCP 配置分发。

## 8. 架构决策

### 8.1 PluginRegistry Module

PluginRegistry 是控制面的 Deep Module。它隐藏归档校验、内容寻址存储、签名验证、兼容性判断、事务激活、并存版本和垃圾回收。

它提供较小的 Interface：

- install
- list
- inspect
- enable
- disable
- update
- rollback
- retire

安装、启用、更新、回滚和移除必须通过现有 Runtime Command 日志执行，复用 command idempotency key 和 CommandReceipt。

### 8.2 PluginCatalog Module

PluginCatalog 是执行目录的 Deep Module。它接收 P3 冻结的插件绑定和 P5 execution context，返回一个不可变的 `PluginExecutionLease`：

- 精确插件 ID、版本和包摘要。
- 固定 Action、Skill 和 Command 视图。
- Action catalog hash。
- Runner 资源租约。
- 关闭和清理能力。

Agent builder 只依赖这个窄 Interface，不读取安装目录，也不判断包格式。

### 8.3 ActionExecutor Interface 与执行 Seam

ActionExecutor 是 Runtime 内部 Interface：

```text
invoke(action_ref, invocation_context) -> action_result
```

它构成真实的 Seam，因为存在两个生产 Adapter：

- `WasiActionAdapter`
- `ManagedWorkerActionAdapter`

两个 Adapter 必须通过同一套 conformance tests。测试中的 FakeActionExecutor 也实现同一个 Interface，使 Agent、收据和 Artifact 测试不依赖具体沙箱。

`runtime.execution.kind` 是公开的插件契约，由开发者根据依赖和隔离需求选择。Runtime 校验当前平台是否支持该 Adapter，并根据用户或部署方的安全策略决定是否允许安装和运行。

### 8.4 PluginToolAdapter

PluginToolAdapter 将固定 Action 描述适配为当前 LangChain 工具形态。它不自行执行权限、重试或持久化，而是进入现有：

```text
ToolReviewMiddleware
  -> ToolExecutionMiddleware
  -> ActionExecutor
  -> staged artifacts
  -> receipt and commit
```

这样插件工具与核心工具共享审批、`prepared/running/completed/failed/outcome_unknown` 状态、完成收据回放和大结果 Artifact 化。

## 9. 执行隔离

### 9.1 WASI Adapter

适合不依赖宿主语言运行时和重型系统库的插件：

- 默认无网络。
- 默认看不到宿主文件系统。
- Runtime 只把已授权输入 bytes 传给 Component，不向 guest 暴露宿主路径或 WASI filesystem。
- Component 返回候选 Artifact bytes，由 Runtime 校验后写入 staging；guest 本身看不到输出目录。
- CPU、内存、时间和输出大小都受限。
- 不允许启动子进程。

Phase 0 spike 选择直接使用 Wasmtime Component Model。Host 不调用 `add_wasip2()`，未定义 import 一律 trap；Rust 运行时所需的 `wasi:random/insecure-seed` 被替换为固定 deterministic seed。Extism 不进入 v1 依赖。这个内部 ABI 不改变 ActionExecutor Interface；未来只有在内存传输成为可测瓶颈时才增加受控流式资源。

### 9.2 Managed Worker Adapter

适合 Documents、Spreadsheets、Presentations、媒体处理或其他需要成熟语言生态与原生依赖的插件：

- Worker 在 Runtime 主进程之外启动。
- Worker 通过版本化 IPC 协议接收 ActionInvocation。
- Worker 只取得临时输入目录、输出目录和短期 capability grant。
- Python、Node.js 等 Worker 私有依赖被封装在 Worker 自身发行物中；LibreOffice 等被多个插件复用的大型确定性引擎可作为精确摘要绑定的只读 Runtime Asset。
- Worker 崩溃不能带崩 Runtime；超时后可被强制终止。
- Worker 版本和依赖摘要纳入插件包摘要及运行绑定。
- v1 每次 Action 启动一个短命 Worker；不做进程池、后台守护或跨调用内存复用。
- stdio 只承载有界、版本化的 JSON-RPC 控制帧；大文件通过 input/output staging 交换。

任何开发者都可以创建 Managed Worker 插件。签名只证明来源和完整性，不自动授予权限。更强的风险提示和用户确认不能替代 OS 强制隔离；当前平台不能落实声明的边界时，非受信任 Managed Worker 不得启用。

Phase 0 的初始状态记录在 [`docs/plugins/managed-worker-isolation.md`](../plugins/managed-worker-isolation.md)，后续一手资料复核与目标架构记录在 [`managed-worker-agent-sandbox-research.md`](../plugins/managed-worker-agent-sandbox-research.md)。统一的是 Action/Artifact/receipt/limits/Gate，不要求三个平台使用同一种 OS primitive：Linux 目标为 bubblewrap + seccomp + cgroup v2 + sized tmpfs；macOS 使用 Virtualization.framework 本地短命 Linux VM；Windows 原生 AppContainer/Job 路线因普通用户权限下无法提供固定容量 scratch 而停止，改用 LPAC/Job 包裹的 QEMU Linux VM。macOS 与 Windows 的 `host_platform` 保留宿主 OS，但 package 与 Runtime Asset 声明 guest `execution_platform=linux/<arch>`，同架构 Linux 资产可以复用。远程 sandbox 仅是可选 executor，trusted-native 明确不算 sandbox。各 target 在打包黑盒 Gate 通过前都必须报告 `sandboxed=false` 并禁用非受信任 Worker。

## 10. 文件、Artifact 与幂等性

### 10.1 输入

- Runtime 继续负责工作区授权。
- 输入文件在调用前被解析为稳定 file reference，并计算内容摘要。
- Adapter 只获得本次 Action 所需输入的只读视图。
- 插件不得就地修改输入文件。

### 10.2 输出

- Action 只能写入本次调用的 staging output。
- Runtime 校验输出 schema、MIME、数量和大小。
- Runtime 计算摘要后，才把输出发布为 Artifact。
- Action 失败、崩溃或超时时，staging output 不得成为已提交 Artifact。

### 10.3 operation identity

Action 调用的 operation identity 至少包含：

- Run 和执行尝试身份。
- 插件包摘要。
- Action ID 与 Action schema 版本。
- 规范化输入参数。
- 输入文件摘要。
- 生效的 capability grant 摘要。

具体实现复用现有 `tool_operation_identity`：插件层把 package/schema/input/grant/limit/environment 规范化为 `plugin-action-v1` tool version digest，现有工具层继续加入 Run、namespace、tool call、tool name 和 arguments。`invocation_id` 只标识一次尝试，不进入稳定摘要。

完成收据存在时直接重放结果，不再次执行 Action。清单中的 determinism 声明只用于调度和可观测性，不替代 Runtime 收据。

## 11. 安装、版本和生命周期

### 11.1 安装

安装顺序：

1. 检查压缩包大小、文件数量、展开后大小和压缩比。
2. 拒绝路径穿越、危险链接和重复规范化路径。
3. 校验 manifest 与所有 JSON Schema。
4. 校验 Runtime/平台兼容性。
5. 计算规范化包摘要。
6. 验证发行者签名状态和本机安装策略。
7. 写入 staging store。
8. 在 SQLite 中事务激活。

任一步失败都不能产生半安装状态。

### 11.2 来源、签名与执行权限

Runtime 分别记录：

- 发行者声明。
- 包是否签名、签名是否有效以及签名身份。
- 安装来源。
- `runtime.execution.kind`。
- 用户或部署策略授予的能力。

这些字段不合并成“官方/社区”信任等级。开源部署方可以要求签名，也可以允许用户确认后安装未签名包。签名只证明包来源与完整性；是否允许 Managed Worker、网络、文件或其他能力仍由本机策略和用户授权决定。

v1 使用 detached Ed25519 envelope 覆盖 canonical package SHA-256。Runtime 的安装策略提供受信公钥并校验 key ID；包内自带公钥不能自行建立信任。签名文件不进入 package digest，以避免循环签名，但任何其他文件变化都会改变 digest。

Phase 1 将安装策略具体化为部署方拥有的本地只读 trust store：同一 publisher 可配置多把 Ed25519 公钥用于轮换，每把 key 都有稳定 key ID、publisher 绑定、trusted/revoked 状态以及可选生效和过期时间。该设计沿用成熟扩展系统把“包签名有效”和“是否信任发行者”分开的做法；未来接入自托管来源时，可以由签名目录或 TUF/Sigstore 类根信任更新这个策略，但插件包本身永远不能增加受信 key。依据包括 [VS Code Extension Runtime Security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)、[npm registry signature keys](https://docs.npmjs.com/cli/v9/commands/npm-audit/) 和 [Sigstore threat model](https://docs.sigstore.dev/about/threat-model/)。

### 11.3 版本冻结

- P3 将精确插件 ID、版本和摘要写入 Run binding。
- P6 按 binding 取得资源租约和固定目录。
- 插件更新只影响之后创建的 Run。
- 活跃或可恢复 Run 始终使用原摘要。
- 精确版本缺失时返回 `plugin_version_unavailable`，不静默改用新版。

### 11.4 更新与卸载

- 支持并存版本和手动回滚。
- v1 不自动更新。
- 卸载先进入 retired 状态，不再用于新 Run。
- 被非终态 Run 引用的版本不得物理删除。
- 已完成 Run 保留绑定元数据；若旧包已回收，基于旧 checkpoint 的 fork 必须明确失败或由未来的 rebase 流程处理。

## 12. 对话框引用协议

### 12.1 `@插件`

用户在 Composer 输入 `@` 后选择一个已安装插件。UI 显示插件 chip，但提交给 Runtime 的是稳定 ID：

```json
{
  "plugin_refs": [
    {
      "plugin_id": "com.shejane.documents",
      "required": true,
      "expected_digest": "sha256:..."
    }
  ]
}
```

语义：

- 该插件必须已安装、已启用且兼容。
- `expected_digest` 是可选的客户端前置条件，不是权威版本。
- Runtime 在 P3 重新校验并冻结真实摘要。
- 插件不可用时本次 Command 被明确拒绝。
- 引用插件不等于授予额外权限。

允许一次引用多个插件；最终数量由协议 schema 限制。

### 12.2 `/插件:命令`

用户在 `/` 菜单中选择插件命令：

```json
{
  "plugin_command": {
    "plugin_id": "com.shejane.documents",
    "command_id": "document.review",
    "expected_digest": "sha256:..."
  }
}
```

v1 每次提交最多一个 Plugin Command。Runtime 验证 Command 所需 Action 都在固定目录中，然后把命令工作流作为结构化运行输入交给现有 Agent Run Loop。

它不是本地快捷脚本，也不直接绕过模型、权限或 ToolExecutionMiddleware。

### 12.3 无显式引用

如果用户没有显式引用，P3 可以冻结当前已启用且与本次上下文兼容的插件集合，供 Agent 自动选择。显式引用的插件必须始终出现在固定集合中。

### 12.4 Composer 实现约束

- 复用现有 Lexical 编辑器和自定义 token 机制。
- `@` 提供插件选择菜单。
- `/` 菜单增加插件命令分组。
- Draft parser 产生 `plugin_refs` 和 `plugin_command`，不得把它们拼成隐藏 prompt directive。
- Runtime 将规范化选择写入用户消息元数据，以便历史记录稳定渲染。
- 活跃 Run 的 steering 不得改变 P3/P6 已冻结的插件目录。v1 在 steering 模式禁用新增插件引用；需要新插件时创建新的 Run。

## 13. Runtime 协议与持久化

### 13.1 HTTP 和 Command

读取接口：

- `GET /v1/plugins`
- `GET /v1/plugins/{plugin_id}`

变更继续走：

- `POST /v1/commands`

新增 Command 类型：

- `plugin.install`
- `plugin.enable`
- `plugin.disable`
- `plugin.update`
- `plugin.rollback`
- `plugin.remove`

`CreateRunRequest` 和相关 fork/retry 请求增加结构化 `plugin_refs` 与可选 `plugin_command`。Runtime capability 集增加 `plugins`。

Pydantic schema 仍是协议真相源，TypeScript SDK 由 `make schemas` 生成，禁止手工维护重复类型。

### 13.2 SQLite

计划新增以下权威记录：

  - `plugin_versions`：包 ID、版本、摘要、manifest、兼容性、签名状态、执行类型、安装和 retired 状态。
- `plugin_installations`：principal 下的启用版本、来源、配置 revision。
- `run_plugin_bindings`：Run 绑定的精确版本、摘要、选择来源、Command 和 Action catalog hash。

现有 tool receipts 和 artifacts 继续承载 Action 结果，不新增平行的 plugin receipt 系统。

## 14. 工具发现

- 显式 `@` 选择的插件 Action 直接进入本次固定工具视图。
- 已启用插件数量较小时，可以继续直接暴露工具。
- 当 Action 总量超过当前工具目录的安全规模时，把现有 MCP 专用延迟搜索泛化为统一 `tool.search`。
- 不新增与 `mcp.search_tools` 并列的 `plugin.search` 长期分叉。

统一搜索属于容量触发的后续工作，不是 v1 的前置条件。

## 15. Plugin Tab

Client 左侧能力区新增“插件”Tab，使用 SheJane 现有视觉系统。它只渲染 Runtime 返回的可信结构化数据。

页面分区：

- 已安装
- 可用来源
- 本地导入

最小信息：

- 名称、稳定 ID、发行者和签名状态。
- WASI 或 Managed Worker 执行类型。
- 当前版本、可用更新和 Runtime 兼容性。
- Action、Skill 和 Command 清单。
- 所需权限与支持的文件类型。
- 已启用、禁用、需要更新、不兼容或 retired 状态。

操作：

- 安装
- 启用/禁用
- 更新
- 回滚
- 移除

v1 配置使用宿主渲染的类型化表单，不允许插件注入 React、HTML 或 WebView。

## 16. Office 的目标形态

Office 不作为一个巨型插件发布，而拆为三个独立插件：

- Documents
- Spreadsheets
- Presentations

PDF 作为独立插件演进，因为它同时服务文档、网页和媒体工作流。

三个 Office 插件可引用同一个平台专属、内容寻址的 Office Runtime Asset。Asset 不是插件，没有 Action 或独立执行能力；它只避免重复分发固定的 LibreOffice、MuPDF、字体、许可证和 SBOM 字节。

迁移原则：

1. 先用当前 `office.py` 行为建立契约测试和 golden fixtures。
2. 再按 Documents、Spreadsheets、Presentations 顺序迁移到 Managed Worker。
3. 每个插件分别达到读取、创建、修改、渲染和 Artifact 输出的目标契约。
4. 兼容性和结果质量通过后，删除核心静态注册与 Office 专属 visibility。
5. 不在新旧两条生产路径上长期双写。

现有实现是行为基线，不是未来插件 API 的结构模板。

Phase 0 基线记录在 [`docs/plugins/office-behavior-baseline.md`](../plugins/office-behavior-baseline.md)。当前 51 项测试覆盖结构、编辑、公式文本、样式、copy-on-write 与原子回滚；渲染像素、公式重算和跨平台布局仍是生产 Office 插件必须新增的 Gate。

## 17. 多模态能力

媒体插件通过 MIME 契约工作，不依赖聊天模型本身必须原生理解图片或视频。

推荐拆分：

- Media Foundation：探测元数据、抽帧、缩略图、音轨分离和格式转换。
- OCR：图片和扫描文档转结构化文本。
- Speech：音频转写、时间戳和说话人信息。
- Vision：对图片或关键帧进行视觉理解。

Vision 可以使用本地模型或用户明确配置的云模型，但必须：

- 标明具体提供方和模型。
- 记录输入摘要与输出 provenance。
- 遵守 Runtime 的模型与 BYOK 规则。
- 不静默切换聊天模型或提供方。

本地和云端是同一 Vision 能力的两个显式 backend，不是新的插件执行类型：

- 本地 backend 仍使用 `managed_worker`，只读取授权图片和精确、内容寻址的视觉 Runtime Asset。
- 云端 backend 仍使用 `managed_worker`，但 Worker 不获得密钥、provider base URL 或通用网络。它只能在显式授权后通过受限的 Runtime host call 请求一次具体视觉模型推理。
- 云端 backend 使用 `model.vision.invoke` capability、安装级不可变模型绑定和有界双向 Worker 协议；Runtime 已实现单次 host call、输入/生成配额、凭据隔离、出站脱敏、禁重试、安全 provenance 与威胁模型。fake local/cloud Action/Worker 已验证共同契约；真实质量 Gate 完成前仍不得用通用 HTTP、把凭据放进 Worker 或宣称产品能力。
- 同一个 Action 不得在本地、云端或当前聊天模型之间 fallback。云端结果标记为 `nondeterministic`；幂等性只保证同一 Operation 不被重复执行/计费。

Phase 6 的具体研究和实施顺序见 [`phase6-vision-research.md`](../plugins/phase6-vision-research.md)。

## 18. 安全不变量

- 任何插件代码都不进入 Runtime 主进程。
- WASI 与 Managed Worker 都可由任意开发者选择；执行类型本身不代表可信。
- Managed Worker 安装和高风险能力必须经过明确用户或部署策略授权。
- 输入只读，输出先 staging 后提交。
- 插件不能扩大 Runtime 已授权的工作区边界。
- v1 插件默认无网络、Shell、系统密钥和后台执行；新增能力必须单独设计和授权。
- Managed Worker 只能使用 Runtime 发放的短期 capability grant。
- 密钥不进入 manifest、SQLite 明文、环境快照、日志或模型上下文。
- 所有安装和 Action 操作都具有稳定身份和可审计收据。
- 插件显示名不能覆盖稳定 ID，也不能造成核心工具名冲突。
- 更新不能改变已接受 Run 的 Agent definition。

## 19. 错误模型

协议至少区分：

- `plugin_not_installed`
- `plugin_disabled`
- `plugin_incompatible`
- `plugin_digest_mismatch`
- `plugin_signature_invalid`
- `plugin_version_unavailable`
- `plugin_action_not_found`
- `plugin_capability_denied`
- `plugin_runner_unavailable`
- `plugin_execution_timeout`
- `plugin_result_invalid`
- `plugin_artifact_commit_failed`

错误必须说明可恢复方式，不能以“工具不存在”掩盖版本、权限或兼容性问题。

## 20. 被否决的方案

### 20.1 只复制 Codex/Claude 的目录插件

拒绝。它擅长组合和分发，但允许任意脚本或 Hook 时，无法满足 SheJane 的隔离、幂等收据和 Run 恢复要求。

### 20.2 只使用 MCP

拒绝。MCP 适合外部服务和动态工具，但不负责本地包安装、内容寻址、Action 产物提交和版本冻结。

### 20.3 只支持 WASM/WASI

拒绝。它适合高隔离场景，但会显著限制 Office、媒体、OCR 和成熟 Python/原生库的最佳实现。

### 20.4 在 Runtime 内直接导入 Python/Node 插件

拒绝。依赖冲突、崩溃传播、更新与卸载、权限边界都不可接受。

### 20.5 保持 Office 永久内置

拒绝。它会持续放大 Runtime 核心，并让后续 PDF、媒体能力再次复制同一问题。

### 20.6 让斜杠命令直接执行插件

拒绝。这会建立第二套权限、收据、Artifact 和生命周期路径，并破坏 P1-P12 的单一 Run Loop。

## 21. 后果

正面后果：

- Runtime 核心和领域依赖解耦。
- 插件可独立安装、更新、回滚和审计。
- Run 恢复具有明确的版本与资源语义。
- 用户能直接指定能力，不必依赖模型猜测。
- 简单插件的高隔离和复杂插件的完整依赖生态不再二选一。

成本：

- 需要维护 WASI 与 Managed Worker 两套 Adapter。
- 需要包签名、目录、跨平台 Worker 和垃圾回收能力。
- Office 迁移前会有一段受控的双实现验证期。
- Composer、Runtime 协议和 SDK 都需要新增结构化引用。
- 发布测试矩阵扩大到插件版本、平台、沙箱和旧 Run 恢复。

## 22. 实施前 spike

以下问题不阻塞架构决定，但必须在相应 Phase 的 gate 前完成：

1. WASI runtime 选择：比较 Wasmtime 与 Extism 的组件模型、资源限制、跨平台打包和 Python 宿主成本。
2. 插件签名格式：比较 Sigstore bundle 与可自托管的离线签名链。
3. Managed Worker OS 沙箱：分别验证 macOS、Windows、Linux 的进程、文件和网络限制。

这些 spike 只能影响 Adapter 或发布实现，不得扩大 ActionExecutor Interface。

## 23. ADR 验收条件

本 ADR 转为 Accepted 前，需要确认：

- Action manifest schema 和 invocation/result envelope 有版本化草案。
- P3/P6/P10/P12 的状态与失败语义通过架构评审。
- 两个 reference fixture 能证明执行 Seam：一个 WASI Archive 插件和一个 Managed Worker Documents 插件。
- Threat model 覆盖安装包、签名、目录穿越、压缩炸弹、输入授权、Worker 隔离和 Artifact 提交。
- 实施计划中的 Phase 0 gate 已完成。

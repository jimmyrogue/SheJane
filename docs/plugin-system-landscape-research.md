# 可安装应用插件系统案例调研

> 检索日期：2026-07-15
> 范围：确定性、本地优先、可安装或自建的应用插件系统
> 来源约束：只使用官方文档、官方规范和官方源代码仓库
> 本文只记录事实、优缺点和可借鉴机制，不提出 SheJane 方案

## 摘要

这些案例没有提供一个同时解决“分发、权限、隔离、生命周期和幂等”的完整答案。成熟体系通常把问题拆成几层：

- **包与目录层**：VSIX、MCPB、GitHub Release、OCI Artifact 等负责身份、版本、兼容性和分发。
- **宿主扩展层**：VS Code、Raycast、Obsidian、Home Assistant 负责加载、卸载、配置和更新。
- **能力边界层**：MCP Apps 的 iframe/CSP、WASI/Extism 的显式 imports、系统权限或宿主 API 决定代码能接触什么。
- **供应链信任层**：商店审核、签名、内容摘要、发布者身份和阻止列表解决“拿到的是不是预期代码”。
- **操作语义层**：JSON Schema、稳定标识、`idempotentHint`、唯一 ID、结构化错误和重试状态解决“同一次工作能否安全重放”。

最稳定的共识是：**声明不是执行保证**。MCP 的工具注解只是提示；VS Code、Obsidian、Raycast 和 Home Assistant 的插件代码仍继承宿主进程的大量权限；OCI 摘要保证内容完整性但不等于发布者可信；只有宿主真正限制 capability、校验包、控制生命周期并约束副作用时，确定性才成立。

## 事实矩阵

| 体系 | 分发与清单 | 权限与隔离 | 生命周期与更新 | 幂等与重试 | 主要优点 | 主要缺点 |
| --- | --- | --- | --- | --- | --- | --- |
| ChatGPT Apps SDK / MCP Apps | 远程 MCP endpoint；工具和 UI resource 由协议发现；公开发布走扫描、审核和版本快照 | UI 使用隔离 iframe、独立 origin、CSP 和权限策略；工具授权仍由 server/host 执行 | MCP 初始化/运行/关闭；公开元数据按审核版本发布，live server 继续提供调用与资源 | `idempotentHint` 可声明可重放；它只是提示，server 必须实现真正幂等 | 标准化工具、结构化输出和嵌入 UI；风险元数据明确 | 更像远程应用协议，不是离线本地二进制插件；正确性仍取决于远程 server |
| Claude Desktop extensions / MCPB | `.mcpb` 是带 `manifest.json` 的 zip，可包含 Node、Python 或二进制 stdio MCP server | 清单可声明用户配置和敏感字段，但本地 server 本身不是 capability sandbox | 宿主安装并启动 stdio server；MCP 定义连接初始化、运行、关闭 | 沿用 MCP 的结构化错误和工具注解；包格式没有事务或幂等执行语义 | 单文件安装，本地资源能力强，语言/运行时选择多 | 捆绑原生依赖复杂；本地进程安全边界弱；包格式与执行安全是两回事 |
| Obsidian community plugins | `manifest.json` + GitHub Releases 中的 `main.js`、可选 CSS；官方目录维护索引 | Restricted Mode 默认阻止第三方代码；启用后插件继承 Obsidian 权限，无法可靠做细粒度限制 | `onload` / unload；注册式 API 自动清理事件；按 SemVer 和兼容版本取 release | 没有插件级重试/幂等协议；`Vault.process()` 提供单文件原子式读改写语义 | 生态门槛低、安装模型清楚、用户数据本地 | 插件可读文件、联网和安装程序；JavaScript 包权限过大 |
| VS Code extensions | `package.json` manifest；Marketplace 或 `.vsix`；Contribution Points 是声明式扩展点 | extension host 与 VS Code 权限相同；Workspace Trust 和 capabilities 可降级功能，但不是通用逐权限 sandbox | activation events 惰性激活；`activate` / `deactivate`；自动更新和 uninstall hook | 无通用幂等协议；由具体命令/API 自行保证 | 声明式贡献点 + 惰性激活成熟；签名、扫描、发布者信任和 block list 完整 | 运行时代码仍可读写文件、联网、启动进程；安全主要依赖信任和商店治理 |
| Raycast extensions | `package.json` 声明 commands、tools、preferences；公开扩展通过官方 GitHub PR 审核入库 | 每个扩展在独立 V8 isolate；但 Node 文件、网络能力没有进一步 sandbox；敏感配置进加密存储 | command 启动即加载，退出即卸载；内存超限终止；商店自动更新且只有隐式 latest | 没有通用幂等契约；短命令生命周期鼓励无持久内存状态 | 本地优先、命令粒度清楚、开源审核、短生命周期简单 | 缺少版本回退选择和细粒度权限；V8 隔离不等于 OS capability 隔离 |
| Home Assistant integrations | 每个 integration 有 `manifest.json`；官方集成随 Core 发布，custom integration 可手动/HACS 安装 | integration 运行在 Home Assistant 内；custom code 可影响整个实例，没有进程隔离 | Config Entry 有 setup、retry、loaded、unload、remove、migration 等显式状态 | `ConfigEntryNotReady` 自动退避重试；稳定 unique ID 阻止重复配置；更新协调器支持 `retry_after` | 生命周期、恢复、迁移和质量门槛最系统化 | 强宿主耦合；第三方集成故障或漏洞可伤及整个实例 |
| WASI / Wasmtime Component Model | Wasm component 是带 WIT imports/exports 的可移植二进制；WIT package 提供版本化接口契约 | 未导入的能力不可用；Wasmtime 默认无 env、args、preopen，网络地址默认拒绝；可加内存、实例、fuel/epoch 限额 | host 创建/销毁 Store 和 instance；resource handle 有 own/borrow/drop 生命周期 | WIT 不定义幂等；host 可用纯函数接口、内容摘要、短命 Store 和可重建状态获得可重试性 | 能力边界强、跨语言、接口可验证、资源限制可执行 | 生态和工具链成本高；文件格式不解决商店、签名、发现、更新和数据迁移 |
| Extism | 插件是 Wasm module；Host SDK 负责装载并调用导出函数，Manifest 配置运行能力 | 原始 Wasm 默认没有文件、syscall 或宿主内存能力；Host Functions 是显式 imports；host 可按域名、目录和 WASI 开关授权 | host 创建 Plugin 实例并调用导出函数；可配置 timeout、最大内存、变量和 HTTP 响应尺寸 | 没有通用事务或幂等协议；host 可用受控配置、输入输出和能力实现可重放边界 | 把 Wasm 隔离、跨语言 SDK 和 capability 注入封装为可直接采用的插件框架 | 不提供完整商店、签名、审核、自动更新或业务数据迁移；Host Function 仍可能授权过宽 |
| OCI Artifact + Sigstore | OCI manifest/layout/registry 可分发任意 artifact；descriptor 以 digest 内容寻址；Sigstore/Cosign 附加签名和证明 | OCI 不执行代码，因此不提供 runtime sandbox；它解决包传输与供应链信任 | registry 支持 push/pull、tag、digest、referrers、分块续传；版本策略由上层定义 | 内容地址天然去重；HEAD 检查、分块 offset 和 digest 校验支持安全重试 | 复用成熟 registry、缓存、镜像和签名基础设施 | 规范体量大；tag 可变；签名策略、兼容性、权限和执行生命周期仍需宿主定义 |

## 1. ChatGPT Apps SDK 与 MCP Apps

### 已验证机制

OpenAI Apps SDK 以 MCP 为工具和数据协议，并已转向优先使用 MCP Apps 标准字段和 `ui/*` bridge。工具通过输入/输出 JSON Schema 暴露，UI resource 在 ChatGPT 中以组件呈现；公开 app 现在作为 plugin 的一部分提交和发布。[OpenAI Apps SDK Reference](https://developers.openai.com/apps-sdk/reference) [OpenAI app submission](https://developers.openai.com/apps-sdk/deploy/submission)

MCP Apps 为 UI 定义了独立于核心 MCP 的扩展协商。Web host 必须在不同 origin 的 sandbox 中渲染 View，执行 CSP，默认禁止未声明的 frame、object 和外部连接；UI 与 host 只通过 `postMessage` 上的 JSON-RPC 通信。host 仍应验证消息、控制工具代理并保留审批权。[MCP Apps 2026-01-26 specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

工具可以声明 `readOnlyHint`、`destructiveHint`、`openWorldHint` 和可选的 `idempotentHint`。OpenAI 明确说明这些字段只影响客户端如何表述和审批调用，server 仍需执行自己的授权逻辑；MCP 规范也要求客户端把 tool annotations 视为不可信，除非来自可信 server。[OpenAI Apps SDK annotations](https://developers.openai.com/apps-sdk/reference#annotations) [MCP Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

公开分发不是上传一个本地 bundle。提交门户扫描 MCP endpoint 的工具、schema、security scheme、annotation、UI metadata 和 CSP，并把它们冻结为审核版本；工具调用和 UI resource 仍来自 live server。破坏性 schema 或 resource 变更没有透明迁移机制，官方要求保持旧契约、先发布兼容新增，再切换版本。[OpenAI app version maintenance](https://developers.openai.com/apps-sdk/deploy/submission#ongoing-maintenance)

MCP 本身定义初始化、能力协商、正常运行和关闭；请求应有超时，超时后发送取消并停止等待；工具执行错误应返回给模型用于调整参数后自纠。协议没有为副作用操作规定幂等 key、事务或 exactly-once 语义。[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) [MCP tool error handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling)

### 优点

- 输入和输出 schema、风险提示、OAuth、安全 UI bridge 与宿主审批有明确标准边界。
- UI sandbox 的 CSP 与显式 permissions 比普通 Electron 插件直接操作宿主 DOM 更容易审计。
- 元数据审核快照把“模型看到的契约”从 live server 代码中部分解耦。

### 缺点

- `idempotentHint` 是自述，不是运行时保证；调用重试是否安全仍取决于 server 实现。
- Apps SDK 主要描述远程 MCP 应用，并不提供本地文件包、离线依赖或 OS 级代码隔离。
- UI 被隔离不代表工具 server 被隔离；server 的网络、数据和副作用仍在 iframe 之外。

### 可借鉴机制

- 工具输入/输出 schema 与结构化错误。
- 把“只读、破坏性、开放世界、可幂等”作为显式风险词汇，但不把声明当作安全证明。
- 独立 origin + CSP allowlist + JSON-RPC bridge 的 UI 隔离。
- 审核时冻结公开契约，兼容新增后再切换版本。

## 2. Claude Desktop extensions 与 MCPB

### 已验证机制

MCP Bundle（原 DXT / Desktop Extension）是一个 `.mcpb` zip，包含本地 MCP server、依赖和 `manifest.json`。manifest 的必需字段覆盖规范版本、名称、SemVer、作者和 server 入口；可选字段覆盖平台/运行时兼容、工具/提示目录、用户配置、敏感配置、隐私政策和本地目录选择。[MCPB repository](https://github.com/modelcontextprotocol/mcpb) [MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)

格式支持 Node、Python、UV 和原生 binary server；server 仍通过 stdio 使用普通 MCP。Claude Desktop 提供单文件安装和宿主管理的运行时，企业还可以用 allowlist 控制组织成员可用的 Desktop extensions。[MCPB repository](https://github.com/modelcontextprotocol/mcpb) [Claude enterprise Desktop extensions](https://support.claude.com/en/articles/12702546-deploying-enterprise-grade-mcp-servers-with-desktop-extensions)

MCPB manifest 没有一个可由宿主强制执行的通用 OS 权限集合。本地 server 作为用户进程运行；Anthropic 的官方 MCPB 构建指引明确提醒格式本身没有 sandbox，路径校验、子进程 allowlist 和最小权限要由实现者承担。[Anthropic official MCPB build skill](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/mcp-server-dev/skills/build-mcpb/SKILL.md)

MCPB 解决安装与启动，不定义工具调用的事务、幂等 key 或数据迁移。连接生命周期、超时、取消和结构化错误仍由 MCP；可重试副作用仍须由每个 server 实现。[MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) [MCP Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

### 优点

- 本地 MCP server 从“编辑 JSON + 安装运行时”降为单文件安装。
- manifest 能表达运行时、平台、配置和入口，且 server 不需要学习专有 RPC。
- 本地文件、桌面应用、内网和硬件等能力不必暴露为公网服务。

### 缺点

- 打包 Python/native dependency 会产生平台矩阵和体积成本。
- 单文件便利性容易掩盖“安装后就是本地可执行代码”的风险。
- manifest 的目录选择和敏感配置是安装 UI/配置机制，不自动构成 filesystem sandbox。

### 可借鉴机制

- “普通协议实现 + 可选自包含 bundle”的双层设计。
- manifest 中分离机器 ID、显示信息、兼容范围、入口和 user config schema。
- 敏感配置交给宿主凭据存储，而不是打包在 artifact 中。
- 企业 allowlist 与公共目录分开。

## 3. Obsidian community plugins

### 已验证机制

Obsidian 插件以 `manifest.json` 标识 ID、名称、SemVer、最低宿主版本和 desktop-only 状态。公共目录只维护插件索引；具体 `manifest.json`、`main.js` 和可选 `styles.css` 从作者 GitHub Release 获取，release tag 必须匹配 manifest version；`versions.json` 用来选择兼容旧版 Obsidian 的插件版本。[Obsidian releases repository](https://github.com/obsidianmd/obsidian-releases) [Obsidian manifest](https://docs.obsidian.md/Reference/Manifest)

Restricted Mode 默认禁止第三方代码执行。用户启用 community plugins 后，Obsidian 明确说明它无法可靠限制插件的具体权限：插件继承宿主访问级别，可以访问计算机文件、联网和安装程序。官方目录的安全扫描和人工复核是供应链治理，不是运行时 sandbox。[Obsidian plugin security](https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Plugin%20security.md)

插件使用 `onload()` 注册命令、视图和事件；需要在卸载时释放的 event/interval 可通过宿主的 register API 自动跟随生命周期清理。官方还要求把昂贵工作移出 `onload()`，避免拖慢整个应用启动。[Obsidian event lifecycle](https://docs.obsidian.md/Plugins/Events) [Obsidian load-time guide](https://docs.obsidian.md/plugins/guides/load-time)

Obsidian 没有插件级幂等或重试协议。不过 `Vault.process()` 将“读取当前内容—生成新内容—写回”封装为一个不会在读写间被外部修改打断的操作，是宿主提供确定性原语而不是要求每个插件重造锁。[Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault#modify-files)

### 优点

- 文件数量少、手动安装和公共目录模型都很透明。
- 版本与最低宿主版本明确，旧宿主可选最后兼容 release。
- 注册式资源清理降低插件残留 listener/timer 的概率。

### 缺点

- 插件权限与 Obsidian 基本相同；用户只能在“完全信任”与“不运行”之间选择。
- GitHub Release 是分发约定，不是强签名和可复现构建证明。
- 没有统一副作用、重试或数据迁移语义。

### 可借鉴机制

- Restricted Mode 的默认拒绝与显式启用。
- 宿主提供 register/disposable 原语，卸载时自动清理。
- 兼容性索引把宿主版本与插件版本选择解耦。
- 给常见数据修改提供原子宿主 API。

## 4. VS Code extensions

### 已验证机制

VS Code extension 的根清单是 `package.json`，包含 publisher、SemVer、宿主 engine range、入口、activation events、Contribution Points、依赖和 capability。扩展既可发布到 Marketplace，也可打成可离线安装的 VSIX。[VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest) [VS Code publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

Contribution Points 允许主题、语法、菜单、命令、视图、配置等大量功能只靠声明接入；代码扩展则在 activation event 首次触发时激活，入口导出 `activate` 和可选 `deactivate`。这是声明式注册和惰性执行的组合。[VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points) [VS Code activation events](https://code.visualstudio.com/api/references/activation-events) [VS Code extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)

VS Code 明确说明 extension host 与 VS Code 本身拥有相同权限，扩展可以读写文件、联网、启动进程和修改设置。Workspace Trust 与 `capabilities.untrustedWorkspaces` 可以在不可信工作区禁用或限制功能，但并非逐扩展 OS capability sandbox。[VS Code extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security) [VS Code manifest capabilities](https://code.visualstudio.com/api/references/extension-manifest#capabilities)

Marketplace 在发布时做恶意软件扫描、动态行为检测、secret scanning 和发布者治理，并签名 extension；VS Code 安装时验证签名，恶意包可进入 block list 并被自动卸载。[VS Code extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security#_marketplace-protections)

### 优点

- Contribution Points 减少为简单 UI/语法功能加载任意代码的必要。
- activation events 避免全部 extension 在启动时运行。
- 离线 VSIX、Marketplace、签名、扫描、发布者信任和组织 allowlist 形成完整分发治理。

### 缺点

- extension host 是稳定性隔离，却不是最小权限安全隔离。
- manifest capability 主要表达运行环境兼容/受限工作区支持，不是通用文件/网络/进程权限清单。
- 命令执行的幂等性和重试行为没有统一约束。

### 可借鉴机制

- 优先声明式 Contribution Points，只有行为需要时再惰性激活代码。
- 安装包签名、发布者身份、恶意包阻止列表和组织 allowlist 多层结合。
- 显式兼容版本与“在受限环境中是否可用/降级”的 capability 声明。
- disable 与 uninstall 分开，并提供卸载清理 hook。

## 5. Raycast extensions

### 已验证机制

Raycast 的 `package.json` 是 npm manifest 的超集，声明 extension metadata、平台、commands、AI tools、preferences 和入口。preferences 支持 password、file、directory 等原生控件；敏感字段和 LocalStorage 保存在仅对应 extension 可读的本地加密数据库。[Raycast manifest](https://developers.raycast.com/information/manifest) [Raycast preferences](https://developers.raycast.com/api-reference/preferences)

公开 extension 通过官方 `raycast/extensions` 仓库的 pull request 提交；经过人工 review、manifest/schema、asset、author、build 和 type check 后合并并发布。所有公开 extension 保持开源，更新也走 PR。[Raycast publish flow](https://developers.raycast.com/basics/publish-an-extension) [Raycast security](https://developers.raycast.com/information/security#publishing-process)

Raycast 以一个托管 Node 子进程运行 extensions，每个 extension 有独立 V8 isolate、event loop 和有限 heap；command 通常按调用加载、退出后整体卸载，超出内存限制会被终止。但官方明确说明文件和网络没有进一步 sandbox，扩展仍受 Raycast 父进程拥有的 macOS 权限影响。[Raycast security](https://developers.raycast.com/information/security) [Raycast lifecycle](https://developers.raycast.com/information/lifecycle)

商店只保留隐式 latest，extension 自动更新，宿主依据实际使用的 API version 检查兼容性。这个模型降低用户选版本的成本，也意味着发布错误会快速扩散且缺少面向用户的版本固定语义。[Raycast versioning](https://developers.raycast.com/information/versioning)

### 优点

- command 是清晰的最小执行单元；短生命周期降低常驻状态和资源泄漏。
- 官方仓库 PR 让实际源码、review 和发布 artifact 形成可查看链路。
- 宿主管理 Node、加密配置和自动更新，开发者不处理安装环境。

### 缺点

- V8 isolate 隔离 extension 之间的 JS 状态，不限制文件、网络和进程能力。
- “只有 latest + 自动更新”对消费端简单，但不利于版本固定和渐进发布。
- 无统一幂等或任务恢复协议，后台 command 仍需自行处理重复执行。

### 可借鉴机制

- 以 command/tool 为 manifest 中的一等入口，不把整个 extension 当作一个模糊能力。
- 每次调用创建短命执行实例，持久状态显式落到宿主 storage。
- 宿主管理语言 runtime 和加密配置。
- public extension 源码 review 与 private organization store 双通道。

## 6. Home Assistant integrations

### 已验证机制

Home Assistant integration 必须有 `manifest.json`，声明 domain、类型、依赖、requirements、IoT class、code owners、发现方式和质量等级。官方 integration 随 Core 统一构建和发布；custom integration 可以手动或经 HACS 安装。[Home Assistant integration manifest](https://developers.home-assistant.io/docs/creating_integration_manifest/) [Home Assistant Integration Quality Scale](https://developers.home-assistant.io/docs/core/integration-quality-scale/)

Config Entry 有明确状态机：setup、setup retry、loaded、unload、failed unload、migration 等。`async_setup_entry` 建立资源，`async_unload_entry` 应清理 entity、subscription 和 connection，`async_remove_entry` 做删除清理，`async_migrate_entry` 迁移旧配置。[Home Assistant config entry lifecycle](https://developers.home-assistant.io/docs/config_entries_index/) [Home Assistant unload rule](https://developers.home-assistant.io/docs/core/integration-quality-scale/rules/config-entry-unloading/)

当设备或服务暂时离线，integration 从 setup 抛出 `ConfigEntryNotReady`，宿主自动重试并增加间隔；认证失效使用 `ConfigEntryAuthFailed` 进入 reauth flow；DataUpdateCoordinator 可依据 API 的 Retry-After 延迟刷新，恢复后回归正常周期。[Home Assistant setup failures](https://developers.home-assistant.io/docs/integration_setup_failures/) [Home Assistant coordinator retry-after](https://developers.home-assistant.io/blog/2025/11/17/retry-after-update-failed/)

稳定 unique ID 防止同一设备或服务重复创建 Config Entry；发现信息变化时可以更新现有 entry 后终止新 flow。这不是所有 action 的幂等保证，但它把“安装/发现重试导致重复实例”变成宿主可执行的不变量。[Home Assistant config flow unique IDs](https://developers.home-assistant.io/docs/core/integration/config_flow/#unique-ids) [Home Assistant unique config entry rule](https://developers.home-assistant.io/docs/core/integration-quality-scale/rules/unique-config-entry/)

隔离是该体系的弱点。Home Assistant 官方说明每个 integration 运行在 Home Assistant 内，HACS custom code 直接在 Home Assistant 中运行；第三方故障或漏洞可能影响整个实例，而不是像 add-on 那样在旁路环境运行。[Why integrations run inside Home Assistant](https://www.home-assistant.io/blog/2021/05/12/integrations-api/) [Home Assistant HACS 2.0](https://www.home-assistant.io/blog/2024/08/21/hacs-the-best-way-to-share-community-made-projects)

### 优点

- 生命周期、配置迁移、临时失败、认证失败和后台刷新都有宿主级标准原语。
- unique ID 与 registry 将重复发现、重启和实体持久化纳入一致模型。
- Quality Scale 把测试、恢复、文档、维护者和用户体验变成逐级要求。

### 缺点

- integration 与宿主 Python 进程和内部 API 高度耦合。
- custom integration 缺少进程/capability 隔离，一项故障可影响整个系统。
- 官方生态要求完整且 review 成本高，不适合无约束的快速脚本分发。

### 可借鉴机制

- 把 retry、reauth、unload、remove、migration 建模为宿主生命周期，而不是插件约定。
- 使用稳定 unique ID 防重复安装、发现和实体创建。
- 对临时失败使用宿主退避，对认证失败进入独立用户流程。
- 用分级质量标准区分“可运行”与“可长期维护”。

## 7. WASI / Wasmtime Component Model

### 已验证机制

WebAssembly Component Model 用 WIT 定义组件 import/export；`world` 是组件需要和提供的完整契约。组件只能通过显式 import 触达外部能力：没有 secret store、filesystem 或 HTTP import，就不能调用相应宿主接口。组件内存也不直接与其他 component 共享。[WIT worlds](https://component-model.bytecodealliance.org/design/worlds.html) [Component structure](https://component-model.bytecodealliance.org/design/components.html)

WIT package 名称含 namespace、package 和可选 SemVer；interface 可以标注 `@since`、unstable 和 deprecated feature。resource 使用 own/borrow handle，并在 owning handle drop 时调用 destructor，给跨语言资源生命周期一个可验证模型。[WIT specification](https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md)

Wasmtime 的 WASI context 默认没有环境变量、参数和 preopened directory，stdin 关闭，网络地址与 DNS lookup 默认拒绝；host 必须显式 preopen 目录并指定目录/文件读写权限。路径不能用 `..` 越出 preopen 根。[Wasmtime WasiCtxBuilder](https://docs.wasmtime.dev/api/wasmtime_wasi/struct.WasiCtxBuilder.html)

Wasmtime 允许宿主用 ResourceLimiter 限制 memory、table 和 instance，用 fuel 或 epoch deadline 中断无限循环。官方同时提醒 fuel/epoch 不能中断卡在 host call 的代码，host 仍需用 async API 和外层 timeout 约束 I/O。[Wasmtime Store limits](https://docs.rs/wasmtime/latest/wasmtime/struct.Store.html) [Wasmtime interrupting execution](https://docs.wasmtime.dev/examples-interrupting-wasm.html) [Wasmtime epoch caveat](https://docs.rs/wasmtime/latest/wasmtime/struct.Config.html)

Component Model 规定类型和 capability，不规定函数的幂等性、事务、包签名、registry、自动更新或状态迁移。因此“Wasm sandbox”不能单独替代插件平台；它是执行层原语。

### 优点

- capability 不是自述权限清单，而是链接时必须由 host 满足的 import。
- 多语言组件共享 WIT ABI；输入输出边界可静态检查。
- 每次执行可创建短命 Store，并执行 CPU、内存、实例和文件/网络限制。

### 缺点

- Word/Excel/视频等现实能力仍需宿主实现 WIT interface 或组件携带相应库。
- 语言工具链和 Component Model/WASI 版本兼容仍在演进。
- host function 一旦授权过宽，Wasm 内存隔离不能修复宿主 API 设计错误。

### 可借鉴机制

- 把权限变为显式 imports，默认不提供能力。
- 接口版本、feature gate、own/borrow resource 生命周期。
- 每次调用独立实例和可执行的 CPU/内存/网络/目录限额。
- 把执行 sandbox 与包分发、签名、审核分成不同层。

## 8. Extism：基于 Wasm 的插件框架

### 已验证机制

Extism 把插件定义为 WebAssembly module，并由各语言的 Host SDK 装载和调用导出函数。插件本身可以由多种语言编写；Host SDK 管理 plugin instance，PDK 负责插件侧导出和内存交互。这一层提供的是跨语言插件 ABI 与执行容器，不是商店或远程工具协议。[Extism plug-in system](https://extism.org/docs/concepts/plug-in-system/) [Extism Host SDK](https://extism.org/docs/concepts/host-sdk/) [Extism plug-in quickstart](https://extism.org/docs/quickstart/plugin-quickstart/)

Extism 官方把未授权的 Wasm 描述为基本隔离的计算单元：它不能直接访问文件系统、宿主进程内存或系统调用。外部能力必须以 import 注入；Host Functions 让宿主选择性暴露自定义函数和受控 UserData。启用 WASI 则会扩大到相应的 POSIX 风格能力，因此是否启用仍由 host 决定。[Extism plug-in concepts](https://extism.org/docs/concepts/plug-in/) [Extism Host Functions](https://extism.org/docs/concepts/host-functions/) [Extism configuration](https://extism.org/docs/concepts/configuration/)

Extism Manifest/CLI 可以限制允许访问的 HTTP host 和文件路径；未列出 host 时 HTTP 请求失败，目录必须显式通过 `--allow-path` 授权，WASI 也需显式开启。CLI 还提供 timeout、最大内存、变量尺寸和 HTTP response 尺寸限制。这些限制是执行防护，但不自动赋予导出函数事务或幂等语义。[Extism installation and CLI options](https://extism.org/docs/install/)

配置由 host 拥有，插件可以读取，但不能在运行时修改 host 配置。这个单向控制面有利于让相同输入、相同配置和相同 capability 形成可复现调用；如果 Host Function 自身包含网络写入、随机数、时钟或文件副作用，确定性仍由宿主接口设计负责。[Extism configuration](https://extism.org/docs/concepts/configuration/)

### 优点

- 比直接集成 Wasmtime 更接近可用的跨语言插件框架，已有多种 Host SDK 与 PDK。
- capability 通过 imports、allowlist 和 host-owned config 注入，默认可以不暴露文件和网络。
- timeout、内存和响应尺寸等限制由宿主集中配置。

### 缺点

- 不提供完整插件目录、签名、审核、自动更新、版本迁移或回滚策略。
- Host Function 一旦暴露宽泛的文件或网络接口，Wasm sandbox 仍会被宿主 API 穿透。
- 没有统一的 operation key、事务或 exactly-once 语义；幂等仍是业务接口契约。

### 可借鉴机制

- 使用统一 Host SDK 管理实例、调用、timeout 和资源上限。
- 用少量、窄接口 Host Functions 代替通用 shell、任意路径文件和无限制网络。
- host 拥有配置与 capability，插件只读取被授予的值。
- 将 Extism/Wasm 视为执行层；manifest 分发、签名、更新和业务幂等继续由上层定义。

## 9. OCI Artifact、内容寻址与 Sigstore

### 已验证机制

OCI descriptor 用 `mediaType`、digest 和 size 描述内容；digest 是内容地址，消费者应重新计算并验证，从不可信来源取得的长度不匹配内容不应信任。OCI Image Layout 把 blob 存为 `blobs/<algorithm>/<digest>`，目录中内容必须匹配该 digest。[OCI descriptor specification](https://specs.opencontainers.org/image-spec/descriptor/) [OCI image layout](https://specs.opencontainers.org/image-spec/image-layout/)

OCI manifest 可用自定义 `artifactType` 和 layer 承载非容器 artifact；`subject` 与 registry referrers API 可以把签名、SBOM 或证明附到目标 digest。实现遇到未知 artifact type 不应报错，这让 registry 能作为通用插件 artifact 分发层。[OCI manifest artifact guidance](https://specs.opencontainers.org/image-spec/manifest/) [OCI Distribution referrers](https://specs.opencontainers.org/distribution-spec/?v=v1.1.1)

Distribution Spec 提供 HEAD 存在性检查、digest pull、分块 upload session、offset 查询、断点续传、429 `Retry-After` 和最终 digest 校验。内容相同的 blob 具有同一地址，客户端可在重试前查存在并从已确认 offset 继续；tag 只是可变的人类可读指针，稳定安装必须记录 digest。[OCI Distribution specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md)

digest 证明“字节没变”，不证明“谁发布”。Cosign 可以给 blob/image 生成签名 bundle；keyless 模式把短期证书绑定 OIDC identity，bundle 可包含签名、证书和透明日志 inclusion proof；验证时还应约束 certificate identity 与 issuer，并校验签名 payload 中的 artifact digest。[Sigstore signing blobs](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/) [Sigstore verifying signatures](https://docs.sigstore.dev/cosign/verifying/verify/)

### 优点

- 内容地址使缓存、去重、镜像、固定版本和重试自然一致。
- registry 已有权限、上传/下载、分页、续传和大文件基础设施。
- signature、SBOM 和 provenance 可作为 referrer 附着到同一 digest。

### 缺点

- OCI 是 artifact/transport 格式，不定义插件 manifest、用户配置或执行 ABI。
- tag 可移动；只记录 `name:latest` 无法得到可重现安装。
- Sigstore 验证策略、信任根、身份 allowlist 和离线行为仍要由宿主选择。

### 可借鉴机制

- 安装记录固定不可变 digest，显示名称/版本只做可读别名。
- 下载后验证 digest，执行前验证签名身份和可选 provenance。
- 上传/下载使用可查询 offset 的 session，重试不重复传完整 artifact。
- 分发 artifact、签名/证明和执行 sandbox 三层分离。

## 跨案例可借鉴机制

以下机制在多个成熟体系中重复出现，且不依赖某一家产品：

1. **一个小而稳定的 manifest**：稳定 ID、SemVer、宿主兼容、入口、平台、配置 schema、能力声明和作者信息。
2. **声明式优先**：像 VS Code Contribution Points 一样，能由宿主直接完成的注册不加载任意代码。
3. **惰性激活与短生命周期**：按 command、tool、event 启动；宿主拥有 unload、timeout 和 cleanup。
4. **能力默认拒绝**：WASI imports、preopened directory、MCP Apps CSP 都要求能力被显式满足。
5. **供应链和运行时分层**：商店审核/签名回答“代码从哪里来”，sandbox/capability 回答“代码能做什么”。
6. **稳定 ID 与内容 digest**：unique ID 防重复逻辑对象，digest 防重复或被篡改的物理 artifact。
7. **幂等作为可验证契约**：风险 annotation 可以辅助 UI，但真正的可重试操作需要宿主或插件实现稳定 operation key、原子写入、去重记录或纯函数边界。
8. **失败分类**：输入错误、临时不可用、认证失效、永久不兼容和内部错误应进入不同状态，而不是统一“失败后再试”。
9. **兼容更新优先**：公开 schema/entry/resource 先兼容新增，再切换版本；破坏性更新需要独立版本和迁移。
10. **官方与自建同格式、不同信任等级**：公共审核目录、组织 allowlist 和本地手动安装可以复用包格式，但 UI 必须明确来源和信任差异。

## 不应混淆的边界

- **MCP/MCP Apps** 定义远程或本地 server 的工具、资源、UI 和连接协议；不等于本地插件包或 sandbox。
- **MCPB/VSIX/Obsidian Release** 主要解决发现、安装、兼容和更新；普通本地代码仍继承用户或宿主进程的高权限，它们不是 capability sandbox，也不自动保证工具操作幂等。
- **WASI/Wasmtime/Extism** 解决未信任代码执行和 capability；不提供完整商店、审核、签名和更新策略。
- **OCI/Sigstore** 解决 artifact 寻址、传输、完整性和发布者证明；不提供插件 API 或执行隔离。
- **商店审核** 降低恶意包概率；不能取代最小权限、超时、审计和数据备份。

因此，SheJane 可以借鉴 MCPB、VS Code 和 Obsidian 的 manifest、安装与更新体验，但不应照搬其“插件作为高权限用户进程或宿主内代码执行”的模式。若插件面向用户自建且默认不受信任，运行边界必须由宿主强制执行：未授权时没有文件系统，目录只能通过 preopen/allow-path 精确授予，网络能力可以完全不暴露；WASI/Wasmtime 或 Extism 提供了比信任式 JavaScript/本地进程更合适的执行原语。

## 结论

案例最值得借鉴的不是某个现成“插件框架”，而是它们共同形成的分层：可移植 manifest、不可变 artifact、可信分发、显式 capability、宿主生命周期、结构化输入输出、稳定 ID 和可恢复失败状态。没有任何一个案例证明“只增加一个插件 tab 和一个 zip 格式”就能得到确定性或安全性；同样，也没有必要让第一版包格式同时承担 sandbox、商店、远程协议和工作流编排。

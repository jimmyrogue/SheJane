# Agent 插件系统一手资料研究：Codex 与 Claude Code

> 研究日期：2026-07-15
> 资料范围：OpenAI、Anthropic 官方文档、官方仓库源码，以及本机 Codex 官方插件缓存。本文只记录可验证事实，不展开 SheJane 架构方案。

## 结论

Codex 和 Claude Code 都有正式插件系统，但两者的 Plugin 首先是**可安装、可版本化的能力分发容器**，不是统一的插件执行 Runtime：

- Skill 仍由模型选择和执行。
- MCP/App 仍由 MCP Server 或 Connector 提供工具和数据。
- Hook 仍进入宿主已有的生命周期执行框架。
- Claude Code 的 Agent、LSP、Monitor 和 `bin/` 也各自进入已有 Runtime。
- 两家的 Manifest 都没有统一的 Action Schema、幂等键、Receipt、原子产物提交或副作用回放协议。

因此，它们主要解决的是组件组合、发现、安装、命名空间、版本缓存、启用和信任管理；不能直接等同于一个确定性组件 Runtime。

## 事实矩阵

| 维度 | OpenAI Codex | Anthropic Claude Code |
|---|---|---|
| 官方定义 | 可复用工作流的能力包 | self-contained directory of components |
| Manifest | `.codex-plugin/plugin.json`，必需 | `.claude-plugin/plugin.json`，可选；默认目录可自动发现 |
| 当前 Runtime 实际消费 | Skills、Apps/Connectors、MCP Servers、Hooks | Skills/Commands、Agents、Hooks、MCP、LSP、Monitors、Themes、`bin/`、部分 Settings |
| Skill/Command | `skills/`；插件名成为 Skill namespace | `skills/`；`commands/` 是旧式平铺 Skill |
| Subagent | 当前 Codex 插件 Manifest/Loader 没有 `agents` 能力字段 | `agents/*.md` 接入既有 Subagent 机制 |
| Hook | 支持；按 Hook 精确定义哈希单独审查 | 支持 command、HTTP、MCP tool、prompt、agent 等类型 |
| 安装来源 | 官方/个人/仓库 Marketplace；本地、Git、npm | 官方/第三方 Marketplace；GitHub、Git、目录、URL、npm |
| 本地缓存 | `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` | `~/.claude/plugins/cache`；每版本独立目录 |
| 更新边界 | 新会话加载；当前 Store 激活新版本后清理旧版本 | 当前会话保留旧版本；旧缓存约 7 天后删除 |
| 信任控制 | 插件启用、MCP server/tool policy、Hook 哈希信任、宿主 Runtime 权限 | Workspace Trust、项目 MCP/LSP 审批、企业策略；官方明确插件可执行任意用户权限代码 |
| 统一插件沙箱 | 无；各组件沿用自己的执行与权限机制 | 无；Monitor 明确 unsandboxed |
| 统一幂等协议 | 无 | 无 |
| 性质 | 分发容器 + 既有能力聚合 | 组件面更广的分发容器 + 既有能力聚合 |

## OpenAI Codex

### 包结构与实际能力面

官方结构以 `.codex-plugin/plugin.json` 为入口，可组合：

```text
plugin/
├── .codex-plugin/plugin.json
├── skills/
├── hooks/hooks.json
├── .mcp.json
├── .app.json
└── assets/
```

当前 `openai/codex` 源码中的 `PluginManifestPaths` 只包含：

- `skills`
- `mcp_servers`
- `apps`
- `hooks`

Loader 将这些组件分别投影到现有 Skill、MCP、App/Connector 和 Hook Runtime，并返回 `PluginLoadOutcome`。没有为整个 Plugin 启动统一进程或虚拟机。

OpenAI 官方 Figma 插件仓库中存在 `commands/` 和根级 `agents/`，但当前 Codex Runtime Manifest 与 Loader 不消费这两个字段。Marketplace 兼容解析可以保留来自其他生态的未知字段，不代表运行时会注册 Slash Command 或 Subagent。

### 发现、安装与版本

Marketplace 是 JSON Catalog，支持：

- 官方 Curated Directory。
- 用户级 `~/.agents/plugins/marketplace.json`。
- 仓库级 `.agents/plugins/marketplace.json`。
- Claude 兼容的 `.claude-plugin/marketplace.json`。
- 本地目录、Git/GitHub、Git 子目录和 npm 来源；Git 可固定 ref/SHA。

npm 物化过程不运行 lifecycle scripts。安装缓存位于：

```text
~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/
```

本地无版本插件使用 `local`。Store 会校验 Marketplace 名、Manifest 名和安全版本路径，先复制到 staging，再以 rename 激活；失败时尝试恢复旧缓存。当前实现激活新版本后会清理同插件其他旧版本。

### 权限、信任与隔离

Codex 把控制分层：

- Plugin installation/enablement 决定包是否可用。
- Skill、Connector/App、MCP Server/Tool 各自继续使用宿主策略。
- MCP policy 可按 Server 和 Tool 限制启用与审批。
- Runtime sandbox 和执行审批仍由当前 Surface 控制。

Plugin Hook 不因安装而自动受信任。非 Managed Hook 的信任绑定当前 Hook 定义的精确哈希；内容变化后会重新要求审查。

这不是统一 Plugin Sandbox：STDIO MCP 是本地进程，HTTP MCP 是远程服务，Hook 是受审查命令处理器，Skill 的脚本最终仍经 Agent 可用工具执行，App/Connector 使用自己的认证和 Workspace Policy。

公开 Manifest/Source 类型也没有通用插件签名字段。官方公共目录通过开发者身份、扫描、域名验证、Tool Annotations、测试用例和人工审核建立额外发布门槛。

### 本机快照

本机 `codex-cli 0.142.5` 的 `~/.codex/plugins/cache/` 与官方源码一致：缓存按 Marketplace/Plugin/Version 分层；官方 Figma 包用 Manifest 显式组合 Skills、MCP 与 App，同时可以携带 Hooks、Scripts、UI 和素材。这支持“能力聚合与分发容器”的判断。

### Codex 一手来源

- [Plugins overview](https://developers.openai.com/codex/plugins)
- [Build plugins](https://developers.openai.com/codex/plugins/build)
- [Submit plugins](https://learn.chatgpt.com/docs/submit-plugins)
- [Hooks](https://developers.openai.com/codex/hooks)
- [MCP](https://developers.openai.com/codex/mcp)
- [Plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors)
- [Plugin Manifest 源码](https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/plugin/src/manifest.rs)
- [Plugin Loader 源码](https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/core-plugins/src/loader.rs)
- [Plugin Store 源码](https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/core-plugins/src/store.rs)
- [Marketplace 源码](https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/core-plugins/src/marketplace.rs)
- [官方 Figma 插件](https://github.com/openai/plugins/tree/main/plugins/figma)

## Anthropic Claude Code

### 包结构与能力面

Claude Code Plugin 是组件目录；Manifest 可选，省略时按约定目录发现：

```text
plugin/
├── .claude-plugin/plugin.json
├── skills/<name>/SKILL.md
├── commands/*.md
├── agents/*.md
├── hooks/hooks.json
├── .mcp.json
├── .lsp.json
├── monitors/monitors.json
├── bin/
└── settings.json
```

Plugin 名成为能力 namespace。各组件仍进入既有 Runtime：

- Skill/Command 由模型选择或通过 namespaced command 调用。
- Agent 进入 Subagent，可声明模型、Tools、最大回合和 worktree isolation。
- Hook 可调用 command、HTTP、MCP Tool、prompt 或 Agent。
- MCP 与 LSP 各自启动服务进程。
- `bin/` 加入 Bash Tool 的 `PATH`。
- Monitor 运行长期后台 Shell 命令并注入通知。

Plugin Agent 只能使用 `isolation: "worktree"`，且不能自行设置 `hooks`、`mcpServers` 或 `permissionMode`。

Agent SDK 没有另一套远程插件协议；当前只接受 `{ type: "local", path }`，Marketplace 插件需先下载到本地。

### Marketplace、配置与版本

Marketplace 使用 `.claude-plugin/marketplace.json`，可来自 GitHub、任意 Git URL、本地目录、远程 Catalog、Git 子目录或 npm。安装 Scope 包括 user、project、local 和 managed。

`userConfig` 支持类型化字段；敏感值可存入 macOS Keychain，其他平台可回退到凭据文件。Claude Code 禁止把 `${user_config.*}` 直接插入 Shell 命令字段。插件依赖支持 SemVer；跨 Marketplace 依赖默认拒绝，需根 Marketplace 显式放行。

版本解析优先级是：

1. `plugin.json.version`
2. Marketplace 条目版本
3. Git commit SHA
4. `unknown`

官方 Marketplace 默认自动更新，第三方和本地开发 Marketplace 默认关闭。当前会话继续使用启动时版本；每版本使用独立缓存，更新或卸载后的 orphaned 版本约 7 天后删除。

### 权限、信任与隔离

Anthropic 官方明确表示：插件和 Marketplace 是高信任组件，可以用当前用户权限在机器上执行任意代码。

Project Scope 叠加以下保护：

- Workspace Trust。
- 项目 Plugin 的 MCP Server 逐服务器批准。
- LSP 仅在信任 Workspace 后启动。
- Project Plugin 不加载后台 Monitor。
- Marketplace 缓存与 Plugin Root 路径约束。
- 企业可限制 Marketplace、MCP、Hooks 等来源和能力。

但 Personal Scope 不具备全部 Project 限制；Monitor 明确是 unsandboxed。Hook、MCP、LSP、Monitor 和 `bin/` 都可能执行代码或产生副作用，因此通用 Bash Sandbox 不能视为统一插件 capability sandbox。

### Claude Code 一手来源

- [Create plugins](https://code.claude.com/docs/en/plugins)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Discover and install plugins](https://code.claude.com/docs/en/discover-plugins)
- [Plugins in the Agent SDK](https://code.claude.com/docs/en/agent-sdk/plugins)
- [Plugin dependencies](https://code.claude.com/docs/en/plugin-dependencies)
- [Claude Code security](https://code.claude.com/docs/en/security)
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
- [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)

## 可验证的共同边界

1. Plugin 是组合、分发和版本单位，不是统一执行语义。
2. Marketplace 是 Catalog 与安装策略，不是完整安全边界。
3. 各组件保留自己的 Runtime、权限、失败模式和副作用语义。
4. 缓存与版本解决复现、更新和会话稳定性，不解决业务幂等。
5. 两家都没有宿主强制的 Operation ID、Receipt Replay 或 Artifact Commit 协议。
6. Skill 与工具被打进同一插件，不会自动提高工具本身的确定性。

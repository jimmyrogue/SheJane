# MCP 生命周期与工具目录研究

> 更新日期：2026-07-14
> 主要阶段：P6 绑定资源并取得 Agent 定义
> 直接上游：P5 冻结执行上下文
> 直接下游：P7 启动或恢复 LangGraph、P10 执行工具
> 当前状态所有者：每次执行临时创建的 MCP 工具对象
> 建议状态所有者：Runtime 级 MCP 管理器拥有服务与目录；每次执行只拥有不可变工具快照和资源租约

> 实施进度：已建立 Runtime 级工具目录和 Server Supervisor，按 Server 配置指纹并发刷新并复用长会话；每次执行持有固定目录快照租约，配置更新不会中断进行中的 Run。失败连接使用退避重试，Runtime API 和 Desktop 可显示连接状态。无密钥目录元数据已经写入 SQLite；Runtime 重启后会校验配置指纹并恢复惰性工具代理。首次发现和刷新已移到 Runtime 后台，P6 只读取当前有效快照，不连接 Server 或执行 `tools/list`。`build_agent()` 已停止每 Run 发现，也不再隐式扫描其他客户端的全局配置。Server 发出 `notifications/tools/list_changed` 后，Runtime 在后台替换后续 Run 的目录快照；已有 Run 继续使用旧会话直到释放租约。MCP 工具达到 12 个时，主 Agent 和通用子 Agent 只常驻一个 `mcp.search_tools` 目录工具，搜索命中的结构才在后续模型回合中暴露。该方案不依赖模型供应商，因此适用于 DeepSeek 等 OpenAI 兼容服务。

## 结论

SheJane 不应该在每个 Run 内重新连接全部 MCP Server、依次执行 `initialize` 和 `tools/list`，随后关闭连接，再在真正调用工具时重新连接。

这不是 Deep Agents 要求的做法，而是 SheJane 当前接入层自己选择的生命周期。Deep Agents SDK 只接收已经构造好的 `tools`；MCP 的配置发现、连接、缓存、刷新和关闭都由宿主应用负责。Deep Agents Code、OpenAI Agents SDK 和 Codex 的公开实现也都把这些职责放在 Agent Run 之外或更长的会话生命周期内。

最优方案不是把当前顺序循环改成并发，而是从 `build_agent()` 中删除 MCP 全量发现，把以下四件事彻底分开：

1. MCP Server 配置和信任管理；
2. MCP 连接、子进程和会话管理；
3. 工具目录发现、缓存、版本和失效；
4. 每个 Run 向模型暴露哪些工具，以及真正执行工具时使用哪个连接。

## 改造前实现的问题

改造前链路是：

```text
每个 Run
  -> build_agent()
  -> build_validated_mcp_tools()
  -> 顺序遍历全部 MCP Server
  -> 每个 Server 最多等待 15 秒
  -> initialize + 分页 tools/list
  -> 关闭发现会话
  -> 为每个工具生成运行时代理
  -> 模型真正调用工具时再次创建 MCP 会话
```

当前机器会从 SheJane、Claude Desktop、Cursor 和 Codex 配置中自动合并出 9 个 Server。一次正常 Run 的首次模型调用前等待约 23.5 秒，而关闭 MCP、Skill 和 Subagent 后约为 0.48 秒；模型调用本身约 2.8 秒。因此主要延迟在 P6，不在模型供应商。

这里有五个根本问题：

- **发现位于请求关键路径。** 用户每发一条消息都要重新支付全部 Server 的启动、握手和目录读取成本。
- **连接被重复创建。** 发现结束即关闭；P10 真正调用工具时再次连接。对 stdio 来说意味着重复启动子进程。
- **一个慢 Server 拖慢整个 Run。** 当前是顺序遍历，即使单个失败不会终止 Run，也会累计等待时间。
- **工具目录没有生命周期。** 配置、Server 健康、工具定义版本和本次 Run 可见工具混在一次临时函数调用中。
- **配置所有权不清。** Runtime 默认扫描其他产品的全局配置。用户在 Codex 或 Cursor 中启用 Server，不等于授权 SheJane 启动同一命令、读取同一环境变量或访问同一远程端点。

## 一手实现对比

| 实现 | 连接生命周期 | 工具目录 | 单 Server 失败 | 模型可见工具 |
|---|---|---|---|---|
| Deep Agents SDK | 不管理；调用者传入 `tools` | 不管理 | 由宿主决定 | `create_deep_agent()` 收到的工具 |
| Deep Agents Code | 启动会话时连接；stdio 在工具调用之间保持存活 | 启动时发现 | 记录为 `error` 或 `unauthenticated`，其他 Server 继续 | 会话期间已成功加载的工具 |
| LangChain MCP Adapters | 默认工具每次调用创建新 `ClientSession`；也支持显式长会话 | `get_tools()` 负责加载，多个 Server 并发 | 基础客户端需要宿主决定策略 | 转换后的 LangChain 工具 |
| OpenAI Agents SDK | `MCPServerManager` 在应用或会话生命周期连接和清理 | 可开启 `cache_tools_list`，可显式失效 | 默认只暴露成功连接的 Server，可单独重连失败项 | 每个 Run 从已连接 Server 取得，可缓存目录 |
| Codex | 会话级 `McpConnectionManager` 管理已启用 Server，并发启动 | 使用启动快照和目录缓存 | 每个 Server 独立报告启动状态 | 支持 `tool_search` 时，MCP 工具默认延迟加载 |

### Deep Agents

Deep Agents 的公开 API 将工具作为 `create_deep_agent(tools=[...])` 的普通输入；API 中没有 MCP 配置、连接池或目录缓存参数。因此可以明确判断：**Deep Agents SDK 负责 Agent 结构和工具调用循环，不负责 MCP 生命周期。** [Deep Agents API](https://reference.langchain.com/python/deepagents/graph/create_deep_agent)

Deep Agents Code 是构建在 SDK 之上的完整应用。它在会话启动时发现并连接 MCP Server，stdio Server 在多次工具调用之间保持运行；单个 Server 失败只进入独立状态，不阻断其余 Server。它只读取 `~/.deepagents/.mcp.json` 和当前项目的 `.mcp.json`，项目配置还要经过基于内容指纹的信任确认。[Deep Agents Code MCP 文档](https://docs.langchain.com/oss/python/deepagents/code/mcp-tools)

这说明正确分层是：SDK 接收工具，Runtime 或产品宿主管理 MCP。

### LangChain MCP Adapters

`MultiServerMCPClient.get_tools()` 的默认模式会把 Server 转成 LangChain 工具；这些工具在每次实际调用时新建 `ClientSession`。官方同时提供 `client.session(server)` 与 `load_mcp_tools(session)`，允许宿主显式保持会话。[LangChain MCP Adapters 官方仓库](https://github.com/langchain-ai/langchain-mcp-adapters#multiple-mcp-servers)

官方实现对多个 Server 的工具加载使用并发任务，而不是顺序等待。但这只能说明 SheJane 当前的顺序发现比适配器默认实现更慢，**不能证明每个 Run 全量发现是正确架构**。适配器提供连接原语；缓存、健康状态、重连和应用生命周期仍由 Runtime 决定。

### MCP 官方协议

MCP 把一个连接明确分成初始化、运行和关闭三个阶段；初始化会协商协议版本与能力，之后才进入正常操作。[MCP 生命周期规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)

工具目录通过 `tools/list` 发现，并支持分页。Server 可以声明 `tools.listChanged`；当目录变化时发送 `notifications/tools/list_changed`，客户端再刷新目录。[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

这意味着协议已经提供“初次读取 + 变化通知”的模型，没有要求客户端在每次 Agent Run 前重新读取全部目录。对于 Streamable HTTP，Server 还可以返回 `MCP-Session-Id`；客户端必须在后续请求中复用，收到 404 后才重新初始化。[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

### OpenAI Agents SDK

OpenAI Agents SDK 明确要求调用者管理 MCP Server 生命周期，并提供 `MCPServerManager` 在应用生命周期中统一连接、清理和重连。默认情况下，连接失败的 Server 不进入 `active_servers`；管理器可以并发连接并只重试失败项。[OpenAI Agents SDK MCP 管理器](https://openai.github.io/openai-agents-python/ref/mcp/manager/)

它仍会在每个 Agent Run 调用 `list_tools()`，但官方专门提供 `cache_tools_list=True` 和 `invalidate_tools_cache()`，因为远程目录读取会造成明显延迟；stdio 连接则由上下文管理器保持管道打开直到退出。[OpenAI Agents SDK MCP 文档](https://openai.github.io/openai-agents-python/mcp/)

这套实现比 SheJane 当前方案更合理的地方是：连接属于管理器，不属于一次 `build_agent()`；目录可以缓存和主动失效；失败 Server 有独立状态。

### Codex 与大工具库

Codex 的公开源码使用集中式 `McpConnectionManager` 管理运行中的 MCP Client，并并发启动已启用的 Server；工具信息含稳定的 Server、工具名和模型可见命名空间。[Codex MCP Connection Manager](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/mcp_connection_manager.rs)

更重要的是，Codex 当前公开特性说明：当 `tool_search` 可用时，MCP 工具默认延迟加载，而不是把全部工具结构直接放进模型上下文。[Codex Tool Search 特性](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs)

Anthropic 的官方实践也给出相同方向：当有多个 MCP Server、超过 10 个工具或工具定义超过约 10K token 时，应使用按需 Tool Search，只保留少量高频工具常驻。其测试显示，大量预装工具不仅消耗上下文，还降低选择准确率。[Anthropic Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)

因此，“Runtime 已经知道全部工具”和“模型每一轮都看到全部工具结构”是两件不同的事。

## 建议的目标架构

```text
Runtime MCP Registry
  ├─ Server 配置、启用状态、信任、凭证引用
  ├─ Tool Catalog：工具结构、目录版本、健康状态、更新时间
  └─ Server Supervisor：连接、子进程、会话、重连和关闭
             │
             ▼
P5 冻结执行上下文
  └─ 选择本次 Run 可使用的目录版本和权限
             │
             ▼
P6 绑定资源
  ├─ 复用 Agent 定义
  ├─ 取得不可变 Tool Catalog Snapshot
  └─ 取得按需连接租约，不执行全量 tools/list
             │
             ▼
P8 模型回合
  ├─ 小工具集：直接暴露
  └─ 大工具集：先 search_tools，再暴露相关工具
             │
             ▼
P10 工具执行
  └─ RuntimeToolProxy -> Supervisor -> MCP tools/call
             │
             ▼
P11 释放本次执行租约
  └─ 空闲连接按策略回收；Runtime 关闭时统一清理
```

### 1. Runtime 只管理自己的 MCP 配置

删除每次 Run 扫描 Claude Desktop、Cursor 和 Codex 配置的路径。保留“从其他客户端导入”作为用户主动触发的一次性操作：展示将导入的命令、URL、环境变量名和权限，确认后复制成 SheJane 自己的配置。

Runtime 的 MCP 配置进入 SQLite；密钥仍进入系统凭据库。配置变化生成不含密钥明文的结构指纹，并立即使旧目录版本失效。

### 2. 建立 Runtime 级 Server Supervisor

Supervisor 负责：

- 按 Server 隔离启动、健康状态和错误；
- 有界并发初始化，而不是顺序初始化；
- stdio 子进程和有状态 HTTP 会话复用；
- 单 Server 重连，不重建全部 Server；
- Runtime 关闭时统一清理；
- 记录启动、目录读取和工具执行耗时。

连接不应简单地“永久全部常驻”。推荐按传输和能力选择：

- stdio：首次激活后保持会话，在空闲超时或 Runtime 退出时关闭；
- 返回 Session ID 的 HTTP：保持该逻辑会话；
- 明确无状态的 HTTP：复用 HTTP Client，工具调用可以按需建立短会话；
- 本次 Run 从未使用的 Server：不为了发送一条普通消息而启动。

每次执行只持有 Supervisor 的租约。P11 释放租约，但不能关闭仍被其他 Run 使用的共享连接。

### 3. Tool Catalog 独立持久化

添加 Runtime 级工具目录，按 Server 保存：

- 配置指纹；
- Server 名称、版本、协议版本和能力；
- 已验证的工具名、说明、输入结构和注解；
- 目录版本、更新时间和最后成功时间；
- `ready`、`warming`、`error`、`unauthenticated`、`stale` 状态。

刷新触发条件：

1. 用户新增、修改、启用或手动刷新 Server；
2. 配置指纹变化；
3. 收到 `notifications/tools/list_changed`；
4. 连接重建后发现 Server 版本或能力变化；
5. 不支持变化通知的 Server 到达后台刷新期限。

刷新在后台执行，不进入普通 Run 的关键路径。刷新失败保留最后一次成功目录用于诊断，但新的 Run 默认只暴露当前可执行的 Server；若工具在调用时临时离线，返回带 Server 名称和可重试信息的结构化错误。

### 4. Run 使用不可变目录快照

P5 冻结本次 Run 的 Server 启用状态、权限和目录版本。P6 取得只读快照，不重新发现工具。

这样可以保证：

- 同一个 Run 的工具名称和结构不会在中途变化；
- `list_changed` 只影响后续 Run；
- 检查点恢复可以引用原目录版本；
- Agent 定义可以按工具结构指纹复用，而不是每条消息重新编译。

真正的工具对象使用稳定 `RuntimeToolProxy`。代理只保存 Server ID、原始工具名和目录版本；执行时再向 Supervisor 取得连接，避免把凭证、会话或任务编号放进可复用图定义。

### 5. 工具目录与模型上下文分开

Runtime 可以掌握完整 Tool Catalog，但不应把 64 个工具结构都发送给每次模型调用。

建议采用跨供应商可用的 Runtime 级策略：

- 工具少且结构总量小：直接暴露全部允许工具；
- 工具达到 10 个、结构超过约 10K token，或来自多个 Server：只暴露少量常用核心工具和 `search_tools`；
- `search_tools` 返回候选工具的稳定 ID、说明和结构；下一次模型调用只绑定已发现的相关工具；
- 支持供应商原生延迟工具加载时可使用原生能力，但不能让 Runtime 正确性依赖某一家模型。

这一步解决的是模型上下文和选择准确率，不代替 Tool Catalog，也不要求临时连接全部 MCP Server。

## 删除与保留

### 应删除

- `build_agent()` 中的每 Run 全量 MCP 发现；
- 每个 Run 自动扫描其他产品全局配置；
- “发现完成即关闭、调用时再次连接”的双重连接；
- 将 MCP 总开关理解为“每条消息立即启动全部 Server”；
- 把顺序循环改成 `gather()` 后继续留在 Run 关键路径的临时优化。

### 应保留

- 当前对工具名、说明、JSON Schema、总大小和敏感值的边界校验；
- 每 Server 超时、最大响应体、最大 stdio 帧和工具数量限制；
- 工具名称前缀和冲突检查；
- 单 Server 失败不拖垮 Runtime；
- P10 的权限审批、审计、取消和结构化错误；
- `RuntimeToolProxy` 的无密钥图定义方向。

## 迁移顺序

1. 先增加耗时分段和契约测试，固定当前工具名、错误和审批行为。
2. 建立 Runtime 自有 MCP 配置与一次性导入流程，停止隐式跨客户端扫描。
3. 建立 Tool Catalog，首次发现后持久化；Run 先读取目录快照。
4. 建立 Server Supervisor，把连接和子进程移出 `build_agent()`。
5. 让 `RuntimeToolProxy` 通过 Supervisor 执行，支持取消、重连和结构化失败。
6. 接入 `list_changed`、配置指纹失效和后台刷新。
7. 按结构指纹复用 Agent 定义。
8. 在大工具集启用 Runtime 级 `search_tools` 和按回合工具绑定。
9. 删除旧的每 Run 发现、其他客户端扫描和兼容注释。

## 验收标准

- MCP 开启但本轮未调用 MCP 时，P6 不启动任何未缓存 Server，也不执行 `tools/list`。
- 有有效目录缓存时，普通 Run 的 P6 MCP 开销应接近本地数据库读取，不再出现十秒级等待。
- 同一 stdio Server 在连续多个 Run 中不会重复启动；空闲回收和 Runtime 退出后没有孤儿进程。
- 一个 Server 超时、缺少认证或损坏，不阻塞其他 Server 和模型首字输出。
- 配置变化或 `tools/list_changed` 会产生新目录版本，但不改变正在执行的 Run。
- 检查点恢复使用原目录快照或明确报告目录版本不可用，不能静默换成另一套工具结构。
- 10 个以上工具时，模型请求默认不携带全部结构；BYOK 供应商不支持原生 Tool Search 时仍可通过 Runtime 的 `search_tools` 正常工作。
- 未经用户确认，Runtime 不会执行从 Claude Desktop、Cursor 或 Codex 配置中发现的命令。

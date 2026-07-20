# SheJane 路线图

## 当前优先级

1. 增加真实 BYOK“模型 → 工具 → 模型”离线验证。
2. 继续收敛 Runtime 状态所有权，减少 Client 的本地投影兼容代码。
3. 完成插件平台的真实签名/公证以及 Windows、Linux 原生隔离发布 Gate。
4. 完善 Runtime 安装包、Client Runtime 锁定和跨平台发布验证。
5. 审计第三方依赖、许可证、签名、SBOM 和供应链安全。

## 产品方向

- 移动端先作为 Remote Client，连接用户自己的 Runtime。
- 远程接入必须经过独立网关，负责 TLS、设备身份、撤销和限流；Runtime 仍只监听 loopback。
- 需要新能力时优先使用 MCP、Skills 或标准供应商接口。
- 不预建移动端、远程网关或托管 Runtime 空目录。

## 明确不做

- 不增加 Web 聊天客户端或强制账号体系。
- 不默认提供模型服务。
- 不把 Runtime 直接暴露到公网。
- 不增加自动模型选择或静默供应商回退。

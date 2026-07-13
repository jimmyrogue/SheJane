# Desktop 分发

## Runtime 锁定

Desktop 在 `apps/desktop/runtime-version.json` 中锁定一个 `runtime-vX.Y.Z` 标签。正式打包必须下载对应平台产物并验证 SHA-256；本地开发继续运行 `services/runtime` 源码。

支持的 Runtime 产物：

- macOS arm64；
- macOS x64；
- Windows x64；
- Linux x64。

## 启动边界

Electron Main：

1. 选择 loopback 地址和空闲端口；
2. 生成随机配对 Token；
3. 通过 `--host`、`--port`、`--token` 和 `--data-dir` 启动 `shejane-runtime`；
4. 使用带认证的 `/local/v1/runtime` 验证协议版本和必需能力；
5. 只向 Renderer 暴露地址、就绪状态和桌面会话标记；
6. 应用退出时只停止自己启动的 Runtime。

Runtime 不接收 Cloud 地址、Cloud Token 或供应商环境变量。BYOK 密钥由 Runtime 凭据存储管理。

## 打包验证

发布前至少检查：

- 安装包只包含锁定版本的 Runtime；
- Runtime 校验文件匹配；
- 清空用户环境变量后能够启动；
- 在没有任何 SheJane 云服务的环境中完成 BYOK“模型 → 工具 → 模型”；
- Runtime 只监听 loopback；
- Renderer 无法读取配对 Token 明文；
- 外部 Runtime 不会在 Desktop 退出时被停止。

## 发布标签

Desktop 与 Runtime 独立发布：

```text
desktop-vX.Y.Z
runtime-vX.Y.Z
```

Desktop 工作流读取锁定文件并从对应 Runtime Release 下载产物。不要从当前分支临时构建 Runtime 塞入正式 Desktop 安装包。

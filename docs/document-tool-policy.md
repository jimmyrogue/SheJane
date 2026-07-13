# 文档与工具策略

Desktop 已删除 Cloud 文档上传和 S3 附件路径。Runtime 只处理用户授权工作区中的本地文件。

## 当前行为

| 输入 | 处理方式 |
|---|---|
| 工作区中的 DOCX / XLSX / PPTX | 使用 Runtime Office 工具读取、预览或生成编辑副本 |
| 工作区中的普通文本文件 | 使用 Runtime 文件工具读取 |
| URL | 使用本地 `web.fetch`，或由用户配置的 MCP 工具处理 |
| Desktop 附件按钮 | 当前隐藏，直到存在明确的 Runtime 本地附件协议 |
| 图片生成、网页搜索、云端 PDF、云端代码执行 | Runtime 不内置；需要时通过 MCP 或标准外部工具接入 |

## 约束

- 文件必须位于已授权工作区。
- Desktop 不把文件上传到 SheJane Cloud。
- Runtime 不接收 S3 文档编号或 Cloud 下载地址。
- 新附件能力必须先定义 Runtime 所有的持久协议、权限和生命周期，不能恢复 Desktop → Cloud 私有路径。

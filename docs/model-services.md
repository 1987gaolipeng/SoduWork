# 模型服务、协议与计费

**简体中文** · [English](model-services.en.md) · [文档目录](README.zh-CN.md)

在**我的模型**中配置供应商的 API 地址、接口协议、模型 ID 和对应凭据。连接测试和企业模型请求由 Hub 发起。如果 Hub 在另一台电脑上，`127.0.0.1` 指向那台电脑，而不是你的桌面；本地模型服务需要填写 Hub 能访问的地址。

## 连接测试能证明什么

**保存并测试连接**首先读取供应商的模型列表。列表请求成功只验证该接口可访问，不代表聊天生成已获授权、计费余额充足，也不代表所选 Agent 支持该协议。模型列表接口不可用时，测试可能发送一个最小聊天请求，产生相应用量。结果会说明哪种测试成功。

当前企业模型对话通道使用 OpenAI 兼容接口。Anthropic 服务可以保留给支持它的 Agent，但 Anthropic 连接测试通过不会让它兼容此通道。模型编辑页和企业模型选择器会在执行前提示这个限制。只更改协议选项不会转换供应商接口；应使用供应商提供的对应地址和密钥。

## 智谱 GLM 接口与错误码 1113

智谱为标准 API 和 Coding Plan 提供了不同的接口及凭据。[官方配置文档](https://zcode.z.ai/cn/docs/configuration)列出了：

| 产品与协议 | API 地址 |
| --- | --- |
| 标准 API，OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4` |
| Coding Plan，OpenAI 兼容 | `https://open.bigmodel.cn/api/coding/paas/v4` |
| Coding Plan，Anthropic | `https://open.bigmodel.cn/api/anthropic` |

请按照供应商当前文档核对订阅、API Key 类型、接口地址和模型。Coding Plan 还限制受支持的工具和产品场景，修改接口地址并不代表 SoduWork 已获得使用资格。资格和计费规则请参阅[官方 Coding Plan 常见问题](https://docs.bigmodel.cn/cn/coding-plan/faq)。

供应商返回错误码 `1113` 或已识别的余额/额度不足类型时，SoduWork 会显示计费问题，并只保留允许公开的诊断码。自动重试会停止，因为重试不能补充余额或改变订阅。请先核对供应商账单和 API Key 类型。没有已识别计费码的普通限流 `429` 仍可按既有上限重试。

这些诊断不会显示原始上游错误正文、凭据或内部地址。模拟供应商的本地回归通过只能验证上述行为，不能验证某个付费账户的余额或使用资格。

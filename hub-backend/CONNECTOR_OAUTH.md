# 连接器 OAuth 部署与验证

**简体中文** · [English](CONNECTOR_OAUTH.en.md) · [后端说明](README.zh-CN.md)

首批个人连接支持 Google Drive、OneDrive、Outlook、SharePoint 和 Microsoft Teams。企业微信、飞书、钉钉已有的原生授权流程不变。公司共享连接不能绑定管理员个人 OAuth；普通用户通过平台登录完成自己的授权。

## 管理员一次性配置

在 Google / Microsoft 平台注册 Web 应用，将回调设为 HUB_PUBLIC_URL + /api/v1/mcp-servers/oauth/callback。生产环境必须为固定 HTTPS 根地址，只有本机开发允许 localhost HTTP。客户端不能传入替代回调或供应商地址。

- CONNECTOR_OAUTH_KEY：Fernet 加密密钥；可通过 cryptography.fernet.Fernet.generate_key() 生成。仅放部署密钥配置，不提交源码。
- CONNECTOR_GOOGLE_CLIENT_ID / CONNECTOR_GOOGLE_CLIENT_SECRET：Google 应用凭据。
- CONNECTOR_MICROSOFT_CLIENT_ID / CONNECTOR_MICROSOFT_CLIENT_SECRET：Microsoft 应用凭据。
- CONNECTOR_MICROSOFT_TENANT：默认 organizations，也可以填写已批准的租户标识。

同一集群所有 Hub 节点必须使用相同的密钥、应用配置、HUB_PUBLIC_URL 与共享数据库。需要备份加密密钥；直接替换密钥会使已有授权不可解密，轮换必须配合记录迁移。缺少密钥或应用配置时界面显示管理员尚未配置，不能静默以明文保存令牌。反向代理和访问日志必须对回调路径隐藏查询串，避免记录一次性 code / state。

## 授权与运行边界

使用授权码和 PKCE S256、随机 state、十分钟有效期以及单次消费。取消与回调保存做条件更新；取消后不保存令牌。平台 HTTP 请求不跟随重定向、不返回第三方响应或个人资料。

授权记录加密保存，绑定当前 Hub、设备、登录用户、连接器与连接标识。配置仅保存授权引用，访问令牌只在服务器执行派发或探测时注入。续期在独立事务中保存，避免业务失败回滚丢失轮转后的 refresh token；生产 PostgreSQL 行锁负责串行续期。续期仍需匹配原平台账号，明确失效时提示重连，网络抖动不永久注销授权。

上述五个平台的内置 OAuth 使用只读权限并强制 ALLOW_WRITES=false。身份验证通过不代表能读取组织内的所有业务资源；资源本身的权限仍由供应商控制。Microsoft 某些权限需租户管理员同意，Google 应用上线范围可能需要平台审核，不能仅填写环境变量就宣称已接通。

OAuth 授权引用不随导出、导入或共享传播；目标账号必须重新登录。删除或更换连接绑定会在同一事务删除原本地令牌；关闭尚未保存的授权也会清理。迟到的关闭请求不会撤销已成功保存的连接。此操作不在供应商处撤销整个应用授权，平台级撤销仍由平台账号设置执行。

## 探测状态

- configured：配置与工具目录可用，但未验证业务账号。
- verified：审核过的只读身份接口或数据库常量只读查询通过。
- needs_auth：供应商明确拒绝授权，需要重新连接。
- offline：需要的执行机不在线。
- error：网络或运行异常，不能假定账号已失效。

固定商业连接器只调用审核过的身份接口，未知连接器不会猜测或执行第一个业务工具。数据库仅执行只读事务内的 SELECT 1，不读取业务表。旧 Runner 没有返回身份探测标志时只显示配置就绪。自动化预检保留这些状态，并区分执行机离线与授权失效。

## 验证边界与依据

后端自动化测试覆盖单项并发更新、加密与账号隔离、跨 Hub 拒绝、PKCE / state、取消、过期、续期、保存到实际派发、导出限制和探测状态。供应商接口使用受控夹具模拟，未配置真实 Google / Microsoft 应用及账号，因此尚未做真实供应商登录与续期验收。部署后应由授权用户完成平台登录及只读验证。

- Google 授权与续期：https://developers.google.com/identity/protocols/oauth2/web-server
- Google Drive 身份接口：https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get
- Microsoft 授权码与 PKCE：https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- Microsoft 权限：https://learn.microsoft.com/en-us/graph/permissions-reference
- Microsoft 当前用户接口：https://learn.microsoft.com/en-us/graph/api/user-get


## 接口清单的通用 OAuth

导入 OpenAPI 3.0/3.1 JSON/YAML 或简化接口清单后，`soduwork-api` 运行器生成 API Key、Bearer、Basic 或 OAuth2 字段。它接入 REST API，不是任意远程 MCP 服务的 OAuth 发现客户端。

授权码支持 PKCE S256、`client_secret_basic`、`client_secret_post`、公共客户端 `none`。客户端个人连接配置页填写该系统的 Client ID/Secret，显示 Hub 固定回调地址，再点击「登录并连接」。平台应用必须登记这个回调地址；没有平台应用权限时不能绕过。平台不返回 refresh_token 时，只使用尚未到期的访问令牌，到期后重新登录。

通用入口复用既有 OAuth attempt/binding、加密存储和刷新事务。除 CONNECTOR_OAUTH_KEY 和有效 HUB_PUBLIC_URL 外，不需要为每个新系统增加服务器环境变量。应用认证参数按连接填写；正式平台授权端点必须 HTTPS，仅本机开发允许回环 HTTP，内网非加密 OAuth 端点不接受。

接口文档目标、认证方案、应用凭据和回调都绑定原授权。工具范围变化只允许缩小；扩大 scope、变更系统目标或应用身份需重新登录。默认关闭写入，只有用户明确开启才申请该工具的范围。公司共享连接不接收个人 OAuth 绑定，宜使用该公司的 API Key 或 Client Credentials。

Client Credentials 在执行机运行时取得短期令牌，不在配置中保存访问令牌。导出所有凭据置空、删除个人授权引用并关闭写入，保留接口定义和工具范围。通用 API 网络请求不跟随重定向、限制响应大小并校验实际连接地址，禁止系统元数据地址。未知写入结果不自动重试。

无显式只读 `x-soduwork-probe` 的连接只显示「配置就绪」。匿名健康接口不会证明用户授权有效；需要获准的真实只读业务调用来验收。

协议依据：
- OpenAPI 3.0.3：https://spec.openapis.org/oas/v3.0.3.html
- OAuth2 授权码及 Client Credentials：https://www.rfc-editor.org/rfc/rfc6749
- PKCE：https://www.rfc-editor.org/rfc/rfc7636

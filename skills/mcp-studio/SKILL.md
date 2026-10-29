---
name: mcp-studio
description: 在 SoduWork 对话中创建、调整和检查 MCP 配置，生成可导入的连接文件与接入说明。
---

# 连接器快速配置

在当前对话理解用户要接入的业务系统和使用范围。用户已有配置时先检查配置；没有地址、服务文档或本地程序说明时，只询问这些必要信息，不猜造 MCP 服务。

支持 SoduWork 客户端导入 JSON（mcpServers / servers）与 Codex config.toml。个人 HTTP 支持显式鉴权头，本地 stdio 只允许可信模板；自定义本地命令交管理员导入审查。旧 SSE、通用远程 MCP OAuth、headersHelper 和宿主环境变量引用不能假装兼容。Google Drive、OneDrive、Outlook、SharePoint、Teams 已有产品内的账号连接与续期流程；以配置页是否开放登录为准，管理员尚未配置应用时如实说明。

生成候选 JSON，再运行随包 scripts/mcp-config.cjs prepare <候选.json> <新输出目录>。脚本只做静态校验，产出 mcp-config.json 与检查报告，剥离凭据值并列出待补字段。不要将“静态通过”写成“连接成功”。保留原配置，不覆盖用户文件。

交付可点击文件链接，说明：
- 客户端「插件 → 连接器 → 导入配置」选择文件并核对目标；导入后保持停用。
- 在连接编辑页安全填写鉴权头、确认目标、测试连接，再启用。不要让用户在对话中发送密码或 Token。
- 共享用「共享到公司」。个人密钥不会提交；管理员补公司凭据，实测后开放，其他客户端按需启用。
- 本地工具安装依赖和目录权限属于各执行机，不会因为共享了配置就自动安装成功。
- 最后用用户授权的一个低风险工具验证实际业务结果；未经授权不调用写入、发布、删除等工具。

不要修改其他会话、MCP、管理员开放策略或宿主全局配置。不会自动安装 npm/uv 程序，也不执行输入包的脚本。错误报告仅包含字段名称，不回显敏感值。


## 随插件交付连接模板

用户需要可安装的连接器插件时，先生成配置，再由你整理一份 `plugin-info.json`，包含 `key`、`name`、`version`、`description`、`instructions`，可选 `author`。标识使用小写字母、数字和短横线，版本使用 SemVer；工作方法应说明用户实际要完成的业务，不索取凭据。

运行 `node scripts/mcp-config.cjs bundle <mcp-config.json> <plugin-info.json> <新输出目录>`。脚本生成可直接导入的 `soduwork-plugin-draft.json`、无凭据配置、检查报告与每个连接的 `references/connections/<连接名>.mcp.json`，自动登记资源、同名依赖、权限范围、超时和 SHA-256。使用真实产出的草稿与资源，不让用户手动拆分文件。草稿可从客户端现有插件导入入口预检、安装、试用，并从现有导出入口生成 `.soduwork-plugin` 包。

检查报告的 `requiresAdminReview` 非空时，表示有自定义本地命令，只交管理员审查，不能生成个人连接插件。错误传输方式、未知内置连接器、未声明字段、冲突的权限/超时别名、虚构工具和不适合跨平台文件名的连接名称都会拒绝；不要删掉权限或认证来绕过。内置模板或 API 标题包含路径字符时，生成器使用其稳定标识作为连接名，以检查报告的 `connections` 为准。

随包模板的 URL、接入方式及鉴权字段名称来自真实官方文档，所有 `headers` / `env` 值必须为空，`enabled:false`。先运行附带脚本生成无凭据配置，再分拆连接；不能携带 OAuth 令牌、动态鉴权辅助器、宿主变量引用、密钥或假凭据。已有产品内账号连接的平台，引导用户在配置页登录；其余只支持 OAuth 的平台须先确认当前客户端是否适配，不伪造可安装连接。

用户安装插件后点击试用，即可核对随包模板，确认导入后打开预填的连接编辑页。已有同名连接保持原配置；导入不会启用或执行工具。密钥由用户在只写配置页填写，不索取到对话、插件正文或安装偏好中。没有随包模板的旧插件仍可手工配置。

## 内置通用连接器

先运行 scripts/mcp-config.cjs catalog，查阅随包 references/connectors.json 的真实目录、字段、工具与限制。已支持的平台优先使用 scripts/mcp-config.cjs template <平台ID> <新输出目录>，交付无凭据、停用的 mcp-config.json。用户在客户端安全填写授权，启用后同一连接可由不同插件、普通对话和自动化复用，不要另建只能汇报的连接器。

可选写入权限默认为关闭；只有用户明确需要创建或发送等业务操作才引导在连接设置中开启。文件导出不携带写入授权、密钥或账号。短期 OAuth Access Token 到期需要在配置页更新；未实现自动刷新时不得承诺自动化可长期无人值守。数据库仅提供固定只读工具，不接受任意 SQL。

用户要接入目录外服务时，仍按真实官方 MCP 或 API 文档制作；远程 MCP 的 OAuth 客户端准入、权限和付费限制必须核实。标准 REST API 可直接运行下方接口清单制作流程，不需等待产品发版。自定义签名、文件上传等尚未覆盖的协议才需开发适配；配置导入始终不执行自定义代码。无真实平台授权时只做静态验证，明确后续授权步骤，禁止把工具列表生成说成业务连接成功。

## 生成后的验收

目录中的模板可直接复用。新增 API 适配必须核对最新官方文档中的端点、Action、版本、签名、地域示例和分页参数；云签名应对照官方测试向量或 SDK，不能只与自己的实现互相验证。生成测试须等待所有异步操作完成，错误响应和缺少驱动不能记为成功。

数据库优先使用成熟驱动，真实执行只读授权探测，保留服务端分页结果，验证 TLS 及中文路径。PostgreSQL、MySQL、SQLite、ClickHouse 的表/数据读取支持 `offset`，最多跳过 10000 行；数据跨页时必须使用稳定唯一的 `order_by`，并发修改下不是快照。Redis 继续使用服务端游标，MongoDB 使用 skip/limit，Elasticsearch 使用 from/size。不能把多次读取相同首批数据当作分页。云服务没有测试账号时，分别说明官方协议验证与真实账号验收的结果；不得将本地协议夹具、工具列表或配置保存称为已连接。敏感凭据只在配置页输入。


## 一份接口清单接入系统

用户给出接口文档时，先读取并整理为 OpenAPI 3.0 / 3.1 JSON 或简化 JSON：`{name,baseUrl,securitySchemes,security,endpoints:[{method,path,operationId,parameters,requestBody}]}`。parameters/requestBody/securitySchemes 沿用 OpenAPI 格式。用户只给自然语言或表格时，由本技能转换，不要求用户手工写规范；缺失地址、必填参数、认证端点时询问缺项，不编造。

运行 `node scripts/mcp-config.cjs api <接口清单.json> <新输出目录>`，得到停用、无凭据的 mcp-config.json 和检查报告。客户端现有「导入配置」也能直接导入 OpenAPI JSON/YAML，自动生成工具和认证字段。一个连接最多100个接口，默认只开放GET/HEAD，创建、修改、删除需用户在设置中打开写入权限。参数和响应有大小限制，接口拒绝、超时或未知写入结果不会被自动重试。

支持 API Key（请求头或query）、Bearer、Basic、OAuth2 Client Credentials 和授权码PKCE。认证要求从security及securitySchemes生成；多个认证AND组合保留，OR选择必须先明确。OAuth自定义token/authorization端点来自用户文档；不实现通用远程MCP OAuth发现，不把REST适配与MCP服务协议混淆。Client Credentials每次调用使用应用凭据获取短期token；授权码在配置页登录，Hub安全保管并在提供refresh_token时续期。平台没有返回refresh_token时，过期需重新登录，不承诺永不过期。

只有官方文档明确无副作用、无必填参数的GET/HEAD可以在根字段`x-soduwork-probe`中指定operationId作为连接检查。没有此接口时保持“配置就绪、业务未验证”，由用户授权一次实际只读工具后验收。文档示例、响应示例和默认值不作为认证，不将密码/token写入源文档、报告、对话或导出文件。

目前不自动处理外部$ref、循环schema、oneOf/allOf、文件上传、cookie认证、私有签名和多目标servers。编译会给出具体缺项；不得删除认证或必需参数来绕过检查。按用户真实文档补充适配后再测。

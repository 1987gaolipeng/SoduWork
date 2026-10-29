'use strict';
// Author connection resources through the bundled-resource contract without embedding account grants or secrets in installation preferences.
module.exports = [
  '用户提供 REST 接口清单时，优先使用 mcp-studio 的 scripts/mcp-config.cjs api 编译为 soduwork-api 声明式连接器，按其报告带入认证字段；不为每个系统生成并执行新程序。OpenAPI 3.0/3.1 JSON/YAML 可从现有导入配置入口直接导入。',
  '制作外部 MCP 连接插件时，先从官方文档确认真实服务地址、接入方式和权限；不能编造服务或宣称尚未授权的连接已经可用。',
  '除已有 platforms 账号连接和 soduwork-media 外，为 mcpServers 中每个需要新建的 HTTP/可信本地连接实际生成 references/connections/<连接名>.mcp.json，并在草稿 resources 声明 {"path":"references/connections/<连接名>.mcp.json","kind":"reference"}。连接名必须与 mcpServers 中该项完全一致。',
  '每个模板使用 {"mcpServers":{"<连接名>":{"type":"http","url":"<官方业务 MCP 地址>","headers":{"Authorization":""},"enabled":false}}} 结构，只含这一个连接。不要原样保留示例占位地址；URL、鉴权头名称应来自真实官方契约，所有 headers/env 值必须为空。可声明实际支持的 enabledTools、disabledTools 与超时，不写虚构工具名。',
  '模板不能携带密码、Token、个人OAuth绑定、动态鉴权辅助器、宿主环境变量引用或含凭据 URL；REST API 模板可声明受支持的 OAuth2 授权码PKCE或Client Credentials，凭据在配置页填写；不支持的私有鉴权只交付接入说明，不用空 Token 冒充授权。个人 stdio 只允许现有可信模板，自定义命令交管理员审查，不在导入时安装或执行。',
  '安装后点击试用会读取此插件当前版本的模板并打开连接预览；用户核对后导入为停用，再在预填的连接页填写凭据、测试和启用。不要求用户复制 URL 或鉴权字段，不修改已有同名连接。静态预检通过不等于真实连接或业务验证通过。',
  '凡需在会话工作区写入报告、方案或脚本文件，应在 runtimeCapabilities 显式声明 files；不要把 MCP 的只读业务权限与本地文件输出权限混为一谈。',
  '已有 platforms 连接在模型启动前校验，未授权时插件不能开始；不要承诺未连接仍由同一插件自动生成草稿。可以提示用户先授权，或取消插件后在普通对话起草；运行中读取失败则明确缺失范围。',
  'soduwork-media 当前公开 generate_image 与 generate_video，视频提交和等待在工具内部完成；只按真实工具返回说明结果，不虚构独立轮询或任务查询工具。同参数失败重试可沿用 generationId，修改请求必须使用新 ID，不能承诺平台不重复扣费。',
].join('\n');

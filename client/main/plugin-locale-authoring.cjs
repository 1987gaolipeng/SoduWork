'use strict';
// Shared by application and plugin authors; locale variants contain display text only.
module.exports = [
  '新创作或改进的应用与插件最低支持中文和英文双语。必须在同一 soduwork-plugin-draft.json 中声明 locales，至少含 zh-CN 与 en-US，均提供真实翻译的 name、description；用户要求韩语、日语等时追加 ko-KR、ja-JP 等语言。',
  '基础 name、description 保留兼容；locales 是展示配置，不复制多套执行配置文件。语言匹配顺序是当前语言精确匹配、同语言地区回退、英文回退；中文用中文，未提供其他语言时用英文。',
  'locales 示例：{"zh-CN":{"name":"运营助手","description":"管理运营工作","ui":{"main":{"title":"运营工作台"}}},"en-US":{"name":"Operations Assistant","description":"Manage operations","ui":{"main":{"title":"Operations workspace"}}}}。ui 下以贡献 id 为键，值只含 title、description。',
  '有公开参数或安装设置时一并翻译：locales.<语言>.inputs.<参数key> 和 setup.preferences.<设置key> 可含 label、description、placeholder、group、options；options 是稳定 value 到翻译 label 的映射，setup 另可含 title、description。不得翻译或修改 key、id、value、default、URL、MCP、权限、技能标识、工作流和执行指令。',
  '交付前重读最终 JSON，检查中文、英文的名称、简介、所有存在的页面入口、公开参数与安装偏好文案；验证中英文切换、未支持语言回退英文和旧格式兼容。业务页面是否翻译按用户范围执行，不能把只翻译清单说成业务页面已多语言。',
].join('\n');

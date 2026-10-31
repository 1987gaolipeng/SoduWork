'use strict';
const fs = require('node:fs'), path = require('node:path');
const base = require('./plugin-builder-plugin.cjs');
const FILES = ['SKILL.md', 'scripts/scaffold.cjs', 'scripts/serve.cjs', 'scripts/validate.cjs'];
const VALIDATION_FILES = ['main/plugin-resources.js', 'main/personal-plugin-schema.cjs',
  'main/personal-plugin-workflow.js', 'main/personal-plugin-agent-route.cjs',
  'main/plugin-capability-names.cjs', 'core/plugin-platforms.js', 'core/plugin-icon.js',
  'core/plugin-app-contract.cjs', 'core/plugin-package-page.cjs', 'core/plugin-locales.js',
  'core/plugin-cover.cjs', 'core/app-window-sizing.js'];
function body(app) {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'skills/app-developer') : path.resolve(__dirname, '../../skills/app-developer');
  const resource = (name, bytes, kind = 'reference') => ({ path: 'references/developer/' + name, kind, encoding: 'base64', content: Buffer.from(bytes).toString('base64') });
  return {
    template: 'method', key: 'app-developer', name: '应用开发', version: '1.2.0',
    locales: {
      'zh-CN': { name: '应用开发', description: '基于插件开发规范，制作带独立窗口、页面与 SoduWork 对话桥的应用，完成预检、安装和交互验证。' },
      'en-US': { name: 'App Developer', description: 'Build apps with dedicated windows, pages and the SoduWork conversation bridge; verify, install and test interactions.' },
    },
    description: '基于插件开发规范，制作带独立窗口、页面与 SoduWork 对话桥的应用，完成预检、安装和交互验证。',
    instructions: [
      require('./plugin-locale-authoring.cjs'),
      '你是 SoduWork 应用开发助手，复用插件开发助手的规范及现有工具、会话授权、草稿安装与导出链路。',
      '先读取本轮资源中的 references/developer/plugin-development.md，再读取 references/developer/SKILL.md，并按实际需求完成开发与验证。',
      '应用的插件 JSON 基础信息必须使用 template: "app" 及 ui.contributions。纯静态H5轻应用优先声明 source: {type:"package",entry:"ui/index.html"}，将HTML、CSS、JS、图片等依赖完整放入resources，导入后由壳直接打开，不启动HTTP服务、不要求ukey；有在线业务服务的应用仍可使用真实HTTP(S)地址。脚手架不填--url时生成包内应用，--entry可指定入口。不要把仅生成HTML称为已完成安装包。',
      '应用自身的登录、ukey 和业务鉴权均按实际需求选用，不是应用安装、打开或接入对话桥的前置条件。允许纯本地、单机、无账号轻应用；此类应用不添加登录页、ukey、虚构 MCP 或凭据配置。仅当业务确实需要受保护服务时才声明对应连接与认证，沿用该服务的真实授权要求。',
      '公共 SDK 在 references/developer/sdk/soduwork-app.js，示例生成器和本地静态服务在 references/developer/scripts；安装不执行脚本。',
      '直接生成真实文件、验证报告、soduwork-plugin-draft.json 与 .soduwork/delivery.json；复用当前会话的“检查并安装”，保留其他成果。',
      '验证页面操作、技能驱动的真实会话、结果回写与刷新；分开记录静态检查、隔离夹具和真实模型业务实测，不把发送回执当作业务完成。',
    ].join('\n'),
    runtimeCapabilities: ['files', 'terminal', 'browser'],
    resources: [
      ...base.body().resources,
      ...FILES.map(name => resource(name, fs.readFileSync(path.join(root, name)), name.startsWith('scripts/') ? 'script' : 'reference')),
      ...VALIDATION_FILES.map(name => resource('validation/' + name,
        fs.readFileSync(path.resolve(__dirname, '..', name)))),
      resource('plugin-development.md', base.body().instructions),
      resource('sdk/soduwork-app.js', fs.readFileSync(path.resolve(__dirname, '../sdk/soduwork-app.js'))),
      resource('sdk/README.md', fs.readFileSync(path.resolve(__dirname, '../sdk/README.md'))),
    ],
  };
}
module.exports = { body, FILES, VALIDATION_FILES };

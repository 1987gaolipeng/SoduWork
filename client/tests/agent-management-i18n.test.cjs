'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sources = [
  '所选 Linux 执行机的 CPU 缺少 sse4_2 指令集，无法运行 OpenCode。请选择兼容的执行机，或由管理员调整该虚拟机的 CPU 配置。',
  '模型上下文超限；完整历史已保留，将通过现有会话接续机制恢复。',
  '轻快，原生支持技能（Agent Skills，和 Claude Code 同一套标准）。',
  'Apache-2.0 开源的 Codex Agent Harness；通过 ACP 接入，使用 SoduWork 分配的企业模型。',
  '开源编码 Agent；按需安装，使用企业模型执行代码与命令。',
  'OpenAI 官方 CLI。用它自己的账号（ChatGPT 登录或 OpenAI key），不吃 SoduWork 这边的模型配置。',
  'Apache-2.0 开源编码 Agent；通过 ACP 接入，支持公司 OpenAI 兼容模型。',
  'MIT 开源的 DeepSeek 官方 Agent 框架（dsh）；通过 ACP 接入，支持公司 OpenAI 兼容模型或个人 DeepSeek Key。',
  '上次测试尚未验证当前执行组件；请点「测一下」重新验证。',
];

function loadI18n(withoutChineseCatalog = false) {
  const storage = new Map();
  const listeners = new Map();
  const context = vm.createContext({
    Intl, Map, Set, Object, JSON, console,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    document: { readyState: 'loading', documentElement: { dataset: {} }, querySelectorAll: () => [] },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    addEventListener: (name, callback) => listeners.set(name, callback),
    dispatchEvent: event => listeners.get(event.type)?.(event),
    soduWorkAPI: { setLocale() {}, onLocaleChange: callback => listeners.set('ipc-locale', callback) },
  });
  vm.runInContext('window = globalThis; let cfg = {}; const saveCfg = () => {};', context);
  {
    for (const file of JSON.parse(fs.readFileSync(path.join(root, 'core/locales/manifest.json'), 'utf8'))) {
      if (withoutChineseCatalog && file.startsWith('zh-CN')) continue;
      vm.runInContext(fs.readFileSync(path.join(root, 'core/locales', file), 'utf8'), context);
    }
    vm.runInContext(fs.readFileSync(path.join(root, 'core/i18n.js'), 'utf8'), context);
  }
  return context.SoduWorkI18n;
}

test('agent management card blurbs are localized in every shipped non-Chinese locale', () => {
  const i18n = loadI18n();
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    i18n.setLocale(locale, { persist: false, broadcast: false });
    for (const source of sources) {
      const translated = i18n.translateText(source);
      assert.notEqual(translated, source, `${locale} missing Agent blurb: ${source}`);
      assert.ok(translated.length > 0);
    }
  }
});

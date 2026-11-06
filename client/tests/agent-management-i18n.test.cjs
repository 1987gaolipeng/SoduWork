'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sources = [
  '轻快，原生支持技能（Agent Skills，和 Claude Code 同一套标准）。',
  'Apache-2.0 开源的 Codex Agent Harness；通过 ACP 接入，使用 SoduWork 分配的企业模型。',
  '开源编码 Agent；按需安装，使用企业模型执行代码与命令。',
  'OpenAI 官方 CLI。用它自己的账号（ChatGPT 登录或 OpenAI key），不吃 SoduWork 这边的模型配置。',
  'Apache-2.0 开源编码 Agent；通过 ACP 接入，支持公司 OpenAI 兼容模型。',
  'MIT 开源的 DeepSeek 官方 Agent 框架（dsh）；通过 ACP 接入，支持公司 OpenAI 兼容模型或个人 DeepSeek Key。',
  'Harness² 文本推演后由 OpenCode 执行，增加耗时与模型用量',
  '每轮先运行 Google Research Harness² 的七阶段文本推演，再由 OpenCode 执行工具；推演会增加耗时与模型用量，失败时不会切换底座。',
  '② 仅验证 OpenCode 执行组件；不运行 Harness² 推演，会使用所选模型额度，最多 3 分钟。',
  '收到执行回复，但尚未确认 OpenCode 执行组件完整结束，请点「测一下」重试。',
  '上次测试尚未验证当前执行组件；请点「测一下」重新验证。',
  '通了 —— Harness² 0.1.0 的 OpenCode 执行组件已验证；此测试不包含推演。',
];

function loadI18n() {
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
  for (const file of JSON.parse(fs.readFileSync(path.join(root, 'core/locales/manifest.json'), 'utf8'))) {
    vm.runInContext(fs.readFileSync(path.join(root, 'core/locales', file), 'utf8'), context);
  }
  vm.runInContext(fs.readFileSync(path.join(root, 'core/i18n.js'), 'utf8'), context);
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

/* Every catalog blurb/warn/config_how rendered by the drawer must translate. */
test('agent catalog drawer copy (blurb/warn/config_how) is localized', () => {
  const i18n = loadI18n();
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '..', 'hub-backend/app/agent_catalog.json'), 'utf8'));
  const fields = [];
  for (const agent of catalog.agents) {
    for (const field of ['blurb', 'warn', 'config_how']) {
      const value = agent.install?.[field];
      if (value) fields.push(value);
    }
  }
  assert.ok(fields.length >= 12);
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    i18n.setLocale(locale, { persist: false, broadcast: false });
    for (const source of fields) {
      assert.notEqual(i18n.translateText(source), source, `${locale} missing catalog copy: ${source}`);
    }
  }
});

/* Server-composed job copy, log lines and status whys shown in the drawer and
 * the Test flow. Backend stays Chinese; the panel translates at render time
 * via translateText and the same prefix/suffix splitting as panels-agents.js. */
const CJK = /[\u4e00-\u9fff]/;
const jobCopy = [
  '正在修复安装', '修复未完成', '作业没有正常收尾', '[超时] 跑太久，已经把它收掉了',
  '最新是 0.2.0，你这台还没装', '已经是最新的 0.166.0', '有新版：0.1.0 → 0.2.0',
  '适配器已经是最新的 0.166.0，但找得到程序，但版本自检失败。建议重装。',
  '适配器已经是最新的 0.166.0，但保留了安装记录，但找不到执行程序。请点「重装」补齐。',
  '适配器已经是最新的 0.166.0，但找得到可执行文件，却问不出版本——多半是装到一半。建议「重装」。',
  '卸干净了', '卸载失败（npm 退出码 1）', 'OpenCode 安装失败：npm ERR! code 1',
  'Codex Harness 安装不完整：缺少与适配器匹配的官方执行包 codex（需要 0.166.0）。请点一次“更新”自动补齐。',
  '它自己报的版本是 0.1.2，但 npm 那边没有这个包的记录（全局包目录里只剩可执行文件）。这样升级、卸载都不会干净，建议点一次「重装」把它补回来。',
  '装了吗', '跑得起来吗', '能干活吗', '① 先看它跑不跑得起来…',
  '② 让它真干一轮最小的活（要它把两段拼成一个词说回来）…',
  '准备 CLI 运行环境失败（TypeError），请检查依赖、配置与目录权限后重试',
  'CLI 测试进程未能正常运行（TypeError），请检查依赖、可执行文件与目录权限后重试',
  '通了 —— Codex codex-cli 0.166.0 真跑了一轮，口令对上了。',
  '② 验证 Harness² 日常执行与完整回复；会使用所选模型额度，最多 3 分钟。',
  '还没装。点「装上」，SoduWork 会安装已校验的官方版本，不需要 Node/npm 或管理员权限。',
  'SoduWork 独立 Codex 账号已登录；新对话使用此账号',
  '装好了，但独立 Codex 账号未通过本机验证，请点击「登录 Codex」后新建对话。它用自己的账号和模型，SoduWork 不会给它配共享模型。',
  '装好了，但暂时无法确认 Codex 登录状态，请重新检查或使用独立授权。。它用自己的账号和模型，SoduWork 不会给它配共享模型。',
  '暂时无法确认 Codex 登录状态，请重新检查或使用独立授权。，可以直接派活。它用自己的模型，不占共享模型。',
  '重装', '没发起来', '后端没给作业号',
];
const logLines = [
  '   没通：密钥不对或已过期', '   它把口令原样拼回来了：SODUWORK_AGENT_OK',
  '   用的模型：gpt-5（走我自己的额度）', '   用的模型：gpt-5（走公司那把）',
  '① 先看它跑不跑得起来…', '② 让它真干一轮最小的活（要它把两段拼成一个词说回来）…',
  '⚠ 你指定的「gpt-5」现在用不了，这一轮退回了默认模型',
];

/* Mirror of the panels-agents.js _agTx prefix/suffix splitting so the test
 * exercises the same render-time path as the real panel. */
function makeAgTx(i18n) {
  const tx = value => {
    const text = String(value == null ? '' : value);
    let out = text;
    try { out = i18n.translateText(text) || text; } catch (_) { return text; }
    if (out !== text) return out;
    let m = text.match(/^([\s\S]*?)(（[^（）]{1,24}）)$/);
    if (m) { const suffix = tx(m[2]); if (suffix !== m[2]) return m[1] + suffix; }
    m = text.match(/^(\s*)([^：:\n]{1,14}：)([\s\S]+)$/);
    if (m) { const head = tx(m[2]); if (head !== m[2]) return m[1] + head + tx(m[3]); }
    return out;
  };
  return tx;
}

const jaIdentityOk = new Set(['更新', 'Agent 管理', 'Runner 管理']);

function assertRendered(locale, raw, out, label) {
  if (locale === 'ja-JP') {
    const identical = ['更新', 'Agent 管理', 'Runner 管理'];
    if (!CJK.test(raw) || identical.includes(raw)) return;
    assert.notEqual(out, raw, `${locale} untranslated ${label}: ${raw}`);
    return;
  }
  assert.ok(!CJK.test(out), `${locale} residual Chinese in ${label}: ${raw} -> ${out}`);
}

test('agent job copy, log lines and probe steps are localized at render time', () => {
  const i18n = loadI18n();
  const agoSec = Date.now() / 1000 - 3700;
  for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
    i18n.setLocale(locale, { persist: false, broadcast: false });
    const tx = makeAgTx(i18n);
    for (const raw of jobCopy) assertRendered(locale, raw, tx(raw), 'job copy');
    for (const raw of ['正在安装', '正在修复安装', '正在卸载', '正在查版本', '正在测', '等待官方登录授权', '正在跑']) {
      assertRendered(locale, raw + '…', tx(raw) + '…', 'job title');
    }
    for (const raw of logLines) assertRendered(locale, raw, tx(raw), 'log line');
    for (const raw of ['装了吗：还没装。先点「装上」。', '跑得起来吗：问它版本，没有回话']) {
      const [head, ...rest] = raw.split('：');
      assertRendered(locale, raw, tx(head) + '：' + tx(rest.join('：')), 'probe step');
    }
    for (const raw of ['上次测：' + tx('1 小时前'), '历史测试：' + tx('3 天前')]) {
      assertRendered(locale, raw, i18n.translateText(raw), 'ago combo');
    }
    for (const raw of ['刚刚', '5 分钟前', '2 小时前', '3 天前']) assertRendered(locale, raw, tx(raw), 'ago');
  }
});

test('agent locale files stay syntactically loadable and registered', () => {
  const i18n = loadI18n();
  for (const [locale, file] of [
    ['en-US', 'en-US-agent-pages.js'], ['ja-JP', 'ja-JP-agent-pages.js'], ['ko-KR', 'ko-KR-agent-pages.js'],
  ]) {
    const registry = require(path.join(root, 'core/locales', file));
    assert.ok(Object.keys(registry).length > 150, `${file} unexpectedly small`);
    i18n.setLocale(locale, { persist: false, broadcast: false });
    assert.notEqual(i18n.translateText('重装'), '重装', `${locale} missing 重装`);
  }
});

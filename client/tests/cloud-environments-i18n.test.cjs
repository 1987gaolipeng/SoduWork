'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');

// Mirrors the sandbox used by i18n.test.cjs: DOM-stub context plus every
// locale shard, so translateText resolves exactly like in the renderer.
function client() {
  const context = vm.createContext({
    Intl, Map, Set, Object,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      readyState: 'loading', documentElement: { dataset: {} },
      querySelectorAll: () => [], addEventListener() {},
    },
    CustomEvent: class {},
    addEventListener() {}, dispatchEvent() {},
    soduWorkAPI: { setLocale: () => {}, onLocaleChange: () => {} },
    setTimeout, clearTimeout,
  });
  vm.runInContext('window = globalThis;', context);
  for (const file of JSON.parse(
    fs.readFileSync(path.join(root, 'core', 'locales', 'manifest.json'), 'utf8'),
  )) {
    vm.runInContext(
      fs.readFileSync(path.join(root, 'core', 'locales', file), 'utf8'),
      context,
    );
  }
  vm.runInContext(fs.readFileSync(path.join(root, 'core', 'i18n.js'), 'utf8'), context);
  return context.SoduWorkI18n;
}

test('cloud environments panel entries exist in en-US-plugin-pages', () => {
  const enUS = require(path.join(root, 'core', 'locales', 'en-US-plugin-pages.js'));
  // Representative strings from every section of the panel: header, empty
  // state, routing copy, server rows, harness actions, and error paths.
  const keys = [
    '管理远程连接与执行底座', '查看安装记录', '查看连接详情', '连接信息',
    '在新会话中选择云端执行，即可使用这台电脑。',
    '我的云端环境', '配置和管理你的专属远程执行机', '配置执行机', '正在检查你的云端环境…',
    '你的云端执行机，系统会自动安排', '配置一台专属机器', '在会话中查看成果',
    '配置后即可在云端执行会话，密钥只在生成时显示一次', '状态自动更新',
    '还没有专属云端执行机', '添加一台你自己的远程电脑。连接完成后，云端会话会自动使用它。',
    '当前账号暂时没有配置权限，请联系管理员开通。', '配置专属执行机',
    '每个账号仅保留一台专属云端执行机。需要更换设备时，先移除当前环境，再配置新的设备。',
    '此执行机尚未加入当前环境的可用执行名单，请联系管理员。', '这是当前账号专属的云端执行机，云端会话会自动选择它。',
    '专属云端电脑', '登录信息已安全保存', '等待完成连接', '使用执行机默认目录',
    '在这台云电脑上一键准备', '可直接使用', '已安装，等待云端确认', '安装后即可在云端会话中使用',
    '安装没有完成，请重试', '执行容量', '服务没有返回安装任务', '安装时间较长，请稍后刷新查看结果',
    '安装失败，请重试', '更新 Runner 密钥',
  ];
  const missing = keys.filter(key => !(key in enUS));
  assert.deepEqual(missing, [], 'panel strings missing from en-US-plugin-pages.js');
});

test('cloud environments strings translate in en-US, ja-JP and ko-KR', () => {
  const i18n = client();
  i18n.setLocale('en-US');
  for (const word of ['我的云端环境', '还没有专属云端执行机', '云端底座', '安装没有完成，请重试']) {
    assert.notEqual(i18n.translateText(word), word, `untranslated: ${word}`);
  }
  assert.equal(
    i18n.translateText('{ready} 台在线 · 会话将自动选择，无需手动指定').replace('{ready}', 2),
    '2 online · chats pick automatically, no manual selection needed',
  );
  for (const [locale, empty, online] of [
    ['ja-JP', '専用クラウド実行マシンはまだありません', '2 台がオンライン · チャットは自動で選択し、手動指定は不要です'],
    ['ko-KR', '전용 클라우드 실행 머신이 아직 없습니다', '2대 온라인 · 채팅이 자동으로 선택하므로 수동 지정이 필요 없습니다'],
  ]) {
    i18n.setLocale(locale);
    assert.equal(i18n.translateText('还没有专属云端执行机'), empty);
    assert.equal(
      i18n.translateText('{ready} 台在线 · 会话将自动选择，无需手动指定').replace('{ready}', 2),
      online,
    );
  }
  i18n.setLocale('zh-CN');
  assert.equal(i18n.translateText('我的云端环境'), '我的云端环境');
  assert.equal(
    i18n.translateText('{ready} 台在线 · 会话将自动选择，无需手动指定').replace('{ready}', 2),
    '2 台在线 · 会话将自动选择，无需手动指定',
  );
});

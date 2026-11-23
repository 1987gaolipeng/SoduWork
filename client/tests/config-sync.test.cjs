'use strict';







const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const lifecycle = () => read('core', 'store-lifecycle.js');

test('store.js：定义服务端专属字段清单与剥离函数', () => {
  const store = lifecycle();
  assert.match(store, /CFG_SERVER_OWNED = \['modelProviders'\]/);
  assert.match(store, /CFG_SERVER_OWNED\.forEach\(key => \{ delete value\[key\]; \}\)/);
});

test('store：启动读入 localStorage 即剥离存量污染', () => {
  const store = read('core', 'store.js');
  const expression = store.match(/^\s*_cfg:(.+),$/m)?.[1];
  assert.ok(expression, 'The production configuration initializer must be present');
  const scope = { window: {} };
  vm.runInNewContext(lifecycle(), scope);
  const { stripServerOwned, safeParseCfg } = scope.window.SoduWorkStoreLifecycle;
  for (const visibility of [{}, { dockVisible: true, petVisible: true }, { dockVisible: false, petVisible: true }]) {
    const saved = { theme: 'saved-theme', locale: 'ja-JP', userPreference: { keep: true },
      modelProviders: [{ id: 'legacy-server-provider' }], ...visibility };
    const persisted = JSON.stringify(saved);
    const cfg = vm.runInNewContext(expression, { stripServerOwned, safeParseCfg,
      LS_CFG: 'soduwork_work_cfg_v5', localStorage: { getItem(key) {
        assert.equal(key, 'soduwork_work_cfg_v5');
        return persisted;
      } } });
    assert.equal(Object.hasOwn(cfg, 'modelProviders'), false, 'Legacy server-owned data must be removed at startup');
    assert.equal(cfg.theme, saved.theme);
    assert.equal(cfg.locale, saved.locale);
    assert.equal(cfg.userPreference.keep, true, 'Unrelated user preferences must survive sanitization');
    assert.equal(cfg.dockVisible, visibility.dockVisible ?? false);
    assert.equal(cfg.petVisible, visibility.petVisible ?? false);
    assert.equal(JSON.stringify(saved), persisted, 'Reading configuration must not mutate the saved input');
  }
});

test('store：hydrate 回灌合并前剥离后台下行值', () => {
  const store = lifecycle();
  const hydrate = store.slice(store.indexOf('_loadConfig(revision)'), store.indexOf('hydrate(force'));
  assert.match(hydrate, /const incoming = stripServerOwned\(\{ \.\.\.apiCfg \}\);/,
    'hydrate must sanitize a copied server configuration');
  assert.match(hydrate, /Object\.assign\(this\._cfg, incoming\);/,
    'hydrate must merge only the sanitized configuration copy');
  // Strip server-owned fields from persisted snapshots to clean legacy contamination.
  assert.match(hydrate, /localStorage\.setItem\(LS_CFG, JSON\.stringify\(stripServerOwned\(this\._cfg\)\)\)/);
});

test('store：saveCfg 上报的是剥离副本，本地真值不被改动', () => {
  const store = lifecycle();
  assert.match(
    store,
    /api\(\)\.syncConfig\(stripServerOwned\(Object\.assign\(\{\}, this\._cfg\)\)\)/,
    '_syncCfgToHub 必须上报剥离副本'
  );
  assert.doesNotMatch(store, /api\.syncConfig\(this\._cfg\)/, '不得再把含服务端字段的真值原样上报');
});

test('store：WS config.patch 下发合并前剥离', () => {
  const store = read('core', 'store.js');
  assert.match(store, /this\._applyConfigPatch\(ev\.patch\)/);
  const patch = lifecycle().slice(lifecycle().indexOf('_applyConfigPatch(patch)'), lifecycle().indexOf('initLocal()'));
  assert.match(patch, /const incoming = stripServerOwned\(\{ \.\.\.patch \}\);/,
    'config.patch must sanitize a copied server patch');
  assert.match(patch, /Object\.assign\(this\._cfg, incoming\);/,
    'config.patch must merge only the sanitized server patch');
});

test('store：pending 标记读取异常时保守视为「有待同步」', () => {
  const store = lifecycle();
  assert.match(
    store,
    /function cfgSyncPending\(\)\s*\{\s*try\s*\{ return global\.localStorage\.getItem\(LS_CFG_PENDING\) === '1'; \} catch \(_\) \{ return true; \}/,
    '读异常返回 true（宁可多补推，不给后台旧值回灌开门）'
  );
});

test('win-bridge：窗口广播合并前剥离（自包含清单，不依赖加载顺序）', () => {
  const bridge = read('core', 'win-bridge.js');
  const pull = bridge.slice(bridge.indexOf('function pullCfg()'), bridge.indexOf('function pullCfg()') + 700);
  assert.match(pull, /\['modelProviders'\]\.forEach\(k\s*=>\s*\{\s*delete incoming\[k\];\s*\}\)/);
});

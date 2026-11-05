const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
/*
 * Assert the combined schedule panel, method controls, and execution drawer so split
 * modules receive complete coverage.
 */
const panel = fs.readFileSync(
  path.join(root, 'components', 'panels', 'panels-schedules.js'), 'utf8') +
  fs.readFileSync(path.join(root, 'components', 'panels', 'panels-schedules-cards.js'), 'utf8') +
  fs.readFileSync(
    path.join(root, 'components', 'panels', 'panels-schedules-methods.js'), 'utf8') +
  fs.readFileSync(
    path.join(root, 'components', 'panels', 'panels-schedules-editor.js'), 'utf8') +
  fs.readFileSync(
    path.join(root, 'components', 'panels', 'panels-schedules-runs.js'), 'utf8');
const compose = fs.readFileSync(
  path.join(root, 'components', 'panels', 'panels-compose.js'), 'utf8');
const css = fs.readFileSync(
  path.join(root, 'components', 'panels', 'panels-schedules.css'), 'utf8');
const indexEntry = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const deskEntry = fs.readFileSync(path.join(root, 'desk.html'), 'utf8');

test('自动化只展示后端批准并开放 automation 入口的插件', () => {
  assert.match(api, /plugins\/automation-options/);
  assert.match(panel, /item\.entrypoints\.automation/);
  assert.match(panel, /item\.runnable/);
});

test('计划保存不可变绑定与公开输入，不把插件退化成单 Agent 派活', () => {
  assert.match(panel, /pluginBindingId:/);
  assert.match(panel, /pluginInputs:/);
  assert.match(panel, /mode === 'plugin'/);
  assert.match(panel, /插件自动化/);
});

test('自动化表单说明两种执行心智并预览插件节点', () => {
  assert.match(panel, /直接执行/);
  assert.match(panel, /多节点、可审批、可追踪/);
  assert.match(panel, /sch-plugin-flow/);
  assert.match(css, /\.sch-mode-tabs/);
  assert.match(css, /\.sch-plugin-card/);
});

test('自动化参数支持说明、默认值、数字和选项而不是裸文本框', () => {
  assert.match(panel, /field\.description/);
  assert.match(panel, /field\.default/);
  assert.match(panel, /field\.type === 'select'/);
  assert.match(panel, /data-input-type="number"|data-input-type/);
  assert.match(panel, /Number\(el\.value\)/);
  assert.match(css, /sch-plugin-field>span small/);
});
test('scheduled computer automation is preflighted and retryable', () => {
  assert.match(api, /schedules\/preflight/);
  assert.match(panel, /requiredCapabilities/);
  assert.match(panel, /preflightSchedule\(readBody\(\)\)/);
  assert.match(panel, /result\.checks/);
  assert.match(panel, /schReady/);
  assert.match(panel, /schCaps/);
  assert.match(panel, /schRetry/);
  assert.match(css, /\.sch-cap-grid/);
  assert.match(css, /\.sch-ready small/);
  assert.match(css, /\.sch-ready\.blocked/);
  assert.match(css, /\.sch-retry-row/);
});
test('自动化执行记录展示普通会话、状态和打开入口', () => {
  assert.match(api, /schedules\/.*\/runs/);
  assert.match(panel, /listScheduleRuns/);
  assert.match(panel, /客户端接收任务后才会创建会话/);
  assert.match(panel, /data-run-chat/);
  assert.match(panel, /starting:/);
  assert.match(panel, /waiting:/);
  assert.match(panel, /succeeded:/);
  assert.doesNotMatch(panel, /data-run-task/);
  assert.match(panel, /receipt\.plugin/);
  assert.match(panel, /receipt\.route/);
  assert.match(panel, /固定版本/);
  assert.match(panel, /class="sch-run-drawer" role="dialog" aria-modal="true"/);
  assert.match(panel, /data-run-close/);
  assert.match(panel, /event\.key === 'Escape'/);
  assert.match(panel, /event\.key !== 'Tab'/);
  assert.match(panel, /button:not\(\[disabled\]\)/);
  assert.match(panel, /_schRenderRunDrawer/);
  assert.doesNotMatch(panel, /_schRunsHtml\(s\.id\)/);
  assert.match(css, /\.sch-run-layer/);
  assert.match(css, /\.sch-run-drawer\{position:absolute;top:0;right:0;bottom:0/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /\.sch-run-proof/);
  assert.match(css, /\.sch-run\.failed/);
});

test('手动新建、编辑和场景模板继续在右侧配置抽屉中完成', () => {
  assert.match(panel, /class="sch-editor-drawer" role="dialog" aria-modal="true"/);
  assert.match(panel, /_schPrepareEditor\('new'/);
  assert.match(panel, /_schPrepareEditor\(s, btn\)/);
  assert.match(panel, /_schPrepareEditor\(draft, button\)/);
  assert.match(panel, /_schCloseEditor\(true\)/);
  assert.match(panel, /正在保存…/);
  assert.doesNotMatch(panel, /if \(_schEditing\) \{ body\.innerHTML/);
  assert.match(css, /\.sch-editor-layer/);
  assert.match(css, /\.sch-editor-drawer\{position:absolute;top:0;right:0;bottom:0/);
  assert.match(css, /\.sch-editor-drawer \.sch-f-acts\{position:sticky/);
});

test('两个自动化抽屉在桌宠和主窗口都紧随主脚本加载', () => {
  for (const entry of [indexEntry, deskEntry]) {
    const main = entry.indexOf('components/panels/panels-schedules.js');
    const editor = entry.indexOf('components/panels/panels-schedules-editor.js');
    const runs = entry.indexOf('components/panels/panels-schedules-runs.js');
    assert.ok(main >= 0, '缺少自动化主脚本');
    assert.ok(editor > main, '配置抽屉必须在自动化主脚本之后加载');
    assert.ok(runs > main, '执行记录抽屉必须在自动化主脚本之后加载');
  }
});

test('automation disable confirmation uses the shared accessible dialog in both entry points', () => {
  assert.match(indexEntry, /components\/shared\/app-confirm-dialog\.css/);
  assert.match(indexEntry, /components\/shared\/app-confirm-dialog\.js/);
  assert.match(deskEntry, /components\/shared\/app-confirm-dialog\.css/);
  assert.match(deskEntry, /components\/shared\/app-confirm-dialog\.js/);
  assert.match(panel, /SoduWorkConfirmDialog\.open/);
  assert.match(panel, /继续运行/);
  assert.match(panel, /停用自动化/);
});

test('automation templates come only from the admin console (no built-in fallback)', () => {
  assert.doesNotMatch(panel, /SCH_RECIPES/);
  assert.match(panel, /_schTemplates\.length/);
  assert.match(panel, /sch-recipes/);
  assert.match(panel, /sch-blueprint/);
  assert.match(panel, /schBpWhen/);
  assert.match(panel, /schBpWork/);
  assert.match(css, /\.sch-recipes>div/);
  assert.match(css, /\.sch-blueprint ol/);
  /* Omit the template section when no administrator templates exist; do not fabricate examples. */
  assert.match(panel, /function _schRecipeHtml\(compact\) \{\r?\n  if \(!_schTemplates\.length\) return '';/);
  assert.doesNotMatch(panel, /每日工作总结/);
  assert.doesNotMatch(panel, /网页巡检/);
  assert.doesNotMatch(panel, /业务系统办理/);
  assert.match(panel, /_schVisualIcon\('template'\)/);
});

test('模板产生的是新草稿，只有真实持久化 id 才走更新接口', () => {
  assert.match(panel, /const editingId = _schEditing/);
  assert.match(panel, /if \(editingId\) await SoduWorkAPI\.updateSchedule\(editingId, body\)/);
  assert.match(panel, /else await SoduWorkAPI\.createSchedule\(body\)/);
  assert.doesNotMatch(panel,
    /if \(_schEditing && _schEditing !== 'new'\) await SoduWorkAPI\.updateSchedule/);
});

test('普通自动化编辑时能力可取消，空插件 key 不会被误判成固定快照', () => {
  assert.match(panel, /const same = Boolean\(personalKey && editing/);
  assert.match(panel, /document\.querySelectorAll\('#schCaps input:checked'\)/);
});
test('计划保存浏览器 IANA 时区，但界面只展示本地化的人类时间', () => {
  assert.match(panel, /resolvedOptions\(\)\.timeZone/);
  assert.match(panel, /timeZone:/);
  assert.match(panel, /nextRunLocal/);
  assert.match(panel, /_schLocal\(s\.nextRunAt\)/);
  assert.match(panel, /_schTimeZoneLabel/);
  assert.match(panel, /北京时间/);
  assert.doesNotMatch(panel, /\(s\.timeZone \? ' · ' \+ esc\(s\.timeZone\) : ''\)/);
});

test('个人插件自动化默认固定可验证版本，能力合同随方法自动锁定', () => {
  assert.match(panel, /personalPluginKey/);
  assert.match(panel, /personalPluginVersionPolicy/);
  assert.match(panel, /personalPluginVersion/);
  assert.match(panel, /personalPluginChecksum/);
  assert.match(panel, /id="schMethod"/);
  assert.match(panel, /data-method-input/);           /* Keep personal parameter state separate from enterprise-plugin state. */
  assert.match(panel, /_schmCaps/);                   /* Include plugin-declared capabilities in the execution contract. */
  assert.match(panel, /只在这台 SoduWork/);
  assert.match(panel, /结果可复现/);
  assert.match(panel, /跟随最新版/);                  /* Preserve legacy schedule semantics as explicit choices. */
  assert.match(panel, /一个 Agent/);                  /* Treat personal workflows as sequential drafts, not an orchestration engine. */
  assert.match(panel, /逐节点 Agent/);
  assert.match(panel, /preserveSnapshot/);            /* Changing time on a pinned version must not rewrite parameters or capabilities. */
  assert.match(panel, /_schmSnapshotLocked/);
  assert.match(panel, /原方法当前不可用/);             /* Retain snapshots after disabling or deleting a plugin. */
  assert.match(css, /\.snapshot-locked/);
  assert.match(panel, /entrypoints && item\.entrypoints\.automation/);
});

test('对话第四态可选个人插件，落库形状与定时面板一致', () => {
  assert.match(compose, /automationMethods/);
  assert.match(panel, /_schmCreateAutomation/);
  assert.match(panel, /personalPluginKey: methodKey/);
  assert.match(panel, /personalPluginVersionPolicy: method \? 'pinned'/);
  assert.match(panel, /personalPluginChecksum: method/);
  assert.match(panel, /requiredCapabilities: method \? _schmCaps\(method\)/);
});

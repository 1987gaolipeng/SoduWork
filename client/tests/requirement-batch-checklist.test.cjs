const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-draft.js'), 'utf8');
function functionBefore(name, nextName) {
  const start = source.indexOf('function ' + name + '(');
  const end = source.indexOf('function ' + nextName + '(', start + 1);
  assert.ok(start >= 0 && end > start, 'The production function boundaries must exist');
  return source.slice(start, end);
}
const mergeSource = functionBefore('_mergeChecks', 'open');
const criteria = Array.from({ length: 12 }, (_, i) => `[R${i < 6 ? 1 : 2}] acceptance ${i + 1}`);
function merge(requirementBatch) {
  const context = { _opts: { requirementBatch }, global: {}, criteria };
  return Array.from(vm.runInNewContext(mergeSource + '\n_mergeChecks(criteria)', context));
}
test('batch delivery retains every requirement criterion beyond the fifth row', () => {
  assert.deepEqual(merge(true), criteria);
});
test('ordinary requirements retain every acceptance criterion without a lossy preview limit', () => {
  assert.deepEqual(merge(false), criteria);
});
test('batch refinement receives the full checklist rather than a five-row preview', () => {
  const start = source.indexOf('function _refinePrompt(');
  const end = source.indexOf('\n  function ', start + 1);
  const functionText = source.slice(start, end);
  const prompt = vm.runInNewContext(functionText + '\n_refinePrompt({check: criteria}, "只修改标题")', {
    _opts: { requirementBatch: true }, criteria,
  });
  for (const row of criteria) assert.ok(prompt.includes(row));
});

test('创建阶段忽略旧工作类型选择，不加载或绑定执行流程', () => {
  const context = { _d: { title: 'Meeting', scene: 'old', flow: '', who: { kind: 'me' } }, _submission: null };
  vm.runInNewContext(functionBefore('_apply', '_sync') + "\n_apply('scene|meeting-followup')", context);
  assert.equal(context._d.scene, 'old'); assert.equal(context._d.sceneManual, undefined);
  assert.equal(context._d.flow, ''); assert.equal(context._d.who.kind, 'me');
});

test('opening a persisted delivery conversation cannot turn its success receipt into cancellation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-compose-submit.js'), 'utf8');
  const handlers = {}, opened = [], cleared = [], created = [], window = {};
  const box = { innerHTML: '', querySelector: selector => ({
    addEventListener: (_type, action) => { handlers[selector] = action; },
  }) };
  vm.runInNewContext(source, { window });
  window.ComposeDraftSubmit.done({ box, id: 'stored-task', title: 'Created', variant: 'chat', esc: String,
    clear: () => cleared.push(true), onOpen: id => opened.push(id), onCreated: id => created.push(id) });
  handlers['#cpOpen']();
  assert.deepEqual(opened, ['stored-task']);
  assert.deepEqual(created, ['stored-task']);
  assert.deepEqual(cleared, []);
  handlers['[data-cp-receipt-close]']();
  assert.equal(cleared.length, 1);
});

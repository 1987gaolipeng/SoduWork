"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const node = () => ({ dataset: {}, setAttribute() {}, classList: { toggle() {}, remove() {} } });
  const nodes = { '.ncw': node(), '.ncw-tabs': node(), '.ncw-body': node() };
  const root = { ...node(), querySelector: selector => nodes[selector] || null, addEventListener() {} };
  const calls = [], sandbox = { console, URL, document: { activeElement: null },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    ChatChrome: { workbenchState() {} }, ChatWorkspaceSplit: { DEFAULT: 0.5, set() {}, bind: () => ({ dispose() {} }) },
    soduWorkAPI: { conversationSession: { artifactAction: async (...args) => { calls.push(['artifact', ...args]); return { ok: true }; } } } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  for (const name of ['chat-output-links', 'chat-dom-patch', 'panels-chat-tools', 'chat-workspace-info', 'chat-workspace-controls', 'panels-chat-workspace'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', name + '.js'), 'utf8'), sandbox);
  const links = sandbox.ChatOutputLinks;
  links.openTaskFile = async file => { calls.push(['task', file.name]); };
  links.taskAttachment = async file => { calls.push(['pdf-window', file.name]); return { url: '/attachment' }; };
  sandbox.soduWorkAPI.previewAttachment = async () => ({ ok: true });
  links.materialize = async (file, api, ref, options) => {
    calls.push(['materialize', file.name, options]);
    return { ...file, cloudPending: false, taskId: undefined, attachmentId: undefined, path: '/project/' + file.name };
  };
  const wb = sandbox.ChatWorkbench;
  wb.bind(root, () => ({ ref: 'chat', cwd: '/project', intent: {} }));
  const render = files => wb.render(root, { status: 'idle', messages: [
    { role: 'user', at: 1000, blocks: [{ kind: 'text', text: 'Generate files' }] },
    { role: 'assistant', at: 1200, blocks: [{ kind: 'text', text: 'Done' }] }], tools: [],
    deliverySync: { currentTurn: true, artifactVersions: files.map(f => ({ id: f.artifactId, at: f.at, size: f.size })) } }, files);
  return { wb, calls, sandbox, render };
}
const artifact = (name, extra = {}) => ({ artifactId: name, relative: name, name, size: 20, at: 1200,
  primary: true, changedInTurn: true, ...extra });
for (const source of ['local', 'task', 'cloud']) test(source + ': non-preview files stay passive until explicitly opened', async () => {
  for (const [name, kind] of [['report.docx','document'], ['slides.pptx','presentation'], ['table.xlsx','spreadsheet'], ['bundle.zip','archive'], ['data.bin','binary'], ['opaque','document'], ['remote.pdf','pdf']]) {
    if (source === 'local' && name === 'remote.pdf') continue;
    const f = fixture(), file = artifact(name, { kind, ...(source === 'local' ? { path: '/project/' + name }
      : { taskId: 'task', attachmentId: name, cloudPending: source === 'cloud' }) });
    f.render([file]); f.render([file]); await tick();
    assert.deepEqual(f.calls, [], name + ' must not download, open an app, or open a separate preview');
    assert.equal(f.wb.state().open, false, name + ' must not leave an empty right pane');
    assert.equal(f.wb.openOutput(file.artifactId), true);
    await tick();
    assert.ok(f.calls.length > 0, name + ' remains manually accessible');
  }
});
test('supported local previews still open automatically when mixed with Office files', () => {
  for (const name of ['index.html', 'report.md', 'image.png', 'movie.mp4', 'report.pdf']) {
    const f = fixture();
    f.render([artifact('table.xlsx', { kind: 'spreadsheet' }), artifact(name, { path: '/project/' + name })]);
    assert.equal(f.wb.state().open, true, name);
    assert.equal(f.calls.some(call => call[0] !== 'artifact' || call.at(-1) === 'open'), false);
  }
});
test('automatic cloud preview keeps preview-only intent through async materialization', async () => {
  const f = fixture();
  f.sandbox.ChatOutputLinks.materialize = async (file, api, ref, options) => {
    f.calls.push(['materialize', options]);
    return artifact('unexpected.xlsx', { kind: 'spreadsheet', path: '/project/unexpected.xlsx' });
  };
  f.render([artifact('index.html', { cloudPending: true, taskId: 'task', attachmentId: 'page', kind: 'website' })]);
  await tick();
  assert.equal(f.calls.length, 1, 'a materialized file must not fall back to an external application');
  assert.equal(f.calls[0][1]?.previewOnly, true, 'automatic preview must not fetch unrelated Office files');
});


test('production preview readers forward preview-only downloads separately from manual actions', async () => {
  const links = require('../components/panels/chat-output-links'), calls = [];
  const oldBridge = global.soduWorkAPI;
  const file = artifact('page.html', { taskId: 'task', attachmentId: 'page', cloudPending: true });
  const local = artifact('page.html', { remoteAttachmentId: 'page', cloudTaskId: 'task' });
  const api = { cloud: { materialize: async (ref, input) => { calls.push(input); return { ok: true, artifact: local }; } },
    artifactAction: async () => ({ ok: true, text: '<h1>Preview</h1>' }) };
  try {
    await links.readPreview(file, api, 'chat');
    await links.materialize(file, api, 'chat');
    assert.equal(calls[0].previewOnly, true);
    assert.equal(calls[1].previewOnly, undefined);
    global.soduWorkAPI = { attachmentMaterialize: async input => {
      calls.push(input); return { ok: true, artifacts: [{ ...local, attachmentId: 'page', path: '/project/page.html' }] };
    } };
    await links.materializeTask(file, api, 'chat', { previewOnly: true });
    await links.materializeTask(file, api, 'chat');
    assert.equal(calls[2].previewOnly, true);
    assert.equal(calls[3].previewOnly, undefined);
  } finally { global.soduWorkAPI = oldBridge; }
});

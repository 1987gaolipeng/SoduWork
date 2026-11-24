'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const personal = require('../../main/personal-plugins');

const draftName = 'soduwork-plugin-draft.json';
const template = 'templates/review.md';
const content = '# Review\nCompare the supplied facts against the checklist.\n';
const chats = ['history-method', 'history-archive', 'history-app', 'history-unrecorded', 'history-connector', 'history-workflow'];

async function write(root, row) {
  const folder = path.join(row.cwd, 'delivery');
  const manifest = { template: 'method', key: row.id, name: row.id, version: '1.0.0',
    description: 'Compare a sample with the supplied checklist.',
    instructions: 'Copy the supplied review template and check each fact.',
    resources: [{ path: template, kind: 'template' }] };
  let files;
  if (row.id === 'history-connector') {
    const candidate = path.join(row.cwd, 'mcp-config.json'), info = path.join(row.cwd, 'plugin-info.json');
    fs.writeFileSync(candidate, JSON.stringify({ mcpServers: { 'template-fixture': {
      type: 'http', url: 'https://import.fixture.invalid/mcp', headers: { Authorization: '' },
      enabled: false, enabledTools: ['read_status'], disabledTools: ['delete_item'] } } }));
    const { key, name, version, description, instructions } = manifest;
    fs.writeFileSync(info, JSON.stringify({ key, name, version, description, instructions }));
    require('../../../skills/mcp-studio/scripts/mcp-config.cjs').bundle(candidate, info, folder);
    const draft = JSON.parse(fs.readFileSync(path.join(folder, draftName), 'utf8'));
    files = [draftName, ...draft.resources.map(resource => resource.path)];
  } else if (row.id === 'history-workflow') {
    fs.mkdirSync(path.join(folder, 'ordinary'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ ...manifest, template: 'workflow', resources: [] }));
    fs.writeFileSync(path.join(folder, 'ordinary/plugin.json'), JSON.stringify({ name: 'ordinary application metadata' }));
    files = ['plugin.json', 'ordinary/plugin.json'];
  } else if (row.id === 'history-app') {
    const result = require('../../../skills/app-developer/scripts/scaffold.cjs').scaffold({
      out: folder, key: row.id, name: 'History review app', storage: 'local' });
    const draft = JSON.parse(fs.readFileSync(result.draft, 'utf8'));
    files = [draftName, ...draft.resources.map(resource => resource.path)];
  } else if (row.id === 'history-archive') {
    const archive = 'method.soduwork-plugin';
    const author = { getPath: () => path.join(root, 'export-profile') };
    fs.mkdirSync(folder);
    const { plugin } = personal.create(author, { ...manifest, resources: [{ ...manifest.resources[0], content, encoding: 'utf8' }] });
    await personal.exportToFile(author, { showSaveDialog: async () => ({ canceled: false, filePath: path.join(folder, archive) }) }, plugin.pluginId);
    files = [archive];
  } else {
    fs.mkdirSync(path.join(folder, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(folder, draftName), JSON.stringify(manifest));
    fs.writeFileSync(path.join(folder, template), content);
    files = row.id === 'history-unrecorded' ? [draftName] : [draftName, template];
  }
  return files.map(file => 'delivery/' + file);
}

async function verify({ app, root, activate, click, js, until, report }) {
  const installed = key => personal.catalog(app, true).find(row => row.key === key);
  for (const id of chats.slice(0, 3)) {
    assert.equal(await activate(id), 1, 'Cold history must expose exactly one install action for ' + id);
    const ref = await js("document.querySelector('[data-install-plugin-draft]').dataset.pluginDraftRef");
    const target = await js("document.querySelector('[data-install-plugin-draft]').dataset.installPluginDraft");
    await click('[data-install-plugin-draft]');
    await until(() => js("!document.getElementById('capModalLayer')?.hidden && !!document.getElementById('capLocalOnly')"), 'installation preview for ' + id);
    assert.equal(await js("document.getElementById('capLocalInstall').textContent"), id === 'history-app' ? '安装并打开' : '安装并试用');
    assert.equal(installed(id), undefined, 'Preflight alone cannot install a plugin');
    await click('#capLocalOnly');
    await until(() => js("!!document.getElementById('capLocalDone')"), 'confirmed installation for ' + id);
    await click('#capLocalDone');
    await until(() => js("document.getElementById('capModalLayer').hidden"), 'dismissed completion dialog');
    assert.ok(installed(id));
    const draft = personal.exportDraft(app, installed(id).pluginId);
    const folder = path.join(root, 'workspaces', id, 'delivery');
    if (id === 'history-app') {
      assert.equal(draft.template, 'app');
      assert.equal(draft.jiyong.storage.location, 'local');
      assert.equal(draft.resources.length, 4);
      for (const resource of draft.resources) {
        assert.deepEqual(Buffer.from(resource.content, 'base64'), fs.readFileSync(path.join(folder, resource.path)));
      }
      fs.unlinkSync(path.join(folder, 'ui/app.js'));
    } else {
      assert.equal(draft.resources.length, 1);
      assert.equal(Buffer.from(draft.resources[0].content, 'base64').toString(), content);
      if (id === 'history-method') fs.writeFileSync(path.join(folder, template), 'different bytes');
      else fs.unlinkSync(path.join(folder, 'method.soduwork-plugin'));
    }
    const stale = await js(`soduWorkAPI.conversationSession.pluginDraft(${JSON.stringify(ref)}, ${JSON.stringify(target)})`);
    assert.equal(stale.ok, false, 'The previous card must refuse a changed or missing resource');
    assert.equal(await activate(id), 0, 'Reopening must not re-enable installing the changed bytes');
    report.cases.push('Historical ' + id + ' preflight and explicit installation preserve the verified package and reject changed or missing files');
  }
  assert.equal(await activate('history-unrecorded'), 0, 'An unreceipted resource cannot be collected from a neighboring folder');
  assert.equal(installed('history-unrecorded'), undefined);
  report.cases.push('A historical manifest cannot install its unreceipted sibling resource');
  for (const id of ['history-connector', 'history-workflow']) {
    assert.equal(await activate(id), 1, 'Only the recognized historical draft should expose an install action for ' + id);
    const result = await js(`(async () => {
      const card = document.querySelector('[data-install-plugin-draft]');
      return soduWorkAPI.conversationSession.pluginDraft(card.dataset.pluginDraftRef, card.dataset.installPluginDraft);
    })()`);
    assert.equal(result.ok, true);
    assert.equal(result.body.template, id === 'history-connector' ? 'connector' : 'workflow');
    if (id === 'history-connector') {
      assert.deepEqual(result.body.mcpServers, ['template-fixture']);
      const file = result.body.resources.find(resource => resource.path === 'references/connections/template-fixture.mcp.json');
      const server = JSON.parse(Buffer.from(file.content, 'base64')).mcpServers['template-fixture'];
      assert.equal(server.enabled, false);
      assert.deepEqual(server.headers, { Authorization: '' });
    }
    await click('[data-install-plugin-draft]');
    await until(() => js("!document.getElementById('capModalLayer')?.hidden && !!document.getElementById('capLocalOnly')"), 'historical preflight for ' + id);
    await click('#capLocalCancel');
    await until(() => js("document.getElementById('capModalLayer').hidden"), 'dismissed preflight');
    assert.equal(installed(id), undefined);
  }
  report.cases.push('MCP Studio connector and legacy workflow pass historical preflight without installing or connecting; unrelated plugin.json stays a file');
}

module.exports = { chats, write, verify };

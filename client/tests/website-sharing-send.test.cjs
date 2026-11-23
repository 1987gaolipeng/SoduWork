'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), zlib = require('node:zlib'), crypto = require('node:crypto');
const archive = require('../main/conversation/zip-archive');
const artifacts = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');
const mate = require('../components/panels/chat-mate-mention');
const { createPickFolderHandler } = require('../main/pi-session/mate-message-ipc');

function website(t, depth, empty = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-website-send-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, ...Array.from({ length: depth }, (_, i) => 'level-' + i));
  fs.mkdirSync(directory, { recursive: true });
  const script = empty ? 'app.js' : path.relative(root, path.join(directory, 'required.js')).replaceAll('\\', '/');
  fs.writeFileSync(path.join(root, 'index.html'), '<script src="' + script + '"></script>');
  fs.writeFileSync(path.join(root, script), 'window.fixtureLoaded = true;');
  const session = { cwd: root, outputSnapshot: () => outputs.scan(root, 0, 0) };
  const api = {
    outputs: async () => ({ ok: true, artifacts: artifacts.decorate('fixture', { items: session.outputSnapshot().delivery.items }) }),
    artifactAction: (ref, id, action) => artifacts.action(session, ref, id, action, {}),
    pickShareFolder: () => createPickFolderHandler({ BrowserWindow: { fromWebContents: () => null },
      dialog: { showOpenDialog: async () => ({ filePaths: [root] }) }, shareArchive: archive })({ sender: {} }),
  };
  return { root, script, api, context: { ref: 'fixture', api } };
}

function entries(bytes) {
  const result = new Map(); let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const method = bytes.readUInt16LE(at + 8), size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26), extraLength = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    at += 30 + nameLength + extraLength;
    const data = bytes.subarray(at, at + size); at += size;
    result.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
  }
  assert.equal(bytes.readUInt32LE(at), 0x02014b50);
  return result;
}

function events() {
  const handlers = new Map();
  return {
    addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(handler); },
    removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
    async dispatchEvent(event) { for (const handler of handlers.get(event.type) || []) await handler(event); },
  };
}
function element(tag = 'div') {
  return { ...events(), tag, children: [], style: {}, value: '', textContent: '', attributes: {}, nodeType: 1,
    isConnected: true, scrollHeight: 80, selectionStart: 0, focus() {}, remove() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; }, contains(target) { return target === this || this.children.some(c => c.contains(target)); },
    querySelector(tag) { return this.children.find(c => c.tag === tag); },
    set innerHTML(value) { this.children = (value.match(/<(b|span)>/g) || []).map(t => element(t.slice(1, -1))); },
  };
}
async function settled(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'The sharing card did not finish its current action');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function sharingCard(t, fixture, folderOnly = false, fromApp = false) {
  const input = element('textarea'), host = element(), document = { ...events(), createElement: element };
  host.getBoundingClientRect = () => ({ left: 0, top: 500, bottom: 550, width: 600 });
  const browser = { ...events(), document, innerWidth: 1200, innerHeight: 900, crypto, Event, setTimeout, clearTimeout,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout };
  browser.window = browser;
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/panels/chat-mate-mention'), 'utf8'), browser);
  const sent = [], messages = [];
  const api = folderOnly ? { ...fixture.api, outputs: async () => ({ ok: true, artifacts: [] }) } : fixture.api;
  const controller = browser.ChatMateMention.create({ input, host,
    mates: async () => ({ mates: [{ id: 'recipient', name: 'Recipient', hasBox: true }] }),
    context: () => ({ ref: 'fixture', api }), progress: async () => 'Fixture ready to share',
    send: async (id, text, payload) => { sent.push(payload); return { ok: true, delivered: true }; },
    say: message => messages.push(message) });
  t.after(() => controller.destroy());
  if (fromApp) {
    assert.equal((await controller.open({ recipientUserId: 'recipient', text: 'Fixture ready to share' })).ok, true);
  } else {
    input.value = '@'; input.selectionStart = 1; await input.dispatchEvent({ type: 'input' });
    const menu = host.children[0];
    await settled(() => menu.children.some(c => c.tag === 'button'));
    await menu.children.find(c => c.tag === 'button').dispatchEvent({ type: 'click' });
  }
  const card = host.children[1];
  const results = () => card.children.find(c => c.className === 'nmate-results');
  await settled(() => !String(results()?.children[0]?.textContent || '').includes('正在整理'));
  const send = card.children.find(c => c.className === 'nmate-card-send');
  await settled(() => (!send.disabled && card.children.find(c => c.tag === 'textarea').value) ||
    results().children.some(c => c.tag === 'button'));
  return { card, send, sent, messages, results, async pickFolder() {
    const tools = card.children.find(c => c.className === 'nmate-card-tools');
    await tools.children.find(c => c.textContent === '添加文件夹').dispatchEvent({ type: 'click' });
  } };
}

function otherOutputs(t, documentOnly = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-independent-share-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (documentOnly) {
    fs.writeFileSync(path.join(root, 'report.html'), '<!doctype html><h1>Quarterly report</h1>');
    fs.mkdirSync(path.join(root, '.soduwork'));
    fs.writeFileSync(path.join(root, '.soduwork', 'delivery.json'), JSON.stringify({ schemaVersion: 1,
      deliverables: [{ path: 'report.html', kind: 'document', title: 'Quarterly report' }] }));
  } else {
    fs.writeFileSync(path.join(root, 'report.csv'), 'name,value\ncomplete,42\n');
    const deep = path.join(root, 'website', ...Array.from({ length: 13 }, (_, i) => 'level-' + i));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(root, 'website/index.html'), '<script src="' + path.relative(path.join(root, 'website'), path.join(deep, 'required.js')).replaceAll('\\', '/') + '"></script>');
    fs.writeFileSync(path.join(deep, 'required.js'), 'window.fixtureLoaded=true;');
  }
  const session = { cwd: root, outputSnapshot: () => outputs.scan(root, 0, 0) };
  const api = { outputs: async () => ({ ok: true, artifacts: artifacts.decorate('fixture', { items: session.outputSnapshot().delivery.items }) }),
    artifactAction: (ref, id, action) => artifacts.action(session, ref, id, action, {}) };
  return { root, api, context: { ref: 'fixture', api } };
}

test('website sharing counts each directory once and keeps same-name ZIPs independently selectable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-website-directories-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sites = ['one/site', 'two/site', 'third'];
  for (const site of sites) {
    fs.mkdirSync(path.join(root, site), { recursive: true });
    fs.writeFileSync(path.join(root, site, 'index.html'), site);
  }
  fs.writeFileSync(path.join(root, sites[0], 'guide.html'), 'Guide');
  const sample = crypto.randomBytes(13 * 1024 * 1024);
  fs.writeFileSync(path.join(root, sites[0], 'sample.bin'), sample);
  fs.writeFileSync(path.join(root, 'report.csv'), 'name,value\ncomplete,42\n');
  const caseAlias = 'ONE/SITE/guide.html';
  const guide = fs.existsSync(path.join(root, caseAlias)) ? caseAlias : sites[0] + '/./guide.html';
  const pages = [...sites.map(site => site + '/index.html'), guide];
  fs.mkdirSync(path.join(root, '.soduwork'));
  fs.writeFileSync(path.join(root, '.soduwork/delivery.json'), JSON.stringify({ schemaVersion: 1,
    deliverables: [...pages.map(entry => ({ path: entry, kind: 'website' })), { path: 'report.csv', kind: 'document' }] }));

  const session = { cwd: root, outputSnapshot: () => outputs.scan(root, 0, 0) };
  const packaged = [];
  const context = { ref: 'fixture', api: {
    outputs: async () => ({ artifacts: await artifacts.decorateForSharing('fixture', session.outputSnapshot().delivery) }),
    artifactAction: (ref, id, action) => {
      if (action === 'share-related') packaged.push(id);
      return artifacts.action(session, ref, id, action, {});
    },
  } };
  const rows = await mate.conversationOutputs(context);
  assert.equal(packaged.length, 3);
  const payload = await mate.outputPayload(context, rows, 'within-limit');
  assert.deepEqual(payload.files.map(file => file.name).sort(), ['report.csv', 'site.zip', 'site.zip', 'third.zip']);
  assert.equal(Buffer.from(payload.files.find(file => file.name === 'report.csv').data, 'base64').toString(), 'name,value\ncomplete,42\n');
  const selected = new Set();
  for (const row of rows.filter(row => row.name === 'site.zip')) {
    const { files } = await mate.outputPayload(context, [row], 'select-one');
    assert.equal(files.length, 1);
    const zip = entries(Buffer.from(files[0].data, 'base64'));
    const site = zip.get('index.html').toString();
    selected.add(site);
    if (site === sites[0]) {
      assert.equal(zip.get('guide.html').toString(), 'Guide');
      assert.ok(zip.get('sample.bin').equals(sample));
    }
  }
  assert.deepEqual(selected, new Set(sites.slice(0, 2)));
  fs.writeFileSync(path.join(root, sites[1], 'sample.bin'), sample);
  await assert.rejects(mate.outputPayload(context, await mate.conversationOutputs(context), 'over-limit'), /24 MB/);
});

for (const failedPosition of [3, 4]) {
  test('default teammate send excludes a failed website at position ' + failedPosition + ' and delivers every healthy file', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-multiple-websites-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sites = ['site-a', 'site-b', 'site-c', 'site-d'];
    const deliverables = sites.map((site, index) => {
      const directory = path.join(root, site);
      const script = index + 1 === failedPosition
        ? path.join(...Array.from({ length: 13 }, (_, i) => 'level-' + i), 'required.js') : 'app.js';
      fs.mkdirSync(path.dirname(path.join(directory, script)), { recursive: true });
      fs.writeFileSync(path.join(directory, 'index.html'), '<script src="' + script.replaceAll('\\', '/') + '"></script>');
      fs.writeFileSync(path.join(directory, script), 'window.fixtureLoaded=' + JSON.stringify(site) + ';');
      return { path: site + '/index.html', kind: 'website', title: site };
    });
    fs.writeFileSync(path.join(root, 'report.csv'), 'name,value\ncomplete,42\n');
    fs.mkdirSync(path.join(root, '.soduwork'));
    fs.writeFileSync(path.join(root, '.soduwork/delivery.json'), JSON.stringify({ schemaVersion: 1,
      deliverables: [...deliverables, { path: 'report.csv', kind: 'document', title: 'Report' }] }));
    const session = { cwd: root, outputSnapshot: () => outputs.scan(root, 0, 0) };
    const api = { outputs: async () => ({ ok: true, artifacts: artifacts.decorate('fixture', { items: session.outputSnapshot().delivery.items }) }),
      artifactAction: (ref, id, action) => artifacts.action(session, ref, id, action, {}) };
    assert.deepEqual((await api.outputs()).artifacts.filter(row => row.kind === 'website').map(row => row.relative),
      sites.map(site => site + '/index.html'));
    const ui = await sharingCard(t, { root, api });
    const failed = ui.results().children.find(row => row.tag === 'label' && row.children[1].textContent === 'index.html');
    assert.ok(failed, 'The failed website must remain visible in the card');
    assert.equal(failed.children[0].disabled, true);
    assert.equal(failed.children[0].checked, false);
    assert.match(ui.results().children.map(row => row.textContent).join('\n'), /nested more than 12 levels/);
    await ui.send.dispatchEvent({ type: 'click' });
    assert.equal(ui.sent.length, 1, 'One default send must deliver one message without manual deselection');
    const healthy = sites.filter((_site, index) => index + 1 !== failedPosition);
    assert.deepEqual(Array.from(ui.sent[0].files, file => file.name).sort(), [...healthy.map(site => site + '.zip'), 'report.csv'].sort());
    for (const attachment of ui.sent[0].files) {
      const bytes = Buffer.from(attachment.data, 'base64');
      if (attachment.name === 'report.csv') assert.deepEqual(bytes, fs.readFileSync(path.join(root, attachment.name)));
      else {
        const extracted = entries(bytes), site = attachment.name.slice(0, -4);
        assert.deepEqual([...extracted.keys()].sort(), ['app.js', 'index.html']);
        for (const [name, original] of extracted) assert.deepEqual(original, fs.readFileSync(path.join(root, site, name)));
      }
    }
  });
}

for (const fromApp of [false, true]) {
  const entry = fromApp ? 'prefilled card' : 'teammate mention';
  for (const selected of ['text', 'csv']) {
    test(entry + ' still sends ' + selected + ' when an unrelated website cannot be packaged', async t => {
      const fixture = otherOutputs(t);
      const ui = await sharingCard(t, fixture, false, fromApp);
      assert.equal(ui.send.disabled, false, 'An unselected failed website must not disable sending');
      const rows = ui.results().children.filter(c => c.tag === 'label');
      assert.ok(rows.some(row => row.children.some(c => c.textContent === 'report.csv')));
      for (const row of rows) {
        const checkbox = row.children[0];
        if (checkbox.disabled) continue;
        checkbox.checked = selected === 'csv' && row.children.some(c => c.textContent === 'report.csv');
        await checkbox.dispatchEvent({ type: 'change' });
      }
      await ui.send.dispatchEvent({ type: 'click' });
      assert.equal(ui.sent.length, 1);
      assert.equal(ui.sent[0].files.length, selected === 'csv' ? 1 : 0);
      if (selected === 'csv') {
        assert.equal(ui.sent[0].files[0].name, 'report.csv');
        assert.deepEqual(Buffer.from(ui.sent[0].files[0].data, 'base64'), fs.readFileSync(path.join(fixture.root, 'report.csv')));
      }
    });
  }
  test(entry + ' sends an explicitly declared HTML document as its original file', async t => {
    const fixture = otherOutputs(t, true);
    assert.equal((await fixture.api.outputs()).artifacts[0].kind, 'document');
    const ui = await sharingCard(t, fixture, false, fromApp);
    assert.equal(ui.send.disabled, false);
    const row = ui.results().children.find(c => c.tag === 'label');
    row.children[0].checked = true; await row.children[0].dispatchEvent({ type: 'change' });
    await ui.send.dispatchEvent({ type: 'click' });
    assert.equal(ui.sent.length, 1); assert.equal(ui.sent[0].files.length, 1);
    assert.equal(ui.sent[0].files[0].name, 'report.html');
    assert.deepEqual(Buffer.from(ui.sent[0].files[0].data, 'base64'), fs.readFileSync(path.join(fixture.root, 'report.html')));
  });
}

for (const entry of ['conversation', 'folder']) {
  for (const scenario of [{ name: 'required assets at depth 12', depth: 12 },
    { name: 'a shallow website with an empty directory at depth 13', depth: 13, empty: true }]) {
    test(entry + ' send preserves all bytes for ' + scenario.name, async t => {
      const fixture = website(t, scenario.depth, scenario.empty);
      const ui = await sharingCard(t, fixture, entry === 'folder');
      if (entry === 'folder') await ui.pickFolder();
      assert.equal(ui.send.disabled, false);
      await ui.send.dispatchEvent({ type: 'click' });
      assert.equal(ui.sent.length, 1);
      assert.equal(ui.sent[0].files.length, 1, 'Only the complete ZIP may contribute an attachment');
      const attachment = ui.sent[0].files[0]; assert.match(attachment.name, /\.zip$/);
      const extracted = entries(Buffer.from(attachment.data, 'base64'));
      assert.deepEqual([...extracted.keys()].sort(), ['index.html', fixture.script].sort());
      for (const [name, bytes] of extracted) assert.deepEqual(bytes, fs.readFileSync(path.join(fixture.root, name)));
      const browser = { window: {} };
      vm.runInNewContext(extracted.get(fixture.script).toString('utf8'), browser);
      assert.equal(browser.window.fixtureLoaded, true);
    });
  }
  test(entry + ' rejects a required asset at depth 13 without any outgoing attachment', async t => {
    const fixture = website(t, 13);
    const ui = await sharingCard(t, fixture, entry === 'folder');
    if (entry === 'folder') await ui.pickFolder();
    const errors = ui.messages.join('\n') + ui.results().children.map(c => c.textContent).join('\n');
    assert.match(errors, /nested more than 12 levels/);
    const rows = ui.results().children.filter(c => c.tag === 'label');
    assert.equal(rows.length, entry === 'conversation' ? 1 : 0);
    if (entry === 'conversation') { assert.equal(rows[0].children[0].disabled, true); assert.equal(rows[0].children[0].checked, false); }
    await ui.send.dispatchEvent({ type: 'click' });
    assert.ok(ui.sent.every(payload => payload.files.length === 0), 'No partial ZIP or standalone HTML may be sent');
  });
}

test('send preparation never falls back to bare HTML for an unbundled website', async t => {
  const fixture = website(t, 13);
  const rows = (await fixture.api.outputs()).artifacts.filter(file => file.name === 'index.html');
  await assert.rejects(mate.outputPayload(fixture.context, rows, 'fixture-message'), /nested more than 12 levels/);
});

test('legacy website send preparation packages complete files and keeps preview metadata', async t => {
  const fixture = website(t, 12);
  const rows = (await fixture.api.outputs()).artifacts.filter(file => file.name === 'index.html');
  const payload = await mate.outputPayload(fixture.context, rows, 'legacy-message');
  assert.equal(payload.files.length, 1);
  assert.match(payload.files[0].name, /\.zip$/);
  assert.equal(payload.website.status, 'zip_only');
  const extracted = entries(Buffer.from(payload.files[0].data, 'base64'));
  assert.deepEqual(extracted.get(fixture.script), fs.readFileSync(path.join(fixture.root, fixture.script)));
});

test('a website packaged during send still obeys the single attachment size limit', async () => {
  const context = { ref: 'fixture', api: { artifactAction: async (_ref, _id, action) => {
    assert.equal(action, 'share-related');
    return { ok: true, name: 'site.zip', data: '', size: 20 * 1024 * 1024 + 1 };
  } } };
  await assert.rejects(mate.outputPayload(context, [{ artifactId: 'site', name: 'index.html', kind: 'website' }], 'size-message'), /20 MB/);
});

test('missing or malformed website packaging cannot leave a standalone HTML selected', async () => {
  const result = { ok: true, artifacts: [{ artifactId: 'site', name: 'index.html', kind: 'website' }] };
  const unavailable = await mate.conversationOutputs({ ref: 'fixture', api: { outputs: async () => result } });
  assert.equal(unavailable.length, 1); assert.match(unavailable[0].shareError, /打包失败/);
  for (const bundled of [null, { ok: false }, { ok: true }]) {
    const context = { ref: 'fixture', api: { outputs: async () => result, artifactAction: async () => bundled } };
    const rows = await mate.conversationOutputs(context);
    assert.equal(rows.length, 1); assert.match(rows[0].shareError, /打包失败/);
    assert.equal((await mate.outputPayload(context, rows, 'failed-website')).files.length, 0);
  }
});

test('depth errors in both sharing entry points follow every existing native locale', async t => {
  const locale = require('../main/native-locale.cjs');
  const catalogs = require('../core/locales/builtin-ui');
  const previous = locale.getLocale(); t.after(() => locale.setLocale(previous));
  const fixture = website(t, 13);
  const row = (await fixture.api.outputs()).artifacts.find(file => file.name === 'index.html');
  const key = '文件夹包含超过12层的文件，请将文件移近所选文件夹后重试';
  for (const id of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']) {
    locale.setLocale(id);
    const folder = await fixture.api.pickShareFolder();
    const related = await fixture.api.artifactAction('fixture', row.artifactId, 'share-related');
    assert.equal(folder.ok, false); assert.equal(related.ok, false);
    assert.equal(folder.reason, catalogs[id][key], id);
    assert.equal(related.reason, catalogs[id][key], id);
  }
  await assert.rejects(archive.createZipAsync(fixture.root), error => error.code === 'ZIP_DEPTH_LIMIT');
});

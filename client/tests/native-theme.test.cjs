'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path'), { pathToFileURL } = require('node:url');
const { create, normalize, COLOR_KEYS, FONT_KEYS } = require('../main/native-theme.cjs');
function fixture() {
  const ipcMain = new EventEmitter(), owners = new Map(); let nextId = 1;
  const source = path.resolve(__dirname, '../desk.html');
  const mirror = create({ ipcMain, BrowserWindow: { fromWebContents: wc => owners.get(wc) } });
  function owner(url = pathToFileURL(source).href) {
    const wc = Object.assign(new EventEmitter(), { id: nextId++, url, destroyed: false });
    wc.mainFrame = { url }; wc.getURL = () => wc.url; wc.isDestroyed = () => wc.destroyed;
    const parent = { webContents: wc, isDestroyed: () => wc.destroyed }; owners.set(wc, parent); return parent;
  }
  function report(parent, snapshot, extra = {}) {
    ipcMain.emit('client-theme', { sender: parent.webContents, senderFrame: parent.webContents.mainFrame, ...extra }, snapshot);
  }
  return { mirror, owner, report };
}
test('each trusted application owner has independent live theme and does not inherit the last reporting window', () => {
  const f = fixture(), first = f.owner(), second = f.owner(), unseen = f.owner();
  const updates = [], otherUpdates = [];
  const release = f.mirror.subscribe(first, value => updates.push(value)); f.mirror.subscribe(second, value => otherUpdates.push(value));
  f.report(first, { theme: 'warm', tokens: { '--bg-0': '#fffdfa', '--accent': '#f0926a' } });
  f.report(second, { theme: 'minimal', tokens: { '--bg-0': '#ffffff', '--accent': '#1a1a1a' } });
  assert.equal(f.mirror.snapshot(first).theme, 'warm'); assert.equal(f.mirror.snapshot(second).theme, 'minimal');
  assert.equal(f.mirror.snapshot(unseen).theme, 'vivid'); assert.equal(updates.length, 1); assert.equal(otherUpdates.length, 1);
  f.report(first, { theme: 'azure', tokens: { '--accent': '#2f74e0' } });
  assert.equal(updates.at(-1).theme, 'azure'); assert.equal(otherUpdates.length, 1);
  release(); f.report(first, { theme: 'steady' }); assert.equal(updates.length, 2);
});
test('subframes, remote URLs, previews and destroyed owners cannot report trusted consent styling', () => {
  const f = fixture(), valid = f.owner();
  f.report(valid, { theme: 'warm' });
  f.report(valid, { theme: 'injected' }, { senderFrame: { url: valid.webContents.url } });
  assert.equal(f.mirror.snapshot(valid).theme, 'warm');
  for (const url of ['https://example.com/desk.html', 'file:///tmp/desk.html', pathToFileURL(path.resolve(__dirname, '../main/access-control/full-access-consent.html')).href]) {
    const bad = f.owner(url); f.report(bad, { theme: 'injected' }); assert.equal(f.mirror.snapshot(bad).theme, 'vivid');
  }
  valid.webContents.destroyed = true; f.report(valid, { theme: 'injected' }); assert.equal(f.mirror.snapshot(valid).theme, 'warm');
});
test('navigation invalidates cached appearance; stale and ID-reused sources cannot change another owner', () => {
  const f = fixture(), parent = f.owner(), wc = parent.webContents;
  f.report(parent, { theme: 'warm' });
  wc.emit('did-start-navigation', {}, 'https://example.com', false, true);
  wc.url = wc.mainFrame.url = 'https://example.com';
  f.report(parent, { theme: 'injected' }); assert.equal(f.mirror.snapshot(parent).theme, 'vivid');
  const fresh = f.owner(); fresh.webContents.id = wc.id;
  f.report(fresh, { theme: 'azure' }); assert.equal(f.mirror.snapshot(fresh).theme, 'azure');
  assert.equal(f.mirror.snapshot(parent).theme, 'vivid');
});
test('appearance payload only allows bounded literal colors and font names, never URLs, CSS rules or approval fields', () => {
  const value = normalize({ theme: 'x\" onclick=allow()', skin: '../other', decision: 'allow', acknowledged: true,
    tokens: { '--bg-0': '#fffdfa', '--accent': 'url(https://example.com)', '--ink': '#fffdfa',
      '--line': 'rgba(0, 0, 0, .08)', '--bg-2': 'rgba(0,0,0,0)', '--font-ui': 'A;opacity:0',
      '--font-display': '"Segoe UI Variable Display","Noto Sans SC",sans-serif', '--consent-risk': 'transparent',
      '--bg-3': 'rgb(999,0,0)', '--accent-soft': 'expression(alert(1))', '--evil': 'red' } });
  assert.equal(value.theme, 'vivid'); assert.equal(value.skin, ''); assert.equal(value.decision, undefined);
  assert.equal(value.tokens['--accent'], undefined); assert.equal(value.tokens['--font-ui'], undefined);
  assert.equal(value.tokens['--bg-2'], undefined); assert.equal(value.tokens['--bg-3'], undefined);
  assert.equal(value.tokens['--consent-risk'], undefined); assert.equal(value.tokens['--ink'], '#242427');
  assert.equal(value.tokens['--line'], 'rgba(0, 0, 0, .08)');
  assert.equal(value.tokens['--font-display'], '"Segoe UI Variable Display","Noto Sans SC",sans-serif');
  assert.ok(Object.keys(value.tokens).every(key => COLOR_KEYS.includes(key) || FONT_KEYS.includes(key)));
});
test('application surface controls dark scheme; OS theme is not an input', () => {
  assert.deepEqual(normalize(null).tokens, {});
  assert.equal(normalize({ nativeTheme: 'dark' }).colorScheme, 'light');
  const dark = normalize({ theme: 'custom-night', tokens: { '--bg-0': '#20242a', '--ink': '#eeeeee', '--accent': 'rgb(115 179 245)' } });
  assert.equal(dark.colorScheme, 'dark'); assert.equal(dark.tokens['--ink'], '#eeeeee');
  assert.equal(dark.tokens['--accent'], 'rgb(115 179 245)');
  assert.equal(normalize({ tokens: { '--bg-0': '#ffffff' } }).colorScheme, 'light');
});

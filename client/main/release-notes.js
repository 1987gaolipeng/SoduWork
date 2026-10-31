'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { parseVersion, newer } = require('./client-update-contract');
const storage = require('./release-notes-state');

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function catalog(root, current, locale) {
  const index = read(path.join(root, 'manifest.json'), { releases: [] });
  return (Array.isArray(index.releases) ? index.releases : []).filter(item => parseVersion(item.version) && !newer(item.version, current))
    .sort((a, b) => newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0)
    .map(item => {
      const requested = locale || 'zh-CN';
      let language = requested === 'en-US' ? 'en-US' : 'zh-CN';
      let content = read(path.join(root, language, item.version + '.json'), null);
      if (!validContent(content)) { language = 'zh-CN'; content = read(path.join(root, language, item.version + '.json'), null); }
      if (!validContent(content)) return null;
      return { ...content, version: item.version, locale: language, fallback: language !== requested };
    }).filter(Boolean);
}
function validContent(content) {
  return content && typeof content.summary === 'string' && Array.isArray(content.sections) &&
    content.sections.every(section => typeof section.title === 'string' && Array.isArray(section.items) &&
      section.items.every(item => typeof item.text === 'string'));
}

function createService({ directory, root, version, catalogOf = catalog }) {
  let state = storage.load(directory) || {}, owner = null;
  if (state.schema !== 1) state = { schema: 1, seen: [], lastVersion: null, pending: null };
  if (!Array.isArray(state.seen)) state.seen = [];
  function save(next) {
    storage.save(directory, next);
    state = next;
  }
  function prepare() {
    if (!parseVersion(version)) return;
    const previous = state.lastVersion;
    if (previous && !newer(version, previous)) return;
    const pending = state.seen.includes(version) ? null : {
      version, from: previous || null, kind: previous ? 'updated' : 'new'
    };
    save({ ...state, lastVersion: version, pending });
  }
  return {
    list(locale) { return catalogOf(root, version, locale); },
    pending() { return state.pending?.version === version && !state.seen.includes(version); },
    claim(id, locale) {
      prepare();
      if (owner !== null && owner !== id) return null;
      if (!state.pending || state.pending.version !== version || state.seen.includes(version)) return null;
      const releases = catalogOf(root, version, locale);
      if (!releases.some(item => item.version === version)) return null;
      owner = id;
      return { ...state.pending, releases };
    },
    acknowledge(id) {
      if (owner !== id || state.pending?.version !== version) return false;
      save({ ...state, seen: [...new Set([...state.seen, version])], pending: null });
      owner = null;
      return true;
    },
    release(id) { if (owner === id) owner = null; },
  };
}

function register({ app, ipcMain, BrowserWindow, root, identityOf, authenticatedIdentityOf, channel, getRendererRoot }) {
  const directory = app.getPath('userData'), version = app.getVersion();
  channel ||= read(path.join(root, 'main/release-history.json'), { releases: [] }).releases.find(r => r.version === version)?.channel || 'stable';
  const source = require('./release-notes-source.cjs').createSource({ directory, root, version, channel,
    identityOf: async () => identityOf(app), authenticatedIdentityOf: () => authenticatedIdentityOf(app) });
  const services = new Map(), claims = new Map();
  async function get(locale) {
    const data = await source.list(locale);
    if (!data.scope) return { data, service: null };
    let entry = services.get(data.scope);
    if (!entry) {
      const scoped = path.join(directory, 'release-notes-state', data.scope);
      if (!storage.load(scoped)) {
        const legacy = storage.load(directory);
        if (legacy) storage.save(scoped, legacy);
      }
      entry = { data };
      entry.service = createService({ directory: scoped, root, version, catalogOf: () => entry.data.releases });
      services.set(data.scope, entry);
    }
    entry.data = data;
    return { data, service: entry.service };
  }
  const trustedWindow = require('./app-menu-info.cjs').createTrustedWindow({
    app: { getAppPath: () => root }, BrowserWindow, getRendererRoot });
  function allowed(event) {
    try {
      if (!trustedWindow(event)) return false;
      const url = new URL(event.sender.getURL());
      return url.protocol === 'file:' && path.basename(fileURLToPath(url)) === 'desk.html';
    } catch (_) { return false; }
  }
  ipcMain.handle('release-notes-list', async (event, locale) => {
    if (!allowed(event)) return [];
    const { data } = await get(locale);
    return allowed(event) ? data.releases : [];
  });
  ipcMain.handle('release-notes-version', event => allowed(event) ? version : '');
  ipcMain.handle('release-notes-claim', async (event, locale) => {
    if (!allowed(event)) return null;
    const win = BrowserWindow.fromWebContents(event.sender);
    const panel = new URL(event.sender.getURL()).searchParams.get('panel') || 'workspace';
    if (panel !== 'workspace' || !win?.isFocused() || !win._deskContentReady) return null;
    const { service, data } = await get(locale);
    if (!service || !allowed(event) || win.isDestroyed() || !win.isFocused()) return null;
    const previous = claims.get(event.sender.id);
    if (previous && previous.scope !== data.scope) previous.service.release(event.sender.id);
    const result = service.claim(event.sender.id, locale);
    if (result) claims.set(event.sender.id, { service, scope: data.scope });
    if (result && !event.sender._releaseNotesCleanup) {
      const id = event.sender.id;
      event.sender._releaseNotesCleanup = true;
      const release = () => { claims.get(id)?.service.release(id); claims.delete(id); };
      event.sender.on('destroyed', release);
      event.sender.on('render-process-gone', release);
      event.sender.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) release();
      });
    }
    return result || (!service.pending() ? { complete: true } : null);
  });
  ipcMain.handle('release-notes-ack', event => {
    const claim = claims.get(event.sender.id);
    if (!allowed(event) || !claim || require('./release-notes-source.cjs').scopeOf(identityOf(app), channel) !== claim.scope) return false;
    const saved = claim.service.acknowledge(event.sender.id);
    if (saved) claims.delete(event.sender.id);
    return saved;
  });
  ipcMain.handle('release-notes-release', event => {
    if (allowed(event)) { claims.get(event.sender.id)?.service.release(event.sender.id); claims.delete(event.sender.id); }
  });
  const targets = new Map();
  return { list: async locale => (await get(locale)).data,
    async forVersion(number, locale, targetChannel = channel) {
      if (!parseVersion(number) || !['stable', 'beta'].includes(targetChannel)) return null;
      const key = targetChannel + '/' + number;
      if (!targets.has(key)) targets.set(key, require('./release-notes-source.cjs').createSource({
        directory, root, version: number, channel: targetChannel, identityOf: async () => identityOf(app),
        authenticatedIdentityOf: () => authenticatedIdentityOf(app) }));
      const data = await targets.get(key).list(locale);
      return data.releases.find(row => row.version === number) || null;
    } };

}
module.exports = { createService, catalog, register };

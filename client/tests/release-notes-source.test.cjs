'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSource, scopeOf } = require('../main/release-notes-source.cjs');
function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let identity = { hub: 'https://hub.example', clientId: 'device', session: 'fixture-session' };
  return { options: { root, directory: root, version: '2.0.0', identityOf: async () => identity, ...extra },
    setIdentity: value => { identity = value; } };
}
const row = (version = '2.0.0', locale = 'en-US') => ({ version, locale, summary: 'Notes', sections: [] });
const response = (releases, nextOffset = null) => ({ ok: true,
  text: async () => JSON.stringify({ currentVersion: '2.0.0', releases, nextOffset }) });

test('loads authenticated pages, filters future versions, coalesces requests and persists cache', async t => {
  let calls = 0;
  const f = setup(t, { request: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Device fixture-session');
    assert.equal(options.redirect, 'error');
    calls++;
    return new URL(url).searchParams.get('offset') === '0'
      ? response([row(), row('3.0.0')], 100) : response([row('1.0.0')]);
  } });
  const source = createSource(f.options);
  const [a, b] = await Promise.all([source.list('en-US'), source.list('en-US')]);
  assert.equal(calls, 2);
  assert.deepEqual(a, b);
  assert.deepEqual(a.releases.map(r => r.version), ['2.0.0', '1.0.0']);
  const offline = createSource({ ...f.options, request: async () => { throw Error('offline'); } });
  assert.deepEqual((await offline.list('en-US')).releases, a.releases);
});

test('late responses cannot populate a different environment and authentication is never cached', async t => {
  let resolve, entered;
  const ready = new Promise(r => { entered = r; });
  const f = setup(t, { request: async () => { entered(); return new Promise(r => { resolve = r; }); } });
  const promise = createSource(f.options).list('en-US');
  await ready;
  f.setIdentity({ hub: 'https://other.example', clientId: 'other', session: 'other' });
  resolve(response([row()]));
  assert.deepEqual((await promise).releases, []);
  assert.equal(fs.existsSync(path.join(f.options.directory, 'release-notes-cache')), false);
});

test('offline first launch reads localized bundled snapshot; missing locale is explicitly marked', async t => {
  const f = setup(t, { request: async () => { throw Error('offline'); } });
  fs.mkdirSync(path.join(f.options.root, 'main'));
  fs.writeFileSync(path.join(f.options.root, 'main/release-history.json'), JSON.stringify({ releases: [
    { version: '2.0.0', notes: ['Original'], locales: { 'en-US': { summary: 'English', sections: [] } } },
    { version: '3.0.0', notes: ['future'] }, { version: '1.0.0', notes: ['legacy'] }
  ] }));
  const result = await createSource(f.options).list('zh-CN');
  assert.equal(result.releases[0].summary, 'English');
  assert.equal(result.releases[0].fallback, true);
  assert.equal(result.releases[1].locale, 'und');
  assert.notEqual(scopeOf({ hub: 'https://a', clientId: '1' }, 'stable'), scopeOf({ hub: 'https://a', clientId: '1' }, 'beta'));
});

test('malformed data, failed authentication and invalid pagination never become a valid cache', async t => {
  const f = setup(t, { request: async () => response([row()], 0) });
  assert.deepEqual((await createSource(f.options).list('en-US')).releases, []);
  const invalid = createSource({ ...f.options, request: async () => response([{ version: '../../bad' }]) });
  assert.deepEqual((await invalid.list('en-US')).releases, []);
  f.setIdentity(null);
  assert.equal((await invalid.list('en-US')).scope, '');
});

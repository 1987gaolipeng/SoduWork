'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseVersion, newer } = require('./client-update-contract');

const scopeOf = (id, channel) => id?.hub ? crypto.createHash('sha256')
  .update(JSON.stringify([id.hub.replace(/\/$/, ''), channel, id.clientId])).digest('hex') : '';
function valid(row) {
  return row && parseVersion(row.version) && typeof row.summary === 'string' &&
    typeof row.locale === 'string' && Array.isArray(row.sections) && row.sections.every(s =>
      typeof s.title === 'string' && Array.isArray(s.items) && s.items.every(i => typeof i.text === 'string'));
}
function bundled(root, current, locale, channel = 'stable') {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'main/release-history.json'), 'utf8')).releases
      .filter(r => parseVersion(r.version) && !newer(r.version, current) && r.status !== 'withdrawn' && (!r.channel || r.channel === channel))
      .map(r => {
        const language = r.locales?.[locale] ? locale : r.locales?.['en-US'] ? 'en-US' : 'und';
        return { version: r.version, locale: language, fallback: language !== locale,
          ...(r.locales?.[language] || { summary: (r.notes || []).join('\n'), sections: [] }) };
      }).filter(valid);
  } catch (_) { return []; }
}

function createSource({ directory, root, version, identityOf, authenticatedIdentityOf = identityOf, channel = 'stable', request = fetch,
                        platform = process.platform, arch = process.arch }) {
  const jobs = new Map(), memory = new Map();
  async function list(locale) {
    const id = await identityOf().catch(() => null);
    const scope = scopeOf(id, channel);
    if (!scope) return { scope, releases: [], currentVersion: version };
    const language = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].includes(locale) ? locale : 'en-US';
    const key = scope + '-' + version + '-' + language;
    const file = path.join(directory, 'release-notes-cache', key + '.json');
    let cached = memory.get(key);
    if (!cached) {
      try {
        const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (disk.scope === scope && Array.isArray(disk.releases) && disk.releases.every(valid)) cached = disk;
      } catch (_) { /* A damaged cache never prevents launching the workspace. */ }
      cached ||= { scope, releases: bundled(root, version, language, channel), checked: 0 };
      memory.set(key, cached);
    }
    if (!jobs.has(key) && (!cached.checked || Date.now() - cached.checked > 30000)) {
      jobs.set(key, (async () => {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const authenticated = await authenticatedIdentityOf();
          if (!authenticated?.session || scopeOf(authenticated, channel) !== scope) throw new Error('No device session');
          let offset = 0, releases = [];
          do {
            const query = new URLSearchParams({ current: version, locale: language, channel, platform, arch,
              limit: '100', offset: String(offset) });
            const response = await request(id.hub.replace(/\/$/, '') + '/api/v1/client-release-notes?' + query, {
              headers: { Authorization: 'Device ' + authenticated.session }, redirect: 'error', signal: controller.signal });
            if (!response.ok) throw new Error('Release notes unavailable');
            const text = await response.text();
            if (text.length > 2000000) throw new Error('Release notes response too large');
            const data = JSON.parse(text);
            if (data.currentVersion !== version || !Array.isArray(data.releases) || !data.releases.every(valid)) throw new Error('Invalid release notes');
            releases.push(...data.releases.filter(r => !newer(r.version, version)));
            const next = data.nextOffset;
            if (next !== null && (!Number.isInteger(next) || next <= offset || next > 10000)) throw new Error('Invalid pagination');
            offset = next;
          } while (offset !== null);
          if (scopeOf(await identityOf().catch(() => null), channel) !== scope) throw new Error('Identity changed');
          cached = { scope, releases, checked: Date.now() };
          memory.set(key, cached);
          // Cache is disposable; an interrupted write is ignored on next launch.
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(cached), { encoding: 'utf8', mode: 0o600 });
          } catch (_) { /* Read-only profiles can still show fetched notes. */ }
        } catch (_) { cached.checked = Date.now(); }
        finally { clearTimeout(timeout); jobs.delete(key); }
      })());
    }
    await jobs.get(key);
    if (scopeOf(await identityOf().catch(() => null), channel) !== scope) return { scope: '', releases: [], currentVersion: version };
    return { scope, currentVersion: version, releases: memory.get(key).releases.filter(r => !newer(r.version, version)) };
  }
  return { list };
}
module.exports = { createSource, bundled, valid, scopeOf };

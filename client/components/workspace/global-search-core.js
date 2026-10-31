/* Shared keyword matching and scoped, independently settling search sources. */
(function (host, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else host.SoduWorkSearchCore = api;
})(globalThis, function () {
  'use strict';
  const tokens = query => String(query || '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean).slice(0, 12);
  function match(row, query) {
    const words = tokens(query), title = String(row.title || '').toLocaleLowerCase();
    const haystack = [row.title, row.text, row.source].join(' ').toLocaleLowerCase();
    if (!words.every(word => haystack.includes(word))) return row.serverMatched ? 1 : -1;
    return words.length ? words.reduce((n, word) => n + (title === word ? 80 : title.startsWith(word) ? 40 : title.includes(word) ? 20 : 1), 0) : 0;
  }
  function snippet(text, query, limit = 150) {
    text = String(text || '').replace(/\s+/gu, ' ').trim();
    const lower = text.toLocaleLowerCase(), positions = tokens(query).map(word => lower.indexOf(word)).filter(n => n >= 0);
    const start = positions.length ? Math.max(0, Math.min(...positions) - 35) : 0;
    return (start ? '…' : '') + text.slice(start, start + limit) + (text.length > start + limit ? '…' : '');
  }
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value) || 0;
  function rank(rows, query) {
    const empty = !tokens(query).length;
    return rows.map(row => ({ ...row, score: match(row, query) })).filter(row => row.score >= 0)
      .sort((a, b) => {
        if (empty && (a.type === 'actions' || b.type === 'actions')) {
          if (a.type !== b.type) return a.type === 'actions' ? -1 : 1;
          return (a.order || 0) - (b.order || 0);
        }
        return b.score - a.score || timestamp(b.at) - timestamp(a.at) || String(a.title).localeCompare(String(b.title));
      });
  }
  function createCache({ scope, ttl = 5000, maxEntries = 48, clock = Date.now }) {
    let owner = scope(), revision = 0;
    const entries = new Map();
    function clear() { entries.clear(); owner = scope(); revision++; }
    function sync() { if (scope() !== owner) clear(); }
    function peek(key) {
      sync(); const entry = entries.get(key);
      return entry && entry.expires > clock() ? entry.value : undefined;
    }
    function load(key, loader) {
      sync(); const existing = entries.get(key);
      if (existing?.pending) return existing.pending;
      if (existing?.expires > clock()) return Promise.resolve(existing.value);
      const actor = owner, ticket = revision, entry = {};
      entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      entry.pending = Promise.resolve().then(loader).then(value => {
        if (actor !== scope() || ticket !== revision) throw Error('STALE_SEARCH_SCOPE');
        entry.value = value; entry.expires = clock() + ttl; entry.pending = null; return value;
      }, error => { if (entries.get(key) === entry) entries.delete(key); throw error; });
      return entry.pending;
    }
    return { peek, load, clear };
  }
  function create({ sources, scope, update, timeout = 30000 }) {
    let generation = 0, state = null;
    function cancel() { generation++; state = null; }
    function begin(query) {
      const ticket = ++generation, owner = scope();
      state = { query: String(query || '').trim().slice(0, 200), rows: [], sources: {} };
      const current = () => ticket === generation && owner === scope();
      const parts = new Map();
      const publish = () => {
        if (!current()) return;
        const unique = new Map();
        for (const rows of parts.values()) for (const row of rows) {
          if (row?.id && row.title) unique.set([row.type, row.kind || '', row.id].join(':'), row);
        }
        state.rows = [...unique.values()];
        update({ ...state, rows: rank(state.rows, state.query), sources: { ...state.sources } });
      };
      sources.forEach(source => {
        state.sources[source.id] = { status: 'loading', categories: source.categories };
        try { parts.set(source.id, source.peek?.(state.query)?.rows || []); } catch (_) { parts.set(source.id, []); }
      });
      publish();
      return { current, parts, publish, query: state.query };
    }
    function preview(query) { begin(query); }
    async function search(query) {
      const request = begin(query), { current, parts, publish } = request;
      await Promise.allSettled(sources.map(async source => {
        let timer, alive = true;
        const progress = result => {
          if (!alive || !current()) return;
          parts.set(source.id, result.rows || []); publish();
        };
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => current() ? source.load(request.query, () => alive && current(), progress) : { rows: [] }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SEARCH_TIMEOUT')), timeout); }),
          ]);
          if (!current()) return;
          parts.set(source.id, result.rows || []);
          state.sources[source.id] = { status: result.partial ? 'partial' : 'ready', categories: source.categories };
        } catch (error) {
          if (!current()) return;
          if ([401, 403].includes(Number(error?.status))) parts.delete(source.id);
          state.sources[source.id] = { status: [401, 403].includes(Number(error?.status)) ? 'denied' : 'error', categories: source.categories };
        } finally { alive = false; clearTimeout(timer); publish(); }
      }));
    }
    function invalidate() { cancel(); sources.forEach(source => source.invalidate?.()); }
    return { search, preview, cancel, invalidate, dispose: invalidate };
  }
  return { tokens, match, snippet, rank, create, createCache };
});

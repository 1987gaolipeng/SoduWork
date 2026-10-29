'use strict';
// A local, authenticated lifecycle channel used by SoduWork's desktop Skill.
// It carries no prompts, screenshots, keystrokes or file contents.
const http = require('node:http'), crypto = require('node:crypto'), path = require('node:path');
const ACTIONS = new Set(['focus', 'move', 'click', 'dblclick', 'rclick', 'type', 'key', 'batch']);
const inside = (root, target) => { const relative = path.relative(path.resolve(root), path.resolve(target)); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function create({ overlay, sessions = () => [], stopRunner = async () => {}, now = Date.now, leaseMs = 5000 }) {
  const token = crypto.randomBytes(32).toString('hex'), scopes = new Map(), leases = new Map(), revoked = new Set();
  let server, timer, closed = false, showing = null;
  function ownerFor(input) {
    const handles = sessions();
    if (input.scope) return handles.find(h => h.desktopControlScope === input.scope || h.ownsDesktopControlScope?.(input.scope)) || null;
    const matches = handles.filter(h => h.cwd && input.cwd && inside(h.cwd, input.cwd) && h.inFlight?.());
    return matches.length === 1 ? matches[0] : null;
  }
  function remove(row) {
    if (scopes.get(row.scope) !== row) return;
    for (const id of row.leases) leases.delete(id);
    row.unsubscribe?.(); scopes.delete(row.scope);
    if (!scopes.size) overlay.hide();
  }
  function ownerRunning(row) {
    if (!row.owner) return true;
    try { return row.owner.inFlight?.() === true &&
      (row.owner.desktopControlScope === row.scope || row.owner.ownsDesktopControlScope?.(row.scope) === true); }
    catch (_) { return false; }
  }
  function stop(row) {
    revoked.add(row.scope);
    row.cancelled = true;
    // Revoke before notifying the runtime. A queued or retried desktop action
    // cannot sneak through while a Runner is acknowledging its cancellation.
    try {
      const result = row.owner ? (ownerRunning(row) ? row.owner.cancel() : undefined) : row.scope.startsWith('runner:')
        ? stopRunner(row.scope.slice(7, row.scope.lastIndexOf(':'))) : undefined;
      Promise.resolve(result).catch(() => {});
    } catch (_) { /* the desktop channel still refuses any further input */ }
    remove(row);
  }
  function cancel() { for (const row of [...scopes.values()]) stop(row); }
  function sweep() {
    for (const row of [...scopes.values()]) {
      for (const id of [...row.leases]) {
        const lease = leases.get(id);
        if (lease && now() - lease.at > leaseMs) { stop(row); break; }
      }
      if (scopes.get(row.scope) !== row) continue;
      if (row.owner && !ownerRunning(row)) remove(row);
      else if (!row.owner && !row.pending && !row.leases.size && now() - row.at > 800) remove(row);
    }
  }
  async function dispatch(route, input) {
    if (closed) return { ok: false, cancelled: true, reason: 'Desktop control is unavailable' };
    if (route === '/begin') {
      if (!ACTIONS.has(input.action) || !Number.isInteger(input.pid) || input.pid <= 0 ||
          typeof input.scope !== 'string' || input.scope.length > 240 ||
          input.scope && !/^(?:pi:[^\r\n]+|runner:[^\r\n]+:[1-9]\d*)$/.test(input.scope)) return { ok: false, reason: 'Invalid desktop operation' };
      const owner = ownerFor(input);
      const scope = input.scope || owner?.desktopControlScope;
      if (!scope || !owner && !scope.startsWith('runner:')) return { ok: false, reason: 'Desktop operation has no active owner' };
      if (!owner && scope.startsWith('runner:') && sessions().some(h => h.sessionId === scope.slice(7, scope.lastIndexOf(':')))) {
        return { ok: false, cancelled: true, reason: 'The desktop operation belongs to an earlier turn' };
      }
      if (owner && owner.inFlight?.() !== true) return { ok: false, cancelled: true, reason: 'The owning turn is no longer running' };
      if (revoked.has(scope)) return { ok: false, cancelled: true, reason: 'The user cancelled computer control. Wait for a new user request.' };
      let row = scopes.get(scope);
      if (!row) {
        row = { scope, owner, leases: new Set(), cancelled: false, pending: 0, at: now() };
        scopes.set(scope, row);
        if (owner?.on) row.unsubscribe = owner.on(event => {
          // inFlight includes queued messages. A finished turn must hide its
          // indicator before the next message starts (including image turns).
          const finished = event?.kind === 'turn-finished' || scope.startsWith('runner:') && event?.kind === 'settled';
          if (finished || !ownerRunning(row)) remove(row);
        });
      }
      // Sharing one pending show prevents a second action receiving ACK while
      // the first overlay renderer is still starting.
      row.pending++;
      if (!showing) showing = Promise.resolve().then(() => overlay.show(owner?.attachedWindow)).finally(() => { showing = null; });
      try { await showing; }
      catch (_) { revoked.add(scope); remove(row); return { ok: false, cancelled: true, reason: 'Computer-control indicator could not start' }; }
      finally { row.pending--; }
      if (closed || revoked.has(scope) || scopes.get(scope) !== row) return { ok: false, cancelled: true, reason: 'Computer control was cancelled' };
      const leaseId = crypto.randomUUID();
      row.leases.add(leaseId); row.at = now(); leases.set(leaseId, { scope, at: now(), pid: input.pid });
      return { ok: true, leaseId, scope, cancelled: false };
    }
    const lease = leases.get(input.leaseId), row = lease && scopes.get(lease.scope);
    const valid = lease && row && input.scope === lease.scope && !row.cancelled && !revoked.has(input.scope);
    if (route === '/status') {
      if (valid && now() - lease.at <= leaseMs && ownerRunning(row)) { lease.at = now(); return { ok: true, cancelled: false }; }
      if (row) stop(row);
      return { ok: true, cancelled: true };
    }
    if (route === '/end') {
      if (valid) { row.leases.delete(input.leaseId); leases.delete(input.leaseId); row.at = now(); }
      sweep(); return { ok: true };
    }
    return { ok: false, reason: 'Unknown desktop lifecycle operation' };
  }
  const reply = (response, status, result) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(result));
  };
  return {
    cancel, sweep, dispatch,
    async start() {
      server = http.createServer((request, response) => {
        const key = String(request.headers.authorization || '').replace(/^Bearer /, '');
        if (request.method !== 'POST' || request.headers.origin || !/^[a-f0-9]{64}$/.test(key) ||
            !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(token))) return reply(response, 403, { ok: false });
        let body = '', tooLarge = false;
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; if (body.length > 4096) { tooLarge = true; reply(response, 413, { ok: false }); request.destroy(); } });
        request.on('end', async () => {
          if (tooLarge) return;
          try {
            const input = JSON.parse(body);
            if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(response, 400, { ok: false });
            const result = await dispatch(request.url, input); reply(response, result.ok ? 200 : 409, result);
          } catch (_) { reply(response, 400, { ok: false, cancelled: true }); }
        });
      });
      server.requestTimeout = 8000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      timer = setInterval(sweep, 250); timer.unref?.();
      return { url: 'http://127.0.0.1:' + server.address().port, token };
    },
    async dispose() { closed = true; cancel(); clearInterval(timer); overlay.dispose(); server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve)); },
  };
}
module.exports = { create, ACTIONS };

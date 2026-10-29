'use strict';
// Freeze final bytes at the shared turn boundary; network publication is separate.
const packages = require('./delivery-package-worker');
const artifacts = require('./artifact-runtime');
const { scope, connectionScope } = require('../platform-connections/runtime.cjs');
const fs = require('node:fs/promises'), path = require('node:path');

// Local history follows the account; queued network writes belong to the
// original Hub and device. Include the base path for Hubs behind one origin.
const destination = identity => connectionScope(identity) + '|' + identity.hub.replace(/\/+$/, '');

async function unchanged(handle, previous, ids) {
  if (!previous || ids.length !== previous.ids.length || ids.some(id => !previous.ids.includes(id))) return false;
  const same = await Promise.all(previous.files.map(async before => {
    try {
      const now = await fs.stat(path.join(handle.cwd, before.path));
      return !before.missing && now.isFile() && ['mtimeMs','ctimeMs','size','ino'].every(key => now[key] === before[key]);
    } catch (error) { return before.missing && error.code === 'ENOENT'; }
  }));
  return same.every(Boolean);
}

function ready(snapshot) {
  const execution = snapshot?.execution || {}, phase = execution.quality?.phase;
  return snapshot?.status === 'idle' && !snapshot.pendingUi && !execution.running && !execution.stopped &&
    !execution.limitRequest && !['executing', 'implementing', 'reviewing', 'repairing', 'blocked'].includes(phase);
}
async function publish(identity, payload) {
  const form = new FormData(); form.append('manifest', JSON.stringify(payload.manifest));
  form.append('file', new Blob([payload.bytes], { type: payload.contentType }), payload.filename);
  // A device secret can change owner while an old user's upload is in flight.
  // Only use the captured account's signed token; never fall back to a secret.
  const response = await fetch(identity.hub.replace(/\/+$/, '') + '/api/v1/deliveries', {
    method: 'POST', headers: { Authorization: 'Device ' + identity.session }, body: form,
    redirect: 'error', signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.delivery) throw Error(typeof data.detail === 'string' ? data.detail : '成果同步失败，文件已保留，可在会话中重试');
  return data.delivery;
}
function create({ app, identityOf, notify = () => {}, upload = publish, prepare = packages.capture, snapshotFiles = artifacts.snapshotAsync }) {
  const states = new WeakMap();
  let captureTail = Promise.resolve(), uploadTail = Promise.resolve(), queuedBytes = 0;
  const explain = error => /fetch|network|timeout/i.test(error.message || '') ? '连接失败，文件已保留' : error.message || '同步失败，请重试';
  function mark(handle, state, value) {
    if (states.get(handle) !== state) return;
    handle.deliverySync = { managed: true, ...value };
    try { notify(handle); } catch { /* Closing renderer is unrelated to storage. */ }
  }
  function finish(handle, state, job, value) {
    if (state.previous?.token === job.token) state.previous.sync = value;
    if (state.latest === job.token) mark(handle, state, { ...value, currentTurn: state.currentTurn });
  }
  function connected(handle, state, job, identity) {
    if (states.get(handle) !== state) return false;
    if (destination(identity) === state.destination) return true;
    finish(handle, state, job, { state: 'failed', ...job.view,
      error: '连接已切换，文件已保留，请切回原连接后重试同步' });
    return false;
  }
  async function send(handle, state, job) {
    try {
      let current = { ...await identityOf(app) };
      if (!connected(handle, state, job, current)) return;
      const payload = job.payload.payload ? await job.payload.payload : job.payload;
      if (job.payload.payload) {
        current = { ...await identityOf(app) };
        if (!connected(handle, state, job, current)) return;
      }
      const delivery = await upload(current, payload);
      if (!connected(handle, state, job, await identityOf(app))) return;
      state.saved.set(payload.manifest.revision, delivery);
      while (state.saved.size > 8) state.saved.delete(state.saved.keys().next().value);
      finish(handle, state, job, { state: 'synced', ...job.view, delivery });
    } catch (error) { finish(handle, state, job, { state: 'failed', ...job.view, error: explain(error) }); }
    finally { queuedBytes -= job.byteLength; job.payload.cancel?.(); job.payload = null; }
  }
  async function freeze(handle, state, completedTurn) {
    let view = { artifactIds: [], artifactVersions: [] };
    try {
      if (states.get(handle) !== state || handle.passiveCloudView) return;
      const snapshot = handle.snapshot();
      if (!(completedTurn ? snapshot.status === 'idle' && !snapshot.pendingUi : ready(snapshot) && !handle.inFlight?.())) return;
      // Freeze under the account captured at bind. Authentication/renewal is
      // checked by send, outside the turn boundary, so it cannot stall input.
      const indexed = await snapshotFiles(handle);
      const declared = indexed.delivery?.source === 'manifest';
      const files = (indexed.items || []).filter(file => (file.changedInTurn || declared || state.confirmed.has(file.artifactId)) && file.primary !== false && !file.processEvidence && !file.pluginDraft && file.role !== 'evidence');
      view = { artifactIds: files.map(f => f.artifactId), artifactVersions: files.map(f => ({ id: f.artifactId, at: f.at || 0, size: f.size || 0 })) };
      if (!files.length) return;
      // Most follow-up messages do not edit the deliverable. Cheap metadata
      // checks avoid re-reading, hashing and starting a worker for those turns.
      if (state.previous?.sync.state !== 'failed' && await unchanged(handle, state.previous, view.artifactIds)) {
        // A text-only follow-up keeps the preceding receipt, including an
        // upload still in flight, without claiming a new delivery this turn.
        state.latest = state.previous.token; state.currentTurn = false;
        mark(handle, state, { ...state.previous.sync, currentTurn: false });
        return;
      }
      if (states.get(handle) !== state) return;
      // Leave room for one maximal capture before starting a worker. A slow
      // connection must never grow background work without a memory bound.
      if (queuedBytes > 64 * 1024 * 1024) throw Error('待同步成果较多，文件已保留，请稍后在会话中保存');
      const token = {}; state.latest = token; state.currentTurn = true;
      const payload = await prepare(handle, view.artifactIds, { completedTurn, turnSince: indexed.got?.turnSince || 0 });
      if (states.get(handle) !== state || payload.changedInTurn === false) { payload.cancel?.(); return; }
      view.revision = payload.manifest.revision;
      view.manifest = payload.manifest;
      view.filename = payload.filename;
      state.confirmed = new Set(view.artifactIds);
      const saving = { state: 'saving', ...view };
      if (payload.fileVersions?.length) state.previous = { ids: view.artifactIds, files: payload.fileVersions, token, sync: saving };
      mark(handle, state, saving);
      const saved = state.saved.get(payload.manifest.revision);
      if (saved) { payload.cancel?.(); finish(handle, state, { token }, { state: 'synced', ...view, delivery: saved }); return; }
      const byteLength = payload.byteLength || payload.bytes?.length || 0;
      if (queuedBytes + byteLength > 128 * 1024 * 1024) { payload.cancel?.(); throw Error('待同步成果较多，文件已保留，请稍后在会话中保存'); }
      const job = { payload, view, token, byteLength }; queuedBytes += byteLength;
      // Queue immutable bytes rather than a handle pointing at the next turn.
      uploadTail = uploadTail.then(() => send(handle, state, job), () => send(handle, state, job));
    } catch (error) { finish(handle, state, { token: state.latest }, { state: 'failed', ...view, error: explain(error) }); }
  }
  function capture(handle, state, completedTurn) {
    const pending = captureTail.then(() => freeze(handle, state, completedTurn));
    captureTail = pending.catch(() => {}); return captureTail;
  }
  function bind(handle, identity) {
    let owner, target; try { owner = scope(identity); target = destination(identity); } catch { return; }
    if (states.get(handle)?.destination === target) return;
    const state = { owner, destination: target, lastStatus: '', saved: new Map(), confirmed: new Set(), latest: null }; states.set(handle, state);
    handle.deliveryOwner = owner;
    handle.deliverySync = { managed: true, state: 'local', artifactIds: [], artifactVersions: [] };
    handle.captureDelivery = () => capture(handle, state, true);
  }
  function observe(handle, touched, snapshot) {
    const state = states.get(handle); if (!state || handle.passiveCloudView) return;
    const wasBusy = ['streaming', 'running', 'queued'].includes(state.lastStatus); state.lastStatus = snapshot?.status;
    if (!wasBusy && ['streaming', 'running', 'queued'].includes(snapshot?.status)) {
      state.latest = null;
      mark(handle, state, { state: 'local', artifactIds: [], artifactVersions: [] });
    }
    if (handle.deliveryCaptureAtTurnBoundary) return;
    if (!ready(snapshot) || !(['settled', 'turn-finished'].includes(touched?.kind) || wasBusy)) return;
    // Compatibility for passive adapters without the shared turn queue.
    void (async () => {
      for (let n = 0; n < 8 && ready(handle.snapshot()) && handle.inFlight?.(); n++) await new Promise(resolve => setTimeout(resolve, 25));
      if (!handle.inFlight?.()) await capture(handle, state, false);
    })().catch(() => {});
  }
  return { bind, observe };
}
module.exports = { create, ready, publish };

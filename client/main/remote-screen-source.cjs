'use strict';

/*
 * Consent-gated, read-only screen source for the desktop client.
 * The Hub receives JPEG pixels only. No keyboard, pointer, clipboard, or file
 * operation is exposed by this module.
 */
const { desktopCapturer, screen } = require('electron');
const { fetchWithDeviceAuthRetry } = require('./device-auth-request');

const POLL_MS = 3000;
const FRAME_MS = 500;
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 1280;
const MAX_BYTES = 384 * 1024;
const MAX_ACTIVE = 1;

function baseUrl(identity) {
  return String(identity?.hub || '').replace(/\/+$/, '');
}
function socketUrl(identity) {
  return baseUrl(identity).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/api/v1/remote-screen/media';
}
function safeName(value) {
  return String(value || '移动设备').replace(/[\r\n]/g, ' ').slice(0, 80);
}
function responseJson(response) {
  return response.text().then(text => {
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!response.ok) throw new Error(String(data.detail || data.error || 'remote screen request failed'));
    return data;
  });
}

function create({
  app,
  dialog,
  identityOf,
  fetch = fetchWithDeviceAuthRetry,
  capture = desktopCapturer,
  displays = screen,
  WebSocketImpl = globalThis.WebSocket,
  pollMs = POLL_MS,
  frameMs = FRAME_MS,
  logger = console,
} = {}) {
  let disposed = false;
  let pollTimer = null;
  let polling = false;
  const prompts = new Set();
  const streams = new Map();

  async function identity() {
    if (typeof identityOf !== 'function') return null;
    try { return await identityOf(app); } catch (error) {
      logger.warn?.('[remote-screen] identity unavailable:', error?.message || error);
      return null;
    }
  }

  async function request(id, identityValue, method, path, body) {
    const response = await fetch(identityValue, baseUrl(identityValue) + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
    });
    return responseJson(response);
  }

  function stopStream(grantId) {
    const stream = streams.get(grantId);
    if (!stream) return;
    streams.delete(grantId);
    if (stream.timer) clearInterval(stream.timer);
    try { stream.socket?.close?.(); } catch (_) {}
  }

  function stopAll() {
    for (const id of [...streams.keys()]) stopStream(id);
  }

  async function captureFrame() {
    const primary = displays?.getPrimaryDisplay?.();
    const sources = await capture.getSources({
      types: ['screen'],
      thumbnailSize: { width: MAX_WIDTH, height: MAX_HEIGHT },
    });
    if (!Array.isArray(sources) || !sources.length) throw new Error('no screen source');
    const source = (primary && sources.find(item => String(item.display_id) === String(primary.id))) || sources[0];
    const image = source?.thumbnail;
    if (!image || image.isEmpty?.()) throw new Error('empty screen source');
    const size = image.getSize();
    const width = Number(size?.width || 0), height = Number(size?.height || 0);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > MAX_WIDTH || height > MAX_HEIGHT) throw new Error('screen dimensions exceed limit');
    const bytes = image.toJPEG(55);
    if (!Buffer.isBuffer(bytes) || bytes.length < 10 || bytes.length > MAX_BYTES ||
        bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
        bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new Error('screen JPEG exceeds limit');
    }
    return { width, height, bytes };
  }

  function runFrames(stream) {
    let sequence = 0;
    let inFlight = false;
    const tick = async () => {
      if (disposed || streams.get(stream.grantId) !== stream || stream.socket.readyState !== 1 || inFlight) return;
      inFlight = true;
      try {
        const frame = await captureFrame();
        if (disposed || streams.get(stream.grantId) !== stream || stream.socket.readyState !== 1) return;
        const packet = JSON.stringify({ type: 'frame', sequence: ++sequence,
          width: frame.width, height: frame.height, at: Date.now() / 1000 });
        stream.socket.send(packet);
        stream.socket.send(frame.bytes);
      } catch (error) {
        logger.warn?.('[remote-screen] frame skipped:', error?.message || error);
      } finally { inFlight = false; }
    };
    stream.timer = setInterval(() => { void tick(); }, frameMs);
    stream.timer.unref?.();
    void tick();
  }

  function openStream(grant, identityValue) {
    if (!WebSocketImpl || streams.size >= MAX_ACTIVE || streams.has(grant.id)) return;
    const socket = new WebSocketImpl(socketUrl(identityValue));
    const stream = { grantId: grant.id, socket, timer: null, ready: false };
    streams.set(grant.id, stream);
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ type: 'source-auth', grantId: grant.id,
          device: identityValue.clientId, session: identityValue.session }));
      } catch (_) { stopStream(grant.id); }
    };
    socket.onmessage = event => {
      try {
        const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
        const message = JSON.parse(raw);
        if (message.type === 'ready' && message.role === 'source' && message.permission === 'view') {
          if (!stream.ready) { stream.ready = true; runFrames(stream); }
          return;
        }
        if (message.type === 'ended') stopStream(grant.id);
      } catch (_) { stopStream(grant.id); }
    };
    socket.onerror = () => { /* close schedules a later poll-based reconnect */ };
    socket.onclose = () => {
      if (streams.get(grant.id) === stream) stopStream(grant.id);
    };
  }

  async function prompt(grant, identityValue) {
    if (prompts.has(grant.id) || disposed || streams.size >= MAX_ACTIVE) return;
    prompts.add(grant.id);
    try {
      const answer = await dialog.showMessageBox({
        type: 'question',
        title: 'SoduWork 远程屏幕请求',
        message: `${safeName(grant.viewerName || grant.sourceName)} 请求查看这台电脑的屏幕`,
        detail: '仅传输屏幕画面，不支持键盘、鼠标、剪贴板或文件操作。',
        buttons: ['允许查看', '拒绝'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (disposed) return;
      if (answer.response === 0) {
        const approved = await request(grant.id, identityValue, 'POST', `/api/v1/remote-screen/requests/${encodeURIComponent(grant.id)}/approve`, {});
        if (approved.state === 'active') openStream(approved, identityValue);
      } else {
        await request(grant.id, identityValue, 'POST', `/api/v1/remote-screen/requests/${encodeURIComponent(grant.id)}/stop`, {});
      }
    } catch (error) {
      logger.warn?.('[remote-screen] consent handling failed:', error?.message || error);
    } finally { prompts.delete(grant.id); }
  }

  async function poll() {
    if (polling || disposed) return;
    polling = true;
    try {
      const current = await identity();
      if (!current || !current.session || !current.clientId) { stopAll(); return; }
      const data = await request('', current, 'GET', '/api/v1/remote-screen/requests');
      const items = Array.isArray(data.items) ? data.items : [];
      const active = new Set(items.map(item => String(item.id || '')));
      for (const id of [...streams.keys()]) if (!active.has(id)) stopStream(id);
      for (const grant of items) {
        if (grant.state === 'pending') void prompt(grant, current);
        else if (grant.state === 'active' && !streams.has(grant.id) && streams.size < MAX_ACTIVE) openStream(grant, current);
      }
    } catch (error) {
      logger.warn?.('[remote-screen] poll failed:', error?.message || error);
    } finally { polling = false; }
  }

  function schedule() {
    if (disposed || pollTimer) return;
    pollTimer = setInterval(() => { void poll(); }, pollMs);
    pollTimer.unref?.();
    void poll();
  }

  if (app?.whenReady) app.whenReady().then(schedule).catch(() => {});
  else schedule();

  return {
    poll,
    stopAll,
    dispose() {
      disposed = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      stopAll();
    },
  };
}

module.exports = { create, baseUrl, socketUrl, captureFrame: null };

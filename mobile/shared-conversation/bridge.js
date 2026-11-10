(function (global) {
  'use strict';
  // LAN HTTP exposes getRandomValues but not randomUUID. Keep this compatibility
  // shim inside the mobile iframe so reused desktop code stays byte-identical.
  if (global.crypto && !global.crypto.randomUUID && global.crypto.getRandomValues) {
    global.crypto.randomUUID = function () {
      const bytes = global.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
        '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    };
  }
  const native = global.SoduWorkAndroidBridge;
  const channel = new URLSearchParams(location.hash.slice(1)).get('channel') ||
    (native ? 'soduwork-android' : '');
  const pending = new Map();
  let serial = 0, closed = false;
  const send = message => {
    const envelope = {channel, type: 'soduwork-conversation', ...message};
    if (native?.postMessage) {
      native.postMessage(JSON.stringify(envelope));
      return;
    }
    if (!channel || global.parent === global) throw Error('SoduWork mobile conversation is not embedded');
    global.parent.postMessage(envelope, location.origin);
  };
  function call(method, args = {}) {
    if (closed) return Promise.reject(Error('对话已经关闭'));
    const id = String(++serial);
    return new Promise((resolve, reject) => {
      // User-driven forms have their own request timeouts. Keep the bridge alive
      // until dismissal; a fixed network timeout must not cancel human input.
      const timer = ['handoff', 'workAction', 'pluginDraft', 'workForm'].includes(method) ? null : setTimeout(() => {pending.delete(id); reject(Error('请求回执超时，请保留内容后重试核对'));}, 60000);
      pending.set(id, {resolve, reject, timer});
      try {send({id, method, args});} catch (error) {clearTimeout(timer); pending.delete(id); reject(error);}
    });
  }
  const listeners = new Set();
  const receive = message => {
    if (message?.channel !== channel || message?.type !== 'soduwork-conversation-host') return;
    if (message.event) {for (const fn of listeners) fn(message); return;}
    const row = pending.get(message.id);
    if (!row) return;
    clearTimeout(row.timer); pending.delete(message.id);
    message.error ? row.reject(Object.assign(Error(message.error), {status: message.status || 0})) : row.resolve(message.result);
  };
  global.addEventListener('message', event => {
    if (!native && (event.origin !== location.origin || event.source !== global.parent)) return;
    receive(event.data);
  });
  if (native) {
    global.soduWorkAndroidReceive = value => {
      try {receive(typeof value === 'string' ? JSON.parse(value) : value);} catch (_) {}
    };
  }
  global.addEventListener('pagehide', () => {
    closed = true;
    for (const row of pending.values()) {clearTimeout(row.timer); row.reject(Error('对话已经关闭'));}
    pending.clear(); listeners.clear();
  });
  global.SoduWorkMobileBridge = {call, listen(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
})(window);

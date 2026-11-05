'use strict';
// Bounded inspector connection and request lifecycle. Never log expressions,
// responses, account state or websocket URLs in phase diagnostics.
async function connect(url, { timeoutMs = 10000, Socket = WebSocket, trace = () => {} } = {}) {
  const socket = new Socket(url), pending = new Map(); let id = 0, closed = false;
  function rejectPending(error) {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  socket.addEventListener('close', () => rejectPending(Error('Inspector connection closed')));
  socket.addEventListener('error', () => rejectPending(Error('Inspector connection failed')));
  socket.addEventListener('message', event => {
    let value;
    try { value = JSON.parse(event.data); } catch { rejectPending(Error('Inspector returned invalid JSON')); return; }
    const entry = pending.get(value.id); if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if (value.error) entry.reject(Error('Inspector command failed: ' + entry.method));
    else entry.resolve(value.result);
  });
  const opened = Date.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { finish(Error('Inspector connection timed out')); socket.close(); }, timeoutMs);
    const onOpen = () => finish(), onError = () => finish(Error('Inspector connection failed'));
    function finish(error) {
      clearTimeout(timer); socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError); socket.removeEventListener('close', onError);
      error ? reject(error) : resolve();
    }
    socket.addEventListener('open', onOpen); socket.addEventListener('error', onError); socket.addEventListener('close', onError);
  });
  trace({ command: 'connect', ok: true, elapsedMs: Date.now() - opened });
  async function call(method, params = {}) {
    const started = Date.now();
    try {
      if (closed) throw Error('Inspector connection is closed');
      const result = await new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(Error(method + ' timed out')); }, timeoutMs);
        pending.set(requestId, { timer, resolve, reject, method });
        try { socket.send(JSON.stringify({ id: requestId, method, params })); }
        catch { clearTimeout(timer); pending.delete(requestId); reject(Error('Inspector send failed')); }
      });
      trace({ command: method, ok: true, elapsedMs: Date.now() - started }); return result;
    } catch (error) { trace({ command: method, ok: false, elapsedMs: Date.now() - started }); throw error; }
  }
  return { call, close() { rejectPending(Error('Inspector connection closed')); socket.close(); } };
}
module.exports = { connect };

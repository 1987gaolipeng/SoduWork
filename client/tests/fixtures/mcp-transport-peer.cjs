// Isolated protocol process; no business data or external connections.
const readline = require('node:readline');
const mode = process.argv[2] || 'normal';
let pages = 0, pendingRequestId = null;
function send(message) {
  const buffer = Buffer.from(JSON.stringify(message) + '\n');
  if (mode === 'unicode' && message.result?.content) {
    const at = buffer.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(buffer.subarray(0, at));
    setTimeout(() => process.stdout.write(buffer.subarray(at)), 15);
  } else process.stdout.write(buffer);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const q = JSON.parse(line);
  if (!q.method) {
    if (mode === 'server-request' && pendingRequestId !== null && q.id === pendingRequestId) {
      const id = pendingRequestId;
      pendingRequestId = null;
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text',
        text: q.error?.code === -32601 ? 'UNSUPPORTED_REJECTED' : 'NOT_REJECTED' }] } });
    }
    return;
  }
  if (q.id === undefined) return;
  if (mode === 'exit') return process.exit(7);
  let result;
  if (q.method === 'initialize') {
    result = { protocolVersion: mode === 'bad-version' ? '9999-01-01' : '2025-11-25',
      capabilities: { tools: {} }, serverInfo: { name: 'isolated-peer', version: '1' } };
  } else if (mode === 'flood') {
    process.stdout.write('x'.repeat(2100000));
    return;
  } else if (mode === 'hang') {
    setInterval(() => {}, 500);
    return;
  } else if (q.method === 'tools/list') {
    pages += 1;
    result = { tools: [{ name: 'tool_' + pages, inputSchema: { type: 'object' } }] };
    if (mode === 'cycle') result.nextCursor = 'same';
    else if (mode === 'pagination' && pages === 1) result.nextCursor = ' page-2 ';
    if (mode === 'pagination' && pages === 2 && q.params.cursor !== ' page-2 ') {
      return send({ jsonrpc: '2.0', id: q.id, error: { code: -1, message: 'Cursor changed' } });
    }
    if (mode === 'wrong-id') return send({ jsonrpc: '2.0', id: String(q.id), result });
    if (mode === 'malformed') return send({ jsonrpc: '2.0', id: q.id, result: [] });
    if (mode === 'secret-error') {
      return send({ jsonrpc: '2.0', id: q.id, error: { code: -32603, message: 'fixture-secret-value' } });
    }
  } else {
    result = { content: [{ type: 'text', text: mode === 'unicode' ? '中文结果🙂' : 'BUSINESS_OK' }] };
  }
  if (mode === 'server-request' && q.method !== 'initialize') {
    // Wait for the matching protocol response, not a scheduler-dependent delay.
    // Missing responses still fail through the bridge's existing request timeout.
    pendingRequestId = q.id;
    send({ jsonrpc: '2.0', id: q.id, method: 'sampling/createMessage', params: {} });
  } else send({ jsonrpc: '2.0', id: q.id, result });
});

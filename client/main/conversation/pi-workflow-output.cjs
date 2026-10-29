'use strict';
// Adapt real Pi snapshots to the common executor event contract. Preserve the
// message/tool interleaving and expose incremental text without creating rows.
function create(redact) {
  let seq = 0;
  const messages = new Map(), tools = new Map();
  function project(snapshot) {
    const items = [];
    const emit = item => items.push({ seq: ++seq, ...item });
    function tool(row) {
      const previous = tools.get(row.id);
      if (row.phase === 'preparing') {
        const signature = JSON.stringify(row.args || {});
        if (previous !== signature) emit({ kind: 'tool-preparing', callId: row.id, tool: row.name,
          arguments: JSON.parse(redact(signature)) });
        tools.set(row.id, signature); return;
      }
      if (!previous || !['running', 'done', 'error', 'cancelled'].includes(previous)) {
        emit({ kind: 'do', callId: row.id, tool: row.name, toolKind: row.toolKind,
          args: JSON.parse(redact(JSON.stringify(row.args || {}))) });
        tools.set(row.id, 'running');
      }
      if (row.state !== 'running' && tools.get(row.id) === 'running') {
        emit({ kind: 'out', callId: row.id, tool: row.name,
          text: redact(row.result || row.partial || ''), isError: row.isError === true });
        tools.set(row.id, row.state || 'done');
      }
    }
    const remaining = new Set(snapshot.tools || []);
    function toolsThrough(index) {
      for (const row of remaining) if (!Number.isInteger(row.after) || row.after <= index) {
        tool(row); remaining.delete(row);
      }
    }
    toolsThrough(-1);
    (snapshot.messages || []).forEach((message, index) => {
      if (message.role === 'assistant') {
        const blocks = message.blocks?.length ? message.blocks : [{ kind: 'text', text: message.text || '' }];
        blocks.forEach((block, blockIndex) => {
          if (!['text', 'thinking'].includes(block.kind)) return;
          const id = 'pi:' + index + ':' + blockIndex;
          const text = redact(block.text || '');
          const done = message.done === true || block.done === true;
          const previous = messages.get(id);
          if (text && (!previous || previous.text !== text || previous.done !== done)) {
            emit({ kind: block.kind === 'text' ? 'say' : 'thinking', streamId: id, text, done });
            messages.set(id, { text, done });
          }
        });
      }
      toolsThrough(index);
    });
    for (const row of remaining) tool(row);
    return items;
  }
  return { project };
}
module.exports = { create };

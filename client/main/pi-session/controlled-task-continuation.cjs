'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const MAX_FILES = 20, MAX_BYTES = 16 * 1024 * 1024;

// Continue an admitted Runner turn through Hub instead of moving its transcript
// into a native model with a different cwd. The send identity survives retries.
function create({ request, route, ref, scope }) {
  let messageId = '', content = '', packet, receipt, receiptTurn = '', terminal = '';
  async function start(text, files) {
    // An explicit retry of a confirmed failed execution starts a new send.
    // Transport or delivery recovery retains the immutable original send.
    if (receipt && receiptTurn !== scope.turnId &&
        ['failed', 'stopped', 'interrupted', 'cancelled', 'canceled'].includes(terminal)) {
      messageId = ''; receipt = null; terminal = '';
    }
    if (messageId && content !== text) throw Error('上一条返修消息尚未确认，请先恢复原消息');
    if (!messageId) {
      if ((files || []).length > MAX_FILES) throw Error('本轮附件数量超过限制');
      packet = []; let size = 0;
      for (const file of files || []) {
        const data = await fs.readFile(file.path);
        size += data.length;
        if (size > MAX_BYTES) throw Error('本轮追加附件总大小超过 16 MB');
        packet.push({ name: file.name, data: data.toString('base64'), contentType: file.mimeType || '' });
      }
      content = text;
      messageId = 'task-' + crypto.createHash('sha256').update(scope.conversationId + ':' + scope.turnId).digest('hex');
    }
    if (!receipt || receiptTurn !== scope.turnId) {
      const result = await request(route + '/ai-say', {
        text: content, messageId, expectedRef: ref, conversationTurn: { ...scope }, files: packet,
      });
      if (result.pending || result.uncertain || result.delivery !== 'accepted' ||
          !/^comment:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.admissionKey || '')) {
        throw Error('尚未确认本次返修的执行回执，请恢复本轮核对；不会重复发送');
      }
      receipt = result;
      receiptTurn = scope.turnId;
    }
    return { ...receipt, ref };
  }
  function items(page) {
    const selected = (page.items || []).filter(item => item.admissionKey === receipt?.admissionKey);
    for (const item of selected) if (item.kind === 'turn-end' && item.turnState) terminal = item.turnState;
    return selected;
  }
  function status(page) {
    const state = terminal || (page.admissionKey === receipt?.admissionKey ? page.status || page.state : 'running');
    if (['done', 'completed', 'succeeded', 'failed', 'stopped', 'interrupted', 'cancelled', 'canceled'].includes(state)) terminal = state;
    return state;
  }
  return { start, items, status };
}

module.exports = { create };

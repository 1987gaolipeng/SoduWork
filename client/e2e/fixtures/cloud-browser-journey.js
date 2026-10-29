'use strict';
// Browser bridge uses the actual desktop cloud coordinator. NativeChat's window
// registry is deliberately replaced; product composer and preview code is not.
window.fixtureErrors = [];
addEventListener('error', event => fixtureErrors.push(event.message));
addEventListener('unhandledrejection', event => fixtureErrors.push(String(event.reason?.message || event.reason)));
const notice = document.querySelector('#notice'), chat = document.querySelector('#chat');
const esc = text => String(text || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
let sessionId = '', taskId = '', timer = null, polling = false, generation = 0, receipt = null;
async function api(route, body) {
  const response = await fetch(route, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok || result?.ok === false) throw Error(result.reason || '请求失败'); return result;
}
const attachmentUrl = row => new URL(row.url.replace(/^\/api\/v1\//, '/api/hub/'), location.origin).href;
window.petSay = text => { notice.textContent = text; };
window.SoduWorkAPI = {
  taskStorageKey: () => 'isolated-browser-account',
  myModels: async () => ({ usable: [{ name: 'fixture-model', label: '隔离验收模型' }], defaultModel: 'fixture-model' }),
  listAttachments: id => api('/api/hub/tasks/' + encodeURIComponent(id) + '/attachments'), attachmentUrl,
};
window.soduWorkAPI = {
  conversationSession: { runtimes: () => api('/api/runtime/catalog'), probe: async () => ({ ok: true }),
    cloud: { targets: id => api('/api/cloud/targets?agentId=' + encodeURIComponent(id)), start: async input => {
      receipt = await api('/api/cloud/start', input); taskId = receipt.handoff?.taskId || ''; return receipt;
    } } },
  previewAttachment: async row => {
    const response = await fetch(row.url); if (!response.ok) return { ok: false, reason: '文件暂时无法读取' };
    return { ok: true, text: await response.text(), mimeType: row.contentType || 'text/markdown' };
  },
};
window.WorkspaceHost = { open: () => { location.href = 'cloud-environments.html?live=1'; } };
async function updateView() {
  if (!sessionId || polling) return;
  polling = true; const epoch = generation, id = sessionId;
  try {
    const snapshot = await api('/api/cloud/snapshot?sessionId=' + encodeURIComponent(id));
    if (epoch !== generation) return;
    taskId = snapshot.cloudHandoff?.taskId || snapshot.execution?.taskId || taskId;
    const rows = taskId ? await SoduWorkAPI.listAttachments(taskId) : [];
    if (epoch !== generation) return;
    const outputs = rows.filter(row => row.role === 'output').map(row => ({ artifactId: row.id,
      attachmentId: row.id, taskId, name: row.filename, kind: 'task-file', size: row.size,
      changedInTurn: true, at: row.createdAt || 1 }));
    const html = (snapshot.messages || []).map((message, index) => {
      const text = message.text || (message.blocks || []).filter(block => block.kind === 'text').map(block => block.text || '').join('\n');
      const prose = message.role === 'assistant' ? ChatOutputLinks.sanitize(marked.parse(text), DOMPurify) : esc(text);
      return '<article class="nmsg ' + (message.role === 'assistant' ? 'ai' : 'user') + '" data-chat-node="message:' + index + '" data-output-task="' + esc(taskId) + '"><div class="ntext nmd">' + prose + '</div></article>';
    }).join('') + '<p class="turn-status" data-chat-node="fixture:status" role="status">' + (snapshot.status === 'streaming' ? '云端正在执行…' : snapshot.status === 'error' ? '云端执行异常，请查看说明' : '云端消息已同步') + '</p>';
    ChatTools.patchList(document.querySelector('#transcript'), ChatOutputLinks.decorate(html, outputs, id));
    ChatWorkbench.render(chat, snapshot, outputs);
    document.querySelector('#files').innerHTML = rows.filter(row => row.role === 'output').map(row => '<div><button data-preview="' + esc(row.id) + '">' + esc(row.filename) + '</button><a download="' + esc(row.filename) + '" href="' + esc(attachmentUrl(row)) + '">下载</a></div>').join('');
    window.fixtureSnapshot = snapshot; window.fixtureOutputs = outputs;
  } catch (error) { petSay(error.message); }
  finally { polling = false; if (epoch === generation && sessionId) timer = setTimeout(updateView, 600); }
}
window.NativeChat = { enter: async (_text, id) => {
  generation++; clearTimeout(timer); sessionId = id; panel.classList.remove('show'); chat.hidden = false;
  const history = await api('/api/cloud/history');
  taskId = history.chats.find(row => row.id === id)?.taskId || taskId;
  ChatWorkbench.bind(chat, () => ({ ref: sessionId })); await updateView(); return true;
} };
const surface = ComposeSurface.create({ _bind: panel => {
  const refresh = () => { ComposeRuntime.paint(panel); ComposeExecution.paint(); ComposeModelPicker.refresh(); };
  ComposeExecution.bind(panel, refresh);
  ComposeRuntime.bind(panel, { api: () => soduWorkAPI.conversationSession, refresh, say: petSay,
    close: () => panel.querySelector('#cpRuntimePop').classList.remove('show') });
  ComposeModelPicker.bind({ api: () => soduWorkAPI.conversationSession, escape: esc });
  panel.querySelector('#cpRuntime').addEventListener('click', () => panel.querySelector('#cpRuntimePop').classList.toggle('show'));
  panel.querySelector('#cpGo').addEventListener('click', async () => {
    if (ComposeExecution.value() !== 'cloud') { petSay('隔离验收仅执行云端请求，本地默认路径不启动真实模型。'); return; }
    notice.textContent = '';
    await ComposeExecution.start({ text: panel.querySelector('#cpInput').value,
      attachments: document.querySelector('#attach').checked ? [{ name: 'input.txt', base64: btoa('cloud start input') }] : [], skills: [], plugins: [] });
  });
} });
const panel = surface._panel(); panel.classList.add('show'); panel.dataset.stage = 'compose';
panel.querySelector('#cpInput').value = 'CLOUD_NEW_TEST 请根据附件生成 delivery.md，完成后说明结果。';
ChatWorkbench.bind(chat, () => ({ ref: sessionId }));
chat.addEventListener('click', event => {
  const button = event.target.closest('[data-preview],[data-open-app]');
  if (button) { event.preventDefault(); ChatWorkbench.openOutput(button.dataset.preview || button.dataset.openApp); }
});
document.querySelector('#followup').addEventListener('submit', async event => {
  event.preventDefault(); const input = event.target.querySelector('input');
  if (!input.value.trim()) return;
  try { await api('/api/cloud/send', { sessionId, text: input.value, submissionId: crypto.randomUUID() }); input.value = ''; clearTimeout(timer); void updateView(); }
  catch (error) { petSay(error.message); }
});
document.querySelector('#newChat').addEventListener('click', async () => {
  generation++; clearTimeout(timer); const id = sessionId; sessionId = ''; taskId = ''; receipt = null;
  if (id) await api('/api/cloud/close', { sessionId: id });
  chat.hidden = true; panel.classList.add('show'); ComposeExecution.reset(); notice.textContent = '';
});
document.querySelector('#environments').addEventListener('click', () => WorkspaceHost.open('cloud'));
document.querySelector('#historyButton').addEventListener('click', async () => {
  try { const history = await api('/api/cloud/history'), host = document.querySelector('#history');
    host.hidden = false; host.innerHTML = history.chats.length ? history.chats.map(row => '<button data-session="' + esc(row.id) + '">' + esc(row.title) + '</button>').join('') : '暂无云端会话';
  } catch (error) { petSay(error.message); }
});
document.querySelector('#history').addEventListener('click', async event => {
  const row = event.target.closest('[data-session]'); if (!row) return;
  event.currentTarget.hidden = true; await NativeChat.enter('', row.dataset.session);
});
document.querySelector('.fixture-controls').addEventListener('click', async event => {
  const state = event.target.closest('[data-fixture]')?.dataset.fixture; if (!state) return;
  await api('/api/fixture/state', state === 'offline' ? { online: false } : { online: true, paused: state === 'paused' });
  await ComposeRuntime.refreshAccess(); ComposeExecution.paint();
});
document.querySelector('#manage').addEventListener('change', event => { void api('/api/fixture/state', { manage: event.target.checked }); });
window.fixtureReady = true;

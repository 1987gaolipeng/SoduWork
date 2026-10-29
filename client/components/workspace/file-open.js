/* OS file requests wait for workspace and login readiness; opening never sends a prompt. */
(function (global) {
  'use strict';
  let ready = false, running = false, again = false, epoch = 0;
  const failed = new Set();
  const api = () => global.soduWorkAPI?.fileOpen;
  const authenticated = () => global.SoduWorkAPI?.clientAuthSnapshot?.().state === 'active';
  function failure(id, name, reason) {
    failed.add(id);
    const node = document.createElement('div');
    node.className = 'file-open-notice'; node.setAttribute('role', 'alert');
    node.setAttribute('data-native-preview-overlay', '');
    const text = document.createElement('span');
    text.textContent = name + '：' + reason;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试';
    retry.onclick = () => { failed.delete(id); node.remove(); void drain(); };
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
    close.onclick = () => { void api()?.ack(id); failed.delete(id); node.remove(); };
    node.append(text, retry, close);
    let host = document.querySelector('.file-open-notices');
    if (!host) {
      host = document.createElement('div'); host.className = 'file-open-notices';
      document.body.appendChild(host);
    }
    host.appendChild(node);
  }
  async function drain() {
    if (!ready || !api() || !authenticated()) return;
    if (running) { again = true; return; }
    running = true;
    const started = epoch;
    try {
      const reply = await api().list();
      if (!reply?.ok) return;
      for (const row of reply.items || []) {
        if (started !== epoch || !authenticated()) return;
        if (failed.has(row.id)) continue;
        const request = await api().claim(row.id);
        if (started !== epoch || !authenticated()) return;
        if (!request?.ok) { failure(row.id, row.name, request?.reason || '无法打开文件'); continue; }
        let opened;
        try {
          opened = await global.WorkspaceHost.open('create', {
            newSession: true, tab: 'chat', source: 'file-open', fileOpen: request,
          });
        } catch (error) {
          if (started === epoch) failure(row.id, row.name, String(error.message || '会话暂未就绪'));
          continue;
        }
        if (started !== epoch) return;
        if (opened) await api().ack(row.id);
        else failure(row.id, row.name, '会话暂未就绪，请重试');
      }
    } catch (error) {
      if (started === epoch && typeof global.petSay === 'function') global.petSay('打开文件失败：' + String(error.message || error));
    } finally {
      running = false;
      if (again) { again = false; void drain(); }
    }
  }
  api()?.onPending(() => void drain());
  global.addEventListener('soduwork-workspace-ready', () => { ready = true; void drain(); });
  global.addEventListener('soduwork-device-auth', () => void drain());
  global.addEventListener('soduwork-data-scope-changed', () => {
    epoch++; failed.clear(); document.querySelectorAll('.file-open-notice').forEach(node => node.remove());
  });
})(window);

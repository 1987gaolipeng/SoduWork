(function (global) {
  'use strict';
  let current = null;
  const api = () => global.soduWorkAPI?.deviceDirect;
  function element(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
    node.append(...children);
    return node;
  }
  const button = (marker, label) => element('button', { type: 'button', [marker]: '' }, label);
  const field = (label, tag, attrs) => element('label', {}, label, element(tag, attrs));
  const scope = () => global.SoduWorkAPI?.taskStorageKey?.('device-direct-transfers') || '';
  const size = value => Number(value) >= 1048576 ? (Number(value) / 1048576).toFixed(1) + ' MB' : Math.ceil(Number(value || 0) / 1024) + ' KB';
  const phases = { preview: '待确认', offered: '等待接收设备确认', accepted: '接收设备已同意', transferring: '正在传输',
    prepared: '内容已校验，等待转移执行权', ready: '内容已校验，等待转移执行权', granting: '正在转移执行权', granted: '执行权已转移', committed: '迁移完成', completed: '迁移完成', done: '迁移完成', active: '已接收执行权', sending: '正在传输', packing: '正在打包',
    aborted: '迁移已取消', cancelled: '迁移已取消', failed: '迁移未完成', uncertain: '状态待核对' };
  function saved(key) {
    try { return JSON.parse(global.localStorage.getItem(key) || '[]').filter(row => row && typeof row.operationId === 'string').slice(-20); }
    catch (_) { return []; }
  }
  function remember(key, value) {
    if (!key || !value?.operationId) return;
    const rows = saved(key).filter(row => row.operationId !== value.operationId);
    rows.push({ operationId: value.operationId, sessionId: value.sessionId, targetDeviceId: value.targetDeviceId });
    try { global.localStorage.setItem(key, JSON.stringify(rows.slice(-20))); } catch (_) { /* The native transfer journal remains authoritative. */ }
  }
  function open(options = {}) {
    if (!api()) { global.petSay?.('请更新客户端后使用设备直连'); return; }
    current?.close();
    const owner = scope(), source = options.source || null;
    const dialog = document.createElement('dialog');
    dialog.className = 'device-direct-dialog';
    dialog.setAttribute('aria-labelledby', 'deviceDirectTitle');
    dialog.append(element('header', {}, element('div', {},
      element('h2', { id: 'deviceDirectTitle' }, '本人设备直连'),
      element('p', {}, '本机会话保持设备私有。连接其他电脑仅用于你明确选择的迁移。')),
    element('button', { type: 'button', 'data-close': '', 'aria-label': '关闭' }, '×')),
    element('div', { class: 'device-direct-body' },
      element('section', {}, element('h3', {}, '接收连接'),
        element('p', {}, '两端须登录同一账号。请使用双方能够直达的局域网或专用网络地址。'),
        element('div', { class: 'device-direct-fields' },
          field('监听地址', 'input', { 'data-host': '', value: '0.0.0.0', maxlength: 80, autocomplete: 'off' }),
          field('端口', 'input', { 'data-port': '', type: 'number', min: 0, max: 65535, value: 0 })),
        element('div', { class: 'device-direct-actions' }, button('data-listen', '开启直连'), button('data-stop', '关闭直连'), button('data-offer', '生成一次性配对信息')),
        element('p', { 'data-listener': '' }),
        element('label', { 'data-offer-box': '', hidden: '' }, '配对信息（仅在另一台本人设备输入）',
          element('textarea', { 'data-offer-value': '', readonly: '', rows: 3, autocomplete: 'off', spellcheck: 'false' }))),
      element('section', {}, element('h3', {}, '连接本人电脑'), element('form', { 'data-connect-form': '' },
        field('对端直连地址', 'input', { 'data-endpoint': '', placeholder: '输入对端显示的地址', maxlength: 512, autocomplete: 'off', required: '' }),
        field('对端设备标识', 'input', { 'data-expected-device': '', maxlength: 180, autocomplete: 'off', placeholder: '复制完整配对信息时自动读取' }),
        field('对端一次性配对信息', 'textarea', { 'data-pair-input': '', rows: 3, maxlength: 16000, autocomplete: 'off', spellcheck: 'false', required: '' }),
        element('button', { type: 'submit' }, '配对并连接')),
      element('p', {}, '首次连接需要双方确认设备身份。不会经 Hub 转发会话，也不会自动改连其他设备。')),
      element('section', {}, element('h3', {}, '已连接设备'), element('div', { 'data-peers': '' }), button('data-refresh', '刷新连接状态')),
      element('section', { 'data-migration-section': '' }, element('h3', {}, '迁移当前本机会话'), element('p', { 'data-source': '' }),
        element('label', {}, '接收电脑', element('select', { 'data-target': '' }, element('option', { value: '' }, '请选择已配对的电脑'))),
        button('data-preview', '检查迁移内容'), element('div', { 'data-preview-result': '' })),
      element('section', {}, element('h3', {}, '迁移恢复'), element('p', {}, '中断后先核对同一迁移记录，再恢复；不会自动再次提交会话。'), element('div', { 'data-recovery': '' })),
      element('p', { class: 'device-direct-status', 'data-status': '', role: 'status', 'aria-live': 'polite' })));
    let closed = false, busy = false, revision = 0, preview = null;
    const node = selector => dialog.querySelector(selector);
    const alive = () => !closed && scope() === owner && dialog.isConnected;
    const sourceAlive = () => source && global.NativeChat?.sessionInfo?.().ref === source.ref &&
      global.NativeChat?.sessionInfo?.().sessionId === source.sessionId;
    function close() {
      if (closed) return;
      closed = true; revision++;
      node('[data-offer-value]').value = ''; node('[data-pair-input]').value = '';
      global.removeEventListener('soduwork-data-scope-changed', changed);
      dialog.close(); dialog.remove(); if (current?.dialog === dialog) current = null;
    }
    const changed = () => { if (scope() !== owner) close(); };
    global.addEventListener('soduwork-data-scope-changed', changed);
    function status(value) { if (alive()) node('[data-status]').textContent = value || ''; }
    async function run(job) {
      if (busy || !alive()) return;
      busy = true; const stamp = ++revision;
      dialog.setAttribute('aria-busy', 'true');
      dialog.querySelectorAll('button:not([data-close])').forEach(button => { button.disabled = true; });
      status('正在处理…');
      try { await job(() => alive() && stamp === revision); }
      catch (error) { if (alive() && stamp === revision) status(String(error?.message || '操作未完成，请核对连接后重试')); }
      finally {
        busy = false;
        if (alive()) {
          dialog.removeAttribute('aria-busy');
          dialog.querySelectorAll('button:not([data-close])').forEach(button => { button.disabled = false; });
          node('[data-preview]').disabled = !sourceAlive() || source?.cloudHandoff || !node('[data-target]').value;
        }
      }
    }
    const migrationInput = record => ({ ref: source?.ref || '', sessionId: record.sessionId,
      targetDeviceId: record.targetDeviceId, operationId: record.operationId });
    function recovery() {
      const host = node('[data-recovery]'); host.replaceChildren();
      for (const record of saved(owner).reverse()) {
        const row = document.createElement('div'); row.className = 'device-direct-receipt';
        const title = document.createElement('p'); title.textContent = '迁移 ' + record.operationId;
        const result = document.createElement('p'); result.setAttribute('role', 'status');
        row.append(title, result);
        for (const [action, label] of [['status', '核对状态'], ['resume', '恢复迁移'], ['cancel', '取消未完成迁移']]) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
          button.onclick = () => run(async valid => {
            const value = await api().migration[action](migrationInput(record));
            if (!valid()) return;
            result.textContent = phases[value.state] || value.state || value.reason || '状态已更新';
            status(value.reason || '迁移状态已更新');
          }); row.append(button);
        }
        host.append(row);
      }
      if (!host.children.length) host.textContent = '此账号在本机暂无迁移记录';
    }
    async function refresh(valid) {
      const [state, result] = await Promise.all([api().status(), api().peers()]);
      if (!valid()) return;
      const endpoints = Array.isArray(state.endpoints) ? state.endpoints.join('、') : state.endpoint || '';
      node('[data-listener]').textContent = state.listening ? '直连已开启：' + endpoints : '直连未开启';
      const rows = Array.isArray(result) ? result : result.items || result.peers || [];
      const list = node('[data-peers]'), target = node('[data-target]'), selected = target.value;
      list.replaceChildren(); target.replaceChildren(element('option', { value: '' }, '请选择已配对的电脑'));
      for (const item of rows) {
        const id = item.deviceId || item.peerId, row = document.createElement('div'); row.className = 'device-direct-peer';
        const label = document.createElement('span'); label.textContent = (item.name || id) + ' · ' + (item.role === 'mobile' ? '移动端' : '电脑') + (item.connected ? ' · 已连接' : '');
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '断开连接';
        remove.onclick = () => run(async valid => { await api().disconnect({ peerId: item.peerId || id }); if (valid()) { await refresh(valid); status('已断开设备'); } });
        row.append(label, remove); list.append(row);
        if (item.role === 'desktop') { const option = document.createElement('option'); option.value = id; option.textContent = item.name || id; target.append(option); }
      }
      if (!rows.length) list.textContent = '尚未配对设备';
      if ([...target.options].some(option => option.value === selected)) target.value = selected;
      recovery(); status('连接状态已更新');
    }
    node('[data-close]').onclick = close;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    node('[data-listen]').onclick = () => run(async valid => {
      await api().listen({ host: node('[data-host]').value.trim(), port: Number(node('[data-port]').value) });
      if (valid()) await refresh(valid);
    });
    node('[data-stop]').onclick = () => run(async valid => { await api().stop(); if (valid()) { node('[data-offer-box]').hidden = true; node('[data-offer-value]').value = ''; await refresh(valid); } });
    node('[data-offer]').onclick = () => run(async valid => {
      const value = await api().offer(); if (!valid()) return;
      node('[data-offer-box]').hidden = false;
      node('[data-offer-value]').value = JSON.stringify({ offer: value.offer, deviceId: value.deviceId, endpoints: value.endpoints });
      status('一次性配对信息已生成，请在有效期内使用；不要发送给其他人');
    });
    node('[data-connect-form]').onsubmit = event => { event.preventDefault(); void run(async valid => {
      let offer = node('[data-pair-input]').value.trim();
      try { offer = JSON.parse(offer); } catch (_) { /* Opaque offers remain strings. */ }
      const expectedDeviceId = node('[data-expected-device]').value.trim() || offer?.deviceId;
      if (!expectedDeviceId) throw Error('请填写对端设备标识，或粘贴完整配对信息');
      await api().connect({ endpoint: node('[data-endpoint]').value.trim(), offer: offer?.offer || offer, expectedDeviceId });
      if (valid()) { node('[data-pair-input]').value = ''; await refresh(valid); }
    }); };
    node('[data-refresh]').onclick = () => run(refresh);
    node('[data-source]').textContent = source && !source.cloudHandoff
      ? (source.title || '当前本机会话') + '。迁移需要对端逐次同意，成功后执行权转移到对端。'
      : '请在本人持有的本机会话中打开“添加与设置 → 迁移到本人设备”。';
    node('[data-preview]').disabled = true;
    node('[data-target]').onchange = () => { preview = null; node('[data-preview-result]').replaceChildren(); node('[data-preview]').disabled = !sourceAlive() || !node('[data-target]').value; };
    node('[data-preview]').onclick = () => run(async valid => {
      if (!sourceAlive() || source.cloudHandoff) throw Error('请重新打开当前本机会话的迁移入口');
      const value = await api().migration.preview({ ref: source.ref, sessionId: source.sessionId, targetDeviceId: node('[data-target]').value });
      if (!valid() || !sourceAlive()) return;
      preview = value;
      const host = node('[data-preview-result]');
      host.replaceChildren(element('p', {}, '会话记录将迁移。请选择需要一并传输的工作文件；默认不选任何文件。'),
        element('p', {}, '候选文件 ' + (value.files || []).length + ' 个，共 ' + size(value.totalBytes) + '；已排除 ' + Number(value.excludedCount || 0) + ' 项。'),
        button('data-select-all', '明确选择全部文件'), element('div', { class: 'device-direct-files' }), button('data-start', '确认迁移所选内容'));
      const files = host.querySelector('.device-direct-files');
      if (value.workspaceNotice) {
        const notice = element('p', { 'data-workspace-notice': '', role: 'status' });
        notice.textContent = String(value.workspaceNotice);
        files.before(notice);
      }
      for (const file of value.files || []) {
        const label = document.createElement('label'), checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = file.path;
        const paths = file.historyAlias ? file.path + ' / ' + file.historyAlias : file.path;
        label.append(checkbox, document.createTextNode(paths + ' · ' + size(file.size))); files.append(label);
      }
      host.querySelector('[data-select-all]').onclick = () => { files.querySelectorAll('input').forEach(input => { input.checked = true; }); };
      host.querySelector('[data-start]').onclick = () => run(async valid => {
        if (!sourceAlive() || preview !== value) throw Error('会话或迁移预览已变化，请重新检查');
        const selectedPaths = [...files.querySelectorAll('input:checked')].map(input => input.value);
        remember(owner, value); recovery();
        const result = await api().migration.start({ ...migrationInput(value), selectedPaths });
        if (!valid()) return;
        status(result.reason || phases[result.state] || '迁移请求已处理，请核对状态'); recovery();
      });
      status('请检查文件清单后确认迁移');
    });
    current = { dialog, close }; document.body.append(dialog); dialog.showModal();
    void run(refresh);
  }
  global.document?.addEventListener('click', event => {
    if (!event.target.closest?.('[data-device-direct-transfer]')) return;
    global.WorkComposer?.closeMore?.();
    open({ source: global.NativeChat?.sessionInfo?.() });
  });
  global.DeviceDirect = { open };
})(window);

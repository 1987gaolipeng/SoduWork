/* Account-scoped remote conversation setup; credentials live only in the current form. */
(function (global) {
  'use strict';
  const el = (tag, value, cls = '') => {
    const node = document.createElement(tag); node.className = cls;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const button = (label, action) => { const b = el('button', label, 'btn-mini'); b.type = 'button'; b.onclick = action; return b; };
  const statuses = {queued:'排队中',waiting:'执行中，等待结果',processing:'正在处理',submitted:'已交给会话',running:'执行中',done:'执行完成',sent:'已发送',sending:'正在发送',pending:'等待发送',failed:'未完成',rejected:'未执行',uncertain:'需要核对',cancelled:'已结束'};
  const detailText = value => String(value || '').startsWith('platform_') ? ({platform_rate_limited:'平台暂时限制发送频率，正在等待',platform_send_unconfirmed:'平台尚未确认送达，请先核对手机消息',platform_timeout:'平台响应超时，请核对手机消息',platform_recipient_rejected:'平台拒绝向此会话发送，请检查机器人权限'}[value] || '平台回传未完成，请检查机器人授权和平台状态') : String(value || '');
  function field(parent, name, node) { const label = el('label', undefined, 'cap-field wide'); label.append(el('span', name), node); parent.append(label); return node; }
  function input(value = '', secret = false) { const node = el('input', undefined, 'cap-input'); node.value = value; node.type = secret ? 'password' : 'text'; node.autocomplete = 'off'; node.maxLength = 16384; return node; }
  function mount(content, ctx) {
    const api = ctx.editorContext().api;
    if (!api.im) return () => {};
    const owner = api.taskStorageKey?.('ops');
    const section = el('section', undefined, 'cap-section cap-template-section im-remote');
    const head = el('header', undefined, 'connector-section-heading'), title = el('div', undefined, 'cap-section-head');
    title.append(el('b', '手机远程对话'), el('span', '通过已绑定的机器人继续电脑上的任务'));
    const actions = el('div', undefined, 'im-actions'), list = el('div', undefined, 'im-connections');
    const note = el('p', '正在检查服务…', 'connector-inline-note'); note.setAttribute('role', 'status');
    head.append(title, actions); section.append(head, note, list);
    const common = content.querySelector('.connector-common-section');
    if (common) common.before(section); else content.querySelector('.cap-connections-view').append(section);
    let disposed = false, catalog = null, revision = 0, modalRevision = 0, modalCleanup = null;
    const current = () => !disposed && section.isConnected && ctx.isCurrent?.() !== false && api.taskStorageKey?.('ops') === owner;
    const options = () => ({taskScope: owner});
    const errorText = error => error?.status === 401 || error?.status === 403 ? '当前账号无权执行此操作，请检查登录和授权。'
      : error?.status === 404 ? '服务尚未提供远程对话，请联系管理员升级服务。'
      : error?.status === 409 ? '连接或任务状态已变更，请刷新后检查。'
      : error?.status === 400 || error?.status === 422 ? '配置未通过检查，请核对平台凭据和任务状态。'
      : error?.status === 502 ? '平台验证未通过，请检查机器人凭据和平台权限。'
      : error?.status === 503 ? '服务配置尚未完成，请联系管理员检查公网地址和授权密钥。'
      : '未能确认操作结果，请先刷新检查，避免重复操作。';
    function setupHelp(parent, providerId) {
      const provider = catalog?.providers?.find(item => item.id === providerId);
      if (provider?.setupHint) parent.append(el('p', provider.setupHint, 'connector-inline-note'));
      try {
        const url = new URL(provider?.docsUrl);
        if (url.protocol !== 'https:' || url.username || url.password) return;
        const link = el('a', '查看平台配置说明', 'connector-help'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link);
      } catch (_) { /* Provider help is optional; never render an invalid link. */ }
    }
    function modal(name, subtitle) {
      modalCleanup?.(); const version = ++modalRevision, abort = new AbortController();
      const layer = ctx.openModal(name, subtitle, '<div data-im-body></div><p data-im-note role="status" class="connector-inline-note"></p>', '<button class="btn-mini" data-im-close>关闭</button>');
      const body = layer.querySelector('[data-im-body]'), status = layer.querySelector('[data-im-note]');
      const active = () => current() && version === modalRevision && !layer.hidden && layer.querySelector('[data-im-body]') === body;
      let pending = false;
      const clear = () => { body.querySelectorAll('input[type=password]').forEach(node => { node.value = ''; }); };
      const observer = new MutationObserver(() => { if (!active()) dispose(); });
      function dispose() { clear(); abort.abort(); observer.disconnect(); }
      observer.observe(layer, {attributes:true, attributeFilter:['hidden'], childList:true, subtree:true});
      modalCleanup = dispose;
      layer.querySelector('[data-im-close]').onclick = () => { dispose(); ++modalRevision; ctx.closeModal(); };
      async function run(action) {
        if (!active() || pending) return;
        pending = true; status.textContent = '正在处理…';
        const controls = [...body.querySelectorAll('button,input,select')].map(node => [node, node.disabled]);
        controls.forEach(([node]) => { node.disabled = true; });
        try { await action(); } catch (error) { if (active()) status.textContent = errorText(error); }
        finally { pending = false; if (active()) controls.forEach(([node, disabled]) => { node.disabled = disabled; }); }
      }
      return {body, status, active, run, clear, options:() => ({...options(), signal:AbortSignal.any([abort.signal, AbortSignal.timeout(30000)])})};
    }
    async function refresh() {
      if (!current()) return;
      const ticket = ++revision; refreshButton.disabled = true;
      try {
        const result = await api.im.catalog(options());
        if (!current() || ticket !== revision) return;
        catalog = result; add.disabled = !result.available;
        note.textContent = result.available ? '先连接机器人，再绑定一个任务。电脑离线时消息会等待；执行结果会回传到原 IM 会话。' : '服务尚未启用远程对话；现有连接器仍可照常使用。';
        list.replaceChildren();
        for (const item of result.connections || []) {
          const row = el('article', undefined, 'im-connection'), copy = el('div');
          copy.append(el('b', item.name), el('span', item.credentialsConfigured ? item.enabled ? '已启用 · 管理手机绑定' : '待验证机器人' : '已撤销', 'connector-inline-note'));
          const manage = button('管理', () => { if (current()) openConnection(item); }); manage.disabled = !result.available;
          row.append(copy, manage); list.append(row);
        }
      } catch (error) { if (current() && ticket === revision) note.textContent = errorText(error); }
      finally { if (current() && ticket === revision) refreshButton.disabled = false; }
    }
    function create() {
      if (!current() || !catalog?.available) return;
      const view = modal('连接远程对话机器人', '使用机器人凭据；普通连接器授权不会自动开放远程控制。');
      const select = el('select', undefined, 'cap-input');
      for (const provider of catalog.providers || []) { const option = el('option', provider.name); option.value = provider.id; select.append(option); }
      field(view.body, '消息平台', select);
      const name = field(view.body, '连接名称', input()); name.maxLength = 80;
      const fields = el('div', undefined, 'cap-fields'); view.body.append(fields);
      function choose() {
        fields.querySelectorAll('input').forEach(node => { node.value = ''; }); fields.replaceChildren();
        const provider = catalog.providers.find(item => item.id === select.value); name.value = provider?.name || '';
        for (const spec of provider?.fields || []) { const node = input('', spec.secret !== false); node.dataset.imCredential = spec.key; field(fields, spec.label, node); }
        setupHelp(fields, select.value);
      }
      select.onchange = choose; choose();
      const save = button('保存机器人', () => view.run(async () => {
        const credentials = Object.fromEntries([...fields.querySelectorAll('input')].map(node => [node.dataset.imCredential, node.value.trim()]));
        const result = await api.im.create({provider:select.value, name:name.value.trim(), credentials}, view.options());
        view.clear(); if (!view.active()) return;
        await refresh(); if (view.active()) openConnection(result);
      }));
      save.disabled = !select.options.length; view.body.append(save);
    }
    function openConnection(connection) {
      const view = modal(connection.name, '手机绑定后可向此任务发送指令。撤销连接会取消后续远程访问。');
      if (!connection.credentialsConfigured) { view.status.textContent = '此连接已撤销，请重新添加机器人。'; return; }
      setupHelp(view.body, connection.provider);
      if (connection.webhookUrl) {
        const callback = input(connection.webhookUrl); callback.readOnly = true; field(view.body, '平台回调地址', callback);
        const callbackHelp = {
          telegram: '验证机器人时会向 Telegram 注册回调地址。',
          discord: '在 Discord 应用后台将此地址填入 Interactions Endpoint URL；验证时会注册 /pair 和 /soduwork 命令。',
          teams: '在 Azure Bot 后台将此地址设为消息终结点，并启用 Microsoft Teams 通道。'
        };
        view.body.append(el('p', callbackHelp[connection.provider] || '请在平台后台配置此回调地址，并开通机器人消息接收事件。', 'connector-inline-note'));
      }
      if (!connection.enabled) view.body.append(button('验证并启用机器人', () => view.run(async () => {
        const result = await api.im.connect(connection.id, view.options()); if (!view.active()) return;
        await refresh(); if (view.active()) openConnection(result);
      })));
      else view.body.append(button('绑定任务', () => { if (view.active()) chooseTask(connection); }), button('查看绑定和消息', () => { if (view.active()) inspect(connection); }));
      view.body.append(button('撤销远程连接', () => {
        if (!view.active()) return;
        const confirm = modal('撤销远程连接', '此机器人的所有手机绑定将失效；原任务和历史记录会保留。');
        confirm.body.append(button('确认撤销', () => confirm.run(async () => {
          await api.im.revoke(connection.id, confirm.options()); if (!confirm.active()) return;
          confirm.status.textContent = '已撤销远程连接。'; confirm.body.replaceChildren(); await refresh();
        })));
      }));
    }
    async function chooseTask(connection) {
      const view = modal('绑定手机与任务', '选择任务和执行电脑。手机发送配对命令后，后续指令会进入该任务。');
      await view.run(async () => {
        const result = await api.im.targets(connection.id, view.options()); if (!view.active()) return;
        const targets = [...(result.targets || [])].sort((a,b) => Number(b.started) - Number(a.started));
        if (!targets.length) { view.status.textContent = '暂无可绑定任务。请先在需求池创建任务，并确认执行电脑已登记。'; return; }
        const select = el('select', undefined, 'cap-input');
        targets.forEach((item, index) => { const option = el('option', item.title + ' · ' + item.runnerName + (item.online ? ' · 在线' : ' · 离线等待')); option.value = String(index); select.append(option); });
        field(view.body, '任务与执行电脑', select); view.status.textContent = '';
        const setup = el('div', undefined, 'cap-fields'); view.body.append(setup);
        let consent, agent, model;
        const generate = button('生成一次性配对命令', () => view.run(async () => {
          const target = targets[Number(select.value)];
          const body = {taskId:target.taskId, runnerId:target.runnerId, allowStart:false};
          if (!target.started) {
            if (!consent?.checked || !agent?.value) { view.status.textContent = '请先选择执行方式，并确认允许从手机启动任务。'; return; }
            const selected = target.agents.find(item => item.id === agent.value);
            if (selected.modelPick && !model?.value) { view.status.textContent = '请选择可用模型。'; return; }
            Object.assign(body, {allowStart:true, agentId:agent.value, model:selected.modelPick ? model.value : ''});
          }
          const pair = await api.im.pair(connection.id, body, view.options());
          if (!view.active()) return;
          view.body.replaceChildren(); const command = input(pair.command); command.readOnly = true;
          field(view.body, '在手机发给此机器人', command);
          const instructions = connection.provider === 'discord'
            ? '在 Discord 选择 /pair，将配对码填入 code 参数；成功后用 /soduwork 的 text 参数发送任务指令。'
            : connection.provider === 'telegram'
              ? '配对成功后，私聊可直接发送任务指令；群聊请使用 /soduwork@机器人名 加任务内容。'
              : '群聊请按平台要求 @机器人。配对成功后即可发送任务指令。';
          view.status.textContent = '命令有效期 ' + Math.ceil(pair.expiresIn / 60) + ' 分钟，仅可使用一次。' + instructions;
        }));
        function changeTarget() {
          setup.replaceChildren(); consent = agent = model = null;
          const target = targets[Number(select.value)]; generate.disabled = !target.started;
          if (target.started) return;
          if (!target.agents?.length) { setup.append(el('p', '这台电脑还没有可用的执行方式或模型，请在 SoduWork 配置后刷新。', 'connector-inline-note')); return; }
          agent = el('select', undefined, 'cap-input');
          for (const item of target.agents) { const option = el('option', item.name); option.value = item.id; agent.append(option); }
          field(setup, '执行方式', agent); const models = el('div'); setup.append(models);
          consent = el('input'); consent.type = 'checkbox'; consent.dataset.imStartConsent = ''; field(setup, '允许手机指令首次启动此任务，并按当前权限使用模型和工具', consent);
          const update = () => { const selected = target.agents.find(item => item.id === agent.value); generate.disabled = !consent.checked || !!(selected.modelPick && !model?.value); };
          agent.onchange = () => {
            models.replaceChildren(); model = null;
            const selected = target.agents.find(item => item.id === agent.value);
            if (selected.modelPick) {
              model = el('select', undefined, 'cap-input');
              for (const item of selected.models || []) { const option = el('option', item.label || item.name); option.value = item.name; model.append(option); }
              field(models, '模型', model); model.onchange = update;
            }
            update();
          };
          consent.onchange = update; agent.onchange();
        }
        select.onchange = changeTarget; changeTarget(); view.body.append(generate);
      });
    }
    async function inspect(connection) {
      const view = modal('绑定与消息记录', '执行状态无法确认时，请先在原会话核对，避免重复执行。');
      await view.run(async () => {
        const [bindings, messages] = await Promise.all([api.im.bindings(connection.id, view.options()), api.im.messages(connection.id, view.options())]);
        if (!view.active()) return;
        view.status.textContent = ''; view.body.append(el('b', '已绑定会话'));
        const activeBindings = (bindings.bindings || []).filter(item => item.enabled);
        if (!activeBindings.length) view.body.append(el('p', '尚未在手机完成绑定。', 'connector-inline-note'));
        for (const item of activeBindings) {
          const row = el('div', undefined, 'im-connection'); row.append(el('span', '任务 ' + item.taskId + ' · ' + (item.external?.chat || '私聊')),
            button('解除绑定', () => view.run(async () => { await api.im.unbind(item.id, view.options()); if (view.active()) inspect(connection); }))); view.body.append(row);
        }
        view.body.append(el('b', '最近消息'));
        if (!messages.messages?.length) view.body.append(el('p', '还没有收到手机消息。', 'connector-inline-note'));
        for (const item of messages.messages || []) {
          const row = el('div', undefined, 'im-message');
          row.append(el('p', (statuses[item.status] || '状态待检查') + ' · ' + new Date(item.createdAt).toLocaleString()), el('p', detailText(item.detail), 'connector-inline-note'));
          for (const outgoing of item.outgoing || []) row.append(el('p', '回传：' + (statuses[outgoing.status] || '状态待检查') + (outgoing.detail ? ' · ' + detailText(outgoing.detail) : ''), 'connector-inline-note'));
          if (item.status === 'uncertain' || item.outgoing?.some(outgoing => outgoing.status === 'uncertain')) row.append(button('我已核对，结束等待', () => {
            if (!view.active()) return;
            const confirm = modal('结束人工核对', '请确认已经检查原会话和手机消息。此操作会解除等待状态，不会重新发送或执行。');
            confirm.body.append(button('确认已核对', () => confirm.run(async () => { await api.im.dismiss(item.id, confirm.options()); if (confirm.active()) inspect(connection); })));
          }));
          view.body.append(row);
        }
        view.body.append(button('刷新记录', () => { if (view.active()) inspect(connection); }));
      });
    }
    const refreshButton = button('刷新', refresh), add = button('连接机器人', create); add.disabled = true;
    function scopeChanged() {
      if (api.taskStorageKey?.('ops') === owner) return;
      modalCleanup?.(); ++modalRevision; ctx.closeModal(); list.replaceChildren(); add.disabled = refreshButton.disabled = true;
      note.textContent = '账号已切换，请重新打开连接器页面。';
    }
    global.addEventListener('soduwork-data-scope-changed', scopeChanged);
    actions.append(refreshButton, add); refresh();
    return () => { disposed = true; ++revision; ++modalRevision; modalCleanup?.(); global.removeEventListener('soduwork-data-scope-changed', scopeChanged); section.remove(); };
  }
  global.SoduWorkIMRemote = {mount};
})(window);

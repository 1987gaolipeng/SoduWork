/* New Agent runtimes use the same registry and conversation flow as built-ins. */
(function (global) {
  'use strict';
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="14" height="13" rx="4"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6M2 12v4m20-4v4"/></svg>';
  const bridge = () => global.soduWorkAPI?.conversationSession || global.soduWorkAPI?.piSession;
  let active = null;
  async function mount(host) {
    if (!host) return;
    const api = bridge()?.customAgents;
    if (!api) return;
    const reply = await api.list().catch(error => ({ ok: false, reason: error.message }));
    if (!host.isConnected) return;
    if (!reply.ok) { host.innerHTML = '<p class="ca-error" role="alert">' + esc(reply.reason) + '</p>'; return; }
    if (!reply.agents.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<section class="ca-section"><header><h3>本机接入的底座</h3><p>独立 Agent 程序，与内置底座使用同一个对话入口。</p></header><div class="ca-list">' +
      reply.agents.map(row => '<article class="ca-row"><span class="ca-icon">' + icon + '</span><div><b data-user-content>' + esc(row.displayName) +
        '</b><span>' + (row.active ? '已接入 · 可在新对话中选择' : '已保存 · 等待执行机确认') + '</span></div>' +
        '<button type="button" class="btn-mini" data-ca-' + (row.active ? 'probe' : 'activate') + '="' + esc(row.id) + '">' +
        (row.active ? '检测程序' : '重试生效') + '</button><p class="ca-result" aria-live="polite"></p></article>').join('') + '</div></section>';
    host.querySelectorAll('[data-ca-probe],[data-ca-activate]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true; const status = button.closest('article').querySelector('.ca-result'); status.textContent = '正在检查…';
      try {
        if (button.hasAttribute('data-ca-activate')) {
          const result = await api.activate();
          if (!result.ok || result.state === 'pending') throw Error(result.reason || '执行机尚未确认');
          await mount(host); return;
        }
        const result = await bridge().probe(button.dataset.caProbe);
        status.textContent = result.ok ? '程序已找到；开始对话时将建立 ACP 连接。' : result.reason || '程序暂不可用，请检查安装与账号。';
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    }));
  }
  function open(onSaved) {
    if (active) { active.focus(); return; }
    const api = bridge()?.customAgents;
    if (!api) { global.petSay?.('请更新客户端后接入新底座'); return; }
    const dialog = document.createElement('dialog'); active = dialog;
    dialog.className = 'ca-dialog'; dialog.setAttribute('aria-labelledby', 'caTitle');
    dialog.innerHTML = '<form novalidate><header><span class="ca-icon">' + icon + '</span><div><h2 id="caTitle">接入新的 Agent 底座</h2>' +
      '<p>在这台电脑接入已安装、支持标准 ACP 的 Agent。</p></div><button type="button" data-ca-close aria-label="关闭">×</button></header>' +
      '<div class="ca-form"><label>底座名称<input name="displayName" maxlength="80" placeholder="例如：我的编程 Agent" required></label>' +
      '<label>启动程序<span class="ca-command"><input name="command" placeholder="程序路径或 PATH 中的命令名" required><button type="button" data-ca-pick>选择程序</button></span></label>' +
      '<label>启动参数<textarea name="args" rows="2" placeholder="每行一个参数，例如 --acp"></textarea></label>' +
      '<label>模型来源<select name="modelMode"><option value="account">使用底座自己的账号与模型</option><option value="managed">使用 SoduWork 中的模型</option></select></label>' +
      '<fieldset class="ca-model-env" hidden><legend>程序接收模型配置的环境变量名</legend><p>按该 Agent 的说明填写变量名，密钥由 SoduWork 临时提供。</p>' +
      '<label>模型地址<input name="baseEnv" value="OPENAI_BASE_URL"></label><label>模型令牌<input name="keyEnv" value="OPENAI_API_KEY"></label>' +
      '<label>模型名称<input name="modelEnv" value="OPENAI_MODEL"></label></fieldset>' +
      '<p class="ca-hint">接入后可在新对话的 Agent 列表中选择。程序的权限由自身控制；暂不提供统一权限与目标模式。使用独立 SDK 或其它协议的底座，需要先提供适配器。</p>' +
      '<p class="ca-error" role="alert" hidden></p><p class="ca-success" role="status" hidden></p></div>' +
      '<footer><button type="button" data-ca-close>取消</button><button type="submit" class="ca-primary">保存并接入</button></footer></form>';
    const form = dialog.querySelector('form'), field = name => form.elements.namedItem(name);
    const error = dialog.querySelector('[role=alert]'), success = dialog.querySelector('[role=status]'), save = dialog.querySelector('[type=submit]');
    let busy = false, saved = false;
    const runtimeId = 'custom-' + global.crypto.randomUUID().slice(0, 8);
    const close = () => { if (busy) return; dialog.close(); dialog.remove(); active = null; };
    dialog.querySelectorAll('[data-ca-close]').forEach(button => button.addEventListener('click', close));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    field('modelMode').addEventListener('change', () => { dialog.querySelector('fieldset').hidden = field('modelMode').value !== 'managed'; });
    dialog.querySelector('[data-ca-pick]').addEventListener('click', async () => {
      try {
        const result = await api.pick();
        if (result?.ok) field('command').value = result.path;
        else if (!result?.canceled) throw Error(result?.reason || '未能选择程序，请填写完整路径');
      } catch (problem) { error.textContent = problem.message; error.hidden = false; }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return; if (saved) { close(); return; }
      error.hidden = true; success.hidden = true;
      if (!field('displayName').value.trim() || !field('command').value.trim()) { error.textContent = '请填写底座名称和启动程序'; error.hidden = false; return; }
      const input = { id: runtimeId, displayName: field('displayName').value.trim(), command: field('command').value.trim(),
        args: field('args').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean), modelMode: field('modelMode').value, modelEnv: {} };
      if (input.modelMode === 'managed') for (const [name, source] of [['baseEnv', 'base'], ['keyEnv', 'key'], ['modelEnv', 'model']]) input.modelEnv[field(name).value.trim()] = source;
      busy = true; form.setAttribute('aria-busy', 'true'); save.textContent = '正在接入…';
      for (const control of form.elements) control.disabled = true;
      try {
        const result = await api.add(input);
        if (!result.ok) throw Error(result.reason || '接入未完成');
        saved = true; success.hidden = false;
        success.textContent = result.state === 'active' ? '已接入，可在新对话的 Agent 列表中选择。' : result.reason || '配置已保存，执行机连接后可重试生效。';
        if (typeof onSaved === 'function') onSaved();
      } catch (problem) { error.textContent = problem.message; error.hidden = false; }
      finally {
        busy = false; form.removeAttribute('aria-busy');
        for (const control of form.elements) control.disabled = saved && !control.matches('button');
        save.textContent = saved ? '完成' : '保存并接入';
        if (saved) dialog.querySelector('[data-ca-pick]').disabled = true;
      }
    });
    document.body.append(dialog); dialog.showModal(); field('displayName').focus();
  }
  global.CustomAgents = { open, mount };
})(window);

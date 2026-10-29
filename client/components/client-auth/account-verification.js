(function (global) {
  'use strict';
  const labels = { change_email: '更换登录邮箱', change_password: '设置新密码', export: '导出个人数据', delete_account: '注销账号', devices: '删除设备' };
  function verify(purpose, user, parent) {
    const ui = global.AccountUI, api = global.SoduWorkAPI;
    const emailOnly = purpose === 'change_password';
    const owner = api.clientAuthSnapshot()?.user?.id, hub = api.hubBase();
    return new Promise((resolve, reject) => {
      let settled = false, busy = false, challenge = null, revision = 0, timer = null, until = 0;
      const dialog = ui.modal(parent || document.body, '确认是你本人',
        '<p class="ac-muted">' + ui.esc(labels[purpose] || '此操作') + '前，请验证身份。验证仅用于这一次操作。</p>' +
        '<form class="ac-form" novalidate><div class="ac-segments"' + (emailOnly ? ' hidden' : '') + '><button type="button" data-proof-mode="password" aria-pressed="' + !emailOnly + '">密码验证</button>' +
        '<button type="button" data-proof-mode="code" aria-pressed="' + emailOnly + '">邮箱验证</button></div>' +
        '<label data-proof-password' + (emailOnly ? ' hidden' : '') + '>当前密码<input type="password" name="password" autocomplete="current-password" maxlength="128"></label>' +
        '<div data-proof-code' + (emailOnly ? '' : ' hidden') + '><p class="ac-muted">向已验证的登录邮箱发送验证码</p><label>邮箱验证码<span class="ac-code-row"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码"><button class="ac-secondary" type="button" data-proof-send>获取验证码</button></span></label></div>' +
        '<p class="ac-status" role="status" aria-live="polite"></p><button class="ac-primary" type="submit">验证并继续</button></form>', 'ac-verify');
      let mode = emailOnly ? 'code' : 'password';
      const form = dialog.mask.querySelector('form'), status = form.querySelector('.ac-status');
      const send = form.querySelector('[data-proof-send]');
      const current = () => dialog.active() && owner === api.clientAuthSnapshot()?.user?.id && hub === api.hubBase();
      const scopeChanged = () => { if (!current()) dialog.close(); };
      global.addEventListener('soduwork-data-scope-changed', scopeChanged);
      global.addEventListener('soduwork-client-auth-required', scopeChanged);
      function cooldown() {
        const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        send.textContent = seconds ? seconds + ' 秒后重发' : '获取验证码'; send.disabled = busy || seconds > 0;
      }
      function block(value) { busy = value; form.querySelectorAll('button,input').forEach(el => { el.disabled = value; }); cooldown(); }
      form.querySelector('[name="code"]').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });
      form.querySelectorAll('[data-proof-mode]').forEach(button => button.addEventListener('click', () => {
        if (emailOnly) return;
        revision++; mode = button.dataset.proofMode; status.textContent = '';
        form.querySelector('[data-proof-password]').hidden = mode !== 'password';
        form.querySelector('[data-proof-code]').hidden = mode !== 'code';
        form.querySelectorAll('[data-proof-mode]').forEach(el => el.setAttribute('aria-pressed', String(el === button)));
        form.querySelector('[name="password"]').value = '';
      }));
      send.addEventListener('click', async () => {
        if (busy || until > Date.now()) return;
        const stamp = revision; block(true); status.textContent = '正在发送…';
        try {
          const result = ui.check(await api.clientAccountRequest('challenge', { purpose: 'reauthentication' }));
          if (!current() || stamp !== revision) return;
          challenge = result.challengeId; until = Date.now() + (result.retryAfter || 60) * 1000;
          if (timer) clearInterval(timer); timer = setInterval(cooldown, 1000);
          status.textContent = '验证码发送请求已受理，请查看邮箱。';
        } catch (error) { if (current()) status.textContent = ui.error(error); }
        finally { if (current()) block(false); }
      });
      form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy) return;
        const password = form.querySelector('[name="password"]'), code = form.querySelector('[name="code"]');
        if (mode === 'password' && !password.value) { status.textContent = '请输入当前密码。'; password.focus(); return; }
        if (mode === 'code' && (!challenge || !ui.code(code.value))) { status.textContent = '请获取并填写 6 位验证码。'; code.focus(); return; }
        block(true); status.textContent = '正在验证…';
        try {
          const payload = mode === 'password' ? { purpose, password: password.value } : { purpose, challengeId: challenge, code: code.value };
          const result = ui.check(await api.clientAccountRequest('verification', payload));
          if (!current()) return;
          if (!result.verificationToken) throw Error('服务未返回有效的身份确认凭据');
          settled = true; dialog.close(); resolve(result.verificationToken);
        } catch (error) { if (current()) status.textContent = ui.error(error); }
        finally { password.value = ''; code.value = ''; if (current()) block(false); }
      });
      dialog.mask.addEventListener('ac-close', () => {
        revision++; if (timer) clearInterval(timer);
        global.removeEventListener('soduwork-data-scope-changed', scopeChanged);
        global.removeEventListener('soduwork-client-auth-required', scopeChanged);
        form.querySelectorAll('input').forEach(input => { input.value = ''; });
        if (!settled) { const error = Error('已取消身份验证'); error.name = 'AbortError'; reject(error); }
      });
    });
  }
  global.AccountVerification = { verify };
})(window);

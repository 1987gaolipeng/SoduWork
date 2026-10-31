/* Renderer only: native persistence is behind an injectable bridge. No HTML from release data. */
(function (global) {
  'use strict';
  const bridge = () => global.soduWorkAPI?.releaseNotes;
  const locale = () => global.SoduWorkI18n?.getLocale() || 'zh-CN';
  const t = (key, params) => global.SoduWorkI18n.t('releaseNotes.' + key, undefined, params);
  let dialog, payload, history = false, busy = false, done = false, previousFocus, request = 0;
  function node(tag, text, parent) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    parent?.append(element);
    return element;
  }
  function button(text, id, parent, action) {
    const element = node('button', text, parent);
    element.type = 'button'; element.dataset.rnFocus = id;
    element.addEventListener('click', action);
    return element;
  }
  function section(content, parent) {
    node('h3', content.title, parent);
    const list = node('ul', undefined, parent);
    for (const item of content.items) node('li', item.text, list);
  }
  function render() {
    const scroll = dialog.querySelector('.rn-content')?.scrollTop || 0;
    const focus = document.activeElement?.dataset.rnFocus;
    dialog.replaceChildren();
    const header = node('header', undefined, dialog);
    const title = node('h2', t(history ? 'history' : payload.kind === 'updated' ? 'updated' : 'title', { version: payload.version }), header);
    title.id = 'releaseNotesTitle';
    const close = button('', 'close', header, dismiss);
    close.className = 'ws-project-dialog-close'; close.setAttribute('aria-label', t('close'));
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stroke.setAttribute('d', 'm6 6 12 12M18 6 6 18'); icon.append(stroke); close.append(icon);
    const body = node('div', undefined, dialog); body.className = 'rn-content';
    body.tabIndex = 0; body.dataset.rnFocus = 'content';
    body.setAttribute('role', 'region'); body.setAttribute('aria-labelledby', title.id);
    const releases = history ? payload.releases : payload.releases.filter(item => item.version === payload.version);
    if (!releases.length) node('p', t('empty'), body);
    for (const release of releases) {
      const article = node('article', undefined, body);
      article.lang = release.locale;
      if (history) node('h3', 'SoduWork ' + release.version, article).className = 'rn-version';
      if (release.publishedAt && Number.isFinite(Date.parse(release.publishedAt))) {
        const published = new Date(release.publishedAt);
        const time = node('time', new Intl.DateTimeFormat(locale(), {
          dateStyle: 'medium', timeStyle: 'short',
        }).format(published), article);
        time.dateTime = published.toISOString();
      }
      if (release.fallback) node('p', t('fallback'), article);
      node('p', release.summary, article);
      release.sections.forEach(value => section(value, article));
    }
    const error = node('p', '', dialog); error.className = 'rn-error'; error.setAttribute('role', 'status');
    const footer = node('footer', undefined, dialog);
    button(t(history ? 'backToCurrent' : 'history'), 'history', footer, () => {
      history = !history; dialog.replaceChildren(); render();
      dialog.querySelector('[data-rn-focus="history"]').focus({ preventScroll: true });
    }).className = 'ws-project-cancel';
    button(t('dismiss'), 'dismiss', footer, dismiss).className = 'ws-project-save';
    if (focus) [...dialog.querySelectorAll('[data-rn-focus]')].find(el => el.dataset.rnFocus === focus)?.focus({ preventScroll: true });
    body.scrollTop = scroll;
  }
  function show(value, manual) {
    payload = value; history = manual;
    previousFocus = document.activeElement;
    dialog = node('dialog'); dialog.className = 'ws-project-dialog release-notes-dialog';
    dialog.setAttribute('translate', 'no'); dialog.setAttribute('aria-labelledby', 'releaseNotesTitle');
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    document.body.append(dialog); render(); dialog.showModal();
    dialog.querySelector('[data-rn-focus="dismiss"]').focus();
  }
  async function dismiss() {
    if (busy || !dialog) return;
    busy = true;
    try {
      if (payload.automatic && !await bridge().acknowledge()) throw new Error('ack failed');
      dialog.close(); dialog.remove(); dialog = null;
      if (payload.automatic) done = true;
      previousFocus?.focus();
    } catch (_) {
      // Storage failures retain pending for the next launch, but never trap the user in a modal.
      await bridge().release().catch(() => {});
      dialog.close(); dialog.remove(); dialog = null; done = true;
      previousFocus?.focus();
      if (global.petSay) global.petSay(t('error'));
      else { const notice = node('p', t('error'), document.body); notice.setAttribute('role', 'status'); }
    }
    finally { busy = false; }
  }
  function available() {
    return !document.hidden && document.hasFocus() &&
      !document.documentElement.matches('.soduwork-auth-pending,.soduwork-auth-open') &&
      !document.querySelector('dialog[open], [aria-modal="true"]:not([hidden]), .pui-layer.is-visible, .nchat-access-overlay');
  }
  async function attempt() {
    if (done || busy || dialog || !bridge() || global.__deskPanel !== 'workspace' || !available()) return;
    busy = true;
    try {
      const token = request;
      const value = await bridge().claim(locale());
      if (token !== request) { await bridge().release(); return; }
      if (!value) return;
      if (value.complete) { done = true; return; }
      if (!available()) { await bridge().release(); return; }
      show({ ...value, automatic: true }, false);
    } catch (error) {
      // A broken state file must not interrupt work or retry disk writes every two seconds.
      done = true;
      await bridge().release().catch(() => {});
      console.warn('[release-notes]', error);
    }
    finally { busy = false; }
  }
  async function openHistory() {
    if (dialog || busy || !bridge()) return;
    busy = true;
    try {
      const releases = await bridge().list(locale());
      const version = await bridge().version();
      show({ releases, version, automatic: false }, true);
    } catch (_) { global.petSay?.(t('error')); }
    finally { busy = false; }
  }
  global.addEventListener('soduwork-locale-change', async () => {
    const token = ++request;
    if (!dialog) return;
    try {
      const releases = await bridge().list(locale());
      if (token !== request || !dialog) return;
      payload.releases = releases; render();
    } catch (_) { if (dialog) dialog.querySelector('.rn-error').textContent = t('error'); }
  });
  document.getElementById('releaseNotesHistory')?.addEventListener('click', openHistory);
  global.addEventListener('focus', attempt);
  // Capture at window level before workspace/panel Escape handlers can close the window.
  global.addEventListener('keydown', event => {
    if (dialog?.open && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); dismiss();
    }
  }, true);
  function resetContext() {
    ++request;
    if (dialog) { bridge()?.release(); dialog.close(); dialog.remove(); dialog = null; }
    done = false;
  }
  global.addEventListener('soduwork-data-scope-changed', resetContext);
  global.addEventListener('soduwork-device-auth', event => {
    if (event.detail?.state && event.detail.state !== 'active') resetContext();
    else { done = false; setTimeout(attempt, 100); }
  });
  const timer = setInterval(() => { if (!done) attempt(); }, 2000);
  global.addEventListener('pagehide', () => { clearInterval(timer); bridge()?.release(); }, { once: true });
  global.SoduWorkReleaseNotes = Object.freeze({ openHistory });
})(window);

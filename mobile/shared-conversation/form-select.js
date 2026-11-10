/* Mobile-only presentation for the shared PC forms; native change contracts stay intact. */
(function (global) {
  'use strict';
  const document = global.document;
  let active = null;
  const owns = node => node?.tagName === 'SELECT' && !node.multiple &&
    node.closest('.waz-sheet, .wes-sheet, .pis-sheet, .mobile-work-card, #composer');
  function close(restore = true) {
    if (!active) return;
    const {panel, source} = active;
    active = null;
    panel.remove();
    source.removeAttribute('aria-expanded');
    if (restore && source.isConnected) source.focus({preventScroll: true});
  }
  function open(source) {
    if (source.disabled || !source.options.length) return;
    close(false);
    const panel = document.createElement('div');
    panel.className = 'mobile-form-options';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', source.getAttribute('aria-label') ||
      source.closest('label')?.querySelector('span')?.textContent || '选择');
    let selected;
    for (const option of source.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.selected));
      button.disabled = option.disabled || option.parentElement?.disabled === true;
      const check = document.createElement('span');
      check.className = 'mobile-form-option-check';
      check.textContent = option.selected ? '✓' : '';
      check.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = option.textContent;
      button.append(check, text);
      button.addEventListener('click', () => {
        // Do not apply a stale choice after the form has reloaded or changed account.
        if (!source.isConnected || source.disabled || ![...source.options].includes(option)) {close(); return;}
        source.value = option.value;
        close();
        source.dispatchEvent(new Event('input', {bubbles: true}));
        source.dispatchEvent(new Event('change', {bubbles: true}));
      });
      if (option.selected && !button.disabled) selected = button;
      panel.append(button);
    }
    active = {panel, source};
    source.setAttribute('aria-expanded', 'true');
    document.body.append(panel);
    const rect = source.getBoundingClientRect(), viewport = global.visualViewport;
    const top = (viewport?.offsetTop || 0) + 12;
    const bottom = top + (viewport?.height || global.innerHeight) - 24;
    const width = Math.min(360, global.innerWidth - 24);
    panel.style.width = width + 'px';
    panel.style.left = Math.max(12, Math.min(rect.right - width, global.innerWidth - width - 12)) + 'px';
    const above = Math.max(0, rect.top - top - 8), below = Math.max(0, bottom - rect.bottom - 8);
    const up = above > below;
    panel.style.maxHeight = Math.min(360, up ? above : below) + 'px';
    panel.style.top = (up ? Math.max(top, rect.top - panel.offsetHeight - 8) : rect.bottom + 8) + 'px';
    (selected || panel.querySelector('button:not(:disabled)'))?.focus({preventScroll: true});
    selected?.scrollIntoView({block: 'nearest'});
  }
  function pointer(event) {
    if (active && !active.panel.contains(event.target) && event.target !== active.source) close(false);
    if (!owns(event.target) || event.target.disabled) return;
    event.preventDefault();
    if (active?.source === event.target) close(); else open(event.target);
  }
  function keyboard(event) {
    if (active) {
      if (event.key === 'Escape' || event.key === 'Tab') {if (event.key === 'Escape') event.preventDefault(); close(); return;}
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...active.panel.querySelectorAll('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    } else if (owns(event.target) && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); open(event.target);
    }
  }
  document.addEventListener('pointerdown', pointer, true);
  document.addEventListener('keydown', keyboard, true);
  global.addEventListener('resize', () => close(false));
  global.addEventListener('pagehide', () => close(false), {once: true});
})(window);

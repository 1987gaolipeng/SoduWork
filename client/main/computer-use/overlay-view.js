'use strict';
const label = document.getElementById('controlLabel'), cancel = document.getElementById('cancelLabel');
const pill = document.querySelector('.control-pill'), cursor = document.querySelector('.cursor-halo');
let themeKeys = [], themeKey = '';
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
window.soduWorkComputerOverlay.onState(state => {
  const nextTheme = JSON.stringify([state.locale, state.theme]);
  if (nextTheme !== themeKey) {
    themeKey = nextTheme;
    document.documentElement.lang = state.locale || 'zh-CN';
    document.documentElement.style.colorScheme = state.theme?.colorScheme || 'light';
    const tokens = state.theme?.tokens || {};
    for (const name of themeKeys) if (!(name in tokens)) document.documentElement.style.removeProperty(name);
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    themeKeys = Object.keys(tokens);
  }
  // Cursor ticks must not rewrite the live announcement or the theme every frame.
  setText(label, state.label); setText(cancel, state.cancelLabel);
  const stopping = String(Boolean(state.stopping));
  if (document.body.dataset.stopping !== stopping) document.body.dataset.stopping = stopping;
  if (pill.hidden === Boolean(state.primary)) {
    pill.hidden = !state.primary;
    pill.style.display = state.primary ? 'flex' : 'none';
  }
  if (state.cursor) {
    cursor.style.transform = `translate3d(${state.cursor.x - 22}px,${state.cursor.y - 22}px,0)`;
    cursor.style.display = 'block';
  } else cursor.style.display = 'none';
});
window.soduWorkComputerOverlay.ready();

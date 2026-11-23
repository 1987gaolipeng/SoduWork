'use strict';

// This sandboxed preload belongs only to the private startup window.
const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('#vault');
  if (!form) return;
  const password = form.querySelector('#passphrase');
  const confirm = form.querySelector('#confirm');
  const status = form.querySelector('[role=status]');
  const submit = form.querySelector('button');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    if (confirm && password.value !== confirm.value) {
      status.textContent = form.dataset.mismatch;
      confirm.select();
      return;
    }
    submit.disabled = true;
    status.textContent = '';
    try {
      if (await ipcRenderer.invoke('linux-device-vault-unlock', password.value)) return;
    } catch { /* Show only a local, non-sensitive error. */ }
    form.reset();
    status.textContent = form.dataset.error;
    submit.disabled = false;
    password.focus();
  });
});

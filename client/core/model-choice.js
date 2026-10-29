/* A modality-qualified choice is never a text completion model name. */
(function (global) {
  'use strict';
  const PREFIX = 'image::';
  function imageKey(row) { return PREFIX + String(row.providerId || '') + '::' + String(row.name || ''); }
  function imageChoice(value) {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
    const split = value.indexOf('::', PREFIX.length);
    if (split < 0) return null;
    const providerId = value.slice(PREFIX.length, split), name = value.slice(split + 2);
    return providerId && name ? { providerId, name } : null;
  }
  const api = { imageKey, imageChoice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.SoduWorkModelChoice = api;
})(typeof window !== 'undefined' ? window : globalThis);

'use strict';
const states = new WeakMap();
// Presentation only: never mutate the signed manifest or installation decisions.
function present(runtime, out, notify) {
  const manifest = runtime.status.manifest;
  if (!manifest || !runtime.releaseNotesOf) return;
  const locale = require('./native-locale.cjs').getLocale();
  let entry = states.get(runtime);
  if (!entry || entry.manifest !== manifest || entry.locale !== locale) {
    entry = { manifest, locale, text: null };
    states.set(runtime, entry);
    Promise.resolve().then(() => runtime.releaseNotesOf(manifest.version, locale, manifest.channel)).then(row => {
      if (states.get(runtime) !== entry || runtime.status.manifest !== manifest || !row) return;
      entry.text = [row.summary, ...row.sections.flatMap(s => [s.title, ...s.items.map(i => '• ' + i.text)])].join('\n');
      notify();
    }).catch(() => {}); // Existing verified prose remains available offline.
  }
  if (entry.text !== null) out.releaseNotes = entry.text;
}
module.exports = { present };

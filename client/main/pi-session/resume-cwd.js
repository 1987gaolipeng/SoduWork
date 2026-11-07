'use strict';

const fs = require('fs');
const path = require('path');

/* Validate persisted history directories before handing them to Pi. A
   conversation may outlive a renamed project, disconnected share, or old
   machine path; the archive remains authoritative while execution falls
   back to the current SoduWork workspace. An explicit override (the user's
   「换个文件夹继续」choice) wins when it is still an existing directory. */
module.exports = function resumeCwd(app, resume, fallback, override) {
  const moved = String(override || '').trim();
  if (moved && path.isAbsolute(moved)) {
    try {
      const stat = fs.statSync(moved);
      if (stat.isDirectory()) return path.resolve(moved);
    } catch (_) { /* the picked folder vanished; keep the archived directory */ }
  }
  const candidate = String(resume && resume.cwd || '').trim();
  if (candidate) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return path.resolve(candidate);
    } catch (_) { /* stale or inaccessible cwd */ }
  }
  return fallback(app);
};

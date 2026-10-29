'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { canonical, within, protectedPath } = require('./policy');
const SECRET = /(?:^|[\\/])(?:credentials?(?:\.[^\\/]+)?|auth\.json|tokens?\.json|id_(?:rsa|dsa|ecdsa|ed25519))(?:$|[\\/])|\.(?:pem|key|p12|pfx)$/i;

// Runtime-only capability, built from the trusted resource loader/materializer.
// Never restore these roots from a transcript, tool arguments or accessPolicy.
function create(roots = []) {
  const entries = [];
  for (const input of roots) {
    try {
      if (typeof input !== 'string' || !path.isAbsolute(input)) continue;
      const source = path.resolve(input), target = canonical(source);
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) continue;
      if (!entries.some(item => item.source === source)) entries.push({ source, target, dev: stat.dev, ino: stat.ino });
    } catch { /* Missing resources cannot grant access. */ }
  }
  function contains(source, target) {
    return entries.some(root => [source, target].some(file =>
      within(root.source, file) || within(root.target, file)));
  }
  function allows(source, target) {
    return entries.some(root => {
      try {
        if (!within(root.target, target)) return false;
        const base = within(root.source, source) ? root.source
          : within(root.target, source) ? root.target : null;
        if (!base) return false;
        // Pin both the installed directory and each resolved read target. A
        // junction replaced after loading must not expand a running grant.
        if (canonical(root.source) !== root.target || canonical(root.target) !== root.target) return false;
        const rootStat = fs.statSync(root.target);
        if (rootStat.dev !== root.dev || rootStat.ino !== root.ino) return false;
        if ([path.relative(base, source), path.relative(root.target, target)]
          .some(relative => protectedPath(relative, false) || SECRET.test(relative))) return false;
        const stat = fs.statSync(target);
        return stat.isFile() || stat.isDirectory();
      } catch { return false; }
    });
  }
  return Object.freeze({ contains, allows });
}

function fromSkills(skills = []) {
  return create(skills.flatMap(skill => {
    try {
      const file = skill.filePath;
      if (!path.isAbsolute(file || '') || path.basename(file).toLowerCase() !== 'skill.md') return [];
      const root = path.dirname(file);
      return within(canonical(root), canonical(file)) && fs.statSync(file).isFile() ? [root] : [];
    } catch { return []; }
  }));
}

function combine(...scopes) {
  return Object.freeze({
    contains: (source, target) => scopes.some(scope => scope?.contains(source, target)),
    allows: (source, target) => scopes.some(scope => scope?.allows(source, target)),
  });
}
module.exports = { create, fromSkills, combine };

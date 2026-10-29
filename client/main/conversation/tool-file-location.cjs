'use strict';
const path = require('node:path');
const toolArgs = require('../../components/shared/execution-tool-args');
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'filename', 'fileName',
  'file', 'target', 'target_path', 'targetPath'];

// This only locates an existing native filename for display/open actions in the
// parent conversation. Never rewrite execution inputs or guess from prose.
function project(item, cwd) {
  const args = toolArgs.normalize(item);
  if (typeof cwd !== 'string' || !cwd || toolArgs.kind(item) !== 'file') return args;
  const native = item.arguments || item.args;
  if (!native || typeof native !== 'object' || Array.isArray(native)) return args;
  const flavor = /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? path.win32 : path;
  const result = { ...args };
  for (const key of PATH_KEYS) {
    if (!Object.hasOwn(native, key)) continue;
    const value = native[key];
    if (typeof value !== 'string' || !value.trim() || /\0/.test(value) ||
        path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
        /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('~')) continue;
    result[key] = flavor.resolve(cwd, value);
  }
  return result;
}

module.exports = { project };

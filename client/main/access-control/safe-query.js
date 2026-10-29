'use strict';
// Literal local queries only; this grammar is not a shell sandbox.
// Keep access_scope.py and the shared test cases aligned.
function words(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 8192 ||
      /[\x00-\x1f\x7f\\]/.test(command)) return null;
  const result = [], pattern = /"[^"]*"|'[^']*'|[^\s"']+/g;
  let match, end = 0;
  while ((match = pattern.exec(command))) {
    if (command.slice(end, match.index).trim() || end && match.index === end) return null;
    const token = match[0];
    // Quoted regexes are literal argv, not shell expressions. Unquoted shell
    // syntax and expansion inside double quotes remain outside this grammar.
    if (token[0] === '"' ? /[$\x60%]/.test(token) : token[0] !== "'" && /[$\x60;&|<>(){}\[\]*?!~%]/.test(token)) return null;
    result.push(/^["']/.test(token) ? token.slice(1, -1) : token);
    end = pattern.lastIndex;
  }
  return command.slice(end).trim() ? null : result;
}
function targets(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string' || !v ||
      /[\x00-\x1f\x7f]/.test(v))) return null;
  const [name, ...args] = argv;
  if (name === 'pwd') return args.every(v => v === '-L' || v === '-P') ? [{ path: '.', kind: 'directory' }] : null;
  if (!['ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep'].includes(name)) return null;
  const result = []; let positional = false, patternSeen = false;
  const listFiles = name === 'rg' && args.includes('--files');
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!positional && value === '--') { positional = true; continue; }
    if (!positional && value.startsWith('-')) {
      if (name === 'ls' && (/^-[lahd1Ftr]+$/.test(value) || ['--all', '--almost-all', '--directory', '--human-readable'].includes(value))) continue;
      if (name === 'cat' && /^-[nbsETv]+$/.test(value)) continue;
      if (name === 'wc' && /^-[lcwmL]+$/.test(value)) continue;
      if (['head', 'tail'].includes(name) && ['-n', '-c'].includes(value) && /^\d{1,7}$/.test(args[i + 1] || '')) { i++; continue; }
      if (['head', 'tail'].includes(name) && /^-[nc]\d{1,7}$/.test(value)) continue;
      if (['head', 'tail'].includes(name) && /^-\d{1,7}$/.test(value)) continue;
      if (['head', 'tail'].includes(name) && /^(?:--lines|--bytes)=\d{1,7}$/.test(value)) continue;
      if (name === 'rg' && (['--no-config', '--files'].includes(value) ||
          !listFiles && (/^-[niFwlcsv]+$/.test(value) || ['--line-number', '--ignore-case', '--fixed-strings', '--count', '--no-heading', '--hidden'].includes(value)))) continue;
      if (['rg', 'grep'].includes(name) && !listFiles && ['-A', '-B', '-C', '-m', '--max-count'].includes(value) && /^\d{1,7}$/.test(args[i + 1] || '')) { i++; continue; }
      if (name === 'grep' && (/^-[nHiFEwclqsv]+$/.test(value) || ['--line-number', '--ignore-case', '--fixed-strings', '--count'].includes(value))) continue;
      return null;
    }
    if (['rg', 'grep'].includes(name) && !listFiles && !patternSeen) { patternSeen = true; continue; }
    if (value.startsWith('-')) return null;
    result.push({ path: value, kind: name === 'ls' || name === 'rg' ? 'either' : 'file' });
  }
  if (!result.length && (name === 'ls' || name === 'rg')) result.push({ path: '.', kind: 'directory' });
  return result.length && (!['rg', 'grep'].includes(name) || listFiles || patternSeen) ? result : null;
}
// Never inherit RIPGREP_CONFIG_PATH, execute preprocessors, or recurse into
// credentials through a directory query. Explicit targets are checked by the
// policy separately; these exclusions cover descendants and junctions.
const SEARCH_EXCLUDES = ['.git', '.ssh', '.aws', '.azure', '.kube', '.codex', '.claude', '.qwen', '.pi', '.soduwork', '.agents', '.opencode',
  '.env', '.env.*', '.npmrc', '.pypirc', '.netrc', 'credential', 'credential.*', 'credentials', 'credentials.*', 'auth.json', 'token.json', 'tokens.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '*.pem', '*.key', '*.p12', '*.pfx'];
function executionArgs(argv) {
  if (!targets(argv)) return null;
  if (argv[0] !== 'rg') return argv.slice(1);
  return ['--no-config', '--no-follow', ...SEARCH_EXCLUDES.flatMap(name => ['--iglob', '!**/' + name, '--iglob', '!**/' + name + '/**']), ...argv.slice(1)];
}
module.exports = { words, targets, executionArgs };

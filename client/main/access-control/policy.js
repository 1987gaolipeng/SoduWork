'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { fileURLToPath } = require('node:url');
const SCHEMA = 'soduwork.access-policy/v1';
const MODES = new Set(['standard', 'readonly', 'full']);
function canonical(target) {
  let current = path.resolve(target);
  const suffix = [];
  while (true) {
    try { return path.join(fs.realpathSync.native(current), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}
function within(root, target) {
  const relative = path.relative(root, target);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function normalize(value, cwd) {
  if (value == null) return null; // Historic full/work is never upgraded to new full access.
  if (value.schema !== SCHEMA || !MODES.has(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error('Invalid access policy');
  }
  if (!path.isAbsolute(value.workspaceRoot || '')) throw new Error('Access policy requires an absolute workspace');
  const root = canonical(value.workspaceRoot);
  if (cwd && !within(root, canonical(cwd)) || cwd && !within(canonical(cwd), root)) throw new Error('Access policy workspace mismatch');
  return Object.freeze({ schema: SCHEMA, mode: value.mode, revision: value.revision, workspaceRoot: root });
}
function create(mode, cwd) { return normalize({ schema: SCHEMA, mode, revision: 1, workspaceRoot: path.resolve(cwd) }, cwd); }
function next(mode, cwd, current, expectedRevision) {
  const revision = current?.revision || 0;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) throw new Error('权限状态已变化，请重新选择');
  return normalize({ schema: SCHEMA, mode, revision: revision + 1, workspaceRoot: path.resolve(cwd) }, cwd);
}
function restore(value, cwd) {
  // Access policy is part of the session's durable history. Reopening a
  // session must recreate the policy that was active when it was closed.
  return normalize(value, cwd);
}
function restoreState(value, pendingValue, cwd) {
  const original = normalize(value, cwd), pending = normalize(pendingValue, cwd);
  const accessPolicy = restore(original, cwd);
  let nextAccessPolicy = pending && pending.revision > (original?.revision || 0) ? restore(pending, cwd) : null;
  // Preserve a newer pending choice without rewriting revisions during
  // restoration.
  if (nextAccessPolicy && nextAccessPolicy.revision <= (accessPolicy?.revision || 0)) {
    nextAccessPolicy = normalize({ ...nextAccessPolicy, revision: accessPolicy.revision + 1 }, cwd);
  }
  return { accessPolicy, nextAccessPolicy };
}
function protectedPath(target, write = true) {
  if (process.platform === "win32" && target.slice(path.parse(target).root.length).includes(":")) return true;
  const sensitive = /(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.codex|\.claude|\.qwen|\.pi|\.soduwork|\.agents|\.opencode|\.env(?:\.[^\\/]*)?|\.npmrc|\.pypirc|\.netrc)(?:[\\/]|$)/i;
  const instructions = /(?:^|[\\/])(?:AGENTS\.md|SKILL\.md|CLAUDE\.md|GEMINI\.md)(?:[\\/]|$)/i;
  return sensitive.test(target) || write && instructions.test(target);
}
function queryTargets(policy, args, cwd, readScope) {
  if (Object.keys(args).some(key => !['command', 'timeout'].includes(key))) return null;
  const query = require('./safe-query');
  const targets = query.targets(query.words(args.command));
  if (!targets || !within(policy.workspaceRoot, canonical(cwd))) return null;
  try {
    return targets.map(item => {
      // Shell paths are literal: @file is not a Pi read-tool alias.
      const source = path.resolve(cwd, normalizeToolPath(item.path, false)), target = canonical(source);
      const workspaceRead = !readScope?.contains(source, target) && within(policy.workspaceRoot, target) && !protectedPath(source, false) && !protectedPath(target, false);
      if (!workspaceRead && !readScope?.allows(source, target)) throw Error('scope');
      if (item.kind === 'file' && !fs.statSync(target).isFile()) throw Error('file');
      if (item.kind === 'directory' && !fs.statSync(target).isDirectory()) throw Error('directory');
      return { source, target };
    });
  } catch { return null; }
}
// Keep this contract aligned with Pi's tools/path-utils and utils/paths. The
// permission target must be the path the native tool opens, including aliases
// and read's filename fallbacks, before following any filesystem junctions.
function normalizeToolPath(input, toolOptions = true) {
  let normalized = input;
  if (toolOptions) {
    normalized = normalized.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
    if (normalized.startsWith('@')) normalized = normalized.slice(1);
  }
  if (process.platform === 'win32' && normalized.startsWith('/') && !normalized.startsWith('//') && !normalized.includes('\\')) {
    const match = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) normalized = `${match[1].toUpperCase()}:\\${(match[2] || '').replaceAll('/', '\\')}`;
  }
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/') || process.platform === 'win32' && normalized.startsWith('~\\')) {
    return path.join(homedir(), normalized.slice(2));
  }
  return /^file:\/\//.test(normalized) ? fileURLToPath(normalized) : normalized;
}
function resolveToolPath(name, input, cwd) {
  const normalized = normalizeToolPath(input);
  const resolved = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(normalizeToolPath(cwd, false), normalized);
  if (name !== 'read') return resolved;
  const nfd = resolved.normalize('NFD');
  const candidates = [resolved, resolved.replace(/ (AM|PM)\./gi, '\u202F$1.'), nfd,
    resolved.replace(/'/g, '\u2019'), nfd.replace(/'/g, '\u2019')];
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.F_OK); return candidate; } catch {}
  }
  return resolved;
}
function operation(policy, name, args, cwd = policy.workspaceRoot, readScope) {
  const fileRead = ['read', 'list', 'ls', 'glob', 'find', 'grep'].includes(name);
  const fileWrite = ['write', 'edit'].includes(name);
  let target = '', source = '';
  if (fileRead || fileWrite) {
    source = resolveToolPath(name, String(args.path || args.file_path || '.'), cwd);
    target = canonical(source);
  }
  const action = fileRead ? 'file.read' : fileWrite ? 'file.write' : name === 'bash' ? 'command.execute' : 'tool.execute';
  const details = { action, tool: name, target, source, cwd: canonical(cwd), arguments: structuredClone(args), policyRevision: policy.revision };
  if (policy.mode === 'readonly' && !fileRead) return { ...details, verdict: 'deny' };
  if (policy.mode === 'full') return { ...details, verdict: 'allow' };
  if (fileWrite && readScope?.contains(source, target)) return { ...details, verdict: 'ask' };
  if (name === 'grep') {
    try { if (!fs.statSync(target).isFile()) return { ...details, verdict: 'ask' }; }
    catch { return { ...details, verdict: 'ask' }; }
  }
  if (fileRead && readScope?.contains(source, target)) {
    const resourceRead = readScope.allows(source, target);
    return { ...details, verdict: resourceRead ? 'allow' : 'ask', resourceRead };
  }
  if ((fileRead || fileWrite) && within(policy.workspaceRoot, target) && !protectedPath(source, fileWrite) && !protectedPath(target, fileWrite)) return { ...details, verdict: 'allow' };
  if (name === 'bash' && policy.mode === 'standard') {
    const commandTargets = queryTargets(policy, args, cwd, readScope);
    if (commandTargets) return { ...details, commandTargets, verdict: 'allow' };
  }
  return { ...details, verdict: 'ask' };
}
function current(policy, previous, cwd = policy.workspaceRoot, readScope) {
  if (previous.commandTargets) return JSON.stringify(queryTargets(policy, previous.arguments, cwd, readScope)) === JSON.stringify(previous.commandTargets);
  if (!previous.source) return true;
  const latest = operation(policy, previous.tool, previous.arguments, cwd, readScope);
  return latest.source === previous.source && latest.target === previous.target && (!previous.resourceRead || latest.verdict === 'allow');
}
module.exports = { SCHEMA, MODES, canonical, within, protectedPath, normalize, create, next, restore, restoreState, operation, current };

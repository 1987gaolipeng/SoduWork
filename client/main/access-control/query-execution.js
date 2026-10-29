'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const query = require('./safe-query');
function trustedProgram(name, workspace, canonical, within) {
  if (!['ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep'].includes(name)) return '';
  // Resolve both sides of the boundary, including Windows short-path aliases.
  try { workspace = canonical(workspace); } catch { return ''; }
  const directories = String(process.env.PATH || process.env.Path || '').split(path.delimiter);
  if (process.platform === 'win32') {
    // Git for Windows adds <install>/cmd to PATH, including custom drives.
    // Resolve its sibling utilities without launching a shell or trusting a
    // workspace-provided Git installation.
    for (const directory of directories.slice()) {
      if (!path.isAbsolute(directory) || !['cmd', 'bin'].includes(path.basename(directory).toLowerCase())) continue;
      try {
        const git = canonical(path.join(directory, 'git.exe'));
        if (within(workspace, git) || !fs.statSync(git).isFile()) continue;
        directories.push(path.resolve(path.dirname(git), '../usr/bin'));
      } catch {}
    }
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (base) directories.push(path.join(base, base === process.env.LOCALAPPDATA ? 'Programs/Git/usr/bin' : 'Git/usr/bin'));
    }
  }
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const target = canonical(path.join(directory, name + (process.platform === 'win32' ? '.exe' : '')));
      if (within(workspace, target) || !fs.statSync(target).isFile()) continue;
      fs.accessSync(target, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return target;
    } catch {}
  }
  return '';
}
function create(cwd, policy, policies, readScope = () => undefined) {
  const plans = new Map(), wrapped = new WeakSet();
  function admit(context, operation) {
    const tool = context.context?.tools?.find(item => item.name === context.toolCall.name);
    if (!tool || typeof tool.execute !== 'function') return false;
    const argv = query.words(context.args.command);
    const executable = argv?.[0] === 'pwd' ? 'builtin:pwd'
      : trustedProgram(argv?.[0], policy.workspaceRoot, policies.canonical, policies.within);
    if (!executable) return false;
    if (!wrapped.has(tool)) {
      const previous = tool.execute;
      tool.execute = async function(id, args, signal, ...rest) {
        const plan = plans.get(id);
        if (!plan) return previous.call(this, id, args, signal, ...rest);
        plans.delete(id);
        if (signal?.aborted || JSON.stringify(args) !== JSON.stringify(plan.operation.arguments) ||
            !policies.current(policy, plan.operation, cwd, readScope())) throw new Error('Safe query target changed before execution');
        if (plan.executable === 'builtin:pwd') return { content: [{ type: 'text', text: cwd }], details: { exitCode: 0 } };
        // Direct argv bypasses login shells, aliases, functions and cwd command
        // lookup. The chosen executable must stay outside the writable workspace.
        const current = policies.canonical(plan.executable);
        if (current !== plan.executable || policies.within(policy.workspaceRoot, current)) throw new Error('Safe query executable changed');
        return new Promise((resolve, reject) => {
          cp.execFile(plan.executable, query.executionArgs(plan.argv), {
            cwd, windowsHide: true, shell: false, encoding: 'utf8', signal,
            timeout: Math.min(300, Math.max(1, Number(args.timeout) || 60)) * 1000,
            maxBuffer: 4 * 1024 * 1024,
          }, (error, stdout, stderr) => {
            if (signal?.aborted) { reject(new Error('Operation aborted')); return; }
            const text = (stdout + stderr).slice(0, 200000) || (error ? String(error.message) : '(no output)');
            resolve({ content: [{ type: 'text', text }], details: { exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0 } });
          });
        });
      };
      wrapped.add(tool);
    }
    plans.set(context.toolCall.id, { executable, argv, operation });
    return true;
  }
  return { admit };
}
module.exports = { create, trustedProgram };

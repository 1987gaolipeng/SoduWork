'use strict';

const path = require('path');
const { spawn, spawnSync } = require('child_process');
const officeCli = require('./office-cli');

const PYTHON_CHECK = [
  'import importlib.util',
  "mods=('docx','openpyxl','pptx')",
  'missing=[x for x in mods if importlib.util.find_spec(x) is None]',
  "assert not missing, ','.join(missing)",
  "print('python-docx + openpyxl + python-pptx')",
].join(';');

function pythonCandidates(env = process.env, platform = process.platform) {
  if (env.SODUWORK_RUNTIME_MANAGED === '1') return env.SODUWORK_MANAGED_PYTHON ? [env.SODUWORK_MANAGED_PYTHON] : [];
  const explicit = String(env.SODUWORK_OFFICE_PYTHON || '').trim();
  const names = platform === 'win32' ? [explicit, 'python.exe', 'python', 'py.exe', 'py'] :
    [explicit, 'python3', 'python'];
  return [...new Set(names.filter(Boolean))];
}

function pythonArgs(command) {
  const launcher = path.win32.basename(String(command || '')).toLowerCase();
  return [...(/^py(?:\.exe)?$/.test(launcher) ? ['-3'] : []), '-c', PYTHON_CHECK];
}

function text(result) {
  return String((result && (result.stdout || result.stderr)) || '').trim();
}

/*
 * Capability discovery runs while a conversation is being opened.  Keep the
 * synchronous runner above for injected unit-test dependencies, but never
 * block Electron's main process on a real Python/Node child process.
 */
function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    try {
      child = spawn(command, args || [], {
        ...options,
        windowsHide: options.windowsHide !== false,
        shell: false,
      });
    } catch (error) {
      finish({ status: null, error });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish({ status: null, error }));
    child.once('close', (status, signal) => finish({ status, signal }));
    const timeout = Number(options.timeout);
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (_) { /* child already exited */ }
        finish({ status: null, error: Object.assign(new Error('spawn timeout'), { code: 'ETIMEDOUT' }) });
      }, timeout);
    }
  });
}

function probe(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = options.run || ((command, args, runOptions) => spawnSync(command, args, runOptions));
  const runOptions = {
    encoding: 'utf8', timeout: 3000, windowsHide: true, shell: false, env,
  };
  for (const command of pythonCandidates(env, platform)) {
    const result = run(command, pythonArgs(command), runOptions);
    if (result && result.status === 0) {
      return {
        ok: true, provider: 'python-office', command,
        detail: '免费本地引擎 · ' + (text(result).split(/\r?\n/)[0] || 'Python Office'),
      };
    }
  }

  // Discover Office CLI only through explicit machine-owner configuration, not its command name.
  const explicitCli = String(env.SODUWORK_OFFICECLI || '').trim();
  if (explicitCli) {
    const result = officeCli.probe({
      ...options, env, platform, run, explicitOnly: true,
    });
    if (result.ok) {
      return {
        ...result, provider: 'officecli-optional',
        detail: '自选适配器 · ' + result.detail,
      };
    }
  }
  return {
    ok: false, provider: '',
    reason: '尚未安装免费办公文档引擎（python-docx、openpyxl、python-pptx）',
  };
}

async function probeAsync(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = options.run || runAsync;
  const runOptions = {
    encoding: 'utf8', timeout: 3000, windowsHide: true, shell: false, env,
  };
  const commands = pythonCandidates(env, platform);
  // Probe all candidate launchers together.  The ordered result selection
  // keeps the explicit/default precedence deterministic while avoiding a
  // serial 3-second timeout chain when one launcher is unavailable.
  const results = await Promise.all(commands.map(async (command) => {
    try {
      return await run(command, pythonArgs(command), runOptions);
    } catch (error) {
      return { status: null, error, stdout: '', stderr: '' };
    }
  }));
  for (let index = 0; index < commands.length; index += 1) {
    const result = results[index];
    if (result && result.status === 0) {
      return {
        ok: true, provider: 'python-office', command: commands[index],
        detail: '免费本地引擎 · ' + (text(result).split(/\r?\n/)[0] || 'Python Office'),
      };
    }
  }

  const explicitCli = String(env.SODUWORK_OFFICECLI || '').trim();
  if (explicitCli) {
    const command = officeCli.locate({ ...options, env, platform, explicitOnly: true });
    if (command) {
      const shellCommand = (platform === 'win32' ? path.win32 : path.posix).isAbsolute(command)
        ? '"' + command.replace(/"/g, '""') + '" --version'
        : command + ' --version';
      const cliOptions = {
        encoding: null, timeout: 2500, windowsHide: true, shell: false, env,
        windowsVerbatimArguments: platform === 'win32',
      };
      const result = platform === 'win32' && /(?:\.cmd|\.bat)$/i.test(command)
        ? await run(env.ComSpec || env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', shellCommand], cliOptions)
        : await run(command, ['--version'], cliOptions);
      const output = officeCli.decodeOutput(result && result.stdout) ||
        officeCli.decodeOutput(result && result.stderr) || '';
      const first = output.trim().split(/\r?\n/)[0].slice(0, 160);
      if (result && result.status === 0) {
        return { ok: true, provider: 'officecli-optional', command,
          detail: '自选适配器 · ' + (first || 'Office CLI 已就绪') };
      }
    }
  }
  return {
    ok: false, provider: '',
    reason: '尚未安装免费办公文档引擎（python-docx、openpyxl、python-pptx）',
  };
}

/*
 * Adopt the Runner-managed office installation into client startup and child-process PATH
 * when no owner-configured SODUWORK_OFFICECLI takes precedence.
 */
function syncManagedOfficeCliEnv(env = process.env,
                                 options = {}) {
  if (String(env.SODUWORK_OFFICECLI || '').trim()) return '';
  const platform = options.platform || process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const managed = officeCli.managed(env, platform, options.managed || {});
  if (!managed) return '';
  env.SODUWORK_OFFICECLI = managed;
  const vendor = paths.dirname(managed);
  const current = String(env.PATH || '').split(paths.delimiter).filter(Boolean);
  const canonical = (item) => platform === 'win32'
    ? paths.resolve(item).toLowerCase() : paths.resolve(item);
  const known = current.some((item) => canonical(item) === canonical(vendor));
  if (!known) env.PATH = vendor + paths.delimiter + String(env.PATH || '');
  return managed;
}

module.exports = { PYTHON_CHECK, probe, probeAsync, runAsync, pythonArgs,
  pythonCandidates, syncManagedOfficeCliEnv };

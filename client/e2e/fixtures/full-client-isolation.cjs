'use strict';

// Test-entry-only safeguards. Install before production main.js or worker code.
// This does not change system networking, production modules on disk, or IPC.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const marker = Symbol.for('soduwork.five-account-isolation');

function isLoopback(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host || '').toLowerCase());
}
function isolationError(kind) {
  return Object.assign(new Error('Isolated account QA blocked ' + kind), { code: 'QA_ISOLATION_BLOCKED' });
}
function installNetwork(report = {}) {
  if (globalThis[marker]) return globalThis[marker];
  report.blockedNetwork ||= [];
  const checkHost = host => {
    if (isLoopback(host)) return;
    report.blockedNetwork.push({ transport: 'node', host: String(host || '').slice(0, 160) });
    throw isolationError('non-loopback network');
  };
  const checkUrl = input => {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
    catch (_) { throw isolationError('invalid network URL'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw isolationError('network protocol');
    checkHost(url.hostname);
    return url;
  };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // net.createConnection passes its already-normalized argument array.
    const [value, callback] = net._normalizeArgs(Array.isArray(args[0]) ? args[0] : args);
    if (value.path) throw isolationError('socket path');
    const options = { ...value };
    checkHost(options.host || 'localhost');
    // Do not accept a custom lookup function redirecting localhost elsewhere.
    if (String(options.host || 'localhost').toLowerCase() === 'localhost') options.host = '127.0.0.1';
    delete options.lookup;
    return originalConnect.call(this, options, callback);
  };
  const dns = require('node:dns');
  for (const owner of [dns, dns.promises]) {
    for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname',
      'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
      if (typeof owner[name] !== 'function') continue;
      const original = owner[name];
      owner[name] = function (host, ...args) {
        checkHost(host);
        return original.call(this, String(host).toLowerCase() === 'localhost' ? '127.0.0.1' : host, ...args);
      };
    }
  }
  for (const protocol of ['node:http', 'node:https']) {
    const module = require(protocol);
    for (const name of ['request', 'get']) {
      const original = module[name];
      module[name] = function (input, ...args) {
        if (typeof input === 'string' || input instanceof URL) checkUrl(input);
        for (const options of [input, args[0]]) if (options && typeof options === 'object' && !(options instanceof URL)) {
          if (options.socketPath) throw isolationError('HTTP socket path');
          if (options.hostname || options.host) checkHost(options.hostname || options.host);
          if (options.lookup) throw isolationError('custom HTTP DNS lookup');
        }
        return original.call(this, input, ...args);
      };
    }
  }
  if (globalThis.fetch) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function (input, options = {}) {
      try { checkUrl(input); } catch (error) { return Promise.reject(error); }
      return originalFetch.call(this, input, { ...options, redirect: 'error' });
    };
  }
  // Keep ESM SDK imports on the same guarded built-in functions.
  require('node:module').syncBuiltinESMExports();
  const state = { checkUrl, checkHost };
  globalThis[marker] = state;
  return state;
}

function installProcesses(report = {}, context = {}) {
  const cp = require('node:child_process');
  report.blockedProcesses ||= [];
  const expectedPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase();
  // Exact read-only command used by the production process-tree PID/reuse guard.
  const suffix = ' | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress';
  const shellProbe = "printf 'SODUWORK_SHELL_OK\\n'; " + ['git', 'find', 'grep', 'sed', 'tar']
    .map(name => 'command -v ' + name + ' >/dev/null || exit 31').join('; ');
  const clientRoot = context.client || path.resolve(__dirname, '../..');
  const gitRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
    .map(directory => path.join(directory, 'Git')).concat(path.join(clientRoot, '.runtime/git'));
  function readonlyProbe(file, args, options) {
    if (!context.root || options?.shell || !Array.isArray(args) || typeof file !== 'string') return null;
    let cwd;
    try { cwd = fs.realpathSync(options?.cwd || process.cwd()); } catch (_) { return null; }
    const relative = path.relative(fs.realpathSync(context.root), cwd);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const name = path.basename(file).toLowerCase().replace(/\.exe$/, '');
    if (!['bash', 'git'].includes(name)) return null;
    const key = JSON.stringify(args);
    const commands = name === 'bash' ? [['--version'], ['-c', shellProbe]] : [
      ['--version'], ['version'], ['rev-parse', '--show-toplevel'], ['rev-parse', '--git-dir'],
      ['rev-parse', '--is-inside-work-tree'], ['rev-parse', '--show-prefix'],
      ['status', '--porcelain'], ['status', '--porcelain=v1'], ['status', '--short'],
    ];
    if (!commands.some(command => JSON.stringify(command) === key)) return null;
    for (const directory of gitRoots) {
      for (const subdir of name === 'bash' ? ['bin', 'usr/bin'] : ['cmd', 'bin']) {
        const candidate = path.join(directory, subdir, name + '.exe');
        if (path.isAbsolute(file) && path.resolve(file).toLowerCase() !== candidate.toLowerCase()) continue;
        if (!path.isAbsolute(file) && ![name, name + '.exe'].includes(file.toLowerCase())) continue;
        try { if (fs.realpathSync(candidate).toLowerCase() !== candidate.toLowerCase()) continue; } catch (_) { continue; }
        const env = { ...(options?.env || process.env) };
        for (const variable of Object.keys(env)) if (/^(?:BASH_ENV|ENV|GIT_.*|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(variable)) delete env[variable];
        // A noninteractive Bash probe must not source inherited scripts. Git
        // can inspect only the fresh test cwd and never real user/global config.
        env.PATH = [path.join(directory, 'bin'), path.join(directory, 'usr/bin'), path.join(directory, 'cmd'),
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')].join(path.delimiter);
        env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = path.join(context.root, 'home', '.gitconfig');
        env.GIT_OPTIONAL_LOCKS = '0';
        return { file: candidate, options: { ...options, cwd, env, windowsHide: true, shell: false } };
      }
    }
    return null;
  }
  function allowed(file, args, options) {
    if (options?.shell || process.platform !== 'win32' || typeof file !== 'string' || !Array.isArray(args)) return false;
    if (path.resolve(file).toLowerCase() !== expectedPowerShell) return false;
    if (args.length !== 4 || args[0] !== '-NoProfile' || args[1] !== '-NonInteractive' || args[2] !== '-Command') return false;
    const command = String(args[3]);
    if (!command.endsWith(suffix)) return false;
    return /^Get-CimInstance Win32_Process(?: -Filter "ProcessId=[1-9]\d*")?$/.test(command.slice(0, -suffix.length));
  }
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[name];
    cp[name] = function (file, args, options, ...rest) {
      const executableCall = ['execFile', 'execFileSync', 'spawn', 'spawnSync'].includes(name);
      const probe = executableCall && readonlyProbe(file, args, options);
      if (probe) {
        report.allowedProbes ||= [];
        report.allowedProbes.push({ executable: path.basename(probe.file), args: args.slice() });
        return original.call(this, probe.file, args, probe.options, ...rest);
      }
      if (!executableCall || !allowed(file, args, options)) {
        report.blockedProcesses.push({ operation: name, executable: path.basename(String(file || '')).slice(0, 120) });
        throw isolationError('subprocess execution');
      }
      return original.call(this, file, args, { ...options, windowsHide: true }, ...rest);
    };
  }
  require('node:module').syncBuiltinESMExports();
}

function isolatePaths({ root, workspace }) {
  root = fs.realpathSync(root);
  if (!path.basename(root).startsWith('soduwork-account-five-')) throw isolationError('unexpected test root');
  const within = directory => {
    const relative = path.relative(root, path.resolve(directory));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw isolationError('directory outside test root');
  };
  within(workspace);
  const directories = {
    USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
    TEMP: 'temp', TMP: 'temp', TMPDIR: 'temp',
    CLAUDE_CONFIG_DIR: 'home/.claude', PI_CODING_AGENT_DIR: 'home/.pi/agent',
    XDG_CONFIG_HOME: 'home/.config', XDG_DATA_HOME: 'home/.local/share', XDG_CACHE_HOME: 'home/.cache',
    SODUWORK_DATA_ROOT: 'hub-data',
  };
  for (const [key, value] of Object.entries(directories)) {
    const target = path.join(root, value); fs.mkdirSync(target, { recursive: true }); process.env[key] = target;
  }
  for (const key of Object.keys(process.env)) {
    if (/proxy$|API_KEY$|ACCESS_TOKEN$|AUTH_TOKEN$|^HOME$|^CODEX_HOME$|^NODE_OPTIONS$|^SODUWORK_DESKTOP_CONTROL_ENDPOINT$/i.test(key)) delete process.env[key];
  }
  os.homedir = () => path.join(root, 'home');
  process.chdir(workspace);
  return root;
}

function installWorker(config) {
  isolatePaths(config);
  installNetwork(config.report);
  installProcesses(config.report, config);
}

function install({ app, electron, root, workspace, client, report }) {
  root = isolatePaths({ root, workspace });
  const network = installNetwork(report);
  installProcesses(report, { root, workspace, client });
  // This OS service is unrelated to account/chat/task acceptance.
  require(path.join(client, 'main/computer-use/index.cjs')).install = () => ({ ready: Promise.resolve(), cancel() {} });
  const worker = path.join(client, 'main/agent-runtime/process-worker.js');
  const bootstrap = path.join(root, 'isolated-pi-worker.cjs');
  fs.writeFileSync(bootstrap, "'use strict';\nrequire(" + JSON.stringify(__filename) + ').installWorker(' +
    JSON.stringify({ root, workspace, client }) + ');\nrequire(' + JSON.stringify(worker) + ');\n');
  const originalFork = electron.utilityProcess.fork.bind(electron.utilityProcess);
  electron.utilityProcess.fork = function (entry, args = [], options = {}) {
    if (path.resolve(entry) !== path.resolve(worker) || args.length) throw isolationError('unexpected utility worker');
    const child = originalFork(bootstrap, [], { ...options, cwd: workspace, env: { ...options.env,
      USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP,
      SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
    child.once('spawn', () => {
      report.ownedProcesses ||= [];
      report.ownedProcesses.push({ pid: child.pid, role: 'isolated original Pi worker' });
    });
    return child;
  };
  const guardedSessions = new WeakSet();
  const guardSession = session => {
    if (!session || guardedSessions.has(session)) return;
    guardedSessions.add(session);
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      try { network.checkUrl(details.url); callback({ cancel: false }); }
      catch (_) { callback({ cancel: true }); }
    });
  };
  app.on('session-created', guardSession);
  if (app.isReady()) guardSession(electron.session.defaultSession);
  else app.whenReady().then(() => guardSession(electron.session.defaultSession));
  if (electron.net) {
    for (const name of ['fetch', 'request']) if (typeof electron.net[name] === 'function') {
      const original = electron.net[name].bind(electron.net);
      electron.net[name] = function (input, options) {
        network.checkUrl(typeof input === 'object' && !(input instanceof URL) && !input.url
          ? (input.protocol || 'https:') + '//' + (input.hostname || input.host || '') + '/' : input);
        return original(input, name === 'fetch' ? { ...options, redirect: 'error' } : options);
      };
    }
  }
  return { root, workspace, bootstrap };
}

module.exports = { install, installWorker, installNetwork, isLoopback };

'use strict';

/* Complete-client updater.  Every privileged operation stays in Electron's main
   process: the renderer cannot choose a Hub, artifact URL or executable path. */
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const contract = require('./client-update-contract');
const installLayout = require('./install-layout');

const TEXT = {
  noIdentity: '这台 SoduWork 尚未完成设备登记，不能检查更新',
  timeout: '检查更新超时',
  untrusted: '客户端没有受信任的升级签名公钥',
};

/* Keep low-level errors like "fetch failed" out of the UI: network
   failures are translated into actionable Chinese messages, while the
   raw error is preserved in rawError, console logs and server reports.
   Already-friendly Chinese business errors pass through unchanged. */
function _friendlyUpdateError(error) {
  const raw = String((error && error.message) || error || '');
  if (!raw) return '';
  const cause = (error && error.cause) || {};
  const hay = [cause.code, cause.message, cause.hostname, raw]
    .filter(Boolean).join(' ');
  if (/ENOTFOUND|EAI_AGAIN/.test(hay)) return '网络连接失败：无法找到更新服务器，请检查网络或代理设置';
  if (/ECONNREFUSED/.test(hay)) return '无法连接更新服务器，请稍后重试；若持续失败请联系管理员';
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|socket hang up/i.test(hay)) return '连接更新服务器超时，请检查网络后重试';
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|OTHER_SIDE_CLOSED/i.test(hay)) return '网络连接被中断，请重试；若持续失败请检查代理或防火墙';
  if (/EACCES|EPERM/.test(hay)) return '网络访问被拒绝，请检查防火墙或安全软件设置';
  if (/CERT|SSL|TLS|certificate/i.test(hay)) return '更新服务器证书校验失败，请检查系统时间或网络环境';
  if (/HTTP 5\d\d/.test(hay)) return '更新服务暂时不可用，请稍后重试';
  if (/HTTP 4\d\d/.test(hay)) return '更新服务拒绝了本次请求，请稍后重试或联系管理员';
  if (/fetch failed|network|DNS/i.test(hay)) return '网络连接失败，请检查网络后重试';
  return raw;
}
const REPORT_INTERVAL = 1200;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const DRAIN_POLL_MS = 2000;
const DRAIN_TIMEOUT_MS = 30 * 60 * 1000;

let runtime = null;

function _root(app) { return path.join(app.getPath('userData'), 'client-updates'); }
function _pendingFile(app) { return path.join(_root(app), 'pending.json'); }
function _stateFile(app) { return path.join(_root(app), 'state.json'); }
function _readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
async function _atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const next = file + '.next';
  await fsp.writeFile(next, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  try { await fsp.rename(next, file); }
  catch (error) {
    /* Fall back to copying when managed filesystems report EXDEV for same-directory rename. */
    if (error && error.code === 'EXDEV') {
      await fsp.copyFile(next, file);
      await fsp.rm(next, { force: true });
    } else {
      await fsp.rm(file, { force: true });
      await fsp.rename(next, file);
    }
  }
}
function _publicState() {
  if (!runtime) return { state: 'idle', currentVersion: '' };
  const out = { ...runtime.status };
  // Only expose notes from the manifest already verified by check(). Never
  // expose the download URL, signature or a server's unsigned manual fallback.
  out.releaseNotes = typeof out.manifest?.notes === 'string' ? out.manifest.notes : '';
  delete out.installerPath;
  delete out.manifest;
  return out;
}
function _set(patch) {
  runtime.status = require('./client-update-progress').advance(runtime.status, patch);
  try {
    for (const win of runtime.BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('client-update-status', _publicState());
    }
  } catch (_) { /* status is still queryable */ }
  return _publicState();
}
function _trust() {
  const profile = require('./distribution.cjs').current();
  // Cloud distributions trust only their own signature, never an intranet or another cloud public key.
  if (profile.distributionId !== 'internal' && profile.distributionId !== 'stage') return profile.updateTrust;
  const candidates = [
    path.join(runtime.app.getAppPath(), 'update-trust.json'),
    path.join(__dirname, '..', 'update-trust.json'),
  ];
  for (const file of candidates) {
    const trust = _readJson(file);
    if (trust && trust.schema === 1 && trust.keys && Object.keys(trust.keys).length) return trust;
  }
  throw new Error(TEXT.untrusted);
}
async function _identity() {
  const value = await runtime.identityOf(runtime.app);
  if (!value || !value.hub || !value.clientId || !value.session) throw new Error(TEXT.noIdentity);
  return value;
}
async function _request(relative, options = {}, timeoutMs = 15000, consume = null) {
  const id = await _identity();
  if (!/^\/api\/v1\//.test(relative)) throw new Error('升级接口地址无效');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { ...(options.headers || {}), Authorization: 'Device ' + id.session };
    const res = await fetch(id.hub + relative, { ...options, headers, signal: ctl.signal });
    return consume ? await consume(res, id) : { res, id };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(TEXT.timeout);
    throw error;
  } finally { clearTimeout(timer); }
}
async function _json(relative, options = {}, timeoutMs = 15000) {
  // Keep the request deadline alive through the body, not just the headers.
  return _request(relative, options, timeoutMs, async (res, id) => {
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!res.ok) throw new Error(String(data.detail || ('HTTP ' + res.status)));
    return { data, id };
  });
}
async function _reportNow(state, progress = 0, extra = {}) {
  const attemptId = runtime.status.attemptId;
  if (!attemptId) return null;
  const body = {
    state, progress,
    currentVersion: runtime.app.getVersion(),
    error: String(extra.error || '').slice(0, 600),
    detail: extra.detail && typeof extra.detail === 'object' ? extra.detail : {},
  };
  try {
    const { data } = await _json('/api/v1/client-updates/attempts/' +
      encodeURIComponent(attemptId) + '/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 3000);
    _set({ reportPending: false, reportError: '' });
    return data;
  } catch (error) {
    _set({ reportPending: true, reportError: String(error.message || error) });
    return null;
  }
}
function _report(state, progress = 0, extra = {}) {
  return runtime.reportQueue(state, progress, extra);
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _setLocalDrain(value) {
  try { runtime.setLocalDrain(Boolean(value)); }
  catch (error) {
    if (value) throw new Error('无法锁定本机工作入口，已取消升级：' +
      String(error.message || error));
  }
}

function _localWorkloads() {
  try {
    const value = runtime.localWorkloads();
    return value && typeof value === 'object' ? value : { safe: true, blockers: [] };
  } catch (error) {
    return {
      safe: false,
      blockers: [{ kind: 'local-check', title: '无法确认本机工作状态',
        state: 'unknown', reason: String(error.message || error) }],
    };
  }
}

async function _prepareRemote(localBlockers = []) {
  const attemptId = runtime.status.attemptId;
  if (!attemptId) throw new Error('升级任务缺少安全检查标识');
  return (await _json('/api/v1/client-updates/attempts/' +
    encodeURIComponent(attemptId) + '/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blockers: Array.isArray(localBlockers)
        ? localBlockers.slice(0, 12) : [] }),
    })).data;
}

function _notice(title, message, detail) {
  const parent = runtime.getWindow && runtime.getWindow();
  const options = { type: 'info', title, message, detail,
    buttons: ['知道了'], defaultId: 0, noLink: true };
  const shown = parent && !parent.isDestroyed()
    ? runtime.dialog.showMessageBox(parent, require("./native-locale.cjs").dialogOptions(options))
    : runtime.dialog.showMessageBox(require("./native-locale.cjs").dialogOptions(options));
  Promise.resolve(shown).catch(() => null);
}

async function _waitForSafeInstall() {
  _setLocalDrain(true);
  _set({ phase: 'waiting', phaseProgress: null });
  runtime.waitNoticeShown = false;
  const started = Date.now();
  const timeoutMs = Number(runtime.drainTimeoutMs || DRAIN_TIMEOUT_MS);
  while (true) {
    const local = _localWorkloads();
    const remote = await _prepareRemote(local.blockers);
    if (runtime.cancelWait) {
      await _report('deferred', 100, { detail: { reason: 'user-cancelled-wait' } });
      _setLocalDrain(false);
      _set({ state: 'deferred', waitingSince: '', actionMessage: '', error: '已取消本次安装等待。处理任务后可再次安装。' });
      return false;
    }
    const blockers = [
      ...(Array.isArray(local.blockers) ? local.blockers : []),
      ...(Array.isArray(remote.blockers) ? remote.blockers : []),
    ].slice(0, 30);
    if (local.safe !== false && remote.safe === true) {
      _set({ state: 'downloaded', phase: 'verifying', phaseProgress: 0, blockers: [], waitingSince: '', actionMessage: '' });
      return true;
    }
    _set({
      state: 'waiting',
      progress: 100,
      blockers,
      waitingSince: runtime.status.waitingSince || new Date().toISOString(),
      error: '',
    });
    const work = blockers.filter(item => item && item.kind !== 'drain-barrier');
    if (work.length && !runtime.waitNoticeShown) {
      runtime.waitNoticeShown = true;
      const first = work[0];
      _notice('SoduWork 正在安全等待升级',
        `还有 ${work.length} 项工作没有结束`,
        (first && first.title ? `例如：${first.title}\n\n` : '') +
        'SoduWork 已停止接收新的本机工作；结束后自动安装。\n请到「我的 → 客户端更新」查看全部阻塞项，可停止不再需要的工作，或取消等待后处理任务。');
    }
    if (Date.now() - started >= timeoutMs) {
      const detail = { reason: 'workloads-still-running', blockers };
      await _report('deferred', 100, { detail });
      _setLocalDrain(false);
      _set({
        state: 'deferred', blockers, waitingSince: '',
        error: '仍有工作正在执行，本次升级已安全延后，没有中断任何任务。',
      });
      _notice('SoduWork 已安全延后升级', '当前任务继续运行，没有被中断',
        '任务结束后，可从“我的”中再次检查更新。');
      return false;
    }
    const retry = Math.max(500, Number(remote.retryAfterMs || runtime.drainPollMs || DRAIN_POLL_MS));
    await runtime.wait(retry);
  }
}
async function _download(manifest, attemptId) {
  const root = _root(runtime.app);
  await fsp.mkdir(root, { recursive: true });
  const target = contract.safeInstallerPath(root, manifest.artifact.name);
  const partial = target + '.part';
  const expected = Number(manifest.artifact.size);
  const hash = crypto.createHash('sha256');
  let received = 0, lastReport = 0, lastProgress = -1;
  try {
    const stat = await fsp.stat(partial);
    if (stat.size > 0 && stat.size < expected) received = stat.size;
    else await fsp.rm(partial, { force: true });
  } catch (_) { /* no partial download */ }
  if (received) {
    await pipeline(fs.createReadStream(partial), new Transform({
      transform(chunk, _encoding, callback) { hash.update(chunk); callback(); },
    }));
  }
  _set({ state: 'downloading', progress: Math.floor(received * 100 / expected),
    phase: 'downloading', receivedBytes: received, totalBytes: expected,
    attemptId, targetVersion: manifest.version });
  await _report('downloading', Math.floor(received * 100 / expected));
  const res = await require('./client-update-download.cjs').requestArtifact(
    _request, runtime.wait, manifest.artifact.url, received);
  if (received && res.status !== 206) {
    try { await res.body.cancel(); } catch (_) { /* restart from zero */ }
    await fsp.rm(partial, { force: true });
    received = 0;
    return _download(manifest, attemptId);
  }
  if (!res.ok || !res.body) throw new Error('安装包下载失败 HTTP ' + res.status);
  let stallTimer = null, totalTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => meter.destroy(new Error('安装包下载超时')), 30000);
  };
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      armStall();
      received += chunk.length;
      if (received > expected) return callback(new Error('安装包大小超出签名清单'));
      hash.update(chunk);
      const progress = Math.min(99, Math.floor(received * 100 / expected));
      _set({ state: 'downloading', progress, receivedBytes: received, totalBytes: expected });
      const now = Date.now();
      if (progress !== lastProgress && now - lastReport >= REPORT_INTERVAL) {
        lastProgress = progress; lastReport = now;
        void _report('downloading', progress);
      }
      callback(null, chunk);
    },
  });
  try {
    armStall();
    totalTimer = setTimeout(
      () => meter.destroy(new Error('安装包下载超过 20 分钟')), DOWNLOAD_TIMEOUT_MS,
    );
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(partial,
      { mode: 0o600, flags: received ? 'a' : 'w' }));
    _set({ phase: 'verifying', phaseProgress: null });
    if (received !== expected) throw new Error('安装包不完整');
    if (hash.digest('hex') !== manifest.artifact.sha256) throw new Error('安装包摘要校验失败');
    await fsp.rm(target, { force: true });
    await fsp.rename(partial, target);
  } catch (error) {
    /* Retain validated partial downloads after network interruption for Range resume; remove them when the completed digest mismatches. */
    if (/摘要|大小超出/.test(String(error.message || error))) await fsp.rm(partial, { force: true });
    throw error;
  } finally { clearTimeout(stallTimer); clearTimeout(totalTimer); }
  _set({ state: 'downloaded', phase: 'ready', phaseProgress: 100, progress: 100, installerPath: target, manifest });
  await _report('downloaded', 100, { detail: { sha256: manifest.artifact.sha256 } });
  return target;
}
async function _promptInstall(interactive) {
  if (runtime.installPromise) return runtime.installPromise;
  if (runtime.status.state === 'installing') return _publicState();
  const { manifest } = runtime.status;
  if (!manifest || !runtime.status.installerPath) return _publicState();
  const saved = _readJson(_stateFile(runtime.app), {});
  const activelyDeferred = saved.targetVersion === manifest.version &&
    Number(saved.deferredUntil || 0) > Date.now() && !manifest.mandatory;
  if (!interactive && activelyDeferred) {
    _set({ state: 'deferred', deferredUntil: saved.deferredUntil });
    if (runtime.status.attemptId) await _report('deferred', 100, {
      detail: { deferredUntil: saved.deferredUntil, preserved: true },
    });
    return _publicState();
  }



  if (!interactive && !manifest.mandatory) {
    await _report('downloaded', 100, { detail: { silent: true } });
    return _publicState();
  }
  const parent = runtime.getWindow && runtime.getWindow();
  const currentVersion = String(runtime.app.getVersion() || '').trim();
  const options = {
    type: 'info', title: 'SoduWork 已准备好更新',
    message: `SoduWork ${currentVersion} → ${manifest.version}`,
    detail: '新版本已下载并通过安全校验，但尚未安装。\n' +
      String(manifest.notes || '安装后将自动重新启动。'),
    buttons: ['重启并安装', '稍后提醒'], defaultId: 0, cancelId: 1, noLink: true,
  };
  const answer = parent && !parent.isDestroyed()
    ? await runtime.dialog.showMessageBox(parent, require("./native-locale.cjs").dialogOptions(options))
    : await runtime.dialog.showMessageBox(require("./native-locale.cjs").dialogOptions(options));
  // Another window may have requested installation while the dialog was open.
  if (runtime.installPromise) return runtime.installPromise;
  if (runtime.status.state === 'installing') return _publicState();
  if (answer.response === 0) return installDownloaded();
  const deferredUntil = Date.now() + 24 * 60 * 60 * 1000;
  await _atomicJson(_stateFile(runtime.app), { deferredUntil, targetVersion: manifest.version });
  _set({ state: 'deferred', deferredUntil });
  await _report('deferred', 100, { detail: { deferredUntil } });
  return _publicState();
}
async function check(options = {}) {
  if (runtime.busy || runtime.installPromise || runtime.status.state === 'installing') return _publicState();
  if (!runtime.app.isPackaged && !options.testMode) {
    return _set({ state: 'development', error: '', progress: 0 });
  }
  runtime.busy = true;
  let prepared;
  runtime.preparation = new Promise(resolve => { prepared = resolve; });
  const interactive = !!options.interactive;
  try {
    /*
     * Replay persisted installation receipts on later checks when initial startup lacked
     * network or device authentication, eventually clearing pending state.
     */
    if (_readJson(_pendingFile(runtime.app))) await confirmPending();
    _set({ state: 'checking', interactive, error: '', progress: 0, attemptId: '',
      targetVersion: '', manifest: null, installerPath: '', blockers: [], waitingSince: '' });
    const current = runtime.app.getVersion();
    const query = await require('./update-target.cjs').query(current, { exec: runtime.linuxExec });
    const { data } = await _json('/api/v1/client-updates/check?' + query.toString());
    if (!data.hasUpdate) return _set({ state: 'current', currentVersion: current, progress: 100 });
    if (data.manualInstallRequired) {
      // Old clients may not know a rotated signing key. This branch only
      // explains the manual upgrade; it must never download or execute a file.
      const targetVersion = data.manifest && data.manifest.version;
      if (!contract.parseVersion(targetVersion)) throw new Error('升级版本无效');
      if (!contract.newer(targetVersion, current)) {
        return _set({ state: 'current', currentVersion: current, progress: 100 });
      }
      return _set({ state: 'manual', currentVersion: current, targetVersion,
        attemptId: data.attemptId,
        error: '当前版本过旧，需要手动安装一次新版客户端' });
    }
    const manifest = contract.validateManifest(data.manifest, _trust());
    require('./update-target.cjs').validateFormat(manifest, query);
    // A stale response is not an update and must not surface as an update error.
    if (!contract.newer(manifest.version, current)) {
      return _set({ state: 'current', currentVersion: current, progress: 100 });
    }
    _set({ attemptId: data.attemptId,
      targetVersion: data.manifest && data.manifest.version || '' });
    _set({ state: 'available', currentVersion: current, targetVersion: manifest.version,
      attemptId: data.attemptId, manifest, progress: 0, totalBytes: manifest.artifact.size });
    const target = contract.safeInstallerPath(_root(runtime.app), manifest.artifact.name);
    let validExisting = false;
    try {
      const stat = await fsp.stat(target);
      if (stat.size === manifest.artifact.size) {
        await _verifyInstaller(target, manifest, _verificationProgress);
        validExisting = true;
      }
    } catch (_) { validExisting = false; }
    const saved = _readJson(_stateFile(runtime.app), {});
    const activelyDeferred = !interactive && !manifest.mandatory &&
      saved.targetVersion === manifest.version &&
      Number(saved.deferredUntil || 0) > Date.now();
    if (activelyDeferred && validExisting) {
      _set({ state: 'deferred', progress: 100, installerPath: target, manifest,
        deferredUntil: saved.deferredUntil });
    } else if (!validExisting) await _download(manifest, data.attemptId);
    else {
      _set({ state: 'downloaded', progress: 100, installerPath: target, manifest });
      await _report('downloading', 99);
      await _report('downloaded', 100, { detail: { reused: true } });
    }
    // Release preparation before prompting: the prompt may await installation.
    // An install click during a background recheck shares this preparation.
    prepared(); runtime.preparation = null;
    return await _promptInstall(interactive);
  } catch (error) {
    const message = String(error.message || error);
    const friendly = _friendlyUpdateError(error);
    _set({ state: 'failed', error: friendly, rawError: message });
    await _report('failed', runtime.status.progress || 0,
      { error: message, detail: { displayError: friendly } });
    if (interactive) {
      const parent = runtime.getWindow && runtime.getWindow();
      const options = { type: 'error', title: 'SoduWork 更新失败', message: friendly,
        detail: '技术详情：' + message, buttons: ['知道了'] };
      if (parent && !parent.isDestroyed()) await runtime.dialog.showMessageBox(parent, require("./native-locale.cjs").dialogOptions(options));
      else await runtime.dialog.showMessageBox(require("./native-locale.cjs").dialogOptions(options));
    }
    return _publicState();
  } finally { prepared(); runtime.preparation = null; runtime.busy = false; }
}
/* Keep the post-quit installer outside cmd.exe.  A detached batch file used to
   poll tasklist/find; on some Windows builds that console becomes visible after
   Electron exits and the loop can keep respawning it.  Windows Script Host is a
   GUI subsystem process, so it has no console to flash or strand.  The bounded
   WMI poll also guarantees the helper cannot wait forever. */
function _updateHelperScript() {
  return [
    'Option Explicit',
    'Dim shell, env, fso, service, rows, row, oldPid, installer, appPath, installDir',
    'Dim attempts, appAlive, ownedAlive, exePath, appFile, exitCode, ready',
    'Set shell = CreateObject("WScript.Shell")',
    'Set env = shell.Environment("PROCESS")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'oldPid = CLng(env("SODUWORK_OLD_PID"))',
    'installer = env("SODUWORK_INSTALLER")',
    'appPath = env("SODUWORK_APP")',
    'appFile = fso.GetFileName(appPath)',
    'installDir = env("SODUWORK_INSTALL_DIR")',
    'If Right(installDir, 1) <> "\" Then installDir = installDir & "\"',
    'appAlive = True',
    'On Error Resume Next',
    'Set service = GetObject("winmgmts:\\\\.\\root\\cimv2")',
    'If Err.Number <> 0 Then',
    '  Err.Clear',
    '  appAlive = False',
    'End If',
    'On Error GoTo 0',
    'If Not appAlive Then',
    '  DeleteSelf fso',
    '  WScript.Quit 4',
    'End If',
    'Set ready = fso.CreateTextFile(env("SODUWORK_HELPER_READY") & ".tmp", True)',
    'ready.Write "ready"',
    'ready.Close',
    'fso.MoveFile env("SODUWORK_HELPER_READY") & ".tmp", env("SODUWORK_HELPER_READY")',
    'If appAlive Then',
    '  For attempts = 1 To 240',
    '    On Error Resume Next',
    '    Set rows = service.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId = " & CStr(oldPid))',
    '    If Err.Number <> 0 Then',
    '      Err.Clear',
    '      appAlive = False',
    '      On Error GoTo 0',
    '      Exit For',
    '    End If',
    '    On Error GoTo 0',
    '    If rows.Count = 0 Then',
    '      appAlive = False',
    '      Exit For',
    '    End If',
    '    WScript.Sleep 500',
    '  Next',
    'End If',
    'If appAlive Then',
    '  DeleteSelf fso',
    '  WScript.Quit 2',
    'End If',
    'ownedAlive = True',
    'For attempts = 1 To 80',
    '  ownedAlive = False',
    '  On Error Resume Next',
    '  Set rows = service.ExecQuery("SELECT ProcessId, ExecutablePath FROM Win32_Process")',
    '  If Err.Number <> 0 Then',
    '    Err.Clear',
    '    ownedAlive = True',
    '    On Error GoTo 0',
    '    Exit For',
    '  End If',
    '  On Error GoTo 0',
    '  For Each row In rows',
    '    exePath = ""',
    '    On Error Resume Next',
    '    exePath = CStr(row.ExecutablePath)',
    '    Err.Clear',
    '    On Error GoTo 0',
    '    If IsOwnedExecutable(exePath, installDir, appFile) Then',
    '      ownedAlive = True',
    '      If attempts > 8 Then',
    '        On Error Resume Next',
    '        row.Terminate',
    '        Err.Clear',
    '        On Error GoTo 0',
    '      End If',
    '    End If',
    '  Next',
    '  If Not ownedAlive Then Exit For',
    '  WScript.Sleep 250',
    'Next',
    'If ownedAlive Then',
    '  shell.Run QuoteArg(appPath) & " --update-failed", 1, False',
    '  DeleteSelf fso',
    '  WScript.Quit 3',
    'End If',
    'Dim modeArg',
    'modeArg = ""',
    'If env("SODUWORK_INSTALL_MODE") = "all" Then modeArg = " /allusers"',
    'If env("SODUWORK_INSTALL_MODE") = "CurrentUser" Then modeArg = " /currentuser"',
    'exitCode = shell.Run(QuoteArg(installer) & " /S --updated" & modeArg & " /D=" & env("SODUWORK_INSTALL_DIR"), 0, True)',
    'If exitCode = 0 Then',
    '  shell.Run QuoteArg(appPath) & " --updated", 1, False',
    'Else',
    '  shell.Run QuoteArg(appPath) & " --update-failed", 1, False',
    'End If',
    'DeleteSelf fso',
    'WScript.Quit exitCode',
    'Function QuoteArg(value)',
    '  QuoteArg = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)',
    'End Function',
    'Function IsOwnedExecutable(value, root, appName)',
    '  Dim fileName',
    '  IsOwnedExecutable = False',
    '  If Len(root) = 0 Or Len(value) < Len(root) Then Exit Function',
    '  If LCase(Left(value, Len(root))) <> LCase(root) Then Exit Function',
    '  fileName = LCase(fso.GetFileName(value))',
    '  IsOwnedExecutable = (fileName = LCase(appName) Or fileName = "soduwork-runner.exe" Or fileName = "soduwork-runner.exe" Or fileName = "soduwork-runner.exe" Or fileName = "openconsole.exe" Or fileName = "winpty-agent.exe")',
    'End Function',
    'Sub DeleteSelf(fileSystem)',
    '  On Error Resume Next',
    '  fileSystem.DeleteFile WScript.ScriptFullName, True',
    '  On Error GoTo 0',
    'End Sub',
  ].join('\r\n');
}

async function _launchUpdateHelper(helper, env) {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidate = path.join(root, 'System32', 'wscript.exe');
  const host = fs.existsSync(candidate) ? candidate : 'wscript.exe';
  const child = spawn(host, ['//B', '//Nologo', helper], {
    detached: true, windowsHide: true, stdio: 'ignore', env,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  // A spawned wscript.exe does not prove the script is allowed to run.
  // Keep SoduWork open until the helper has initialized and acknowledged ownership.
  const deadline = Date.now() + 10000;
  while (await fsp.readFile(env.SODUWORK_HELPER_READY, 'utf8').catch(() => '') !== 'ready') {
    if (child.exitCode !== null || Date.now() >= deadline) {
      child.unref();
      throw new Error('更新助手未能就绪，SoduWork 没有退出；请重试或使用安装包更新');
    }
    await _sleep(50);
  }
  // Readiness is already confirmed. Antivirus may briefly hold this disposable receipt.
  await fsp.rm(env.SODUWORK_HELPER_READY, { force: true }).catch(() => {});
  child.unref();
}
async function installDownloaded() {
  if (runtime.status.state === 'installing') return runtime.installPromise || _publicState();
  if (!runtime.installPromise) {
    runtime.cancelWait = false;
    const preparation = runtime.preparation;
    runtime.installPromise = (async () => {
      if (preparation) {
        await preparation;
        if (!['downloaded', 'deferred'].includes(runtime.status.state)) return _publicState();
      }
      return _installDownloaded();
    })().catch(async (error) => {
      _setLocalDrain(false);
      if (!['failed', 'deferred'].includes(runtime.status.state)) {
        const message = String(error.message || error);
        const friendly = _friendlyUpdateError(error);
        _set({ state: 'failed', error: friendly, rawError: message,
          blockers: [], waitingSince: '' });
        await _report('failed', runtime.status.progress || 0,
          { error: message, detail: { displayError: friendly } });
      }
      throw error;
    }).finally(() => { runtime.installPromise = null; });
  }
  return runtime.installPromise;
}

async function resolveBlocker(raw) {
  if (runtime.status.state !== 'waiting') return _publicState();
  if (raw && raw.action === 'cancel-wait') {
    runtime.cancelWait = true;
    return _set({ actionMessage: '正在取消安装等待…' });
  }
  const item = (runtime.status.blockers || []).find(row =>
    row.kind === raw?.kind && String(row.ref || row.id || '') === String(raw?.id || ''));
  if (!item) throw Error('这项工作状态已变化，请刷新后重试');
  const local = item.kind === 'conversation' && item.ref;
  if (!local) throw Error('请打开任务详情处理；若仍无法停止，请联系管理员检查执行机');
  if (runtime.resolving) return _publicState();
  runtime.resolving = true;
  try {
    const options = { type: 'warning', title: '停止工作以继续升级',
      message: '停止「' + String(item.title || '当前工作') + '」？',
      detail: '将停止当前执行并取消该会话的排队内容。已有记录和文件保留；确认执行结束后才会安装更新。',
      buttons: ['返回', '停止工作'], defaultId: 0, cancelId: 0, noLink: true };
    const parent = runtime.getWindow && runtime.getWindow();
    const answer = parent && !parent.isDestroyed()
      ? await runtime.dialog.showMessageBox(parent, require("./native-locale.cjs").dialogOptions(options)) : await runtime.dialog.showMessageBox(require("./native-locale.cjs").dialogOptions(options));
    if (answer.response !== 1 || runtime.status.state !== 'waiting' || runtime.cancelWait) return _publicState();
    await runtime.stopLocalWorkload(item.ref);
    return _set({ actionMessage: '已请求停止，正在等待执行结束；更新会自动继续。' });
  } catch (error) {
    return _set({ actionMessage: '停止未完成：' + String(error.message || error) + '。可取消等待后打开任务处理。' });
  } finally { runtime.resolving = false; }
}

function _verificationProgress(verifiedBytes, totalBytes) {
  const phaseProgress = Math.floor(verifiedBytes * 100 / totalBytes);
  if (runtime.status.phase === 'verifying' && runtime.status.phaseProgress === phaseProgress &&
      runtime.status.totalBytes === totalBytes) return;
  _set({ phase: 'verifying', verifiedBytes, totalBytes, phaseProgress });
}

async function _verifyInstaller(installer, manifest, onProgress = () => {}) {
  const stat = await fsp.stat(installer);
  if (!stat.isFile() || stat.size !== manifest.artifact.size) throw new Error('升级包不完整，请重新检查更新');
  const hash = crypto.createHash('sha256');
  let verifiedBytes = 0;
  onProgress(0, stat.size);
  for await (const chunk of fs.createReadStream(installer)) {
    hash.update(chunk); verifiedBytes += chunk.length; onProgress(verifiedBytes, stat.size);
  }
  if (hash.digest('hex') !== manifest.artifact.sha256) throw new Error('升级包校验失败，请重新检查更新');
}

/*
 * Manual installers require system-level actions. Open the validated package for
 * installation and confirm its receipt after the new version starts.
 */
async function _installManual(installer, manifest) {
  const pending = {
    schema: 1, attemptId: runtime.status.attemptId, targetVersion: manifest.version,
    createdAt: new Date().toISOString(), installer: path.basename(installer),
  };
  await _atomicJson(_pendingFile(runtime.app), pending);
  const shell = runtime.shell || require('electron').shell;
  const opened = await shell.openPath(installer);
  if (opened) {
    await fsp.rm(_pendingFile(runtime.app), { force: true });
    const message = '无法打开安装包：' + String(opened);
    _set({ state: 'failed', error: message, blockers: [], waitingSince: '' });
    await _report('failed', 100, { error: message });
    throw new Error(message);
  }
  _set({ state: 'deferred', progress: 100,
    actionMessage: '安装包已打开，请按系统提示完成安装，装好后重新启动 SoduWork。' });
  await _report('deferred', 100, { detail: { manualInstall: true } });
  _notice('请完成安装', `SoduWork ${runtime.app.getVersion()} → ${manifest.version} 安装包已打开`,
    '请按系统提示完成安装；装好后重新启动 SoduWork 即完成升级。');
  return _publicState();
}

/*
 * Linux managed installation shares the update state machine with Windows but uses pkexec
 * and package managers. Return manual when artifact and installed-package identity do not
 * match.
 */
function _linuxContext() {
  return {
    attemptId: runtime.status.attemptId,
    set: _set,
    report: _report,
    publicState: _publicState,
    writePending: (pending) => pending
      ? _atomicJson(_pendingFile(runtime.app), pending)
      : fsp.rm(_pendingFile(runtime.app), { force: true }),
    installManual: _installManual,
    binary: installLayout.launchPath(),
    relaunch: (options) => runtime.app.relaunch(options),
    beforeExit: runtime.beforeExit,
    quit: () => runtime.app.quit(),
    forceExit: () => runtime.app.exit(0),
    schedule: runtime.schedule,
    exec: runtime.linuxExec,
  };
}

async function _installDownloaded() {
  const installer = runtime.status.installerPath;
  const manifest = runtime.status.manifest;
  if (!installer || !manifest || !fs.existsSync(installer)) throw new Error('没有可安装的升级包');
  contract.safeInstallerPath(_root(runtime.app), path.basename(installer));
  if (runtime.status.state === 'deferred') {
    await _report('downloading', 100, { detail: { reused: true } });
    await _report('downloaded', 100, { detail: { reused: true } });
  }
  _set({ actionMessage: '' });
  if (!await _waitForSafeInstall()) return _publicState();
  contract.validateManifest(manifest, _trust());
  await _verifyInstaller(installer, manifest, _verificationProgress);
  if (process.platform === 'linux') {
    /* Use managed installation for registered deb or rpm packages; otherwise fall back to manual installation. */
    const linux = runtime.linuxInstall || require('./update-linux-install.cjs');
    const planInfo = await linux.plan(manifest.artifact.name, { exec: runtime.linuxExec });
    if (planInfo.kind === 'managed') {
      return linux.installManaged(_linuxContext(), planInfo, installer, manifest);
    }
    return _installManual(installer, manifest);
  }
  if (process.platform !== 'win32') {
    /*
     * Manual installation bypasses installing because the state machine does not permit
     * installing-to-deferred transitions.
     */
    return _installManual(installer, manifest);
  }
  const pending = {
    schema: 1, attemptId: runtime.status.attemptId, targetVersion: manifest.version,
    createdAt: new Date().toISOString(), installer: path.basename(installer),
  };
  await _atomicJson(_pendingFile(runtime.app), pending);
  _set({ state: 'installing', phase: 'preparing', phaseProgress: null, progress: 100 });
  await _report('installing', 100);
  const helper = path.join(_root(runtime.app), 'install-update.vbs');
  await fsp.writeFile(helper, _updateHelperScript(), { encoding: 'ascii', mode: 0o600 });
  const env = { ...process.env, SODUWORK_OLD_PID: String(process.pid),
    SODUWORK_HELPER_READY: path.join(_root(runtime.app), crypto.randomUUID() + '.ready'),
    SODUWORK_INSTALLER: installer, SODUWORK_APP: installLayout.launchPath(),
    SODUWORK_INSTALL_DIR: installLayout.installRoot(), SODUWORK_INSTALL_MODE: installLayout.installMode(),
    /* Native updater UI follows the client locale (native-locale normalizes). */
    SODUWORK_UPDATE_LANG: require('./native-locale.cjs').getLocale() };
  try {
    await runtime.launchHelper(helper, env);
  } catch (error) {
    await fsp.rm(helper, { force: true });
    const message = '\u65e0\u6cd5\u542f\u52a8\u9759\u9ed8\u5347\u7ea7\u7a0b\u5e8f\uff1a' +
      String(error && error.message || error);
    _set({ state: 'failed', error: message });
    await _report('failed', 100, { error: message });
    throw new Error(message);
  }
  _set({ phase: 'restarting', phaseProgress: null });
  runtime.schedule(() => {
    try { runtime.beforeExit('update-install'); } catch (_) { /* diagnostics are best effort */ }
    runtime.app.quit();
  }, 100);
  /* A renderer beforeunload handler must not strand the update helper. */
  runtime.schedule(() => {
    try { runtime.beforeExit('update-force-exit'); } catch (_) { /* diagnostics are best effort */ }
    runtime.app.exit(0);
  }, 5000);
  return _publicState();
}
async function confirmPending() {
  const pending = _readJson(_pendingFile(runtime.app));
  if (!pending || !pending.attemptId || !contract.parseVersion(pending.targetVersion)) return;
  runtime.status.attemptId = pending.attemptId;
  runtime.status.targetVersion = pending.targetVersion;
  const current = runtime.app.getVersion();
  if (contract.newer(pending.targetVersion, current)) {
    const message = `安装未完成，当前仍是 ${current}`;
    _set({ state: 'failed', currentVersion: current, error: message });
    await _report('failed', 100, { error: message, detail: { launchConfirmed: true } });
    return;
  }
  _set({ state: 'installed', currentVersion: current, progress: 100 });
  const sent = await _report('installed', 100, { detail: { launchConfirmed: true } });
  if (sent) {
    await fsp.rm(_pendingFile(runtime.app), { force: true });
    await fsp.rm(_stateFile(runtime.app), { force: true });
  }
}
function install({
  app, ipcMain, dialog, BrowserWindow, identityOf, getWindow,
  shell = null, releaseNotesOf = null,
  localWorkloads = () => ({ safe: true, blockers: [] }),
  setLocalDrain = () => {},
  stopLocalWorkload = async () => { throw Error('当前版本无法直接停止会话'); },
  beforeExit = () => {},
  wait = _sleep,
  launchHelper = _launchUpdateHelper,
  schedule = setTimeout,
  drainPollMs = DRAIN_POLL_MS,
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
  linuxInstall = null,
  linuxExec = null,
}) {
  runtime = {
    app, dialog, BrowserWindow, identityOf, getWindow, shell, releaseNotesOf,
    localWorkloads, setLocalDrain, stopLocalWorkload, beforeExit, wait, launchHelper, schedule, drainPollMs, drainTimeoutMs,
    linuxInstall, linuxExec,
    busy: false,
    installPromise: null,
    waitNoticeShown: false,
    reportQueue: require('./update-report-queue').createReportQueue(_reportNow),
    status: { state: 'idle', phase: 'idle', phaseProgress: null, receivedBytes: 0, totalBytes: 0,
      currentVersion: app.getVersion(), progress: 0,
      error: '', rawError: '', blockers: [], waitingSince: '' },
  };
  ipcMain.handle('client-update-status', () => _publicState());
  ipcMain.handle('client-update-check', (_event, options) => check(options || {}));
  ipcMain.handle('client-update-install', () => installDownloaded());
  ipcMain.handle('client-update-resolve', (_event, action) => resolveBlocker(action));
  app.whenReady().then(() => {
    require('./update-maintenance').schedule(app, () => !runtime.installPromise && _localWorkloads().safe !== false);
    return confirmPending().catch((error) => {
      const message = String(error.message || error);
      _set({ state: 'failed', error: _friendlyUpdateError(error), rawError: message });
    });
  });
}

module.exports = {
  check, confirmPending, install, installDownloaded, resolveBlocker,
  _updateHelperScript, _launchUpdateHelper, _verifyInstaller, _friendlyUpdateError,
};

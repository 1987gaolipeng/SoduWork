'use strict';
// Electron Node mode still patches fs for ASAR; validate archive bytes, not its virtual directory.
process.noAsar = true;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { gunzipSync } = require('node:zlib');
const NOTICE_BUNDLE = '.soduwork-notices.bin';
const NOTICE_LIMIT = 64 * 1024 * 1024;
// Only redistribution documents, at any depth. Unknown notice-like names fail
// during packaging so new dependencies cannot silently fall outside this policy.
function noticeCandidate(relative) {
  const name = relative.replaceAll('\\', '/').split('/').pop();
  return /^(?:licen[cs]es?|copying\d*|notice|copyright(?:notice)?|authors)(?:[._-]|$)/i.test(name) ||
    /\/share\/licenses\//i.test('/' + relative.replaceAll('\\', '/'));
}
function isNoticePath(relative) {
  const name = relative.replaceAll('\\', '/').split('/').pop().toLowerCase();
  if (/\/share\/licenses\//i.test('/' + relative.replaceAll('\\', '/')) &&
      /^(?:readme(?:\.(?:txt|md))?|runtime\.library\.exception)$/.test(name)) return true;
  return /^(?:licen[cs]es?|copying\d*|notice|copyright(?:notice)?|authors)(?:[._-](?:txt|md|rst|html?|electron|chromium|mit|apache|bsd|lib|runtime|lesserv2|0bsd|gplv?[23]|lgplv?2\.1|bundling|gpl|oxygen|putty))*$/.test(name);
}
// Known non-executable vendor text resources in the supported Windows payload.
// Exact paths are reviewed; executable code, JSON configuration and arbitrary
// future text files never inherit this installation compatibility policy.
const STATIC_TEXT_BUNDLE = '.soduwork-static-text.bin';
const STATIC_TEXT_PATHS = new Set([
  "resources/runner/_internal/redis-5.3.1.dist-info/top_level.txt",
  "resources/runner/_internal/skills/img2threejs/forge/requirements.txt",
  "resources/runner/_internal/websockets-16.1.1.dist-info/entry_points.txt",
  "resources/runner/_internal/websockets-16.1.1.dist-info/top_level.txt",
  "resources/shell/etc/package-versions.txt",
  "resources/shell/mingw64/share/antiword/8859-1.txt",
  "resources/shell/mingw64/share/antiword/8859-10.txt",
  "resources/shell/mingw64/share/antiword/8859-11.txt",
  "resources/shell/mingw64/share/antiword/8859-13.txt",
  "resources/shell/mingw64/share/antiword/8859-14.txt",
  "resources/shell/mingw64/share/antiword/8859-15.txt",
  "resources/shell/mingw64/share/antiword/8859-16.txt",
  "resources/shell/mingw64/share/antiword/8859-2.txt",
  "resources/shell/mingw64/share/antiword/8859-3.txt",
  "resources/shell/mingw64/share/antiword/8859-4.txt",
  "resources/shell/mingw64/share/antiword/8859-5.txt",
  "resources/shell/mingw64/share/antiword/8859-6.txt",
  "resources/shell/mingw64/share/antiword/8859-7.txt",
  "resources/shell/mingw64/share/antiword/8859-8.txt",
  "resources/shell/mingw64/share/antiword/8859-9.txt",
  "resources/shell/mingw64/share/antiword/cp1250.txt",
  "resources/shell/mingw64/share/antiword/cp1251.txt",
  "resources/shell/mingw64/share/antiword/cp1252.txt",
  "resources/shell/mingw64/share/antiword/cp437.txt",
  "resources/shell/mingw64/share/antiword/cp850.txt",
  "resources/shell/mingw64/share/antiword/cp852.txt",
  "resources/shell/mingw64/share/antiword/cp862.txt",
  "resources/shell/mingw64/share/antiword/cp864.txt",
  "resources/shell/mingw64/share/antiword/cp866.txt",
  "resources/shell/mingw64/share/antiword/koi8-r.txt",
  "resources/shell/mingw64/share/antiword/koi8-u.txt",
  "resources/shell/mingw64/share/antiword/MacCyrillic.txt",
  "resources/shell/mingw64/share/antiword/MacRoman.txt",
  "resources/shell/mingw64/share/antiword/roman.txt",
  "resources/shell/mingw64/share/antiword/UTF-8.txt",
  "resources/shell/mingw64/share/git/builtins.txt",
  "resources/shell/usr/share/gnupg/help.be.txt",
  "resources/shell/usr/share/gnupg/help.ca.txt",
  "resources/shell/usr/share/gnupg/help.cs.txt",
  "resources/shell/usr/share/gnupg/help.da.txt",
  "resources/shell/usr/share/gnupg/help.de.txt",
  "resources/shell/usr/share/gnupg/help.el.txt",
  "resources/shell/usr/share/gnupg/help.eo.txt",
  "resources/shell/usr/share/gnupg/help.es.txt",
  "resources/shell/usr/share/gnupg/help.et.txt",
  "resources/shell/usr/share/gnupg/help.fi.txt",
  "resources/shell/usr/share/gnupg/help.fr.txt",
  "resources/shell/usr/share/gnupg/help.gl.txt",
  "resources/shell/usr/share/gnupg/help.hu.txt",
  "resources/shell/usr/share/gnupg/help.id.txt",
  "resources/shell/usr/share/gnupg/help.it.txt",
  "resources/shell/usr/share/gnupg/help.ja.txt",
  "resources/shell/usr/share/gnupg/help.nb.txt",
  "resources/shell/usr/share/gnupg/help.pl.txt",
  "resources/shell/usr/share/gnupg/help.pt.txt",
  "resources/shell/usr/share/gnupg/help.pt_BR.txt",
  "resources/shell/usr/share/gnupg/help.ro.txt",
  "resources/shell/usr/share/gnupg/help.ru.txt",
  "resources/shell/usr/share/gnupg/help.sk.txt",
  "resources/shell/usr/share/gnupg/help.sv.txt",
  "resources/shell/usr/share/gnupg/help.tr.txt",
  "resources/shell/usr/share/gnupg/help.txt",
  "resources/shell/usr/share/gnupg/help.zh_CN.txt",
  "resources/shell/usr/share/gnupg/help.zh_TW.txt",
  "resources/skills/img2threejs/forge/requirements.txt"
]);
function isStaticTextPath(relative) { return STATIC_TEXT_PATHS.has(relative.replaceAll('\\', '/')); }
function loadStaticTexts(root, manifest) {
  if (!manifest.staticTextBundle) return new Map();
  const bundle = manifest.staticTextBundle;
  const item = manifest.files.find(file => file.path === STATIC_TEXT_BUNDLE);
  if (!item || bundle.path !== STATIC_TEXT_BUNDLE || item.size > NOTICE_LIMIT ||
      item.size !== bundle.size || item.sha256 !== bundle.sha256) throw Error('Invalid static text bundle inventory');
  const file = path.join(root, STATIC_TEXT_BUNDLE), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NOTICE_LIMIT) throw Error('Invalid static text bundle file');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw Error('Corrupt static text bundle');
  const data = JSON.parse(gunzipSync(bytes, { maxOutputLength: NOTICE_LIMIT }).toString('utf8'));
  if (data.schema !== 1 || !Array.isArray(data.files)) throw Error('Invalid static text bundle');
  const inventory = new Map(manifest.files.map(file => [file.path, file])), originals = new Map();
  for (const entry of data.files) {
    const expected = inventory.get(entry.path);
    if (!expected || !isStaticTextPath(entry.path) || originals.has(entry.path) || typeof entry.content !== 'string') {
      throw Error('Invalid static text entry');
    }
    const original = Buffer.from(entry.content, 'base64');
    if (original.length !== expected.size || digest(original) !== expected.sha256) throw Error('Corrupt static text entry: ' + entry.path);
    originals.set(entry.path, { sourceSize: original.length, sourceSha256: expected.sha256 });
  }
  for (const file of manifest.files) {
    if (isStaticTextPath(file.path) && !originals.has(file.path)) throw Error('Missing static text entry: ' + file.path);
  }
  return originals;
}
function verifyStaticTextSource(item, error, options, originals) {
  const original = originals.get(item.path), details = error.details;
  if (options.installationMode !== true || !original || details?.fileType !== 'file' ||
      details.actualSize !== item.size + 4096 || item.size <= 0) return false;
  options.onStaticTextDifference?.({ ...details, verification: 'verified-static-text-bundle', ...original });
  return true;
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function loadNotices(root, manifest) {
  if (!manifest.noticeBundle) return new Map();
  const item = manifest.files.find(file => file.path === NOTICE_BUNDLE);
  if (!item || manifest.noticeBundle.path !== NOTICE_BUNDLE || item.size > NOTICE_LIMIT ||
      item.size !== manifest.noticeBundle.size || item.sha256 !== manifest.noticeBundle.sha256) {
    throw Error('Invalid redistribution notice bundle inventory');
  }
  const file = path.join(root, NOTICE_BUNDLE), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NOTICE_LIMIT) throw Error('Invalid redistribution notice bundle file');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw Error('Corrupt redistribution notice bundle');
  const data = JSON.parse(gunzipSync(bytes, { maxOutputLength: NOTICE_LIMIT }).toString('utf8'));
  if (data.schema !== 1 || !Array.isArray(data.files)) throw Error('Invalid redistribution notice bundle');
  const inventory = new Map(manifest.files.map(file => [file.path, file])), notices = new Map();
  for (const entry of data.files) {
    const expected = inventory.get(entry.path);
    if (!expected || !isNoticePath(entry.path) || notices.has(entry.path) || typeof entry.content !== 'string') {
      throw Error('Invalid redistribution notice entry');
    }
    const original = Buffer.from(entry.content, 'base64');
    if (original.length !== expected.size || digest(original) !== expected.sha256) throw Error('Corrupt redistribution notice entry: ' + entry.path);
    notices.set(entry.path, { sourceSize: original.length, sourceSha256: expected.sha256 });
  }
  for (const file of manifest.files) {
    if (isNoticePath(file.path) && !notices.has(file.path)) throw Error('Missing redistribution notice entry: ' + file.path);
  }
  return notices;
}
function failure(message, details) {
  return Object.assign(new Error(message), { details });
}
const TRANSIENT_READ_ERRORS = new Set(['EACCES', 'EPERM', 'EBUSY', 'ETXTBSY', 'ENOENT']);
const RETRY_DELAYS = [200, 800];
const SMALL_FILE_LIMIT = 64 * 1024;
const READ_BUFFER_SIZE = 256 * 1024;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 8;
async function verifyFile(file, item, options = {}, buffer) {
  const details = { path: item.path, expectedSize: item.size, expectedSha256: item.sha256 };
  try {
    const stat = await fs.promises.lstat(file);
    details.filesystemSize = stat.size;
    details.fileType = stat.isSymbolicLink() ? 'symbolic-link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    if (details.fileType !== 'file') throw failure('Invalid payload file type: ' + item.path, details);
    // Explicit installation compatibility policy: only this bootstrap archive
    // skips content checks. Release/package verification remains strict by default.
    if (options.installationMode === true &&
        item.path.replaceAll('\\', '/').toLowerCase() === 'resources/runner/_internal/base_library.zip') {
      if (stat.size <= 0) throw failure('Empty payload file: ' + item.path, details);
      details.verification = 'existence-only';
      options.onContentCheckSkipped?.({ ...details, reason: 'bootstrap-installation-compatibility' });
      return details;
    }
    // Metadata may describe storage overhead. Verify length and digest of the same stream.
    const hash = crypto.createHash('sha256');
    let size = 0;
    // Each reader owns one bounded buffer. Actual asynchronous filesystem calls
    // allow independent files to advance while a filter/drive is serving another.
    // Read through EOF even if the file grows beyond its inventoried length.
    const length = item.size <= SMALL_FILE_LIMIT && stat.size <= SMALL_FILE_LIMIT ? SMALL_FILE_LIMIT : READ_BUFFER_SIZE;
    const handle = await fs.promises.open(file, 'r');
    try {
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, length, null);
        if (!bytesRead) break;
        size += bytesRead; details.bytesRead = size; hash.update(buffer.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
    details.actualSize = size;
    details.actualSha256 = hash.digest('hex');
    if (size !== item.size) throw failure('Incomplete payload: ' + item.path +
      ' (expected=' + item.size + ' bytes; read=' + size + ' bytes; filesystem=' + stat.size + ' bytes)', details);
    if (details.actualSha256 !== item.sha256) throw failure('Corrupt payload: ' + item.path + ' (SHA-256 mismatch)', details);
    return details;
  } catch (error) {
    if (!error.details) error.details = details;
    throw error;
  }
}
function verifyNoticeSource(item, error, options, notices) {
  const original = notices.get(item.path);
  if (!original || error.details?.fileType !== 'file' || !Number.isSafeInteger(error.details.actualSize)) return false;
  // The separate compressed source copy is hashed in full and every original
  // entry is checked against the inventory. Never rewrite/strip protected files.
  options.onNoticeDifference?.({ ...error.details, verification: 'verified-redistribution-bundle', ...original });
  return true;
}
async function verify(root, metadataDifferences = [], options = {}) {
  const started = performance.now(), diagnostics = options.diagnostics || {};
  // readMs sums per-file metadata/read/hash/close time; retryDelayMs sums
  // scheduled retry delays. Both may overlap and exceed elapsed wall time.
  Object.assign(diagnostics, { elapsedMs: 0, readMs: 0, retryDelayMs: 0, retryCount: 0, slowFiles: [] });
  try {
    return await verifyPayload(root, metadataDifferences, options, diagnostics);
  } finally {
    diagnostics.elapsedMs = Math.round(performance.now() - started);
    diagnostics.readMs = Math.round(diagnostics.readMs);
  }
}
async function verifyPayload(root, metadataDifferences, options, diagnostics) {
  const requestedConcurrency = options.concurrency === undefined ? DEFAULT_CONCURRENCY : options.concurrency;
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > MAX_CONCURRENCY) {
    throw Error('Invalid verification concurrency');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.soduwork-payload.json'), 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Missing payload inventory');
  const seen = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string' || !item.path || path.isAbsolute(item.path) ||
        item.path.split(/[\\/]/).includes('..')) throw Error('Invalid payload path');
    if (!Number.isSafeInteger(item.size) || item.size < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw Error('Invalid payload inventory: ' + item.path);
    }
    const key = item.path.replaceAll('\\', '/').toLowerCase();
    if (seen.has(key)) throw Error('Duplicate payload path: ' + item.path);
    seen.add(key);
  }
  const errors = [];
  let firstError, firstErrorIndex = Infinity, errorCount = 0, notices;
  const recordError = (index, error) => {
    if (!(error instanceof Error)) error = Error(String(error));
    if (!firstError || index < firstErrorIndex) { firstError = error; firstErrorIndex = index; }
    errorCount++;
    errors.push({ index, message: error.message, code: error.code, ...error.details });
    errors.sort((a, b) => a.index - b.index);
    if (errors.length > 100) errors.pop();
  };
  const totalBytes = manifest.files.reduce((total, item) => total + item.size, 0);
  if (!Number.isSafeInteger(totalBytes)) throw Error('Invalid payload inventory total size');
  let completed = 0, completedBytes = 0;
  const progress = (finished = false) => options.onProgress?.({ completed, total: manifest.files.length,
    completedBytes, totalBytes, finished });
  progress();
  const staticTexts = loadStaticTexts(root, manifest);
  try { notices = loadNotices(root, manifest); }
  catch (error) { error.details = { path: NOTICE_BUNDLE }; recordError(-1, error); notices = new Map(); }
  const absoluteRoot = path.resolve(root), jobs = manifest.files.map((item, index) => {
    const file = path.resolve(root, item.path);
    if (!file.startsWith(absoluteRoot + path.sep)) throw Error('Payload escaped its directory');
    return { item, index, file, attempt: 1, readMs: 0, retryDelayMs: 0 };
  });
  diagnostics.concurrency = Math.min(requestedConcurrency, jobs.length);
  // Retry timers do not occupy a reader. Even at concurrency=1, hundreds of
  // temporarily locked files wait together while other files continue reading.
  const readyRetries = [], waiters = new Set(), retryWaits = new Set();
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let cursor = 0, pendingRetries = 0;
  const notify = () => { for (const wake of waiters) wake(); waiters.clear(); };
  const nextJob = async () => {
    while (true) {
      if (cursor < jobs.length) return jobs[cursor++];
      if (readyRetries.length) return readyRetries.shift();
      if (!pendingRetries) return null;
      await new Promise(resolve => waiters.add(resolve));
    }
  };
  const finish = job => {
    diagnostics.slowFiles.push({ path: job.item.path, elapsedMs: Math.round(performance.now() - job.started),
      readMs: Math.round(job.readMs), retryDelayMs: job.retryDelayMs, attempts: job.attempt });
    diagnostics.slowFiles.sort((a, b) => b.elapsedMs - a.elapsedMs || a.path.localeCompare(b.path));
    if (diagnostics.slowFiles.length > 10) diagnostics.slowFiles.pop();
  };
  const retry = (job, delay) => {
    pendingRetries++;
    diagnostics.retryCount++; diagnostics.retryDelayMs += delay; job.retryDelayMs += delay;
    const waiting = Promise.resolve().then(() => sleep(delay)).then(() => { job.attempt++; readyRetries.push(job); }, error => {
      recordError(job.index, error); finish(job);
    }).finally(() => { pendingRetries--; retryWaits.delete(waiting); notify(); });
    retryWaits.add(waiting);
  };
  const checkJob = async (job, buffer) => {
      job.started ??= performance.now();
      const started = performance.now();
      let checked = false, retryDelay;
      try {
        const details = await verifyFile(job.file, job.item, options, buffer);
        if (details.actualSize !== undefined && details.filesystemSize !== details.actualSize) metadataDifferences.push({
          path: job.item.path, filesystemSize: details.filesystemSize, actualSize: details.actualSize });
        checked = true;
      } catch (error) {
        error.details = { ...error.details, attempts: job.attempt };
        if (verifyNoticeSource(job.item, error, options, notices) || verifyStaticTextSource(job.item, error, options, staticTexts)) {
          checked = true;
        } else if (TRANSIENT_READ_ERRORS.has(error.code) && job.attempt <= RETRY_DELAYS.length) {
          retryDelay = RETRY_DELAYS[job.attempt - 1];
          options.onRetry?.({ ...error.details, code: error.code, delayMs: retryDelay });
        } else recordError(job.index, error);
      } finally {
        const elapsed = performance.now() - started;
        job.readMs += elapsed; diagnostics.readMs += elapsed;
      }
      if (retryDelay !== undefined) retry(job, retryDelay);
      else {
        finish(job);
        if (checked) { completed++; completedBytes += job.item.size; progress(); }
      }
  };
  const worker = async () => {
    const buffer = Buffer.allocUnsafe(READ_BUFFER_SIZE);
    let job;
    while ((job = await nextJob())) {
      // A diagnostic callback failure must not abandon the other readers/timers.
      try { await checkJob(job, buffer); }
      catch (error) { recordError(job.index, error); finish(job); }
    }
  };
  // Wait for every reader before rejecting; callers may remove a failed stage
  // immediately after this promise settles. No background read may outlive it.
  const workers = await Promise.allSettled(Array.from({ length: diagnostics.concurrency }, worker));
  for (const result of workers) if (result.status === 'rejected') recordError(Infinity, result.reason);
  await Promise.allSettled([...retryWaits]);
  if (firstError) {
    firstError.failures = errors.map(({ index, ...error }) => error);
    firstError.errorCount = errorCount;
    firstError.checkedFiles = manifest.files.length;
    throw firstError;
  }
  progress(true);
  return manifest.files.length;
}
function createProgressWriter(file, options = {}) {
  if (!file) return () => {};
  const now = options.now || Date.now;
  let lastWrite = -Infinity, lastPercent = 70;
  return event => {
    const ratio = event.totalBytes > 0 ? event.completedBytes / event.totalBytes : event.completed / event.total;
    // 98 means verification succeeded, never merely that the last read finished.
    const percent = event.finished ? 98 : Math.max(lastPercent, Math.min(97, 70 + Math.floor(28 * ratio)));
    const time = now();
    if (!event.finished && time - lastWrite < 250) return;
    // Bound retries too when an antivirus or observer temporarily holds the file.
    lastWrite = time;
    const temporary = file + '.verify-' + process.pid + '.next';
    try {
      fs.writeFileSync(temporary, `${percent}|${event.completed}|${event.total}`, 'ascii');
      fs.renameSync(temporary, file);
      lastPercent = percent;
    } catch (_) {
      // Progress is presentation only. A locked or unwritable observer file must
      // never weaken verification or prevent an otherwise valid installation.
      try { fs.unlinkSync(temporary); } catch (_) {}
    }
  };
}
async function run(root, reportFile, archive, extractor, options = {}) {
  const report = { schema: 1, time: new Date().toISOString(), root, ok: false, metadataDifferences: [], retryCount: 0, retrySamples: [], noticeDifferences: [], staticTextDifferences: [] };
  report.verificationMode = options.installationMode === true ? 'installation' : 'strict';
  report.contentCheckSkips = [];
  report.performance = {};
  try {
    report.fileCount = await verify(root, report.metadataDifferences, { archive, extractor,
      installationMode: options.installationMode === true,
      concurrency: options.concurrency, diagnostics: report.performance,
      onProgress: createProgressWriter(options.progressFile),
      onContentCheckSkipped(details) { report.contentCheckSkips.push(details); },
      onStaticTextDifference(details) { report.staticTextDifferences.push(details); },
      onNoticeDifference(details) { report.noticeDifferences.push(details); }, onRetry(details) {
      report.retryCount++;
      if (report.retrySamples.length < 100) report.retrySamples.push(details);
    } });
    report.ok = true;
    console.log('Checked ' + report.fileCount + ' files' +
      (report.contentCheckSkips.length ? '; bootstrap archive content check skipped (existence-only)' : '') + (report.noticeDifferences.length ?
      '; ' + report.noticeDifferences.length + ' public license notices verified from the verified redistribution bundle' : ''));
  } catch (error) {
    report.error = { message: error.message, code: error.code, ...error.details };
    report.errorCount = error.errorCount || 1;
    report.errors = error.failures || [report.error];
    report.checkedFiles = error.checkedFiles;
    console.error(error.message);
  }
  report.fullContentVerified = report.ok && report.contentCheckSkips.length === 0 && report.staticTextDifferences.length === 0;
  if (reportFile) {
    try { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8'); }
    catch (error) { console.error('Unable to save payload diagnostics: ' + (error.code || 'write failed')); }
  }
  return report.ok ? 0 : 2;
}
module.exports = { verify, run, createProgressWriter, isNoticePath, noticeCandidate, NOTICE_BUNDLE, NOTICE_LIMIT, STATIC_TEXT_BUNDLE, isStaticTextPath };
const progressArgument = process.argv.indexOf('--progress-file', 4);
if (require.main === module) run(path.resolve(process.argv[2]), process.argv[3], process.argv[4], process.argv[5], {
  installationMode: process.argv.slice(4).includes('--installation'),
  progressFile: progressArgument === -1 ? undefined : process.argv[progressArgument + 1],
}).then(code => {
  process.exitCode = code;
}).catch(error => { console.error(error.message); process.exitCode = 2; });

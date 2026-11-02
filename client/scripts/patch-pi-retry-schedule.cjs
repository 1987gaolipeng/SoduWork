'use strict';

/*
 * Keep the retry schedule in SoduWork's settings while teaching the bundled
 * Pi runtime to consume it. The dependency is intentionally not vendored in
 * source control, so this idempotent compatibility patch runs before the SDK
 * is imported and again during packaging.
 */
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'SODUWORK_EXPLICIT_RETRY_SCHEDULE';

function patchSource(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, skipped: true, file };
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (error) {
    return { ok: false, file, reason: String(error && error.message || error) };
  }
  if (source.includes(MARKER)) return { ok: true, already: true, file };
  const isSettingsManager = file.endsWith(path.join('core', 'settings-manager.js'));
  const isAgentSession = file.endsWith(path.join('core', 'agent-session.js'));
  // Older local development builds may already contain the compatibility
  // code from an earlier unmarked patch. Treat those copies as idempotent.
  if (isSettingsManager && source.includes('delayScheduleMs: Array.isArray(this.settings.retry?.delayScheduleMs)')) {
    return { ok: true, already: true, file };
  }
  if (isAgentSession && source.includes('const scheduledDelay = settings.delayScheduleMs?.[')) {
    return { ok: true, already: true, file };
  }
  let next = source;
  if (isSettingsManager) {
    const token = [
      '            baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,',
      '            baseDelayMs: this.settings.retry?.baseDelayMs ?? SETTINGS_DEFAULTS.retry.baseDelayMs,',
    ].find(value => source.includes(value));
    if (!token) return { ok: false, file, reason: 'unsupported settings manager retry layout' };
    const replacement = `${token}
            // ${MARKER}: allow the host to provide an explicit bounded schedule.
            delayScheduleMs: Array.isArray(this.settings.retry?.delayScheduleMs)
                ? this.settings.retry.delayScheduleMs.filter(value => Number.isFinite(value) && value >= 0).map(value => Math.floor(value))
                : undefined,`;
    if (!source.includes(token)) return { ok: false, file, reason: 'unsupported settings manager retry layout' };
    next = source.replace(token, replacement);
  } else if (isAgentSession) {
    const fallback = source.includes('        const delayMs = retryDelayMs(settings, this._retryAttempt);')
      ? 'retryDelayMs(settings, this._retryAttempt)' : 'settings.baseDelayMs * 2 ** (this._retryAttempt - 1)';
    const token = `        const delayMs = ${fallback};`;
    const replacement = `        // ${MARKER}: prefer SoduWork's explicit schedule, retaining SDK fallback.
        const scheduledDelay = settings.delayScheduleMs?.[this._retryAttempt - 1];
        const delayMs = Number.isFinite(scheduledDelay)
            ? Math.min(scheduledDelay, settings.maxAgentDelayMs ?? Number.MAX_SAFE_INTEGER)
            : ${fallback};`;
    if (!source.includes(token)) return { ok: false, file, reason: 'unsupported agent retry layout' };
    next = source.replace(token, replacement);
  } else {
    return { ok: false, file, reason: 'unsupported retry patch target' };
  }
  try { fs.writeFileSync(file, next, 'utf8'); } catch (error) {
    return { ok: false, file, reason: String(error && error.message || error) };
  }
  return { ok: true, patched: true, file };
}

function candidateFiles({ root = path.resolve(__dirname, '..'), resourcesPath = process.resourcesPath } = {}) {
  const files = [
    path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'settings-manager.js'),
    path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'agent-session.js'),
  ];
  if (resourcesPath) {
    files.push(
      path.join(resourcesPath, 'pi', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'settings-manager.js'),
      path.join(resourcesPath, 'pi', '@earendil-works', 'pi-coding-agent', 'dist', 'core', 'agent-session.js'),
    );
  }
  return [...new Set(files)];
}

function patchPiRetrySchedule(options = {}) {
  const results = candidateFiles(options).map(patchSource);
  const existing = results.filter(item => !item.skipped);
  const failed = existing.find(item => item.ok === false);
  // A package can expose the SDK only under resourcesPath in a packaged app,
  // so absence of local candidates is allowed. An existing unsupported copy
  // is an actionable packaging error.
  return { ok: !failed, results };
}

if (require.main === module) {
  const result = patchPiRetrySchedule();
  if (!result.ok) {
    console.error(result.results.filter(item => !item.ok && !item.skipped)
      .map(item => `${item.file}: ${item.reason}`).join('\n'));
    process.exitCode = 1;
  }
}

module.exports = { MARKER, patchSource, candidateFiles, patchPiRetrySchedule };

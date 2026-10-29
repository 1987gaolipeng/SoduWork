'use strict';

/*
 * Add bounded command timeouts to the SDK Bash tool and reject known unbounded scans or
 * explicit long waits while retaining native AbortSignal cancellation.
 */
/*
 * Allow command-specific timeout requests within safe bounds and retain a process-tree
 * cleanup grace period.
 */
const ROUTINE_TIMEOUT_SECONDS = 120;
const NETWORK_TIMEOUT_SECONDS = 300;
const LONG_TIMEOUT_SECONDS = 600;
const DELIVERY_TIMEOUT_SECONDS = 900;
const SOFT_NOTICE_MS = 30 * 1000;
const STALL_NOTICE_MS = 90 * 1000;
const HARD_STOP_GRACE_MS = 30 * 1000;
const OTHER_TOOL_LIMIT_MS = 10 * 60 * 1000;
const HARD_TOOL_LIMIT_MS = 30 * 60 * 1000 + HARD_STOP_GRACE_MS;
const LONG_WAIT_LIMIT_SECONDS = 20;
const shellRuntime = require('./shell-runtime');

const PROFILES = Object.freeze({
  routine: Object.freeze({ kind: 'routine', seconds: ROUTINE_TIMEOUT_SECONDS, minSeconds: 15, maxSeconds: 300 }),
  network: Object.freeze({ kind: 'network', seconds: NETWORK_TIMEOUT_SECONDS, minSeconds: 60, maxSeconds: 600 }),
  long: Object.freeze({ kind: 'long', seconds: LONG_TIMEOUT_SECONDS, minSeconds: 120, maxSeconds: 900 }),
  delivery: Object.freeze({ kind: 'delivery', seconds: DELIVERY_TIMEOUT_SECONDS, minSeconds: 300, maxSeconds: 1800 }),
});

function _command(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function _longWaitSeconds(command) {
  const patterns = [
    /(?:^|[;&|]\s*)sleep\s+(\d+(?:\.\d+)?)(?:\s|$)/ig,
    /\bstart-sleep\b(?:\s+-seconds)?\s+(\d+(?:\.\d+)?)(?:\s|$)/ig,
    /\btimeout(?:\.exe)?\s+\/t\s+(\d+)(?:\s|$)/ig,
  ];
  let longest = 0;
  patterns.forEach((pattern) => {
    let matched;
    while ((matched = pattern.exec(command))) longest = Math.max(longest, Number(matched[1]) || 0);
  });
  return longest;
}

function unsafeReason(value) {
  const command = _command(value);
  if (!command) return '命令为空';

  const unixRootFind = /(?:^|[;&|]\s*)find(?:\.exe)?\s+["']?\/["']?(?:\s|$)/i;
  const unixRootSearch = /\b(?:grep|rg)\b[^;\r\n|]*(?:^|\s)["']?\/["']?(?:\s|$)/i;
  const windowsRootRecurse = /\b(?:get-childitem|gci|dir)\b[^;\r\n|]*(?:-literalpath\s+|-path\s+)?["']?[a-z]:[\\/]["']?[^;\r\n|]*(?:-recurse|\/s)\b/i;
  if (unixRootFind.test(command) || unixRootSearch.test(command) || windowsRootRecurse.test(command)) {
    return '已阻止扫描整台电脑。请从当前工作区或一个明确的子目录开始搜索';
  }
  const wait = _longWaitSeconds(command);
  if (wait > LONG_WAIT_LIMIT_SECONDS) {
    return '已阻止显式等待 ' + wait + ' 秒。请直接检查状态，失败后换方案，不要用长时间 sleep 轮询';
  }
  if (/(?:^|[;&|]\s*)(?:while\s+true|while\s*\(\s*\$?true\s*\)|for\s*\(\s*;;\s*\))/i.test(command)) {
    return '已阻止没有退出条件的循环。请改成有次数和超时上限的检查';
  }
  return '';
}

function timeoutProfile(value) {
  const command = _command(value);
  if (/\b(?:terraform\s+(?:apply|destroy)|ansible-playbook|kubectl\s+(?:apply|rollout|wait)|helm\s+(?:install|upgrade)|docker\s+compose\s+(?:up|pull)|alembic\s+upgrade|prisma\s+migrate|flyway|liquibase|deploy|release|publish)\b/i.test(command)) {
    return { ...PROFILES.delivery };
  }
  if (/\b(?:npm|pnpm|yarn|bun)\b[^;\r\n|]*(?:install|ci|build|test|pack)|\belectron-builder\b|\b(?:pytest|unittest|mvn|gradle|dotnet\s+(?:build|test)|docker\s+build|pip\s+install)\b/i.test(command)) {
    return { ...PROFILES.long };
  }
  if (/\bmcp\.mjs\b/i.test(command) ||
      /\b(?:git\s+(?:clone|pull|push|fetch)|curl|wget|invoke-webrequest|playwright|browser-use|computer-use)\b/i.test(command)) {
    return { ...PROFILES.network };
  }
  return { ...PROFILES.routine };
}

function timeoutSeconds(command, requested) {
  const profile = timeoutProfile(command);
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return profile.seconds;
  return Math.max(profile.minSeconds, Math.min(Math.ceil(value), profile.maxSeconds));
}

function executionPolicy(toolName, args) {
  const name = String(toolName || '').toLowerCase();
  if (/^ctx_execute(?:_file)?$/.test(name)) {
    const timeoutMs = contextTimeoutMs(args?.timeout);
    return { kind: 'command', timeoutSeconds: timeoutMs / 1000,
      hardLimitMs: timeoutMs + HARD_STOP_GRACE_MS };
  }
  if (name === 'bash') {
    const input = args && typeof args === 'object' ? args : {};
    const profile = timeoutProfile(input.command);
    const seconds = timeoutSeconds(input.command, input.timeout);
    return {
      kind: profile.kind,
      timeoutSeconds: seconds,
      hardLimitMs: seconds * 1000 + HARD_STOP_GRACE_MS,
    };
  }
  return { kind: 'tool', timeoutSeconds: 0, hardLimitMs: OTHER_TOOL_LIMIT_MS };
}

function contextTimeoutMs(value) {
  const requested = Number(value);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, LONG_TIMEOUT_SECONDS * 1000) : ROUTINE_TIMEOUT_SECONDS * 1000;
}

function createGuardedBash(sdk, cwd, settingsManager, runtimeOptions) {
  if (!sdk || typeof sdk.createBashTool !== 'function') {
    throw new Error('当前 Pi SDK 不支持受控 Bash 工具');
  }
  const options = {};
  if (settingsManager && typeof settingsManager.getShellCommandPrefix === 'function') {
    options.commandPrefix = settingsManager.getShellCommandPrefix();
  }
  const configuredPath = settingsManager && typeof settingsManager.getShellPath === 'function'
    ? settingsManager.getShellPath() : '';
  const resolver = runtimeOptions && typeof runtimeOptions.resolve === 'function'
    ? runtimeOptions.resolve : shellRuntime.resolve;
  const resolvedShell = runtimeOptions?.resolvedShell || resolver({ ...(runtimeOptions || {}), configuredPath });
  options.shellPath = resolvedShell.shellPath;
  const base = sdk.createBashTool(cwd, options);
  const guidelines = Array.isArray(base.promptGuidelines) ? base.promptGuidelines.slice() : [];
  guidelines.push('Search only the current workspace or an explicit bounded directory; never scan filesystem roots.');
  guidelines.push('Do not wait with long sleep commands. Check once, then use a different bounded approach when needed.');
  return {
    ...base,
    description: String(base.description || 'Execute a shell command') +
      ' SoduWork applies an adaptive command timeout and kills the full process tree when it expires.',
    promptGuidelines: guidelines,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const input = params && typeof params === 'object' ? params : {};
      const command = _command(input.command);
      const blocked = unsafeReason(command);
      if (blocked) {
        throw new Error(blocked + '。请立即缩小范围后继续，不要重复同一条命令，也不要询问用户。');
      }
      const bounded = timeoutSeconds(command, input.timeout);
      try {
        return await base.execute(toolCallId, { ...input, command, timeout: bounded },
          signal, onUpdate, context);
      } catch (error) {
        const message = String((error && error.message) || error || '');
        if (/timed out|timeout:/i.test(message)) {
          throw new Error(message + '\nSoduWork 已停止这个耗时步骤并保留现场。请拆小范围或更换方案后继续，不要重跑原命令。');
        }
        throw error;
      }
    },
  };
}

// Preparing a new SDK session must not synchronously launch and wait for Bash
// in Electron's main thread. Construction remains synchronous for old callers
// that already hold a verified shell; execution keeps the SDK cancellation path.
async function prepareGuardedBash(sdk, cwd, settingsManager, runtimeOptions = {}) {
  if (!sdk || typeof sdk.createBashTool !== 'function') {
    throw new Error('当前 Pi SDK 不支持受控 Bash 工具');
  }
  const configuredPath = settingsManager && typeof settingsManager.getShellPath === 'function'
    ? settingsManager.getShellPath() : '';
  const resolver = typeof runtimeOptions.resolveAsync === 'function'
    ? runtimeOptions.resolveAsync : shellRuntime.resolveAsync;
  const resolvedShell = runtimeOptions.resolvedShell || await resolver({ ...runtimeOptions, configuredPath });
  return createGuardedBash(sdk, cwd, settingsManager, { ...runtimeOptions, resolvedShell });
}

module.exports = {
  createGuardedBash,
  prepareGuardedBash,
  unsafeReason,
  timeoutProfile,
  timeoutSeconds,
  executionPolicy,
  contextTimeoutMs,
  HARD_TOOL_LIMIT_MS,
  SOFT_NOTICE_MS,
  STALL_NOTICE_MS,
  HARD_STOP_GRACE_MS,
  OTHER_TOOL_LIMIT_MS,
  ROUTINE_TIMEOUT_SECONDS,
  NETWORK_TIMEOUT_SECONDS,
  LONG_TIMEOUT_SECONDS,
  DELIVERY_TIMEOUT_SECONDS,
  LONG_WAIT_LIMIT_SECONDS,
};

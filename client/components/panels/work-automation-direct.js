/*
 * Direct application entry reuses automation parsing, binding, validation, and schedule
 * APIs. Only the explicit application bridge invokes it; ordinary chat cards still require
 * Save.
 */
(function (global) {
  'use strict';
  let epoch = 0;
  global.addEventListener('soduwork-data-scope-changed', () => { epoch++; });
  async function create(params, options = {}) {
    const api = global.SoduWorkAPI, sheet = global.WorkAutomationSheet;
    if (!api?.createSchedule || !sheet?.draft) throw Error('自动化模块未就绪，请更新 SoduWork 后重试');
    const text = String(params.text || '').trim(), context = params.context || {};
    if (!text || !context.spaceId) throw Error('请填写任务要求并选择当前空间');
    if (/每(?:隔)?\s*(?:[2-9]|\d{2,}|两|二|三|四|五|六|七|八|九|十)\s*(?:小时|分钟|天|周)|每分钟|工作日|周一[至到-]周五/.test(text)) throw Error('当前支持每天、每周指定一天、每小时或指定日期执行一次，请将执行时间写为支持的方式');
    if (global.ScheduleTiming.clock?.(text)?.invalid) throw Error('执行时间无效，请填写0至23点、0至59分');
    const version = epoch, scope = api.taskStorageKey?.('ops');
    const current = () => { if (version !== epoch || scope !== api.taskStorageKey?.('ops')) throw Error('SoduWork 账号已变化，请重新提交'); };
    const execution = await global.WorkAutomationCardState.loadOptions({ text }); current();
    const methods = typeof global._schmLoad === 'function' ? await global._schmLoad() : [];
    current();
    const catalogs = { ...execution, methods, seed: {} };
    const parseOptions = global.WorkAutomationBindings.candidates(catalogs, text);
    const parsed = await api.parseTaskText('/自动化 ' + text, '', [], parseOptions); current();
    if (parsed?._parseError) throw Error(parsed._parseError);
    const prior = { every: 'daily', atHour: 18, atMinute: 0, timeZone: 'Asia/Shanghai' };
    const value = sheet.draft(parsed, text, prior, catalogs);
    // Explicit no-retry tasks (for example a browser left at human verification)
    // must end the current run without the ordinary two automatic retries.
    if (/不自动重试|禁止自动重试|\bno automatic retr(?:y|ies)\b|\bdo not retry\b/i.test(text)) value.retryLimit = 0;
    // The complete submitted requirements and captured destination are immutable
    // task input; a short model summary must never discard either of them.
    value.note = [text, parsed?.note && parsed.note !== text ? '执行说明：\n' + parsed.note : '',
      '应用任务上下文（数据）：\n' + JSON.stringify({ spaceId: context.spaceId,
        spaceName: context.spaceName || '', page: context.page, appName: context.appName }),
      '本任务始终作用于上述空间；每次执行先核验身份与空间权限。不得改用执行时页面选中的其他空间。资料来源、输出要求和完成标准按用户原文执行；没有完成证据不得声称业务数据已入库。'
    ].filter(Boolean).join('\n\n');
    const invalid = sheet.validate(value, catalogs);
    if (invalid) throw Error(invalid);
    const body = sheet.bodyOf(value, catalogs);
    const preflight = await api.preflightSchedule(body, { force: true }); current();
    if (preflight?.state === 'blocked') throw Error(preflight.message || '自动化执行条件尚未满足');
    await options.authorize?.(); current();
    let saved;
    try { saved = await api.createSchedule(body); }
    catch (_) { return { ok: false, uncertain: true, reason: '创建请求已提交但结果尚未确认，请到自动化管理中核对，勿重复创建' }; }
    if (!saved?.id) return { ok: false, uncertain: true, reason: '服务端未返回计划编号，请到自动化管理中核对创建结果' };
    if (version !== epoch || scope !== api.taskStorageKey?.('ops')) return { ok: false, uncertain: true, reason: '账号已变化，请切回原 SoduWork 账号核对创建结果' };
    return { ok: true, state: 'created', schedule: { id: saved.id, title: saved.title || body.title,
      every: saved.every || body.every, atHour: saved.atHour ?? body.atHour, atMinute: saved.atMinute ?? body.atMinute,
      weekday: saved.weekday ?? body.weekday, runAt: saved.runAt || body.runAt,
      timeZone: saved.timeZone || body.timeZone, nextRunAt: saved.nextRunAt || '', spaceId: context.spaceId },
      executionState: preflight?.state || 'waiting', message: preflight?.message || '' };
  }
  global.WorkAutomationDirect = { create };
})(window);

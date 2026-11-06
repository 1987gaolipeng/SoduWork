'use strict';

const DEFAULT_DELAYS = [5000, 15000, 30000, 60000, 120000, 240000];

function create({ clock = Date.now, random = Math.random } = {}) {
  let used = 0, waiting = 0, since = 0, limit = 6, windowMs = 650000;
  function available() { return used < limit && (!since || clock() - since < windowMs); }
  function reserve() {
    if (!available()) return false;
    if (!since) since = clock();
    used++;
    return true;
  }
  function plan({ settings, attempt, error }) {
    limit = settings.enabled === false ? 0 : Math.max(0, Number(settings.maxRetries) || 0);
    if (attempt > limit || !available()) return false;
    const schedule = settings.delayScheduleMs;
    const base = Number.isFinite(schedule?.[attempt - 1]) ? schedule[attempt - 1]
      : Math.max(0, Number(settings.baseDelayMs) || 0) * 2 ** (attempt - 1);
    const budget = Array.from({ length: Math.min(limit, 100) }, (_, i) =>
      Number.isFinite(schedule?.[i]) ? schedule[i] : Math.max(0, Number(settings.baseDelayMs) || 0) * 2 ** i)
      .reduce((sum, value) => sum + value, 0);
    windowMs = Math.max(180000, Math.min(3600000, budget + 180000));
    const retryAfter = Number(error?.retryAfterMs) || Number(String(error?.errorMessage || '')
      .match(/\bretry_after_ms=(\d+)\b/)?.[1]) ||
      (Number(String(error?.errorMessage || '').match(/\bretry after (\d+(?:\.\d+)?) seconds\b/i)?.[1]) || 0) * 1000;
    const defaults = Array.isArray(schedule) && schedule.length === DEFAULT_DELAYS.length &&
      schedule.every((value, index) => value === DEFAULT_DELAYS[index]);
    const suggested = Math.min(300000, Math.max(0, retryAfter));
    const delayMs = Math.ceil(Math.max(suggested, Math.round(base * (defaults ? .8 + .4 * random() : 1))));
    if (waiting + delayMs > windowMs || !reserve()) return false;
    waiting += delayMs;
    return { delayMs };
  }
  return { plan, reserve, available, snapshot: () => ({ used, waiting, since, limit, windowMs }),
    reset() { used = waiting = since = 0; } };
}

module.exports = { create };

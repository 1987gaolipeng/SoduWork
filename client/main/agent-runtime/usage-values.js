'use strict';

// Accounting uses integer micro-USD. Round once per provider receipt, never
// after adding binary floating point costs from an entire conversation.
function number(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function pick(row, names) {
  for (const key of names) if (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0)
    return Math.floor(row[key]);
  return 0;
}
function units(value, scale = 6) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const match = String(value).match(/^\+?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const fraction = match[2] || '';
  const exponent = Number(match[3] || 0) + scale - fraction.length;
  if (Math.abs(exponent) > 100) return null;
  let amount = BigInt(match[1] + fraction);
  if (exponent >= 0) amount *= 10n ** BigInt(exponent);
  else {
    const divisor = 10n ** BigInt(-exponent);
    amount = (amount + divisor / 2n) / divisor;
  }
  return amount;
}
function micro(value) { const amount = units(value); return amount !== null && amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null; }
function usd(units) { const value = units.toString().padStart(13, '0'); return value.slice(0, -12) + '.' + value.slice(-12); }
function cost(row) {
  for (const key of ['costMicrousd', 'cost_microusd'])
    if (Number.isSafeInteger(row[key]) && row[key] >= 0) return row[key];
  return micro(row.cost && typeof row.cost === 'object' ? row.cost.total : row.cost);
}
function empty() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    total: 0, cost: 0, costUsd: '0.000000000000', costMicrousd: 0, costKnown: true, requests: 0,
    turns: 0, steps: 0, durationMs: 0, inputIncludesCache: false };
}
function add(target, raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const input = pick(row, ['input', 'input_tokens', 'prompt_tokens']);
  const output = pick(row, ['output', 'output_tokens', 'completion_tokens']);
  const read = pick(row, ['cacheRead', 'cache_read_tokens', 'cache_read_input_tokens', 'cached_input_tokens']);
  const write = pick(row, ['cacheWrite', 'cache_write_tokens', 'cache_creation_input_tokens', 'cache_write_input_tokens']);
  const reasoning = pick(row, ['reasoning', 'reasoningTokens', 'reasoning_tokens', 'output_reasoning_tokens']);
  const includes = row.inputIncludesCache ?? row.input_includes_cache ?? ('cached_input_tokens' in row);
  target.input += input + (includes ? 0 : read + write);
  target.output += Math.max(output, reasoning);
  target.cacheRead += read; target.cacheWrite += write; target.reasoning += reasoning;
  target.total += Math.max(pick(row, ['total', 'totalTokens', 'total_tokens']), input + Math.max(output, reasoning) + (includes ? 0 : read + write));
  const rawCost = row.cost && typeof row.cost === 'object' ? row.cost.total : row.cost;
  const exact = row.costUsd !== undefined ? units(row.costUsd, 12)
    : row.costMicrousd !== undefined || row.cost_microusd !== undefined ? units(row.costMicrousd ?? row.cost_microusd, 6)
    : rawCost !== undefined ? units(rawCost, 12) : null;
  const exactTotal = units(target.costUsd, 12) + (exact || 0n);
  target.costUsd = usd(exactTotal);
  target.costMicrousd = Number((exactTotal + 500000n) / 1000000n);
  target.costKnown = target.costKnown && exact !== null && row.costKnown !== false;
  target.cost = target.costMicrousd / 1000000;
  target.turns += pick(row, ['turns', 'rounds']); target.steps += pick(row, ['steps', 'tool_calls']);
  target.durationMs += pick(row, ['durationMs', 'duration_ms']);
  target.inputIncludesCache = true;
  // Empty synthetic assistant messages are not model requests.
  target.requests += pick(row, ['requests', 'requestCount', 'api_calls']) || (input || output || reasoning || read || write || exact || pick(row, ['total', 'totalTokens', 'total_tokens']) ? 1 : 0);
}
function usageFromSnapshot(snapshot) {
  const out = empty();
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const reported = messages.filter(item => item?.role === 'assistant' && item.done !== false && item.usage && typeof item.usage === 'object');
  if (reported.length) reported.forEach(item => add(out, item.usage));
  else if (!messages.length && snapshot?.usage) add(out, snapshot.usage);
  out.durationMs = Math.max(out.durationMs, number(snapshot?.execution?.elapsedMs));
  return out;
}
module.exports = { number, pick, micro, cost, units, usd, empty, add, usageFromSnapshot };

'use strict';
const MAX_BYTES = 2 * 1024 * 1024;
class SafeError extends Error {}
const fail = message => { throw new SafeError(message); };
function discard(body) { try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {} }

// Cover connection and stream reads with a deadline, including custom fetch implementations that ignore AbortSignal.
// Do not await untrusted stream cancellation, which could stall timeout cleanup.
async function fetchBounded(request, options = {}) {
  const controller = new AbortController();
  const timeout = Math.max(1, Math.min(300000, Number(options.timeoutMs) || 60000));
  let timedOut = false, reader, timer, rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const abort = () => {
    controller.abort();
    rejectInterrupted(new SafeError(timedOut ? '连接器请求超时；写入请求不会自动重试' : '连接器请求已取消；写入结果可能未知，请先查询确认'));
  };
  const externalAbort = () => abort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
  const bounded = promise => Promise.race([promise, interrupted]);
  try {
    if (options.signal?.aborted) abort();
    if (controller.signal.aborted) return await interrupted;
    const pending = Promise.resolve().then(() => (options.fetchImpl || fetch)(request.url, {
      method: request.method, headers: request.headers, body: request.body,
      signal: controller.signal, redirect: 'manual',
    }));
    // Release response bodies returned after the deadline.
    pending.then(response => { if (controller.signal.aborted) discard(response?.body); }, () => {});
    const response = await bounded(pending);
    if (response.status >= 300 && response.status < 400) {
      discard(response.body); fail('连接器发生重定向，已停止转发凭据');
    }
    if (!response.ok) {
      discard(response.body);
      const hint = response.status === 401 ? '授权已失效，请更新凭据'
        : response.status === 403 ? '当前账号或应用权限不足'
        : response.status === 429 ? '平台请求过于频繁，请稍后再试' : '平台请求未成功';
      throw Object.assign(new SafeError(hint + '（HTTP ' + response.status + '）'), { status: response.status });
    }
    const declared = Number(response.headers?.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      discard(response.body); fail('返回内容超过 2 MB，请缩小范围或分页读取');
    }
    reader = response.body?.getReader();
    const parts = []; let size = 0;
    if (reader) for (;;) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) fail('返回内容超过 2 MB，请缩小范围或分页读取');
      parts.push(Buffer.from(value));
    }
    return { bytes: Buffer.concat(parts), status: response.status, headers: response.headers };
  } catch (error) {
    if (error instanceof SafeError) throw error;
    if (controller.signal.aborted) fail(timedOut ? '连接器请求超时；写入请求不会自动重试' : '连接器请求已取消；写入结果可能未知，请先查询确认');
    fail('连接器网络或响应异常，请检查连接配置；写入请求不会自动重试');
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener('abort', externalAbort);
    if (reader) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
}

function redactor(definition, config, headers = {}) {
  const values = new Set();
  for (const field of definition.fields) {
    if (field.secret || /SECRET|TOKEN|ACCESS_KEY/.test(field.key)) if (config[field.key]) values.add(String(config[field.key]));
  }
  for (const [key, value] of Object.entries(headers)) {
    if (/^(authorization|x-tc-key|x-tc-signature|x-amz-security-token)$/i.test(key)) {
      values.add(String(value));
      if (/^Bearer /i.test(value)) values.add(String(value).slice(7));
    }
  }
  const variants = new Set();
  for (const value of values) {
    variants.add(value); variants.add(encodeURIComponent(value)); variants.add(Buffer.from(value).toString('base64'));
  }
  const ordered = [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
  return text => {
    let output = String(text);
    for (const value of ordered) output = output.split(value).join('[已隐藏凭据]');
    return output;
  };
}
// Redact structured values before serialization to preserve valid JSON for all credential formats.
function redactData(data, definition, config, headers = {}) {
  const replace = redactor(definition, config, headers);
  let nodes = 0;
  function visit(value, depth) {
    if (depth > 32 || ++nodes > 100000) fail('平台响应结构过大，请缩小读取范围');
    if (typeof value === 'string') return replace(value);
    if (typeof value === 'number') {
      const text = String(value), redacted = replace(text);
      return text === redacted ? value : redacted;
    }
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (value && typeof value === 'object') {
      const result = Object.create(null);
      for (const [key, item] of Object.entries(value)) result[replace(key)] = visit(item, depth + 1);
      return result;
    }
    return value;
  }
  return visit(data, 0);
}
module.exports = { fetchBounded, redactData, MAX_BYTES };

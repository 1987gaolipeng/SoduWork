'use strict';

require('node:test')('opaque Hub diagnostic survives SDK message-only errors without changing retry policy', () => {
  const assert = require('node:assert/strict');
  const errors = require('../main/pi-session/model-errors');
  const trace = '0123456789abcdef0123456789abcdef';
  const info = errors.describe(new Error('HTTP 403: rejected [soduwork-trace:' + trace + ']'), true);
  assert.equal(info.publicText, '工具已完成，请求模型继续生成时被拒绝（HTTP 403） [soduwork-trace:' + trace + ']');
  assert.equal(info.retryable, false);
  assert.equal(info.diagnosticId, trace);
  assert.equal(errors.describe('HTTP 403 [soduwork-trace:https://private.invalid]').publicText, '模型请求被拒绝（HTTP 403）');
});
const test = require('node:test'), assert = require('node:assert/strict');
const errors = require('../main/pi-session/model-errors');
const stream = require('../main/pi-session/event-stream');
test('correlation metadata never changes error classification or retry eligibility', () => {
  for (const upstreamRequestId of ['billing-183', 'insufficient_balance', 'context_length_exceeded', 'image_input_rejected', 'TOKEN_QUOTA_EXCEEDED']) {
    const envelope = { error: { type: 'soduwork_proxy_error', status: 503, code: 503,
      message: 'HTTP 503: unavailable', upstreamRequestId } };
    for (const input of [envelope, JSON.stringify(envelope), '503 ' + JSON.stringify(envelope),
      new Error(JSON.stringify(envelope)), new Error('503 ' + JSON.stringify(envelope))]) {
      const result = errors.describe(input);
      assert.equal(result.retryable, true, upstreamRequestId);
      assert.equal(result.code, undefined);
      assert.equal(result.publicText, '模型服务暂时不可用（HTTP 503）');
    }
  }
});
test('only generic HTTP 403 survives local privacy filtering as a summary candidate', () => {
  const privacy = require('../main/pi-session/local-model-runtime-privacy.cjs');
  for (const value of ['HTTP 403', 'HTTP 403: Forbidden']) {
    for (const error of [value, privacy.safeError(value)]) assert.equal(errors.describe(error).genericForbidden, true);
  }
  for (const value of ['HTTP 401', 'HTTP 403: invalid API key', 'HTTP 403: permission denied',
    'HTTP 403: content_filtered', 'HTTP 403: image input rejected', 'HTTP 403: context_length_exceeded',
    'HTTP 403: insufficient_quota', { error: { status: 403, code: 'token_quota_exceeded' } }]) {
    for (const error of [value, privacy.safeError(value)]) assert.ok(!errors.describe(error).genericForbidden);
  }
});
test('a 403 needs explicit neutral evidence before offering a summary', () => {
  const privacy = require('../main/pi-session/local-model-runtime-privacy.cjs');
  for (const body of [{}, [], { requestId: 'fixture' }, { error: null }, { error: [] }, { error: {} },
    { error: { message: null } }, { error: { detail: ' ' } }, { error: { code: '.' } },
    { error: { message: ['Forbidden'] } }, { error: { message: 'Forbidden', mystery: 'unknown' } }]) {
    const raw = 'HTTP 403: ' + JSON.stringify(body);
    for (const value of [raw, new Error(raw), privacy.safeError(raw)]) {
      assert.ok(!errors.describe(value).genericForbidden, raw);
    }
    const sdkError = Object.assign(new Error('HTTP 403: Forbidden'), { error: body, status: 403 });
    assert.ok(!errors.describe(sdkError).genericForbidden, raw);
  }
  for (const value of ['HTTP 403: !', '403:', '403: ambiguous {"error":{"message":"Forbidden"}}',
    '403 [{"error":{"message":"Forbidden"}}]']) assert.ok(!errors.describe(value).genericForbidden, value);
  for (const value of ['403', '403 status code (no body)', { error: { status: 403 } },
    '403 {"error":{"message":"Forbidden."},"request_id":"fixture"}']) {
    assert.equal(errors.describe(value).genericForbidden, true, JSON.stringify(value));
  }
});
const secretBody = '<html><body><h1>504 Gateway Time-out</h1>' +
  "The server didn't respond in time. http://192.0.2.40:8181/private?token=fixture-secret" +
  '<p>Authorization: Bearer fixture-secret</p></body></html>';

test('output-budget rejections retain actionable safe diagnostics through local privacy filtering', () => {
  const privacy = require('../main/pi-session/local-model-runtime-privacy.cjs');
  const raw = 'The chat model rejected this request (400): max_completion_tokens=65536 cannot be greater than max_model_len=32768. private-fixture-secret';
  for (const value of [raw, { status: 400, message: raw },
    JSON.stringify({ error: { status: 422, message: 'max_tokens must be <= 32768' } }),
    { error: { status: 400, code: 'output_token_limit_exceeded', message: 'private-fixture-secret' } },
    'Output token limit exceeded (output_token_limit_exceeded).']) {
    for (const error of [value, privacy.safeError(value)]) {
      const info = errors.describe(error);
      assert.equal(info.code, 'output_token_limit_exceeded');
      assert.equal(info.retryable, false);
      assert.match(errors.forDisplay(error), /最大输出 Token.*模型配置.*上下文窗口/);
      assert.doesNotMatch(errors.forDisplay(error), /private-fixture-secret/);
    }
  }
  for (const value of ['400 Unsupported parameter: max_tokens',
    '400 max_tokens must be a positive integer', '400 context_length_exceeded',
    '401 max_tokens exceeds the limit', '429 max_tokens exceeds the limit',
    { error: { status: 400, code: 'insufficient_quota', message: raw } }]) {
    assert.notEqual(errors.describe(value).code, 'output_token_limit_exceeded');
  }
});

test('chat shows the thinking setting for classified Hub errors and SDK stream errors', () => {
  const hint = '该模型不支持关闭思考；请在模型高级设置把“思考能力”改为“始终开启”后重试';
  for (const status of [400, 422]) {
    const error = { type: 'soduwork_proxy_error', status, code: 'thinking_disabled_unsupported', message: secretBody };
    const expected = hint + '（HTTP ' + status + '）';
    assert.equal(errors.forDisplay({ error }), expected);
    // Pi serializes a direct HTTP error, but only retains the Hub message for SSE.
    for (const [errorMessage, display] of [[status + ': ' + JSON.stringify(error), expected], [hint, hint]]) {
      const acc = stream.create();
      acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage } });
      assert.equal(acc.uiSnapshot().completion.error, display);
    }
  }
  assert.equal(errors.forDisplay({ error: { status: 400, code: 'InvalidParameter', message: 'thinking.type' } }),
    '模型服务返回了暂时无法处理的错误（HTTP 400）');
  assert.equal(errors.forDisplay({ error: { status: 401, code: 'thinking_disabled_unsupported' } }),
    '模型服务拒绝了当前凭据或模型权限。个人服务请在「我的模型」检查个人 Key，企业服务请联系管理员核对模型授权（HTTP 401）');
});

test('a request transformed to omit the tool result cannot report a tool continuation', async () => {
  const phase = require('../main/pi-session/model-request-phase.cjs');
  let dispatch, wire;
  const agent = { async streamFunction(model, context, options) {
    wire = await options.onPayload({ messages: [{ role: 'tool', tool_call_id: 'call1' }] }, model);
  } };
  const session = { agent, subscribe(listener) { dispatch = listener; return () => {}; } };
  const acc = stream.create();
  const off = phase.subscribe(session, event => acc.push(event));
  dispatch({ type: 'agent_start' });
  const result = { role: 'toolResult', toolCallId: 'call1' };
  dispatch({ type: 'message_end', message: result });
  const replacement = { messages: [{ role: 'user', content: 'Replacement' }] };
  await agent.streamFunction({ api: 'openai-completions' }, { messages: [result] }, { onPayload: () => replacement });
  assert.equal(wire, replacement);
  dispatch({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '403 forbidden' } });
  assert.equal(acc.snapshot().completion.error, '模型请求被拒绝（HTTP 403）');
  off();
});

test('gateway HTTP status lines and HTML bodies produce stable safe summaries', () => {
  for (const value of ['504 ' + secretBody, 'HTTP/1.1 504 Gateway Time-out\n' + secretBody,
    'HTTP/2 504', '504', 'Error: 504 ' + secretBody, secretBody,
    new Error('504 ' + secretBody), { status: 504, message: secretBody }]) {
    const info = errors.describe(value);
    assert.equal(info.status, 504);
    assert.equal(info.retryable, true);
    assert.equal(errors.forDisplay(value), '模型服务暂时不可用（HTTP 504）');
  }
  for (const value of ['Gateway Time-out', 'Gateway Timeout', 'Bad Gateway',
    "The server didn't respond in time.", 'The server didnt respond in time.']) {
    assert.equal(errors.describe(value).retryable, true);
    assert.equal(errors.forDisplay(value), '模型服务暂时不可用');
  }
});

test('unknown upstream HTML, structured bodies and private addresses never leak into chat', () => {
  for (const value of ['<html><body>unexpected response from http://192.0.2.40/?token=fixture-secret</body></html>',
    '&lt;html&gt;fixture-secret&lt;/html&gt;', 'Unexpected response from http://gateway.internal/private',
    'Invalid endpoint 192.0.2.40:8181', 'Authorization: Bearer fixture-secret',
    '{"unexpected":"fixture-secret"}', { message: 'unexpected', detail: 'fixture-secret' }]) {
    assert.equal(errors.describe(value).retryable, false);
    assert.equal(errors.forDisplay(value), '模型服务返回了暂时无法处理的错误');
  }
  assert.equal(errors.forDisplay('请选择模型后继续'), '请选择模型后继续');
  assert.equal(errors.forDisplay(''), '');
});

test('permanent gateway errors remain non-retryable and both proxy envelope generations are safe', () => {
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const value = status + ' ' + secretBody;
    assert.equal(errors.describe(value).retryable, false);
    assert.match(errors.forDisplay(value), new RegExp('HTTP ' + status));
    assert.doesNotMatch(errors.forDisplay(value), /html|fixture-secret|192\.0\.2\.40/i);
  }
  for (const type of ['soduwork_proxy_error', 'soduwork_work_proxy_error']) {
    assert.equal(errors.describe(JSON.stringify({ error: { type, message: 'fixture-secret' } })).retryable, true);
    assert.doesNotMatch(errors.forDisplay({ error: { type, message: 'fixture-secret' } }), /fixture-secret|proxy_error/);
  }
  assert.equal(errors.describe('429: insufficient_quota').retryable, false);
});

test('expired model proxy tickets can refresh while generic 401 credentials stay permanent', () => {
  for (const value of [
    '401 AI proxy ticket expired',
    '401 session expired',
    '401 密钥不对或已过期',
    { error: { type: 'soduwork_proxy_error', status: 401, message: 'AI proxy ticket is required' } },
  ]) {
    const info = errors.describe(value);
    assert.equal(info.authExpired, true);
    assert.equal(info.retryable, true);
  }
  const generic = errors.describe({ status: 401, message: 'invalid credentials' });
  assert.equal(generic.authExpired, false);
  assert.equal(generic.retryable, false);
});

test('billing exhaustion is actionable and permanent without exposing the provider envelope', async () => {
  for (const value of [
    { error: { status: 429, code: '1113', message: '余额不足 Bearer fixture-secret https://private.invalid' } },
    { error: { status: 429, code: 'upstream_billing_error', providerCode: '1113', type: 'soduwork_proxy_error' } },
    '429 模型服务余额不足（billing_required；供应商错误码 1113）',
    '429 余额不足或无可用资源包',
    { error: { status: 429, code: 'insufficient_quota', message: 'fixture-secret' } },
  ]) {
    const info = errors.describe(value);
    assert.equal(info.retryable, false);
    assert.equal(info.code, 'upstream_billing_error');
    assert.match(info.publicText, /余额不足.*账单.*接口地址/);
    assert.doesNotMatch(info.publicText, /fixture-secret|private.invalid|Bearer/);
  }
  assert.match(errors.forDisplay({ error: { status: 429, code: '1113' } }), /供应商错误码 1113/);
  assert.equal(errors.describe({ error: { status: 429, code: '11130', message: 'rate limited' } }).retryable, true);
  const sdk = await import('@earendil-works/pi-ai');
  assert.equal(sdk.isRetryableAssistantError({ stopReason: 'error', errorMessage:
    '429 模型服务余额不足或计费额度不可用（billing_required；供应商错误码 1113）' }), false);
});

test('image rejection errors explain the safe recovery path without offering a blind retry', () => {
  const value = { error: { code: 'image_input_rejected', message: 'Image input rejected.', status: 400 } };
  const info = errors.describe(value);
  assert.equal(info.retryable, false);
  assert.equal(errors.forDisplay(value), '当前模型不接受图片输入，请切换支持图片的模型或启用视觉适配（HTTP 400）');
});

test('a verified tool phase preserves recognized quota and billing diagnostics', () => {
  for (const error of [{ status: 403, detail: { code: 'TOKEN_QUOTA_EXCEEDED' } },
    { error: { status: 403, code: 'insufficient_balance' } }]) {
    const info = errors.describe(error, true);
    assert.equal(info.retryable, false);
    assert.match(info.publicText, /额度/);
    assert.equal(info.publicText, errors.forDisplay(error));
  }
});

test('public stream snapshots hide gateway bodies but retain interrupted state and completed work', () => {
  const acc = stream.create(), raw = '504 ' + secretBody;
  acc.push({ type: 'agent_start' });
  acc.push({ type: 'message_start', message: { role: 'assistant', content: [] } });
  acc.push({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: raw,
    content: [{ type: 'text', text: '文件已保存，正在完成总结。' }] } });
  acc.push({ type: 'tool_execution_start', toolCallId: 'saved', toolName: 'write' });
  acc.push({ type: 'tool_execution_end', toolCallId: 'saved', toolName: 'write', result: { content: [{ type: 'text', text: 'saved' }] } });
  acc.push({ type: 'auto_retry_start', attempt: 1, maxAttempts: 1, errorMessage: raw });
  acc.push({ type: 'auto_retry_end', success: false, attempt: 1, finalError: raw });
  acc.push({ type: 'agent_settled' });
  for (const snapshot of [acc.snapshot(), acc.uiSnapshot()]) {
    assert.equal(snapshot.status, 'unreachable');
    assert.equal(snapshot.completion.reason, 'error');
    assert.equal(snapshot.completion.retryable, true);
    assert.equal(snapshot.completion.error, '模型服务暂时不可用（HTTP 504）');
    assert.match(snapshot.statusText, /已有内容和工具结果已保留，可恢复这一轮继续/);
    assert.equal(snapshot.tools.length, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /html|fixture-secret|192\.0\.2\.40/i);
    assert.match(snapshot.messages[0].blocks[0].text, /文件已保存/);
  }
  assert.equal(acc.state.lastAssistantError, raw, 'raw failure remains only in internal diagnostic state');
});

test('legacy Hub capacity messages retain retryability without guessing unrelated localized errors', () => {
  for (const raw of ['模型并发调度连接中断，请稍后重试', '模型并发调度暂时不可用，请稍后重试']) {
    assert.equal(errors.describe(raw).status, 503);
    assert.equal(errors.describe(raw).retryable, true);
    assert.equal(errors.forDisplay(raw), '模型服务暂时不可用（HTTP 503）');
  }
  for (const raw of ['模型等待队列已满，请稍后重试', '等待模型服务超时，请稍后重试']) {
    assert.equal(errors.describe(raw).status, 429);
    assert.equal(errors.describe(raw).retryable, true);
  }
  assert.equal(errors.describe('模型未授权，请稍后重试').retryable, false);
  assert.equal(errors.describe({status: 403, message: '模型并发调度连接中断，请稍后重试'}).retryable, false);
  const acc = stream.create();
  acc.push({type: 'agent_start'});
  acc.push({type: 'message_end', message: {role: 'assistant', stopReason: 'error',
    errorMessage: '模型并发调度连接中断，请稍后重试'}});
  acc.push({type: 'agent_settled'});
  assert.equal(acc.snapshot().completion.retryable, true);
  assert.match(acc.snapshot().statusText, /可恢复这一轮继续/);
});

test('premature provider streams remain recoverable after bounded SDK retries', () => {
  for (const raw of ['terminated', 'other side closed', 'Connection lost',
    'OpenAI Completions stream ended without a stop reason',
    'Anthropic stream ended before message_stop',
    'OpenAI Responses stream ended before a terminal response event',
    'WebSocket closed', 'socket connection was closed']) {
    assert.equal(errors.describe(raw).retryable, true, raw);
    assert.equal(errors.forDisplay(raw), '模型服务暂时不可用');
    assert.equal(errors.describe('403: ' + raw).retryable, false);
    assert.equal(errors.describe('429: insufficient_quota ' + raw).retryable, false);
  }
  for (const raw of ['Request was aborted', 'Access denied by user or policy.', 'Process terminated with exit code 1']) {
    assert.equal(errors.describe(raw).retryable, false, raw);
  }
});

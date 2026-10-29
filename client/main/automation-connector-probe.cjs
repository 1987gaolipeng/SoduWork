'use strict';
// Authorize saved connections before reviewed identity probes; do not send business messages or persist temporary tickets.
const { fetchWithDeviceAuthRetry } = require('./device-auth-request');
const VIRTUAL = new Set(['soduwork-media']);
const strings = value => [...new Set((Array.isArray(value) ? value : [])
  .map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20);
const row = (name, state, label) => ({ key: 'connector', name, state, label });

async function probe(identity, names, { fetchImpl = global.fetch, timeoutMs = 45000 } = {}) {
  const wanted = strings(names).filter(name => !VIRTUAL.has(name));
  if (!wanted.length) return [];
  const signal = AbortSignal.timeout(timeoutMs);
  const hub = String(identity.hub || '').replace(/\/+$/, '');
  async function device(route, body, allowFailed = false) {
    const response = await fetchWithDeviceAuthRetry(identity, hub + '/api/v1' + route, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, fetchImpl);
    if (!response.ok) throw Object.assign(Error('连接器授权暂时无法检查'), { status: response.status });
    const data = await response.json();
    if (!data || data.ok === false && !allowFailed) throw Error('连接器授权暂时无法检查');
    return data;
  }
  try {
    const catalog = await device('/mcp-servers');
    const selected = new Set(catalog.enabledCompany || []);
    const company = (catalog.company || []).filter(item => selected.has(item.name) && item.enabled !== false);
    const companyNames = new Set(company.map(item => String(item.name).toLowerCase()));
    const personal = (catalog.personal || []).filter(item => item.enabled !== false &&
      item.approved === true && !companyNames.has(String(item.name).toLowerCase()));
    const available = new Set([...company, ...personal].map(item => item.name));
    const missing = wanted.filter(name => !available.has(name));
    if (missing.length) return missing.map(name => row(name, 'blocked', '连接器未配置、未启用或未授权：' + name));
    const authorized = await device('/plugins/conversation-grant', {
      pluginIds: [], personalMcpServers: wanted,
      resourceProtocol: 1, conversationId: 'automation-preflight',
    });
    const grant = authorized.mcpGrant;
    if (!grant?.ticket || wanted.some(name => !grant.servers?.includes(name))) {
      return wanted.map(name => row(name, 'blocked', '连接器尚未获得使用授权：' + name));
    }
    const results = new Array(wanted.length);
    let cursor = 0;
    // Bound concurrency to limit local process bursts; the shared timeout includes queue time.
    await Promise.all(Array.from({ length: Math.min(3, wanted.length) }, async () => {
      while (cursor < wanted.length) {
        const index = cursor++, name = wanted[index];
        try {
          signal.throwIfAborted();
          const companyRow = company.find(item => item.name === name);
          const personalRow = personal.find(item => item.name === name);
          const checked = companyRow
            ? await device('/mcp-servers/company/' + encodeURIComponent(companyRow.id) + '/probe', {}, true)
            : await device('/mcp-servers/probe', personalRow, true);
          const state = checked.connectionState || 'configured';
          const ready = checked.ok !== false && (checked.tools || []).length > 0;
          const label = state === 'verified' && checked.authenticationTested === true
            ? '账号授权已验证；资源权限以执行时为准：'
            : state === 'needs_auth' ? '账号授权已失效或权限不足，请重新连接：'
            : state === 'offline' ? '执行机不在线，请启动对应客户端或云端电脑：'
            : ready ? '配置及工具清单就绪，业务授权尚未验证：'
            : '连接器暂时无法验证，请检查配置和执行机：';
          results[index] = { ...row(name, ready ? 'ready' : state === 'needs_auth' ? 'blocked' : 'waiting', label + name),
            connectionState: state, authenticationTested: checked.authenticationTested === true,
            checkedAt: checked.checkedAt || '', runOn: checked.runOn || 'runner' };

        } catch (_) {
          results[index] = row(name, 'waiting', '连接器暂时无法验证，请检查连接后重试：' + name);
        }
      }
    }));
    return results;
  } catch (error) {
    const denied = error.status === 401 || error.status === 403 || error.status === 409;
    return wanted.map(name => row(name, denied ? 'blocked' : 'waiting',
      (denied ? '连接器授权已失效，请重新连接：' : '连接器暂时无法验证，请检查连接后重试：') + name));
  }
}
module.exports = { probe };

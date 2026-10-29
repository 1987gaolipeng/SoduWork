/* Complete a plugin's declared MCP connection before opening a trial. */
(function (global) {
  'use strict';
  const VIRTUAL_MCP_SERVERS = new Set(['soduwork-media']);
  const MAX_TEMPLATE_BYTES = 1024 * 1024;
  let intent = 0;
  function isVirtual(name) { return VIRTUAL_MCP_SERVERS.has(String(name || '').trim()); }
  function sameName(left, right) { return String(left || '').toLowerCase() === String(right || '').toLowerCase(); }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }

  // Templates declare connection methods; the current account supplies credentials through the existing write-only editor.
  function cleanTemplate(text, name) {
    let doc;
    try { doc = JSON.parse(text); } catch { throw Error('连接模板 JSON 格式不正确'); }
    if (!object(doc) || Object.keys(doc).some(key => key !== 'mcpServers') ||
        !object(doc.mcpServers) || Object.keys(doc.mcpServers).length !== 1 || !Object.hasOwn(doc.mcpServers, name)) {
      throw Error('连接模板必须只声明当前插件需要的同名连接器');
    }
    const row = doc.mcpServers[name];
    const allowed = new Set(['type', 'url', 'command', 'args', 'headers', 'env', 'description', 'enabled',
      'enabledTools', 'disabledTools', 'startupTimeoutSeconds', 'toolTimeoutSeconds', 'apiDefinition']);
    if (!object(row) || Object.keys(row).some(key => !allowed.has(key))) {
      throw Error('连接模板包含不支持的字段；账号授权需在连接配置页完成');
    }
    const type = row.type || (row.url ? 'http' : 'stdio');
    if (!['http', 'streamable-http', 'stdio'].includes(type)) throw Error('连接模板仅支持 HTTP 或可信本地模板');
    if (type === 'stdio') {
      if (typeof row.command !== 'string' || !row.command.trim() || row.command.length > 200 ||
          (row.args != null && (!Array.isArray(row.args) || row.args.length > 30 ||
            row.args.some(arg => typeof arg !== 'string' || arg.length > 400 || /token|secret|password|api.?key/i.test(arg))))) {
        throw Error('本地连接模板命令或参数不合法');
      }
    } else {
      let url;
      try { url = new URL(row.url); } catch { throw Error('连接模板地址不合法'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash ||
          [...url.searchParams.keys()].some(key => /token|secret|password|signature|api.?key|authorization|^key$/i.test(key))) {
        throw Error('连接模板地址不能携带凭据');
      }
    }
    const copy = { ...row, type: type === 'streamable-http' ? 'http' : type, enabled: false };
    if (row.apiDefinition !== undefined || row.command === 'soduwork-api') {
      const definition = row.apiDefinition;
      if (type !== 'stdio' || row.command !== 'soduwork-api' || row.url ||
          row.headers && Object.keys(row.headers).length || (row.args || []).length ||
          !object(definition) || definition.schemaVersion !== 1 || !object(definition.openapiDocument) ||
          !/^3\.(0|1)\./.test(definition.openapiDocument.openapi || '')) {
        throw Error('接口连接模板需要完整的接口定义，不能混用命令或服务地址');
      }
      // Only forward the source document. The Hub recompiles it before preview;
      // supplied tools, credential fields and hashes never grant permission.
      copy.apiDefinition = { schemaVersion: 1, openapiDocument: definition.openapiDocument };
    }

    for (const field of ['headers', 'env']) {
      if (row[field] == null) continue;
      if (!object(row[field])) throw Error('连接模板凭据字段格式不正确');
      copy[field] = {};
      for (const [key, value] of Object.entries(row[field])) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) || key === '__proto__' || typeof value !== 'string' || value.trim()) {
          throw Error('连接模板不能携带凭据值，请重新制作无凭据模板');
        }
        copy[field][key] = '';
      }
    }
    if (/(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|(?:token|password|secret|api.?key)\s*[:=]\s*["']?[^\s"']{8,}/i.test(String(row.description || ''))) {
      throw Error('连接模板说明疑似包含凭据');
    }
    return JSON.stringify({ mcpServers: { [name]: copy } });
  }

  async function templateFor(item, name, api) {
    const path = 'references/connections/' + name + '.mcp.json';
    const declared = (item.capabilities?.resources || []).filter(row => row.path === path);
    // Enterprise catalog resources have no body endpoint yet; legacy plugins retain manual configuration.
    if (!item.personal || !declared.length) return null;
    if (declared.length !== 1 || !item.pluginId || !item.checksum || !item.version || !api.personalPlugin) {
      throw Error('未能确认插件连接模板版本，请重新打开插件后重试');
    }
    const response = await api.personalPlugin(item.pluginId);
    const detail = response?.plugin;
    if (!detail || detail.pluginId !== item.pluginId || detail.checksum !== item.checksum || detail.version !== item.version ||
        detail.localDraft?.version !== item.version || !(detail.localDraft.mcpServers || []).includes(name)) {
      throw Error('插件版本已变化，请重新打开插件后配置连接');
    }
    const resources = (detail.localDraft.resources || []).filter(row => row.path === path);
    const resource = resources[0], expected = declared[0];
    if (resources.length !== 1 || resource.kind !== 'reference' || expected.kind !== 'reference' ||
        resource.sha256 !== expected.sha256 || !/^[a-f0-9]{64}$/.test(resource.sha256 || '') ||
        resource.size !== expected.size || !Number.isInteger(resource.size) || resource.size > MAX_TEMPLATE_BYTES ||
        typeof resource.content !== 'string' || resource.content.length > Math.ceil(MAX_TEMPLATE_BYTES / 3) * 4) {
      throw Error('插件连接模板与当前版本的资源清单不一致');
    }
    let bytes;
    try {
      bytes = resource.encoding === 'base64' ? Uint8Array.from(atob(resource.content), c => c.charCodeAt(0))
        : resource.encoding === 'utf8' ? new TextEncoder().encode(resource.content) : null;
      if (!bytes || bytes.length !== resource.size) throw Error();
    } catch { throw Error('连接模板资源编码或大小不正确'); }
    const hash = Array.from(new Uint8Array(await global.crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== resource.sha256) throw Error('连接模板资源校验未通过');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw Error('连接模板必须使用 UTF-8'); }
    return new File([cleanTemplate(text, name)], name + '.mcp.json', { type: 'application/json' });
  }

  async function ensure(item, options) {
    const request = ++intent;
    let revision = options.viewRevision?.();
    const active = () => request === intent && (!options.viewRevision || options.viewRevision() === revision);
    // Opening the requested panel/modal belongs to this flow. Any later close,
    // tab change or other modal increments the view revision and cancels it.
    const ownView = (open, ...args) => {
      const result = open(...args); revision = options.viewRevision?.(); return result;
    };
    const platformNames = global.SoduWorkPluginPlatforms?.forItem(item) || [];
    const required = (item?.capabilities?.mcpServers || [])
      .map(name => String(name || '').trim()).filter(Boolean)
      .filter(name => !platformNames.includes(name) && !isVirtual(name));
    if (!required.length) return true;
    let catalog;
    try { catalog = await options.api.myMcpServers(); }
    catch (error) {
      if (active()) options.say(options.errorText(error, '无法检查插件需要的连接器'));
      return false;
    }
    if (!active()) return false;
    catalog = catalog || { company: [], personal: [], enabledCompany: [] };
    options.setCatalog(catalog);
    const company = new Set(catalog.enabledCompany || []);
    const available = new Set([
      ...(catalog.personal || []).filter(row => row.enabled).map(row => String(row.name || '')),
      ...(catalog.company || []).filter(row => company.has(row.name)).map(row => String(row.name || '')),
    ]);
    const missing = required.filter(name => !available.has(name));
    if (!missing.length) return true;
    await ownView(options.openPanel);
    if (!active()) return false;
    const name = missing[0];
    const resumeWhenEnabled = result => {
      if ((result?.personal || []).some(row => row.name === name && row.enabled)) return options.resume();
      options.say('连接已保存，保持停用；测试并启用后可试用插件');
    };
    options.say('「' + String(item.name || '这个插件') + '」还需要连接 ' + missing.join('、'));
    const existing = (catalog.personal || []).find(row => sameName(row.name, name));
    if (existing) {
      options.openEditor(existing, null, { onSaved: resumeWhenEnabled });
      return false;
    }
    if ((catalog.company || []).some(row => sameName(row.name, name))) {
      options.say('公司已有同名连接，请在连接列表中确认并手动启用；不会覆盖原配置');
      return false;
    }
    try {
      const file = await templateFor(item, name, options.api);
      if (!active()) return false;
      if (file && options.openImport) {
        ownView(options.openImport, { file, beforeImport: async () => {
          if (!active()) throw Error('配置入口已变化，请重新打开插件');
          await templateFor(item, name, options.api);
          const latest = await options.api.myMcpServers();
          if ([...(latest.personal || []), ...(latest.company || [])].some(row => sameName(row.name, name))) {
            throw Error('同名连接已存在，请关闭此预览并从连接列表编辑；不会覆盖原配置');
          }
          if (!active()) throw Error('配置入口已变化，请重新打开插件');
        }, onSaved: resumeWhenEnabled });
        return false;
      }
    } catch (error) {
      if (active()) options.say(options.errorText(error, '无法读取插件连接模板'));
      return false;
    }
    options.openEditor(null, null, {
      name, description: '供插件「' + String(item.name || '') + '」调用', onSaved: options.resume,
    });
    return false;
  }
  global.SoduWorkPluginMcpGate = { ensure, isVirtual, cleanTemplate, templateFor };
})(window);

/* Recognize connector configuration while preserving drafts and tool restrictions on failure. */
(function (global) {
  'use strict';
  const aliases = {
    enabledTools: 'enabled_tools', disabledTools: 'disabled_tools',
    startupTimeoutSeconds: 'startup_timeout_sec', toolTimeoutSeconds: 'tool_timeout_sec'
  };
  const supported = new Set(['name','description','descriptionForHuman','type','url','serverUrl','endpoint','baseUrl',
    'headers','http_headers','command','args','env','enabled','disabled','id','templateKey',
    ...Object.keys(aliases),...Object.values(aliases)]);
  function readUrl(value) {
    let url;try{url=new URL(value);}catch(_){throw Error('连接地址无效，请检查后重试');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('请使用 HTTP 或 HTTPS 连接地址，不要将凭据写入地址');
    return url;
  }
  function parse(text) {
    text = String(text || '').trim();
    if (!text) throw Error('粘贴连接地址或配置即可');
    if (text.length > 1024 * 1024) throw Error('配置超过 1 MB，请使用较小的文件');
    if (/^https?:\/\/[^\s]+$/i.test(text)) {
      const url = readUrl(text);
      return [{name:url.hostname.replace(/^www\./i,''),type:'http',url:text}];
    }
    let parsed;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/,'')); }
    catch (_) { throw Error('配置格式不完整，请粘贴完整 JSON，或使用“导入配置”读取 TOML 文件'); }
    const map = parsed && (parsed.mcpServers || parsed.mcp_servers || parsed.servers);
    const entries = map ? (Array.isArray(map) ? map.map((r,i)=>[r?.name||String(i+1),r]) : Object.entries(map))
      : [[parsed?.name || '', parsed]];
    if (!entries.length || entries.length > 100) throw Error('配置需要包含 1–100 个连接');
    return entries.map(([name,row]) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('连接配置必须为对象');
      const unknown = Object.keys(row).filter(k => !supported.has(k));
      if (unknown.length) throw Error('此配置需要适配这些字段：' + unknown.join('、') + '。请使用导入配置检查，不会忽略它们。');
      const url = row.url || row.serverUrl || row.endpoint || row.baseUrl;
      if (row.command || row.type === 'stdio') return {name:String(row.name||name),type:'stdio',command:row.command};
      if (!url || row.type && !['http','streamable-http'].includes(row.type)) throw Error('仅支持 HTTP 连接；本地工具请从目录选择或导入');
      const parsedUrl=readUrl(url);
      const result = {name:String(row.name||name||parsedUrl.hostname),type:'http',url:String(url),
        description:String(row.description||row.descriptionForHuman||''),headers:row.headers||row.http_headers||{}};
      if (typeof result.headers !== 'object' || Array.isArray(result.headers) ||
        Object.values(result.headers).some(x=>typeof x !== 'string')) throw Error('鉴权头需要使用文本键值');
      if (row.headers && row.http_headers && JSON.stringify(row.headers)!==JSON.stringify(row.http_headers)) throw Error('两份鉴权头不一致，请先确认');
      for (const [key,alias] of Object.entries(aliases)) {
        if (row[key] !== undefined && row[alias] !== undefined && JSON.stringify(row[key])!==JSON.stringify(row[alias])) throw Error(key+' 的两份配置不一致');
        const value = row[key] ?? row[alias];
        if (value === undefined) continue;
        if (key.endsWith('Tools')) {
          if (!Array.isArray(value) || value.some(x=>typeof x!=='string'||!x.trim()||x.includes('*'))) throw Error('工具范围需要明确列出工具名');
          result[key] = [...new Set(value)];
        } else {
          if (!Number.isInteger(value) || value < 3 || value > (key.startsWith('startup')?120:300)) throw Error('超时配置超出允许范围');
          result[key] = value;
        }
      }
      if ((result.enabledTools||[]).some(x=>(result.disabledTools||[]).includes(x))) throw Error('同一工具不能同时启用和禁用');
      if (row.env && Object.keys(row.env).length) throw Error('远程连接不能使用本地环境变量，请先适配鉴权配置');
      return result;
    });
  }
  function status(result, commercial) {
    if (result?.ok === false) return {state:'bad',title:'连接未完成',detail:result.error||result.message||'请检查授权后重试'};
    if (result?.authenticationTested === false || commercial && result?.authenticationTested !== true)
      return {state:'idle',title:'连接配置已就绪',detail:'业务授权尚未验证，首次使用时会继续检查'};
    return {state:'ok',title:'连接可用',detail:'可用于对话、插件和自动化'};
  }
  function summary(value) {return String(value||'').replace(/^.*?通用连接器[^：]*：/,'').split('。')[0];}
  function credentialPaste(key, text) {
    if (!/(?:_PEM|_PRIVATE_KEY)$/.test(String(key)) || !/^-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----[\r\n]/.test(String(text).trim())) return null;
    return String(text).trim().replace(/\r\n?/g,'\n').replace(/\n/g,'\\n');
  }
  function apiTemplate(spec) {
    const def=spec?.apiDefinition;if(!def||spec.command!=='soduwork-api')return null;
    return {key:'api:'+def.id,name:def.name,description:def.description,configurable:true,
      connectionFields:def.fields||[],tools:def.tools||[],template:{command:'soduwork-api',args:[]},
      limitations:[],apiDefinition:def};
  }
  const api = {parse,status,summary,credentialPaste,apiTemplate};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SoduWorkConnectorConfig = api;
})(typeof window === 'undefined' ? globalThis : window);

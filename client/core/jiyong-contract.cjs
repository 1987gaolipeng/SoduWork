'use strict';
// Portable, bounded declaration shared by installation and the hosted runtime.
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
const types = ['string', 'number', 'boolean', 'array', 'object'];
const displays = ['text', 'textarea', 'number', 'switch', 'select', 'multiselect', 'password', 'hidden'];
function key(v) {
  if (typeof v !== 'string' || !KEY.test(v) || blocked.has(v)) throw Error('即用标识无效');
  return v;
}
function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function only(v, names) {
  if (!object(v) || Object.keys(v).some(k => !names.includes(k))) throw Error('即用声明包含不支持的字段');
}
function json(v, max = 65536) {
  let count = 0;
  function walk(x, depth) {
    if (++count > 10000 || depth > 10) throw Error('即用数据嵌套或数量超限');
    if (x === null || typeof x === 'boolean' || typeof x === 'string') return;
    if (typeof x === 'number' && Number.isFinite(x)) return;
    if (Array.isArray(x)) return x.forEach(y => walk(y, depth + 1));
    if (object(x) && Object.getPrototypeOf(x) !== null) return Object.entries(x).forEach(([k,y]) => {
      if (blocked.has(k)) throw Error('即用数据字段无效');
      walk(y, depth + 1);
    });
    throw Error('即用数据必须是 JSON');
  }
  walk(v, 0);
  if (Buffer.byteLength(JSON.stringify(v)) > max) throw Error('即用数据过大，请将文件保存为附件');
  return structuredClone(v);
}
function value(field, v) {
  json(v);
  const type = Array.isArray(v) ? 'array' : typeof v;
  if (v === null || type !== field.type || (field.options?.length && (Array.isArray(v) ? v : [v]).some(x => !field.options.includes(x)))) throw Error('即用参数类型或选项无效：' + field.key);
  return v;
}
function normalize(raw) {
  only(raw, ['version', 'parameters', 'collections', 'mcp', 'initialization', 'storage']);
  if (raw.version !== 1) throw Error('即用声明版本不受支持');
  function list(v, max) { if (v == null) return []; if (!Array.isArray(v) || v.length > max) throw Error('即用声明数量超限'); return v; }
  function unique(rows) { if (new Set(rows.map(r => r.key)).size !== rows.length) throw Error('即用标识重复'); return rows; }
  const parameters = unique(list(raw.parameters, 40).map(p => {
    only(p, ['key','type','display','label','secret','default','options']);
    if (!types.includes(p.type) || !displays.includes(p.display)) throw Error('即用参数类型或显示类型无效');
    const allowed = {text:'string',textarea:'string',password:'string',number:'number',switch:'boolean',select:'string',multiselect:'array'};
    if (allowed[p.display] && p.type !== allowed[p.display]) throw Error('即用参数显示类型与值类型不匹配');
    if (p.secret != null && typeof p.secret !== 'boolean') throw Error('即用秘密标记必须为布尔值');
    const options = list(p.options, 50);
    if (options.some(v => typeof v !== 'string' || v.length > 200)) throw Error('即用参数选项无效');
    const out = {key:key(p.key),type:p.type,display:p.display,label:String(p.label || p.key).slice(0,120),secret:p.secret === true, ...(options.length ? {options} : {})};
    if (Object.hasOwn(p,'default')) {
      if (out.secret || /ukey|token|secret|password|credential|api.?key/i.test(out.key) || /(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}/.test(JSON.stringify(p.default))) throw Error('秘密参数不可内置默认值');
      out.default = value(out, p.default);
    }
    return out;
  }));
  const collections = unique(list(raw.collections, 20).map(c => {
    only(c, ['key','indexes']);
    return {key:key(c.key),indexes:[...new Set(list(c.indexes, 8).map(key))]};
  }));
  let mcp;
  if (raw.mcp != null) {
    only(raw.mcp, ['server','bindings']);
    if (!/^[a-z][a-z0-9-]{0,59}$/.test(raw.mcp.server)) throw Error('即用 MCP 名称无效');
    const bindings = list(raw.mcp.bindings, 40).map(b => {
      only(b, ['tool','argument','parameter']);
      const parameter = key(b.parameter), field = parameters.find(p => p.key === parameter);
      if (!field) throw Error('MCP 引用未声明的即用参数');
      return {tool:key(b.tool),argument:key(b.argument),parameter};
    });
    if (new Set(bindings.map(b => b.tool + ':' + b.argument)).size !== bindings.length) throw Error('MCP 参数绑定重复');
    mcp = {server:raw.mcp.server,bindings};
    if (mcp.server === 'soduwork-jiyong' && bindings.some(b => parameters.find(p => p.key === b.parameter).secret)) throw Error('秘密参数不能绑定本地数据工具');
  }
  let initialization;
  if(raw.initialization!=null){only(raw.initialization,['script']);const script=raw.initialization.script;if(typeof script!=='string'||!/^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/.test(script))throw Error('初始化脚本须为 assets 下的 JSON 文件');initialization={script};}
  let storage;
  if (raw.storage != null) {
    only(raw.storage, ['location']);
    if (!['local','cloud'].includes(raw.storage.location)) throw Error('数据位置必须为 local 或 cloud');
    storage = {location:raw.storage.location};
    if (storage.location === 'cloud' && !initialization) throw Error('云端数据必须声明版本化初始化 JSON');
  }
  return {version:1,parameters,collections,...(mcp ? {mcp} : {}),...(initialization ? {initialization}: {}),...(storage ? {storage} : {})};
}
function dataRequest(method, raw, declaration) {
  const options = json(raw);
  const def = declaration?.collections?.find(c => c.key === options.collection);
  if (!def) throw Error('即用未声明此数据集合');
  const out = {collection:def.key};
  if (method === 'data.list') {
    only(options,['collection','limit','after','filter']);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('分页数量必须在 1–200 之间');
    out.limit = limit;
    // An empty cursor means the first page, matching the omitted/null form.
    // Do not relax key() for record IDs or collection declarations.
    if (options.after == null || options.after === '') out.after = '';
    else {
      try { out.after = key(options.after); }
      catch (_) { throw Error('data.list.after 分页游标无效：第一页省略 after，后续使用上一页 next'); }
    }
    out.filter = options.filter || {};
    if (!object(out.filter) || Object.keys(out.filter).some(k => !def.indexes.includes(k)) || Object.values(out.filter).some(v => v !== null && !['string','number','boolean'].includes(typeof v))) throw Error('过滤只能使用已声明索引的标量字段');
  } else if (method === 'data.get') {
    only(options,['collection','id']); out.id = key(options.id);
  } else if (method === 'data.batch') {
    only(options,['collection','operations']);
    if (!Array.isArray(options.operations) || !options.operations.length || options.operations.length > 100) throw Error('原子批量需要 1–100 个操作');
    out.operations = options.operations.map(op => {
      only(op,['id','value','delete','expectedRevision']);
      const row = {id:key(op.id),expectedRevision:op.expectedRevision};
      if (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0) throw Error('写入必须声明 expectedRevision；新增使用 0');
      if (op.delete === true) return {...row,delete:true};
      if (!object(op.value)) throw Error('记录必须是 JSON 对象');
      return {...row,value:json(op.value)};
    });
    if (new Set(out.operations.map(op => op.id)).size !== out.operations.length) throw Error('批量操作包含重复记录');
  } else throw Error('即用数据方法未开放');
  return out;
}
function assetRequest(method,p) {
  if (method === 'data.assetGet') {
    only(p,['id','appId']);
    if (!/^asset_[a-f0-9]{64}$/.test(p.id)) throw Error('即用素材标识无效');
    return {id:p.id,...(p.appId != null ? {appId:String(p.appId)} : {})};
  }
  only(p,['name','type','data','appId']);
  if (!(p.data instanceof Uint8Array) || p.data.byteLength > 8*1024*1024 || !p.data.byteLength ||
      typeof p.name !== 'string' || p.name.length > 160 || /[\\/\x00-\x1f]/.test(p.name) ||
      typeof p.type !== 'string' || p.type.length > 160 || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(p.type)) throw Error('即用素材格式无效，单文件最多8MiB');
  return {name:p.name,type:p.type,data:p.data,...(p.appId != null ? {appId:String(p.appId)} : {})};
}
module.exports = {normalize,key,json,value,dataRequest,assetRequest};

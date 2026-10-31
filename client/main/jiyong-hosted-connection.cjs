'use strict';
// A capability of an accepted installation, never a second task/scheduler state.
const store = require('./app-settings-store.cjs');
const contract = require('../core/jiyong-contract.cjs');
const packagePage = require('../core/plugin-package-page.cjs');
let dependencies;
function configure(deps) { dependencies = deps; }
function context(app,pluginId) {
  if (!pluginId || !app) return null;
  const local = pluginId.startsWith('local:');
  let installed;
  const origin = packagePage.origin(pluginId), bound = {pluginId,origin};
  if (local) {
    try { installed = require('./personal-plugins').get(app,pluginId); } catch (_) { return null; }
  } else {
    try { installed = store.read(bound).hosted; } catch (_) { return null; }
  }
  const raw = installed?.jiyong || installed?.localDraft?.jiyong;
  if (!raw || raw.mcp?.server !== 'soduwork-jiyong') return null;
  if (local && !installed.enabled) throw Error('即用已停用');
  const declaration = contract.normalize(raw);
  const pages = installed.ui?.contributions?.filter(r => r.slot === 'workspace.navigation' && r.source?.type === 'package' && r.source.bridge?.capabilities?.includes('mcp.connect')) || [];
  if (pages.length !== 1 || !installed.capabilities?.mcpServers?.includes(declaration.mcp.server)) throw Error('即用宿主 MCP 需要唯一包内入口及同名连接声明');
  const entry = pages[0], capabilities = entry.source.bridge.capabilities;
  const expectedScope = store.scope(bound), version = local ? installed.checksum : installed.versionId;
  const check = () => {
    if (store.scope(bound) !== expectedScope) throw Error('即用账号已变化');
    if (local) {
      const current = require('./personal-plugins').get(app,pluginId);
      if (!current.enabled || current.checksum !== version) throw Error('即用安装已变化');
    }
  };
  const readCurrent = () => { check(); return {token:expectedScope,revision:store.read(bound).revision}; };
  const initial = readCurrent();
  const properties = {collection:{type:'string'},appId:{type:'string',description:'目标即用标识；省略为当前即用。仅当前 SoduWork 账号的数据'}};
  const tools = [
    {name:'data_apps',description:'发现当前 SoduWork 账号下即用与业务数据集合；跨即用协作无需单独分享授权',inputSchema:{type:'object',properties:{},additionalProperties:false}},
    {name:'data_get',description:'读取当前即用的一条持久记录',inputSchema:{type:'object',properties:{...properties,id:{type:'string'}},required:['collection','id'],additionalProperties:false}},
    {name:'data_list',description:'分页读取当前即用；filter 只允许声明的索引字段',inputSchema:{type:'object',properties:{...properties,limit:{type:'integer',minimum:1,maximum:200},after:{type:'string'},filter:{type:'object'}},required:['collection'],additionalProperties:false}},
    {name:'data_batch',description:'原子批量写入。先读取修订号；新增 expectedRevision=0；冲突后重新读取合并',inputSchema:{type:'object',properties:{...properties,operations:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{id:{type:'string'},value:{type:'object'},delete:{type:'boolean'},expectedRevision:{type:'integer',minimum:0}},required:['id','expectedRevision'],additionalProperties:false}}},required:['collection','operations'],additionalProperties:false}},
  ].filter(t => capabilities.includes(t.name === 'data_batch' ? 'data.write' : 'data.read'));
  async function authorize() {
    check();
    if (!local) {
      if (!dependencies) throw Error('即用宿主尚未就绪');
      const latest = await require('./app-installed-remote.cjs').get(dependencies,pluginId,check);
      if (latest.versionId !== version || JSON.stringify(latest.jiyong) !== JSON.stringify(raw) || JSON.stringify(latest.ui) !== JSON.stringify(installed.ui)) throw Error('即用已安装版本或授权变化，请重新打开');
    }
  }
  const connection = {pluginId,server:declaration.mcp.server,url:origin+'/mcp',origin,contributionId:entry.id,
    ...(local ? {} : {versionId:version}),credentialKey:'hosted',scope:expectedScope,expiresAt:Number.MAX_SAFE_INTEGER,
    ...initial,readCurrent,authorize,context:{},hosted:true,
    async invoke(body) {
      await authorize();
      if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') throw Error('JSON-RPC 请求无效');
      if (body.method.startsWith('notifications/')) return null;
      const reply = result => ({jsonrpc:'2.0',id:body.id,result});
      if (body.method === 'initialize') return reply({protocolVersion:'2025-03-26',serverInfo:{name:'soduwork-jiyong',version:'1.0.0'},capabilities:{tools:{}}});
      if (body.method === 'ping') return reply({});
      if (body.method === 'tools/list') return require('./jiyong-mcp-bindings.cjs').output(reply({tools:structuredClone(tools)}),declaration.mcp.bindings,[]);
      if (body.method !== 'tools/call') return {jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'方法未开放'}};
      try {
        const tool = tools.find(t => t.name === body.params?.name);
        if (!tool) throw Error('即用工具未授权');
        const args = contract.json(body.params.arguments || {});
        for (const b of declaration.mcp.bindings.filter(b => b.tool === tool.name)) {
          const field = declaration.parameters.find(p => p.key === b.parameter);
          if (field.secret) throw Error('秘密参数不能写入即用业务数据');
          const current = store.read(bound).values;
          const v = Object.hasOwn(current,b.parameter) ? current[b.parameter] : field.default;
          contract.value(field,v); args[b.argument] = v;
        }
        const result = await require('./jiyong-data-access.cjs').request(dependencies || {app},bound,installed,tool.name.replace('_','.'),args,check);
        return reply({content:[{type:'text',text:JSON.stringify(result)}]});
      } catch (error) { return reply({isError:true,content:[{type:'text',text:String(error.message)}]}); }
    }};
  return {pluginId,pageUrl:origin+'/'+entry.source.entry,requiresMcp:true,connection};
}
module.exports = {configure,context};

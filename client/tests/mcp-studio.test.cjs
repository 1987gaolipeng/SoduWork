'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const personal=require('../main/personal-plugins'),resources=require('../main/plugin-resources');
const {prepare}=require('../../skills/mcp-studio/scripts/mcp-config.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-mcp-studio-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,app:{getPath:()=>root}};
}
test('MCP quick configuration is discoverable, resolves and materializes in existing conversation plugins',t=>{
  const {root,app}=fixture(t),item=personal.catalog(app).find(x=>x.pluginId===personal.MCP_STUDIO_ID);
  assert.equal(item.name,'连接器快速配置');assert.equal(item.builtIn,true);
  const detail=personal.get(app,item.pluginId),result=personal.resolve(app,[item.pluginId],{cwd:root});
  assert.equal(result.items.length,1);
  const bundle=resources.materialize(detail.localDraft.resources,root,'mcp-studio');
  const tool=require(path.join(bundle.directory,'references/mcp-studio/scripts/mcp-config.cjs'));
  const source=path.join(root,'candidate.json');fs.writeFileSync(source,JSON.stringify({mcpServers:{crm:{url:'https://example.com/mcp',headers:{Authorization:'NEVER-EXPORT-THIS'}}}}));
  const report=tool.prepare(source,path.join(root,'delivery'));
  assert.equal(report.connectionTested,false);assert.equal(report.requiredCredentials.length,1);
  const artifact=JSON.parse(fs.readFileSync(path.join(root,'delivery/mcp-config.json')));
  assert.equal(artifact.mcpServers.crm.headers.Authorization,'');
  assert.equal(artifact.mcpServers.crm.enabled,false);
  assert.equal(fs.existsSync(path.join(root,'personal-plugins.json')),false);
  const inventory=path.join(root,'interfaces.json');fs.writeFileSync(inventory,JSON.stringify({name:'研发接口',baseUrl:'https://api.example.com',endpoints:[{method:'GET',path:'/me',name:'identity'}]}));
  const apiReport=tool.fromApi(inventory,path.join(root,'api-delivery'));
  assert.equal(apiReport.tools.length,1);assert.equal(apiReport.connectionTested,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'api-delivery/mcp-config.json'))).mcpServers['研发接口'].command,'soduwork-api');

});
test('creator preserves boundaries and does not silently omit unsupported auth or tool permissions',t=>{
  const {root}=fixture(t),src=path.join(root,'in.json'),out=path.join(root,'out');
  for(const extra of [{oauth:{}},{bearer_token_env_var:'KEY'},{enabledTools:['*']},{enabledTools:['write'],disabledTools:['write']},{url:'https://example.com/?token=private'}]){
    fs.writeFileSync(src,JSON.stringify({mcpServers:{crm:{url:'https://example.com/mcp',...extra}}}));
    assert.throws(()=>prepare(src,out));
    assert.equal(fs.existsSync(out),false);
  }
});
test('creator never runs a local command or overwrites output',t=>{
  const {root}=fixture(t),src=path.join(root,'in.json'),out=path.join(root,'out'),sentinel=path.join(root,'executed');
  fs.writeFileSync(src,JSON.stringify({mcpServers:{local:{command:'node',args:['-e','require("fs").writeFileSync('+JSON.stringify(sentinel)+',"BAD")']}}}));
  prepare(src,out);assert.equal(fs.existsSync(sentinel),false);assert.throws(()=>prepare(src,out),/已存在/);
});

function apiCandidate(extra={}){
  return {type:'stdio',command:'soduwork-api',args:[],apiDefinition:{name:'Restricted API',baseUrl:'https://api.example.com',
    securitySchemes:{auth:{type:'http',scheme:'bearer'}},security:[{auth:[]}],
    endpoints:[{method:'GET',path:'/identity',operationId:'identity'},{method:'GET',path:'/projects',operationId:'projects'}]},
    env:{AUTH_AUTH_TOKEN:'NEVER-EXPORT-API-TOKEN'},...extra};
}
test('API creator preserves explicit tool scope and timeouts through the packaged maker and real bridge',async t=>{
  const {root,app}=fixture(t),detail=personal.get(app,personal.MCP_STUDIO_ID);
  const bundle=resources.materialize(detail.localDraft.resources,root,'api-scope-maker');
  const tool=require(path.join(bundle.directory,'references/mcp-studio/scripts/mcp-config.cjs'));
  for(const [index,policy]of [
    {enabledTools:['identity'],disabledTools:['projects'],startupTimeoutSeconds:25,toolTimeoutSeconds:40},
    {enabled_tools:['identity'],disabled_tools:['projects'],startup_timeout_sec:25,tool_timeout_sec:40},
  ].entries()){
    const src=path.join(root,'api-'+index+'.json'),out=path.join(root,'api-out-'+index);
    fs.writeFileSync(src,JSON.stringify({mcpServers:{api:apiCandidate(policy)}}));
    tool.prepare(src,out);const file=path.join(out,'mcp-config.json'),raw=fs.readFileSync(file,'utf8');
    const saved=JSON.parse(raw).mcpServers.api;
    assert.deepEqual(saved.enabledTools,['identity']);assert.deepEqual(saved.disabledTools,['projects']);
    assert.equal(saved.startupTimeoutSeconds,25);assert.equal(saved.toolTimeoutSeconds,40);
    assert.equal(saved.enabled,false);assert.equal(saved.env.AUTH_AUTH_TOKEN,'');assert(!raw.includes('NEVER-EXPORT-API-TOKEN'));
    // Hub confirmation wraps imported configuration as runtime servers while authored resources remain disabled.
    const runtimeFile=path.join(out,'runtime.json');fs.writeFileSync(runtimeFile,JSON.stringify({servers:{api:{...saved,enabled:true}}}));
    const {stdout}=await require('node:util').promisify(require('node:child_process').execFile)(process.execPath,
      ['skills/mcp-tools/scripts/mcp.mjs','--config',runtimeFile,'list','api'],
      {cwd:path.resolve(__dirname,'../..'),env:{...process.env,SODUWORK_MCP_JSON:'1'},timeout:10000,windowsHide:true});
    assert.deepEqual(JSON.parse(stdout).tools.map(x=>x.name),['identity']);
  }
});
test('API creator rejects invalid limits instead of silently expanding authorization',t=>{
  const {root}=fixture(t),src=path.join(root,'candidate.json'),out=path.join(root,'delivery');
  for(const extra of [{enabledTools:['*']},{disabledTools:'identity'},{enabledTools:['identity'],disabledTools:['identity']},
    {startupTimeoutSeconds:0},{tool_timeout_sec:301}]){
    fs.writeFileSync(src,JSON.stringify({mcpServers:{api:apiCandidate(extra)}}));
    assert.throws(()=>prepare(src,out));assert.equal(fs.existsSync(out),false);
  }
});

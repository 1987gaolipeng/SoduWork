'use strict';
// Compile API documentation into a data-only contract without remote references, scripts, dynamic targets, or implicit authentication downgrade.
const {createHash}=require('node:crypto');
const {plain}=require('./validation.cjs');
const BAD=new Set(['__proto__','prototype','constructor']);
function checked(value,depth=0,budget={n:0}) {
  if(depth>24||++budget.n>30000)throw Error('接口文档结构过大');
  if(Array.isArray(value))value.forEach(x=>checked(x,depth+1,budget));
  else if(plain(value))for(const [k,v]of Object.entries(value)){if(BAD.has(k))throw Error('接口字段名称无效');checked(v,depth+1,budget);}
}
function endpoint(value) {
  if(typeof value!=='string'||value.length>400||/[\\\s\x00-\x1f\x7f]/.test(value))throw Error('接口地址无效');
  let u;try{u=new URL(value);}catch{throw Error('需要完整的接口地址');}
  const host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  const blocked=require('./api-network.cjs').blocked;
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||blocked(host))throw Error('接口地址不能含凭据、查询串或系统元数据地址');
  if(u.protocol==='http:'&&!/^(localhost|127\.\d+\.\d+\.\d+|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host))throw Error('公网接口必须使用 HTTPS');
  return u.href.replace(/\/$/,'');
}
function oauthEndpoint(value){
  const address=endpoint(value),u=new URL(address);
  if(u.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('OAuth 端点必须使用 HTTPS；本机开发可用回环地址');
  return address;
}
function compile(source) {
  if(!plain(source)||Buffer.byteLength(JSON.stringify(source))>1024*1024)throw Error('接口清单需要为 1 MB 内的对象');
  checked(source);
  if(source.schemaVersion===1&&source.openapiDocument)source=source.openapiDocument;
  if(Array.isArray(source.endpoints)) {
    const paths={};
    for(const op of source.endpoints){
      if(!plain(op)||!op.path||!op.method)throw Error('每个接口需要 method 和 path');
      const method=String(op.method).toLowerCase();if(!['get','head','post','put','patch','delete'].includes(method))throw Error('接口请求方法不受支持');paths[op.path]||={};
      if(paths[op.path][method])throw Error('接口路径与方法重复');
      paths[op.path][method]={...op,operationId:op.operationId||op.name};
    }
    source={openapi:'3.0.3',info:{title:source.name,description:source.description},servers:[{url:source.baseUrl}],paths,
      components:{securitySchemes:Object.hasOwn(source,'securitySchemes')?source.securitySchemes:{}},
      security:Object.hasOwn(source,'security')?source.security:[], 'x-soduwork-probe':source.probe};
  }
  if(!/^3\.(0|1)\./.test(source.openapi||''))throw Error('请提供 OpenAPI 3.0 / 3.1，或包含 baseUrl、endpoints 的接口清单');
  function resolve(obj,stack=[]) {
    if(!plain(obj))throw Error('接口定义必须为对象');
    if(!obj.$ref)return obj;
    if(Object.keys(obj).some(k=>!['$ref','description','summary'].includes(k)))throw Error('引用包含未支持的覆盖字段');
    const ref=obj.$ref;if(typeof ref!=='string'||!ref.startsWith('#/')||stack.includes(ref)||stack.length>16)throw Error('仅支持无循环的文档内引用');
    let next=source;for(const part of ref.slice(2).split('/').map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~'))){if(BAD.has(part)||!plain(next)||!Object.hasOwn(next,part))throw Error('接口引用不存在');next=next[part];}
    return resolve(next,[...stack,ref]);
  }
  function schema(raw,depth=0){
    if(depth>10)throw Error('接口参数嵌套过深或循环引用');
    const s=resolve(raw||{});
    if(['oneOf','anyOf','allOf','not','if','then','else','patternProperties','$dynamicRef'].some(k=>s[k]!==undefined)||s.nullable||Array.isArray(s.type))throw Error('请将组合或可空参数整理为明确类型');
    if(s.pattern)throw Error('接口参数正则需人工适配，避免不受限执行');
    const type=s.type||(s.properties?'object':null);if(!['object','array','string','integer','number','boolean'].includes(type))throw Error('接口参数缺少受支持的 type');
    const out={type};for(const k of ['description','enum','minimum','maximum','minLength','maxLength','minItems','maxItems'])if(s[k]!==undefined)out[k]=s[k];
    if(type==='object') {out.properties={};for(const[k,v]of Object.entries(s.properties||{}))out.properties[k]=schema(v,depth+1);out.required=s.required||[];out.additionalProperties=s.additionalProperties===true?true:plain(s.additionalProperties)?schema(s.additionalProperties,depth+1):false;}
    if(type==='array')out.items=schema(s.items,depth+1);
    return out;
  }
  const name=String(source.info?.title||'').trim();if(!name||name.length>60)throw Error('接口名称需要 1–60 个字符');
  if(!Array.isArray(source.servers)||source.servers.length!==1||source.servers[0].variables)throw Error('请选择一个明确的 servers 地址后导入');
  const baseUrl=endpoint(source.servers[0].url),fields=[],securitySchemes={};
  // Default only missing fields; reject malformed authentication instead of allowing anonymous access.
  const components=Object.hasOwn(source,'components')?source.components:{};
  if(!plain(components))throw Error('接口 components 必须为对象');
  const declaredSchemes=Object.hasOwn(components,'securitySchemes')?components.securitySchemes:{};
  if(!plain(declaredSchemes))throw Error('securitySchemes 必须为认证对象');
  for(const[key,raw]of Object.entries(declaredSchemes)) {
    if(!/^[A-Za-z][A-Za-z0-9_-]{0,35}$/.test(key))throw Error('认证名称无效');
    const s=resolve(raw),prefix='AUTH_'+key.toUpperCase().replace(/-/g,'_');
    function field(suffix,label,secret=true,required=true){const key=prefix+'_'+suffix;if(fields.some(f=>f.key===key))throw Error('认证字段名称重复');fields.push({key,label,secret,required});return key;}
    if(s.type==='apiKey'&&['header','query'].includes(s.in)) {
      if(!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(s.name)||/^(host|authorization|content-type|content-length|connection|cookie|proxy-authorization)$/i.test(s.name))throw Error('API Key 字段名称不受支持');
      securitySchemes[key]={type:'apiKey',in:s.in,name:s.name,key:field('KEY',key+' · API Key')};
    } else if(s.type==='http'&&s.scheme?.toLowerCase()==='bearer')securitySchemes[key]={type:'bearer',key:field('TOKEN',key+' · 访问令牌')};
    else if(s.type==='http'&&s.scheme?.toLowerCase()==='basic')securitySchemes[key]={type:'basic',usernameKey:field('USER',key+' · 用户名',false),passwordKey:field('PASSWORD',key+' · 密码')};
    else if(s.type==='oauth2') {
      const flows=s.flows;
      if(!plain(flows)||Object.values(flows).some(f=>!plain(f)))throw Error('OAuth flows 必须为明确的授权流程对象');
      const flow=Object.hasOwn(flows,'authorizationCode')?'authorizationCode':Object.hasOwn(flows,'clientCredentials')?'clientCredentials':'';
      if(!flow)throw Error('OAuth 支持授权码 PKCE 和 Client Credentials；不支持密码或隐式授权');
      const f=flows[flow],tokenUrl=oauthEndpoint(f.tokenUrl),declaredScopes=Object.hasOwn(f,'scopes')?f.scopes:{};
      if(!plain(declaredScopes))throw Error('OAuth scopes 必须为权限对象');
      const scopes=Object.keys(declaredScopes);
      if(scopes.some(x=>!/^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(x)))throw Error('OAuth scope 无效');
      const tokenAuth=Object.hasOwn(s,'x-token-endpoint-auth-method')?s['x-token-endpoint-auth-method']:'client_secret_basic';
      if(!['client_secret_basic','client_secret_post','none'].includes(tokenAuth)||flow==='clientCredentials'&&tokenAuth==='none')throw Error('OAuth 客户端认证方式不支持');
      securitySchemes[key]={type:'oauth2',flow,tokenUrl,scopes,tokenAuth,
        ...(flow==='authorizationCode'?{authorizationUrl:oauthEndpoint(f.authorizationUrl)}:{}),
        clientIdKey:field('CLIENT_ID',key+' · Client ID',false),clientSecretKey:field('CLIENT_SECRET',key+' · Client Secret',true,tokenAuth!=='none'),
        ...(flow==='authorizationCode'?{tokenKey:field('ACCESS_TOKEN',key+' · 访问令牌',true,false)}:{})};
    } else throw Error('暂不支持此认证方式：'+key+'；不会按无认证导入');
  }
  if(fields.length>19)throw Error('认证字段超过 19 项，请拆分连接');
  const tools=[],names=new Set();
  for(const[path,pathRaw]of Object.entries(source.paths||{})){
    if(!path.startsWith('/')||path.startsWith('//')||/[\\?#\x00-\x20]/.test(path)||path.split('/').some(x=>x==='.'||x==='..')||/%(?:2e|2f|5c)/i.test(path))throw Error('接口路径无效');
    const pathItem=resolve(pathRaw);if(pathItem.servers)throw Error('接口级 servers 需要拆为独立连接');
    for(const[method,raw]of Object.entries(pathItem)){
      if(!['get','head','post','put','patch','delete'].includes(method)){if(['options','trace'].includes(method))throw Error('不支持 OPTIONS / TRACE');continue;}
      const op=resolve(raw);if(op.servers||op.callbacks)throw Error('接口级地址或回调需要独立适配');
      const toolName=op.operationId||method+'_'+path.replace(/[^A-Za-z0-9]+/g,'_').replace(/_$/,'');
      if(!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(toolName)||names.has(toolName))throw Error('operationId 需要唯一的英文字母、数字或下划线，最多 80 字符');
      names.add(toolName);
      const security=Object.hasOwn(op,'security')?op.security:Object.hasOwn(source,'security')?source.security:[];
      if(!Array.isArray(security)||security.some(s=>!plain(s))||security.length>1)throw Error('请明确选择一种认证组合，不能自动选择或降级认证');
      const requires=security[0]||{};
      for(const[k,scopes]of Object.entries(requires))if(!securitySchemes[k]||!Array.isArray(scopes)||scopes.some(x=>!securitySchemes[k].scopes?.includes(x)))throw Error('接口引用了未知的认证或 scope');
      const properties={},required=[],parameters=[];
      const merged=new Map();for(const p0 of [...(pathItem.parameters||[]),...(op.parameters||[])]){const p=resolve(p0);merged.set(p.in+':'+p.name,p);}
      for(const p of merged.values()){
        if(!['path','query','header'].includes(p.in)||!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(p.name)||BAD.has(p.name))throw Error('参数位置或名称不受支持');
        if(p.content||p.allowReserved||p.style&&p.style!==(p.in==='query'?'form':'simple')||p.explode!==undefined&&p.explode!==(p.in==='query'))throw Error('参数序列化方式需要适配');
        const arg=(properties[p.name]||p.name==='body'?p.in+'_':'')+p.name;
        if(properties[arg])throw Error('参数名称重复');
        const shape=schema(p.schema);
        if(shape.type==='object'||shape.type==='array'&&(p.in!=='query'||!['string','integer','number','boolean'].includes(shape.items.type)))throw Error('路径和请求头仅支持标量；查询数组仅支持基础类型');
        if(p.in==='header'&&/^(host|authorization|content-type|content-length|connection|cookie|proxy-authorization)$/i.test(p.name))throw Error('认证头应在 securitySchemes 中声明');
        if(Object.values(securitySchemes).some(s=>s.type==='apiKey'&&s.in===p.in&&s.name.toLowerCase()===p.name.toLowerCase()))throw Error('参数不得覆盖认证字段');
        properties[arg]=shape;if(p.required||p.in==='path')required.push(arg);parameters.push({in:p.in,name:p.name,arg});
      }
      const variables=[...path.matchAll(/\{([^}]+)\}/g)].map(x=>x[1]);
      if(variables.some(k=>!parameters.some(p=>p.in==='path'&&p.name===k))||parameters.some(p=>p.in==='path'&&!variables.includes(p.name)))throw Error('路径参数声明不完整');
      let bodyType='';if(op.requestBody){
        if(['get','head'].includes(method))throw Error('GET / HEAD 不支持请求体');
        const body=resolve(op.requestBody),types=Object.keys(body.content||{});
        bodyType=types.includes('application/json')?'application/json':types.includes('application/x-www-form-urlencoded')?'application/x-www-form-urlencoded':'';
        if(!bodyType)throw Error('请求体目前支持 JSON 与表单；文件上传需要独立适配');
        properties.body=schema(body.content[bodyType].schema);if(body.required)required.push('body');
        if(bodyType.includes('form')&&(properties.body.type!=='object'||Object.values(properties.body.properties||{}).some(s=>!['string','integer','number','boolean'].includes(s.type))))throw Error('表单只支持标量字段');
      }
      tools.push({name:toolName,description:String(op.summary||op.description||toolName).slice(0,1000),method:method.toUpperCase(),path,
        readOnly:['get','head'].includes(method),security:requires,parameters,bodyType,inputSchema:{type:'object',properties,required,additionalProperties:false}});
    }
  }
  if(!tools.length||tools.length>100)throw Error('每个连接器需要 1–100 个接口');
  if(tools.some(t=>!t.readOnly))fields.push({key:'ALLOW_WRITES',label:'允许写入操作',type:'boolean',secret:false,required:false,default:'false',pattern:'^(true|false)$'});
  const probe=source['x-soduwork-probe']||'';
  if(probe&&!tools.some(t=>t.name===probe&&t.readOnly&&!t.inputSchema.required.length))throw Error('连接检查只能指定不需要参数的 GET / HEAD 接口');
  // Persist a minimal recompilable contract without examples, defaults, or unrestricted extensions.
  const document={openapi:'3.0.3',info:{title:name},servers:[{url:baseUrl}],components:{securitySchemes:{}},paths:{},'x-soduwork-probe':probe};
  for(const[k,s]of Object.entries(securitySchemes))document.components.securitySchemes[k]=s.type==='apiKey'?{type:'apiKey',in:s.in,name:s.name}:s.type==='basic'||s.type==='bearer'?{type:'http',scheme:s.type}:{type:'oauth2','x-token-endpoint-auth-method':s.tokenAuth,flows:{[s.flow]:{tokenUrl:s.tokenUrl,...(s.authorizationUrl?{authorizationUrl:s.authorizationUrl}:{}),scopes:Object.fromEntries(s.scopes.map(x=>[x,'']))}}};
  for(const t of tools){document.paths[t.path]||={};document.paths[t.path][t.method.toLowerCase()]={operationId:t.name,summary:t.description,security:Object.keys(t.security).length?[t.security]:[],parameters:t.parameters.map(p=>({in:p.in,name:p.name,required:t.inputSchema.required.includes(p.arg),schema:t.inputSchema.properties[p.arg]})),...(t.bodyType?{requestBody:{required:t.inputSchema.required.includes('body'),content:{[t.bodyType]:{schema:t.inputSchema.properties.body}}}}:{})};}
  const stable=value=>Array.isArray(value)?value.map(stable):plain(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
  const id=createHash('sha256').update(JSON.stringify(stable(document))).digest('hex');
  return {schemaVersion:1,id,name,description:'来自接口文档 · '+tools.length+' 个接口',baseUrl,fields,securitySchemes,tools,probe,openapiDocument:document};
}
module.exports={compile,endpoint};
if(require.main===module){try{const fs=require('node:fs');process.stdout.write(JSON.stringify(compile(JSON.parse(fs.readFileSync(0,'utf8')))));}catch(e){console.error(e instanceof SyntaxError?'接口 JSON 无效':e.message);process.exitCode=1;}}

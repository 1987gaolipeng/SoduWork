'use strict';
const {compile}=require('./api-definition.cjs');
const {settings,input}=require('./validation.cjs');
const {send}=require('./api-network.cjs');
const {redactData}=require('./special-transport.cjs');
function definition(spec){
  if(spec.command!=='soduwork-api'||!Array.isArray(spec.args)||spec.args.length)throw Error('接口连接器启动配置无效');
  return compile(spec.apiDefinition);
}
function tokenValue(cfg,key){if(!cfg[key])throw Error('请先配置连接器认证');return cfg[key];}
function header(headers,name,value){
  if(!/^[!#$%&'*+.^_~0-9A-Za-z-]+$/.test(name)||/^(host|content-length|connection|transfer-encoding|upgrade|proxy-authorization|cookie)$/i.test(name)||/[\x00-\x1f\x7f]/.test(String(value)))throw Error('接口请求头无效');
  if(Object.keys(headers).some(k=>k.toLowerCase()===name.toLowerCase()))throw Error('接口认证或参数请求头重复');headers[name]=String(value);
}
async function authHeaders(def,cfg,tool,req,options){
  for(const[name,scopes]of Object.entries(tool.security)){
    const s=def.securitySchemes[name];
    if(s.type==='apiKey'){
      if(s.in==='query')req.url.searchParams.set(s.name,tokenValue(cfg,s.key));
      else header(req.headers,s.name,tokenValue(cfg,s.key));
    } else if(s.type==='bearer')header(req.headers,'Authorization','Bearer '+tokenValue(cfg,s.key));
    else if(s.type==='basic')header(req.headers,'Authorization','Basic '+Buffer.from(tokenValue(cfg,s.usernameKey)+':'+tokenValue(cfg,s.passwordKey)).toString('base64'));
    else if(s.type==='oauth2'){
      let token;
      if(s.flow==='authorizationCode')token=tokenValue(cfg,s.tokenKey);
      else {
        const clientId=tokenValue(cfg,s.clientIdKey),secret=tokenValue(cfg,s.clientSecretKey);
        if(new URL(s.tokenUrl).protocol!=='https:'&&process.env.SODUWORK_ENV!=='development')throw Error('生产环境 OAuth 必须使用 HTTPS');
        const form=new URLSearchParams({grant_type:'client_credentials',...(scopes.length?{scope:scopes.join(' ')}:{})});
        const headers={'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
        if(s.tokenAuth==='client_secret_post'){form.set('client_id',clientId);form.set('client_secret',secret);}
        else headers.Authorization='Basic '+Buffer.from(new URLSearchParams({v:clientId}).toString().slice(2)+':'+new URLSearchParams({v:secret}).toString().slice(2)).toString('base64');
        let response;
        try{response=await send({url:s.tokenUrl,method:'POST',headers,body:form.toString()},options);}
        catch(e){throw Object.assign(Error([400,401,403].includes(e.status)?'OAuth 应用认证失败，请检查 Client ID、Secret 和权限':'OAuth 服务暂不可用，请稍后重试'),{...([400,401,403].includes(e.status)?{code:'AUTH_REQUIRED'}:{}),status:e.status});}
        let data;try{data=JSON.parse(response.bytes);}catch{throw Error('OAuth 令牌响应无效');}
        if(data.error||typeof data.access_token!=='string'||!data.access_token||data.access_token.length>16384||!/^Bearer$/i.test(data.token_type||'')||/[\x00-\x20\x7f]/.test(data.access_token))throw Object.assign(Error('OAuth 未返回有效 Bearer 令牌'),{code:'AUTH_REQUIRED'});
        if(data.expires_in!==undefined&&(!Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<=0))throw Error('OAuth 令牌已经过期');
        token=data.access_token;
      }
      header(req.headers,'Authorization','Bearer '+token);
    }
  }
}
function request(def,tool,args){
  input(args,tool.inputSchema);
  let path=tool.path;const headers={Accept:'application/json'};
  for(const p of tool.parameters)if(p.in==='path'){
    const value=String(args[p.arg]);if(value==='.'||value==='..'||/[\\/]/.test(value)||/%(?:2e|2f|5c)/i.test(value))throw Error('路径参数不能改变资源路径');
    path=path.split('{'+p.name+'}').join(encodeURIComponent(value));
  }
  const base=new URL(def.baseUrl),joined=base.pathname.replace(/\/$/,'')+path,url=new URL(base.origin+joined);
  if(url.origin!==base.origin||url.pathname!==encodeURI(joined).replace(/%25/g,'%'))throw Error('接口资源路径无效');
  for(const p of tool.parameters){
    const v=args[p.arg];if(v===undefined)continue;
    if(p.in==='query')for(const part of Array.isArray(v)?v:[v])url.searchParams.append(p.name,String(part));
    if(p.in==='header')header(headers,p.name,v);
  }
  let body;
  if(Object.hasOwn(args,'body')){
    body=tool.bodyType==='application/json'?JSON.stringify(args.body):new URLSearchParams(Object.entries(args.body).map(([k,v])=>[k,String(v)])).toString();
    header(headers,'Content-Type',tool.bodyType);
  }
  return {url,headers,body,method:tool.method};
}
async function execute(def,values,tool,args,options={}){
  const cfg=settings(def,values);
  if(!tool.readOnly&&cfg.ALLOW_WRITES!=='true')throw Error('写入操作尚未授权，请在连接设置中开启');
  const req=request(def,tool,args);
  await authHeaders(def,cfg,tool,req,options);
  // Never retry write requests; token or network failure must not duplicate creation.
  const response=await send(req,options);
  let result;
  if(!response.bytes.length)result={status:response.status};
  else try{result=JSON.parse(response.bytes.toString('utf8'));}catch{result={text:response.bytes.toString('utf8')};}
  if(result&&typeof result==='object'&&(result.error||result.ok===false||result.success===false))throw Error('业务接口返回失败，请检查权限和参数');
  return {content:[{type:'text',text:JSON.stringify(redactData(result,def,cfg,req.headers))}],isError:false};
}
async function session(spec,fn,options={}){
  const def=definition(spec);
  return fn(async(method,params={})=>{
    if(method==='tools/list')return {tools:def.tools.filter(t=>t.readOnly||spec.env?.ALLOW_WRITES==='true').map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema,annotations:{readOnlyHint:t.readOnly,destructiveHint:!t.readOnly,openWorldHint:true}}))};
    if(method!=='tools/call')throw Error('接口连接器方法不支持');
    const tool=def.tools.find(t=>t.name===params.name);if(!tool)throw Error('接口工具不存在');
    return execute(def,spec.env||{},tool,params.arguments||{},{timeoutMs:Number(spec.toolTimeoutSeconds||60)*1000,...options});
  });
}
async function probe(spec,options={}){
  try{
    const def=definition(spec);settings(def,spec.env||{});
    // Require an explicit parameter-free read-only probe for user API definitions instead of guessing a business operation.
    const tool=def.tools.find(t=>t.name===def.probe);
    if(!tool)return {ok:true,connectionState:'configured',authenticationTested:false,verificationScope:'configuration',message:'配置已就绪；接口清单未指定只读连接检查，业务权限待实际调用验证'};
    await execute(def,spec.env||{},tool,{},options);
    const authenticated=Object.keys(tool.security).length>0;
    return {ok:true,connectionState:authenticated?'verified':'configured',authenticationTested:authenticated,verificationScope:'api',message:authenticated?'只读接口调用成功；其他接口权限以实际调用为准':'接口可以访问；此检查接口不要求认证，账号权限尚未验证'};
  }catch(e){return {ok:false,connectionState:[401,403].includes(e.status)||e.code==='AUTH_REQUIRED'?'needs_auth':'error',authenticationTested:false,message:e.message,error:e.message};}
}
module.exports={definition,request,execute,session,probe};

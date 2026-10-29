'use strict';
const http=require('node:http'),https=require('node:https'),dns=require('node:dns'),net=require('node:net');
const MAX=2*1024*1024;
function blocked(host){
  host=host.toLowerCase().replace(/^\[|\]$/g,'');
  if(['metadata.google.internal','metadata','100.100.100.200'].includes(host))return true;
  if(net.isIP(host)===4)return /^(0|169\.254|22[4-9]|2[3-5]\d)(\.|$)/.test(host)||host==='255.255.255.255';
  if(net.isIP(host)===6)return host==='::'||/^f[ef]/.test(host)||host.startsWith('::ffff:');
  return false;
}
// Validate DNS at connection time and reject redirects so credentials cannot reach undeclared destinations.
function send(req,options={}){return new Promise((resolve,reject)=>{
  const u=new URL(req.url),host=u.hostname.replace(/^\[|\]$/g,'');
  if(blocked(host))return reject(Error('不能连接系统元数据或链路本地地址'));
  let settled=false,total=0,parts=[],timer;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const error=(message,status)=>Object.assign(Error(message),{status});
  const request=(u.protocol==='https:'?https:http).request(u,{method:req.method,headers:req.headers,
    lookup(name,opts,cb){dns.lookup(name,{...opts,all:true},(e,items)=>{if(e)return cb(Error('无法解析接口地址'));if(!items.length||items.some(x=>blocked(x.address)))return cb(Error('接口地址解析到受限目标'));cb(null,...(opts.all?[items]:[items[0].address,items[0].family]));});}
  },response=>{
    const status=response.statusCode;
    if(status<200||status>=300){response.resume();finish(error(status>=300&&status<400?'接口重定向已阻止，未转发凭据':status===401?'授权失效，请重新连接':status===403?'账号权限不足':'接口请求失败（HTTP '+status+'）',status));request.destroy();return;}
    if(Number(response.headers['content-length'])>MAX){finish(error('响应超过 2 MB，请分页读取'));request.destroy();return;}
    response.on('data',chunk=>{total+=chunk.length;if(total>MAX){finish(error('响应超过 2 MB，请分页读取'));request.destroy();}else parts.push(chunk);});
    response.on('end',()=>finish(null,{bytes:Buffer.concat(parts),status,headers:response.headers}));
    response.on('error',()=>finish(error('接口响应中断')));
  });
  function abort(){finish(error('接口请求已取消'));request.destroy();}
  request.on('error',()=>finish(error('接口连接失败，请检查地址、证书和网络')));
  timer=setTimeout(()=>{finish(error('接口请求超时；写入不会自动重试'));request.destroy();},Math.max(1,Math.min(300000,options.timeoutMs||30000)));
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted){abort();return;}
  if(req.body!==undefined&&Buffer.byteLength(req.body)>MAX){finish(error('请求超过 2 MB'));request.destroy();return;}
  request.end(req.body);
});}
module.exports={send,blocked};

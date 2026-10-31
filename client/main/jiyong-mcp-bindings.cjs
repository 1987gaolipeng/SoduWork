'use strict';
const contract = require('../core/jiyong-contract.cjs');
const store = require('./app-settings-store.cjs');
function extend(connection,installed,bound) {
  const raw = installed.jiyong || installed.localDraft?.jiyong;
  if (!raw?.mcp || raw.mcp.server !== connection.server) return connection;
  const schema = contract.normalize(raw), row = store.read(bound);
  const values = {...Object.fromEntries(schema.parameters.filter(p => Object.hasOwn(p,'default')).map(p => [p.key,p.default])),...row.values};
  const bindings = schema.mcp.bindings.map(b => {
    const field = schema.parameters.find(p => p.key === b.parameter);
    contract.value(field,values[b.parameter]);
    if (field.secret && (typeof values[b.parameter] !== 'string' || !values[b.parameter])) throw Error('MCP 秘密绑定需要非空字符串');
    return {...b,value:values[b.parameter]};
  });
  const redactions = [...new Set([connection.token,...(row.secretKeys || []).map(k => row.values[k]),...schema.parameters.filter(p => p.secret).map(p => values[p.key])].filter(v => typeof v === 'string' && v))];
  return {...connection,bindings,redactions};
}
function input(body,bindings) {
  if (body.method !== 'tools/call') return body;
  const applicable = bindings.filter(b => b.tool === body.params?.name);
  const args = contract.json(body.params?.arguments || {});
  for (const b of applicable) args[b.argument] = b.value;
  return {...body,params:{...body.params,arguments:args}};
}
function output(body,bindings,secrets) {
  function redact(v) {
    if (typeof v === 'string') { for (const secret of secrets) v = v.split(secret).join('[已隐藏凭据]'); return v; }
    if (Array.isArray(v)) return v.map(redact);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [redact(k),redact(x)]));
    return v;
  }
  body = redact(body);
  if (Array.isArray(body?.result?.tools)) for (const tool of body.result.tools) {
    const hidden = bindings.filter(b => b.tool === tool.name).map(b => b.argument);
    if (tool.inputSchema?.properties) for (const k of hidden) delete tool.inputSchema.properties[k];
    if (tool.inputSchema?.required) tool.inputSchema.required = tool.inputSchema.required.filter(k => !hidden.includes(k));
  }
  return body;
}
async function proxy(request,response,connection,current,signal) {
  if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
  let size = 0, chunks = [];
  for await (const chunk of request) {
    size += chunk.length; if (size > 1024 * 1024) throw Error('MCP 请求过大'); chunks.push(chunk);
  }
  const body = input(JSON.parse(Buffer.concat(chunks).toString('utf8')),connection.bindings);
  await connection.authorize?.();
  const check = () => {
    const now = connection.readCurrent();
    if (now.revision !== connection.revision || now.token !== connection.token) throw Error('MCP 授权已变化');
  };
  check();
  const headers = {'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+current.token};
  for (const key of ['mcp-session-id','mcp-protocol-version']) if (request.headers[key]) headers[key] = request.headers[key];
  const timeout = AbortSignal.timeout(300000);
  const upstream = await fetch(connection.url,{method:'POST',redirect:'error',headers,body:JSON.stringify(body),signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
  const type = upstream.headers.get('content-type') || '';
  // Bound replies before parsing; reject unsupported transports rather than leaking raw data.
  size = 0; chunks = [];
  if (upstream.body) for await (const chunk of upstream.body) { size += chunk.length; if (size > 8*1024*1024) throw Error('MCP 响应过大'); chunks.push(chunk); }
  check();
  const text = Buffer.concat(chunks).toString('utf8');
  const transform = data => JSON.stringify(output(JSON.parse(data),connection.bindings,connection.redactions || []));
  const result = type.includes('text/event-stream') ? text.split(/\r?\n/).map(line => line.startsWith('data:') ? 'data: '+transform(line.slice(5).trim()) : line.startsWith('event:') || !line ? line : '').join('\n')
    : !text && [202,204].includes(upstream.status) ? '' : transform(text);
  const replyHeaders = {'Content-Type':type.includes('text/event-stream') ? 'text/event-stream' : 'application/json','Cache-Control':'no-store'};
  const session = upstream.headers.get('mcp-session-id'); if (session) replyHeaders['mcp-session-id'] = session;
  response.writeHead(upstream.status,replyHeaders); response.end(result);
}
module.exports = {extend,input,output,proxy};

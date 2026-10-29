// Local read-only MCP used by the real desktop connector smoke. No credentials or business data.
import http from 'node:http';
import fs from 'node:fs';
const calls = [];
const evidence = process.argv[2];
const marker = 'SODUWORK_CONNECTOR_FOUNDATION_OK';
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let raw = ''; for await (const chunk of req) {raw += chunk; if(raw.length>65536){res.writeHead(413).end();return;}}
  try {
    const message = JSON.parse(raw);
    if (message.id == null) {res.writeHead(202).end();return;}
    let result;
    if (message.method === 'initialize') result = {protocolVersion:message.params?.protocolVersion || '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'soduwork-connector-validation',version:'1.0.0'}};
    else if (message.method === 'tools/list') result = {tools:[{name:'get_test_marker',description:'Read an inert test marker. Does not read business data or change anything.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false}}]};
    else if (message.method === 'tools/call' && message.params?.name === 'get_test_marker') result = {content:[{type:'text',text:JSON.stringify({marker})}]};
    else if (message.method === 'ping') result = {};
    else {res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}}));return;}
    calls.push({at:new Date().toISOString(),method:message.method,tool:message.params?.name || ''});
    if (evidence) fs.writeFileSync(evidence,JSON.stringify({marker,calls},null,2));
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  } catch (_) {res.writeHead(400).end();}
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));

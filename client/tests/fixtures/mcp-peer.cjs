// Harmless real stdio MCP peer for production-bridge tests; never loaded by the product.
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);if(q.id===undefined)return;
  const result=q.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
    q.method==='tools/list'?{tools:[{name:'read_status',description:'Read status',inputSchema:{type:'object',properties:{}}},{name:'delete_item',description:'Delete item',inputSchema:{type:'object',properties:{}}}]}:
    {content:[{type:'text',text:'STDIO_BUSINESS_OK'}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
});

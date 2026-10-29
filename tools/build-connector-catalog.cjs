'use strict';
// Deterministic, credential-free authoring resources derived from reviewed definitions.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'skills/mcp-tools/connectors/providers');
const providers=fs.readdirSync(dir).filter(f=>f.endsWith('.json')).sort().map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')));
const catalog=providers.map(d=>({id:d.id,name:d.name,description:d.description,category:d.category,
 fields:[...d.fields,...(d.tools.some(t=>!t.readOnly)?[{key:'ALLOW_WRITES',label:'允许写入操作',type:'boolean',secret:false,required:false,default:'false'}]:[])],
 tools:d.tools.map(t=>({name:t.name,readOnly:t.readOnly,description:t.description})),officialDocs:[...(d.authDocs||[]),...d.officialDocs],limitations:d.limitations}));
const output='[\n'+catalog.map(d=>JSON.stringify(d)).join(',\n')+'\n]\n';
const destination=path.join(root,'skills/mcp-studio/references/connectors.json');
if(process.argv.includes('--check')){
 if(fs.readFileSync(destination,'utf8')!==output)throw Error('Connector authoring catalog is stale. Run node tools/build-connector-catalog.cjs');
}else fs.writeFileSync(destination,output);
console.log(JSON.stringify({providers:providers.length,tools:providers.reduce((n,d)=>n+d.tools.length,0),credentialsIncluded:false}));

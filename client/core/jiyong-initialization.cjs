'use strict';
// Initialization scripts are declarative JSON, never executable install hooks.
const contract=require('./jiyong-contract.cjs');
function parse(declaration,resources){
 const reference=declaration?.initialization;
 if(!reference)return {schemaVersion:1,migrations:[]};
 const file=resources.find(row=>row.path===reference.script);
 if(!file)throw Error('初始化脚本未随包提供：'+reference.script);
 const bytes=Buffer.from(file.content,file.encoding==='utf8'?'utf8':'base64');
 if(bytes.length>1024*1024)throw Error('初始化脚本最多1MiB');
 const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 const only=(value,names)=>{if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!names.includes(k)))throw Error('初始化脚本字段无效');};
 only(raw,['schemaVersion','migrations']);
 if(raw.schemaVersion!==1 || !Array.isArray(raw.migrations) || raw.migrations.length>100)throw Error('初始化脚本版本或迁移数量无效');
 let count=0;
 const migrations=raw.migrations.map((step,index)=>{
  only(step,['version','seed']);
  if(step.version!==index+1 || !Array.isArray(step.seed))throw Error('数据迁移版本必须从1连续递增');
  const seen=new Set();
  const seed=step.seed.map(row=>{
   only(row,['collection','id','value']);
   if(++count>1000 || !declaration.collections.some(c=>c.key===row.collection))throw Error('初始数据集合未声明或数量超限');
   const collection=contract.key(row.collection),id=contract.key(row.id),identity=collection+':'+id;
   if(seen.has(identity))throw Error('初始数据记录标识重复');seen.add(identity);
   if(!row.value || typeof row.value!=='object' || Array.isArray(row.value))throw Error('初始数据值须为 JSON 对象');
   return {collection,id,value:contract.json(row.value)};
  });
  return {version:step.version,seed};
 });
 return {schemaVersion:1,migrations};
}
module.exports={parse};

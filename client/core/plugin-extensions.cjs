'use strict';
// Portable public metadata. Unknown namespaces/fields roundtrip unchanged;
// runtime and permission declarations are intentionally outside this extension point.
function normalize(raw) {
  if(raw==null)return undefined;
  const plain=v=>v && typeof v==='object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
  if(!plain(raw)||Object.keys(raw).length>32)throw Error('扩展元数据需要命名空间对象，最多32项');
  let nodes=0;
  function walk(value,depth){
    if(++nodes>2000 || depth>8)throw Error('扩展元数据嵌套或数量超限');
    if(value===null || typeof value==='string' || typeof value==='boolean')return;
    if(typeof value==='number' && Number.isFinite(value) && (!Number.isInteger(value)||Number.isSafeInteger(value)))return;
    if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return;}
    if(!plain(value))throw Error('扩展元数据必须是有限 JSON');
    for(const [key,item] of Object.entries(value)){
      if(!key || key.length>160 || ['__proto__','prototype','constructor'].includes(key))throw Error('扩展元数据字段无效');
      walk(item,depth+1);
    }
  }
  for(const [namespace,value]of Object.entries(raw)){
    if(!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(namespace) || !plain(value))throw Error('扩展元数据命名空间无效');
  }
  walk(raw,0);
  if(Buffer.byteLength(JSON.stringify(raw),'utf8')>16384)throw Error('扩展元数据最多16KiB；文件请使用资源声明');
  return structuredClone(raw);
}
module.exports={normalize};

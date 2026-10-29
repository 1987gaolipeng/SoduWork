'use strict';
// Only a main-process native file selection can authorize reading adjacent resources.
const fs=require('node:fs'),path=require('node:path'),resources=require('./plugin-resources');
const { MAX_PACKAGE_BYTES } = require('./plugin-package-limits.cjs');
async function choose(dialog){
 const result=await dialog.showOpenDialog(require("./native-locale.cjs").dialogOptions({title:'选择本机插件',properties:['openFile'],
  filters:[{name:'SoduWork 插件',extensions:['json','zip','soduwork-plugin']}]}));
 if(result.canceled||!result.filePaths?.length)return {canceled:true};
 const file=path.resolve(result.filePaths[0]),root=path.dirname(file);
 resources.assertNoLinks(root,file);
 const stat=fs.statSync(file);
 if(!stat.isFile()||stat.size>MAX_PACKAGE_BYTES)throw Error('插件文件过大，请精简资源后重试');
 const bytes=fs.readFileSync(file);
 if(bytes.length>MAX_PACKAGE_BYTES)throw Error('插件文件超过10MB');
 if(path.extname(file).toLowerCase()==='.json'){
  const draft=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  if(!draft||typeof draft!=='object'||Array.isArray(draft))throw Error('插件草稿不是有效的JSON对象');
  return {kind:'draft',name:path.basename(file),body:resources.collect(draft,file,root)};
 }
 if(!/\.(zip|soduwork-plugin)$/i.test(file))throw Error('请选择JSON草稿或插件压缩包');
 return {kind:'archive',name:path.basename(file),content:bytes.toString('base64')};
}
module.exports={choose,MAX_PACKAGE_BYTES};

'use strict';
// The official CLI generates the QR image. Only this attempt's PNG is exposed;
// bot credentials remain in the account directory and never reach the renderer.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const runtime=require('./runtime.cjs');
const {assertNoLinks}=require('../plugin-resources');
const SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
function create(app,scope){
 const p=runtime.paths(app,'wecom',scope);
 // Store QR images separately from credential directories to satisfy CLI sandbox restrictions.
 const cwd=runtime.privateDir(p.root,path.join(p.root,'auth-previews',scope,'wecom'));
 const name='login-'+crypto.randomUUID()+'.png',file=path.join(cwd,name);
 let disposed=false;
 return {cwd,name,read(){
  if(disposed)return '';
  try{
   assertNoLinks(p.root,file);
   const stat=fs.lstatSync(file);
   if(!stat.isFile()||stat.size<24||stat.size>256*1024)return '';
   const data=fs.readFileSync(file);
   if(data.length>256*1024||!data.subarray(0,8).equals(SIGNATURE))return '';
   return 'data:image/png;base64,'+data.toString('base64');
  }catch(_){return ''} // The file may not yet exist or may still be incomplete.
 },dispose(){
  disposed=true;
  try{assertNoLinks(p.root,file);fs.unlinkSync(file)}catch(_){}
 }};
}
module.exports={create};

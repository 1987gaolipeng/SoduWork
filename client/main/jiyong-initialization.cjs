'use strict';
const contract=require('../core/jiyong-contract.cjs'),pages=require('../core/plugin-package-page.cjs'),store=require('./app-settings-store.cjs');
async function script(deps,installed,assertCurrent=()=>{}){
 const schema=contract.normalize(installed.jiyong || installed.localDraft?.jiyong);
 if(!schema.initialization)return {schemaVersion:1,migrations:[]};
 let resources=installed.localDraft?.resources;
 if(!resources){
  const accepted=await require('./app-package-pages.cjs').definition(deps,installed.pluginId);
  assertCurrent();
  if(accepted.versionId!==installed.versionId || !require('node:util').isDeepStrictEqual(accepted.jiyong,schema))throw Error('即用安装版本已变化，请重新初始化');
  resources=accepted.resources;
 }
 const result=require('../core/jiyong-initialization.cjs').parse(schema,resources || []);assertCurrent();return result;
}
async function initialize(deps,pluginId,provided){
 const bound={pluginId,origin:pages.origin(pluginId)};
 let installed=provided;
 if(!installed)installed=pluginId.startsWith('local:')?require('./personal-plugins').get(deps.app,pluginId):await require('./app-installed-remote.cjs').get(deps,pluginId);
 if(!(installed.jiyong || installed.localDraft?.jiyong)?.initialization)return {ok:true,state:'not_needed'};
 if(installed.enabled===false)throw Error('即用已停用，无法初始化');
 let owner;
 try{owner=store.scope(bound);}catch(error){if(error.message.includes('请先登录') && (installed.jiyong || installed.localDraft?.jiyong)?.storage?.location!=='cloud')return {ok:true,state:'pending_account'};throw error;}
 const checksum=installed.checksum;
 const check=()=>{if(owner!==store.scope(bound) || (pluginId.startsWith('local:') && require('./personal-plugins').get(deps.app,pluginId).checksum!==checksum))throw Error('即用账号或版本已变化');};
 const initialization=await script(deps,installed,check);check();
 if((installed.jiyong || installed.localDraft?.jiyong)?.storage?.location==='cloud')return require('./jiyong-cloud-data.cjs').execute(deps,bound,installed,'initialize',{},check,initialization);
 return require('./jiyong-data.cjs').execute(deps.app,bound,installed.jiyong || installed.localDraft.jiyong,'initialize',{},check,initialization);
}
module.exports={script,initialize};

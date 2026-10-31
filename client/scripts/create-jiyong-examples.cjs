'use strict';
// Explicit developer command. Never runs during application startup.
const fs = require('node:fs'), path = require('node:path');
async function create({out,profile}) {
  const personal = require('../main/personal-plugins'), resources = require('../main/plugin-resources');
  const app = {getPath:() => path.resolve(profile || path.join(out,'isolated-profile'))};
  fs.mkdirSync(out,{recursive:true});
  if(profile && fs.existsSync(path.join(profile,'personal-plugins.json'))) {
    fs.copyFileSync(path.join(profile,'personal-plugins.json'),path.join(out,'personal-plugins-before-'+Date.now()+'.json'));
  }
  const installed=[];
  for(const [key,name,icon] of [['jiyong-example-notes','灵感便签','home'],['jiyong-example-shared','互通工作台','library']]) {
    const directory=path.join(out,key);fs.mkdirSync(path.join(directory,'ui'),{recursive:true});
    const source=path.resolve(__dirname,'../examples/jiyong-notes');
    for(const file of ['index.html','style.css','app.js']) fs.copyFileSync(path.join(source,file),path.join(directory,'ui',file));
    fs.copyFileSync(path.resolve(__dirname,'../sdk/soduwork-app.js'),path.join(directory,'ui/soduwork-app.js'));
    fs.copyFileSync(path.resolve(__dirname,'../assets/rail-icons',icon+'.png'),path.join(directory,'ui/icon.png'));
    if(key.endsWith('shared')) {
      const file=path.join(directory,'ui/index.html');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('把今天的想法，','让不同的即用，').replace('留给明天。','一起协作。').replace('即用 · 灵感便签','即用 · 互通工作台'));
    }
    const skill='通过本轮授权的 soduwork-jiyong MCP 工作。data_apps 发现同账号即用；notes 集合存业务便签。先读再写，保持 revision，冲突重读合并。不要将秘密写入业务集合；不要声明未执行的修改。';
    fs.mkdirSync(path.join(directory,'references'),{recursive:true});fs.writeFileSync(path.join(directory,'references/usage.md'),skill);
    let version='1.0.0'; const previous=personal.catalog(app,true).find(p=>p.key===key);
    if(previous){const match=/^(\d+)\.(\d+)\.(\d+)/.exec(previous.version);version=match[1]+'.'+match[2]+'.'+(BigInt(match[3])+1n);}
    fs.mkdirSync(path.join(directory,'assets'),{recursive:true});fs.writeFileSync(path.join(directory,'assets/data-init.json'),JSON.stringify({schemaVersion:1,migrations:[{version:1,seed:[]}]},null,2));
    const draft={template:'app',key,name,version,author:'即用实验室',appCategory:'office',description:'本机 SQLite、真实设置、AI 与定时任务入口、同账号即用数据互通的可操作示例。',instructions:skill,
      icon:'data:image/png;base64,'+fs.readFileSync(path.join(directory,'ui/icon.png')).toString('base64'),entrypoints:{automation:true},
      jiyong:{version:1,initialization:{script:'assets/data-init.json'},parameters:[{key:'nickname',label:'显示名称',type:'string',display:'text',default:''},{key:'appearance',label:'色彩',type:'string',display:'select',options:['warm','dark'],default:'warm'}],collections:[{key:'notes',indexes:['status']}],mcp:{server:'soduwork-jiyong',bindings:[]}},
      mcpServers:['soduwork-jiyong'],ui:{contributions:[{id:'main',title:name,slot:'workspace.navigation',source:{type:'package',entry:'ui/index.html',bridge:{version:1,capabilities:['data.read','data.write','settings.read','settings.write','mcp.connect','conversation.send','composer.control','automation.create','context.read','directory.read','notifications.send']}}}]},
      resources:[{path:'assets/data-init.json',kind:'asset'},...['index.html','style.css','app.js','soduwork-app.js','icon.png'].map(file=>({path:'ui/'+file,kind:'ui'})),{path:'references/usage.md',kind:'reference'}]};
    const file=path.join(directory,'soduwork-plugin-draft.json');fs.writeFileSync(file,JSON.stringify(draft,null,2));
    const body=resources.collect(draft,file,out);personal.preflight(body);const plugin=personal.create(app,body).plugin;
    const packaged=path.join(directory,key+'-'+version+'.soduwork-plugin');
    await personal.exportToFile(app,{showSaveDialog:async()=>({filePath:packaged})},plugin.pluginId);
    installed.push({pluginId:plugin.pluginId,name,version,source:directory,package:packaged});
  }
  fs.writeFileSync(path.join(out,'installed.json'),JSON.stringify(installed,null,2));return installed;
}
if(require.main===module){const args=process.argv.slice(2);const value=k=>args[args.indexOf(k)+1];if(!args.includes('--out'))throw Error('Specify --out; optionally --profile to install');create({out:value('--out'),profile:args.includes('--profile')?value('--profile'):null}).then(rows=>console.log(JSON.stringify(rows,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={create};

'use strict';
const fs=require('node:fs'),path=require('node:path');
const FILES=['SKILL.md','scripts/mcp-config.cjs','scripts/authoring-checks.cjs','references/connectors.json'];
const COMPILER=['api-definition.cjs','api-network.cjs','validation.cjs'];
function body(app){
  const root=app.isPackaged?path.join(process.resourcesPath,'skills','mcp-studio'):path.resolve(__dirname,'../../skills/mcp-studio');
  return {template:'method',key:'mcp-studio',name:'连接器快速配置',version:'1.3.0',
    description:'描述业务系统或提供配置，生成可导入的连接器配置，检查权限并指导测试与公司共享。',
    instructions:'先读取本轮资源 references/mcp-studio/SKILL.md。在当前对话创建或调整 MCP 配置，运行附带脚本生成真实文件并登记成果。不得读取密钥、执行上传配置中的命令或擅自启用连接。明确区分静态检查与真实连接实测。需要可安装插件时按指南将无凭据连接模板随包放入 references/connections/，试用时自动带入连接配置预览。',
    runtimeCapabilities:['files','terminal'],entrypoints:{conversation:true,task:true,automation:false},
    inputs:[{key:'brief',label:'接入需求',type:'textarea',placeholder:'描述要连接的系统、连接器地址或已有配置，不要填写密钥。'}],
    resources:[...FILES.map(p=>({path:'references/mcp-studio/'+p,kind:p.startsWith('scripts/')?'script':'reference',
      encoding:'base64',content:fs.readFileSync(path.join(root,p)).toString('base64')})),
      ...COMPILER.map(p=>({path:'references/mcp-studio/scripts/'+p,kind:'script',encoding:'base64',
        content:fs.readFileSync(path.join(root,'../mcp-tools/connectors',p)).toString('base64')}))]};
}
module.exports={body,FILES};

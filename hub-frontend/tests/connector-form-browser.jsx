import React from 'react'
import {createRoot} from 'react-dom/client'
import {McpForm} from '../src/screens/McpConnectionForm.jsx'
import {api} from '../src/api.js'
import '../src/styles.css'
import '../src/styles-devflow.css'
import '../src/design-system.css'
window.saves=[];window.probes=[];window.failProbe=false
api.probeMcpServer=async spec=>{window.probes.push(spec);if(window.hold)await new Promise(resolve=>window.finish=resolve);return window.failProbe?{ok:false,error:'授权已失效'}:{ok:true,authenticationTested:true}}
const root=createRoot(document.getElementById('root'));let seq=0
window.openForm=()=>root.render(<McpForm key={++seq} initial={{id:'fixture',name:'Figma',type:'stdio',command:'node',templateKey:'connector-figma',env:{FIGMA_TOKEN:''}}}
 template={{key:'connector-figma',name:'Figma',description:'读取设计文件，查看项目与评论',configurable:true,connectionFields:[{key:'FIGMA_TOKEN',label:'访问令牌',required:true,secret:true}]}}
 onClose={()=>root.render(<p>已关闭</p>)} onSave={async spec=>{window.saves.push(spec);root.render(<p>已连接</p>)}} />)
window.openForm()

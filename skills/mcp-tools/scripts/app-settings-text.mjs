// Raw Markdown -> deterministic put_settings JSON. The official bridge owns auth.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const argv=process.argv.slice(2), values={}, channels=[], names=[];
try {
  const allowed=new Set(['--config','--server','--space','--series','--style','--ratio','--cover','--channel','--channel-name']);
  for(let i=0;i<argv.length;i+=2){const flag=argv[i],value=argv[i+1];if(!allowed.has(flag)||!value)throw Error('无效的系列设定参数');
    if(flag==='--channel')channels.push(value);else if(flag==='--channel-name')names.push(value);else{if(values[flag])throw Error('重复参数');values[flag]=value;}}
  if(!values['--config']||!values['--server']||!values['--space']||!values['--series'])throw Error('必填：--config --server --space --series；正文从标准输入读取');
  const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>256*1024)throw Error('设定正文过大');chunks.push(chunk)}
  const doc=Buffer.concat(chunks).toString('utf8'), settings={};
  if(doc.trim())settings.doc=doc;
  for(const [flag,key] of [['--style','visual_style'],['--ratio','media_ratio'],['--cover','cover_attachment_id']])if(values[flag])settings[key]=values[flag];
  if(channels.length)settings.target_channels=channels;if(names.length)settings.target_channel_names=names;
  if(!Object.keys(settings).length)throw Error('没有可写入的设定字段');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./mcp.mjs',import.meta.url)),'--config',values['--config'],'call',values['--server'],'put_settings'],
    {shell:false,windowsHide:true,env:{...process.env,SODUWORK_MCP_ARGS_STDIN:'1'},input:JSON.stringify({space_id:values['--space'],series_id:values['--series'],settings}),encoding:'utf8',maxBuffer:2*1024*1024,timeout:300000});
  if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
  if(result.error)throw Error('系列设定桥接失败');process.exitCode=result.status??1;
}catch(error){console.error(error.message);process.exitCode=1}

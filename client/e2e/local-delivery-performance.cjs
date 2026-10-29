'use strict';
// Actual file reads/packing with main-loop responsiveness sampled separately.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), { performance } = require('node:perf_hooks');
const packages = require('../main/conversation/delivery-package');
const artifacts = require('../main/conversation/artifact-runtime');
const outputs = require('../main/pi-session/outputs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'soduwork-local-performance-'));
  const baseline = process.argv.includes('--baseline');
  try {
    await fs.mkdir(path.join(root,'.soduwork'));
    await fs.writeFile(path.join(root,'report.md'),'# Final result\n');
    await fs.writeFile(path.join(root,'data.bin'),crypto.randomBytes(32*1024*1024));
    await fs.writeFile(path.join(root,'.soduwork/delivery.json'),JSON.stringify({schemaVersion:1,deliverables:[{path:'report.md',files:['data.bin']}]}));
    const session = {cwd:root,sessionId:'perf',snapshot:()=>({status:'idle'}),outputSnapshot:()=>outputs.scan(root,0,1)};
    const ids = artifacts.snapshot(session).items.filter(f=>f.primary!==false).map(f=>f.artifactId);
    let last=performance.now(), maxGap=0, beats=0;
    const timer = setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;beats++;},10);
    await wait(30); const start=performance.now();
    const captured=baseline ? {payload:await packages.prepare(session,ids,{completedTurn:true})} : await require('../main/conversation/delivery-package-worker').capture(session,ids,{completedTurn:true});
    const captureMs=performance.now()-start;
    const packed=await captured.payload, totalMs=performance.now()-start;
    await wait(30); clearInterval(timer);
    if(packed.manifest.files.length!==2 || packed.bytes.readUInt32LE(0)!==0x04034b50) throw Error('Incomplete archive');
    const report={mode:baseline?'baseline':'worker',fixtureBytes:32*1024*1024,fileCount:2,captureMs:Math.round(captureMs),totalMs:Math.round(totalMs),maxMainLoopGapMs:Math.round(maxGap),heartbeatSamples:beats,archiveBytes:packed.bytes.length};
    const out=path.resolve(__dirname,'../../outputs/local-execution-20261004');await fs.mkdir(out,{recursive:true});
    await fs.writeFile(path.join(out,(baseline?'before':'after')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1});

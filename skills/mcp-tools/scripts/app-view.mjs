// Uses an explicit per-turn app lease. No stored ukey, arbitrary JS or browser attach.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
try {
  if (args[0] !== '--config' || !args[1] || !args[2] || !['inspect', 'shot'].includes(args[3]) || args.length > 5 || (args[3] === 'inspect' && args.length !== 4)) {
    throw Error('用法：app-view.mjs --config <本轮授权文件> <连接名> inspect|shot [当前工作目录下的新PNG文件]');
  }
  const spec = JSON.parse(fs.readFileSync(args[1], 'utf8')).servers?.[args[2]], url = new URL(spec?.url);
  if (spec.appLease !== true || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password ||
      !/^Bearer [a-f0-9]{64}$/.test(spec.headers?.Authorization || '')) throw Error('必须使用本轮本机应用授权');
  url.pathname = '/app-view/' + args[3];
  const response = await fetch(url, { headers: { Authorization: spec.headers.Authorization }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('当前应用查看失败：HTTP ' + response.status);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 12 * 1024 * 1024) throw Error('应用查看结果过大'); chunks.push(chunk); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result.ok || result.source !== 'current-application') throw Error('应用查看结果无效');
  if (args[3] === 'shot') {
    const directory = fs.realpathSync(process.cwd()), output = path.resolve(args[4] || 'soduwork-app-' + Date.now() + '.png');
    if (path.dirname(output) !== directory || path.extname(output).toLowerCase() !== '.png') throw Error('截图只能保存到当前工作目录的新 PNG 文件');
    const png = Buffer.from(result.png || '', 'base64');
    if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('截图格式无效');
    fs.writeFileSync(output, png, { flag: 'wx', mode: 0o600 }); result.screenshot = output;
  }
  delete result.png;
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }

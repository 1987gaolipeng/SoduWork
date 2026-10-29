/** Thin launcher for reviewed official packages. Import/check never installs or authenticates. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function canonicalTarget(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('路径根目录不存在。');
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  if (!fs.statSync(cursor).isDirectory()) throw new Error('目录路径指向普通文件。');
  return path.join(fs.realpathSync(cursor), ...suffix);
}
export function options(argv) {
  const [action = 'info', ...tail] = argv;
  const result = { action, args: [] };
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] === '--') { result.args = tail.slice(i + 1); break; }
    const name = tail[i];
    if (!['--prefix', '--state', '--port', '--tools'].includes(name) || !tail[i + 1] || tail[i + 1].startsWith('--')) {
      throw new Error('参数不合法；使用 info 查看说明，业务参数放在 -- 之后。');
    }
    if (result[name.slice(2)] !== undefined) throw new Error('参数重复：' + name);
    result[name.slice(2)] = tail[++i];
  }
  if (!['info', 'check', 'run', 'serve'].includes(action)) throw new Error('仅支持 info、check、run、serve。');
  return result;
}
export function inspect(lock, prefix) {
  if (!prefix || !path.isAbsolute(prefix)) throw new Error('--prefix 必须是独立 CLI 安装目录的绝对路径。');
  if (Number(process.versions.node.split('.')[0]) < lock.nodeMinimum) return { status: 'node-version-mismatch', required: lock.nodeMinimum };
  const dir = path.join(prefix, 'node_modules', ...lock.package.split('/'));
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'not-installed' };
    throw new Error('无法读取官方 CLI 清单；请重新检查安装目录。');
  }
  if (metadata.name !== lock.package || metadata.version !== lock.version) return { status: 'version-mismatch', expected: lock.version };
  const entry = path.join(dir, lock.entry);
  if (!fs.existsSync(entry)) return { status: 'entry-missing' };
  if (!inside(fs.realpathSync(prefix), fs.realpathSync(entry))) throw new Error('CLI 入口不能跳出独立安装目录。');
  if (lock.provider === 'dingtalk') {
    const binary = path.join(dir, 'vendor', process.platform === 'win32' ? 'dws.exe' : 'dws');
    if (!fs.existsSync(binary)) return { status: 'binary-not-prepared' };
    if (!fs.statSync(binary).isFile() || !inside(fs.realpathSync(prefix), fs.realpathSync(binary))) {
      throw new Error('钉钉二进制入口必须位于独立安装目录。');
    }
  }
  return { status: 'installed', version: lock.version, authentication: 'not-checked', entry };
}
export function plan(lock, opt, environment = process.env, node = process.execPath) {
  const found = inspect(lock, opt.prefix);
  if (found.status !== 'installed') throw new Error('CLI 尚未就绪：' + found.status + '；按 README 安装固定版本。');
  const env = { ...environment };
  let args = opt.args;
  const cwd = fs.realpathSync(opt.prefix);
  if (lock.provider === 'feishu') {
    if (opt.action !== 'serve') throw new Error('飞书入口只提供 serve；业务操作请使用 SoduWork 授权的 feishu MCP。');
    if (!env.APP_ID || !env.APP_SECRET) throw new Error('请由管理员在服务进程环境中配置 APP_ID 和 APP_SECRET。');
    // Shared service uses only this application's identity and official endpoint.
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'USER_ACCESS_TOKEN' || key.toUpperCase().startsWith('LARK_')) delete env[key];
    }
    const port = Number(opt.port || 3000);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须介于 1024 与 65535。');
    if (args.length) throw new Error('serve 不接受透传参数。');
    args = ['mcp', '-d', 'https://open.feishu.cn', '-m', 'streamable', '--host', '127.0.0.1', '-p', String(port),
      '--token-mode', 'tenant_access_token', '-l', 'zh', '-t', opt.tools || 'preset.default'];
  } else {
    if (opt.action !== 'run' || !args.length) throw new Error('使用 run --prefix ... --state ... -- <官方 CLI 参数>。');
    if (!opt.state || !path.isAbsolute(opt.state)) throw new Error('--state 必须指定当前账号的私有授权目录绝对路径。');
    if (inside(fs.realpathSync(packageRoot), canonicalTarget(opt.state))) throw new Error('授权目录不能位于插件资源包内。');
    const namespace = lock.provider === 'wecom' ? 'WECOM_CLI_' : 'DWS_';
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith(namespace)) delete env[key];
    env[namespace + 'CONFIG_DIR'] = canonicalTarget(opt.state);
    if (lock.provider === 'wecom') {
      env.WECOM_CLI_TMP_DIR = path.join(opt.state, 'tmp');
      env.WECOM_CLI_LOG_DIR = path.join(opt.state, 'logs');
    }
  }
  return { command: node, args: [found.entry, ...args], env, cwd };
}
export async function main(argv) {
  const opt = options(argv);
  const lock = JSON.parse(fs.readFileSync(path.join(packageRoot, 'upstream-lock.json'), 'utf8'));
  if (opt.action === 'info') {
    console.log(JSON.stringify({ provider: lock.provider, package: lock.package, version: lock.version,
      usage: 'check --prefix <absolute-dir> | run --prefix <absolute-dir> --state <private-dir> -- <CLI args> | serve --prefix <absolute-dir>',
      installArgv: ['npm', 'install', '--prefix', '<absolute-dir>', '--save-exact', '--no-audit', '--no-fund',
        ...(lock.provider === 'dingtalk' ? ['--ignore-scripts'] : []), lock.package + '@' + lock.version],
      ...(lock.provider === 'dingtalk' ? { prepareArgv: ['python', path.join(packageRoot, 'scripts', 'prepare-dingtalk.py'), '--prefix', '<absolute-dir>'] } : {}),
      note: '安装和平台授权需要单独操作；本命令没有安装、登录或业务调用。' }, null, 2));
    return 0;
  }
  if (opt.action === 'check') {
    const result = inspect(lock, opt.prefix);
    delete result.entry;
    console.log(JSON.stringify(result));
    return result.status === 'installed' ? 0 : 2;
  }
  const launch = plan(lock, opt);
  return await new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { env: launch.env, cwd: launch.cwd, shell: false, windowsHide: true, stdio: 'inherit' });
    child.once('error', () => { console.error('官方 CLI 未能启动。'); resolve(1); });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

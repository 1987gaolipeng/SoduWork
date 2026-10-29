'use strict';
// User-installed ACP executables. Declarations contain no credentials or code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 32768;
const forbiddenPrograms = /^(?:cmd|powershell|pwsh|bash|sh|zsh|fish|wscript|cscript|mshta)(?:\.exe)?$/i;
function fail(message) { throw Error(message); }
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(label + '不正确');
  return value.trim();
}
function declaration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('底座配置不正确');
  const id = text(input.id, 40, '底座标识');
  if (!/^custom-[a-z0-9][a-z0-9-]*$/.test(id)) fail('自定义底座标识须以 custom- 开头');
  const displayName = text(input.displayName, 80, '底座名称');
  const command = text(input.command, 1024, '启动程序');
  if (!path.win32.isAbsolute(command) && !path.posix.isAbsolute(command) && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(command)) fail('请填写程序的完整路径或 PATH 中的命令名');
  if (forbiddenPrograms.test(path.win32.basename(command)) || forbiddenPrograms.test(path.posix.basename(command))) fail('请选择 Agent 程序，不支持 Shell 命令');
  if (!Array.isArray(input.args) || input.args.length > 32 || input.args.some(arg => typeof arg !== 'string' || arg.length > 1024 || /[\x00-\x1f\x7f]/.test(arg) || /^(?:-e|-c|\/c|\/k|--eval|--command|-command|--encodedcommand|-encodedcommand)(?:=|$)/i.test(arg))) fail('启动参数必须逐项填写，不支持内联脚本');
  if (!['account', 'managed'].includes(input.modelMode)) fail('请选择模型来源');
  const modelEnv = input.modelEnv || {};
  if (typeof modelEnv !== 'object' || Array.isArray(modelEnv) || Object.keys(modelEnv).length > 3 || Object.entries(modelEnv).some(([key, value]) =>
    !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || !['base', 'key', 'model'].includes(value) || /^(?:(?:PATH|PATHEXT|HOME|USERPROFILE|NODE_OPTIONS|NODE_PATH|PYTHONHOME|PYTHONPATH|LD_PRELOAD|LD_LIBRARY_PATH|ELECTRON_RUN_AS_NODE|COMSPEC)$|SODUWORK_|SODUWORK_|DYLD_)/i.test(key))) fail('模型环境变量映射不正确');
  if (input.modelMode === 'account' && Object.keys(modelEnv).length) fail('底座自己的账号不接收 SoduWork 模型配置');
  if (input.modelMode === 'managed' && !['base', 'key', 'model'].every(value => Object.values(modelEnv).includes(value))) fail('请填写模型地址、令牌和模型名称的环境变量名');
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (summary.length > 400 || /[\x00-\x1f\x7f]/.test(summary)) fail('底座说明过长或包含无效字符');
  return { id, displayName, summary, transport: 'runner', modelMode: input.modelMode, goalMode: 'none', group: 'more', order: 1000,
    accessControl: { schema: 'soduwork.access-policy/v1', supported: false, modes: [], approval: '', sandbox: false },
    runner: { adapter: 'acp', bins: [command], args: [...input.args], modelEnv: { ...modelEnv } },
    install: { installer: 'manual', source: '用户接入的本机 Agent', blurb: '使用本机已安装的标准 ACP Agent', install_how: '请按供应商说明安装程序并配置账号。' } };
}
function validateStored(row) {
  const got = declaration({ id: row?.id, displayName: row?.displayName, summary: row?.summary,
    command: row?.runner?.bins?.[0], args: row?.runner?.args, modelMode: row?.modelMode, modelEnv: row?.runner?.modelEnv });
  if (JSON.stringify(got) !== JSON.stringify(row)) fail('本机底座配置格式不受支持，请检查配置文件');
  return got;
}
function createStore(app, io = fs) {
  const file = path.join(app.getPath('userData'), 'agent-runtime', 'custom-agents.json');
  function read() {
    let blob;
    try { blob = io.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (Buffer.byteLength(blob) > MAX_BYTES + 4096) fail('本机底座配置过大');
    const saved = JSON.parse(blob);
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.entries) || saved.entries.length > 16) fail('本机底座配置格式不正确');
    const ids = new Set();
    return saved.entries.map(entry => {
      const spec = validateStored(entry.declaration);
      if (ids.has(spec.id)) fail('本机底座标识重复'); ids.add(spec.id);
      return { declaration: spec, active: entry.active === true };
    });
  }
  function write(entries) {
    if (entries.length > 16 || Buffer.byteLength(JSON.stringify(entries.map(entry => entry.declaration))) > MAX_BYTES) fail('本机最多接入 16 个底座，配置总量不能超过 32 KB');
    const next = file + '.' + crypto.randomUUID() + '.tmp';
    io.mkdirSync(path.dirname(file), { recursive: true });
    try { io.writeFileSync(next, JSON.stringify({ schemaVersion: 1, entries }), { mode: 0o600, flag: 'wx' }); io.renameSync(next, file); }
    finally { try { io.unlinkSync(next); } catch (_) { /* successful rename or failed staging */ } }
  }
  return { read, write, file };
}
function startupAgents(app) {
  // Broken user configuration must not prevent the built-in Runner from starting.
  try { return createStore(app).read().map(entry => entry.declaration); }
  catch { return []; } // The management screen reports the unreadable configuration; never overwrite it.
}
module.exports = { declaration, validateStored, createStore, startupAgents };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_BYTES = 32 * 1024 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const INVALID = '图片文件无效、不完整或超过限制。请检查服务返回的 PNG、JPEG 或 WebP 单帧图片（最多 32 MB、3200 万像素）。';
let checkedRuntime;

class ImageResultError extends Error {}

function validator() {
  const repo = path.resolve(__dirname, '../../..');
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'generated_image.py');
  const script = packaged && fs.existsSync(packaged) ? packaged : path.join(repo, 'hub-backend/app/services/generated_image.py');
  const source = path.basename(repo) === 'application' && process.env.SODUWORK_SOURCE_SESSION === '1';
  const managed = process.env.SODUWORK_RUNTIME_MANAGED === '1';
  const venv = source ? path.resolve(repo, '../venv') : path.join(repo, 'hub-backend/.venv');
  const python = managed ? process.env.SODUWORK_MANAGED_PYTHON
    : path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const help = managed ? '请修复或重新安装 SoduWork 的 Python 运行环境。'
    : source ? '请从项目根目录重新运行 sh start.sh --desktop（Windows 使用 start.cmd --desktop）。'
      : '请激活 ../hub-backend/.venv，在 client/ 目录运行 python -m pip install -c ../hub-backend/requirements.txt Pillow 并重新启动客户端。';
  const unavailable = new ImageResultError('本机图片校验组件不可用。' + help);
  unavailable.code = 'IMAGE_VALIDATOR_UNAVAILABLE';
  if (!python || !fs.existsSync(python) || !fs.existsSync(script)) throw unavailable;
  return { python, script, unavailable };
}

function run(runtime, args, bytes, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(runtime.python, ['-I', runtime.script, ...args], { signal, timeout: 30000, windowsHide: true, maxBuffer: 4096 },
      (error, stdout) => {
        if (error) reject(error.code === 2 ? new ImageResultError(INVALID) : runtime.unavailable);
        else resolve(stdout.trim());
      });
    // The validator can exit before stdin drains, for example on cancellation.
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

async function prepare(signal) {
  const runtime = validator();
  signal?.throwIfAborted();
  if (checkedRuntime?.python !== runtime.python || checkedRuntime.script !== runtime.script) {
    await run(runtime, ['--check'], undefined, signal);
    checkedRuntime = runtime;
  }
  return runtime;
}

async function validate({ bytes, file, expectedType, signal }, runtime = validator()) {
  if (bytes && (!bytes.length || bytes.length > MAX_BYTES)) throw new ImageResultError(INVALID);
  const type = await run(runtime, file ? [file] : [], bytes, signal);
  signal?.throwIfAborted();
  if (!MIME_TYPES.has(type) || (expectedType && expectedType !== type)) throw new ImageResultError(INVALID);
  return type;
}

module.exports = { MAX_BYTES, ImageResultError, prepare, validate };

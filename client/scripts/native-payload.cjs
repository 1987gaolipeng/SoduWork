'use strict';
// Embed application files directly into NSIS. No external archive process writes
// runtime .txt/.zip files. Explicit extended paths avoid File /r MAX_PATH failures.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { stageSource } = require('./payload-sources.cjs');
function literal(value) {
  if (/[\r\n\0"]/u.test(value)) throw Error('Unsupported NSIS payload path');
  return value.replaceAll('$', '$$');
}
function stagedSourcePath(output, index) {
  if (!Number.isSafeInteger(index) || index < 0) throw Error('Invalid payload index');
  // NSIS scans the input directory for each File instruction, even for an exact
  // name. Bound each directory to 64 files to avoid quadratic compile time.
  return path.resolve(output, 'payload-sources', String(Math.floor(index / 64)).padStart(4, '0'),
    String(index).padStart(6, '0') + '.bin');
}
async function writeNativePayload(root, output) {
  root = path.resolve(root);
  const manifestBytes = await fs.readFile(path.join(root, '.soduwork-payload.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const sizes = new Map(manifest.files.map(item => [item.path, item.size]));
  if (sizes.size !== manifest.files.length || sizes.has('.soduwork-payload.json')) throw Error('Duplicate payload path');
  sizes.set('.soduwork-payload.json', manifestBytes.length);
  validateSizes(sizes);
  const inventory = [...manifest.files, { path: '.soduwork-payload.json', size: manifestBytes.length,
    sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex') }];
  const sources = new Map();
  for (const [index, item] of inventory.entries()) {
    validatePath(item.path);
    const target = stagedSourcePath(output, index);
    await stageSource(path.join(root, item.path), target, item);
    sources.set(item.path, target);
  }
  const content = renderNativePayload(sizes, sources);
  await fs.writeFile(path.join(output, 'native-payload.nsh'), content);
  return sizes.size;
}
function validatePath(file) {
  if (path.posix.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => part === '..' || !part)) {
    throw Error('Unsafe payload path: ' + file);
  }
}
function validateSizes(sizes) {
  for (const [file, size] of sizes) {
    if (!Number.isSafeInteger(size) || size < 0) throw Error('Invalid payload size: ' + file);
  }
}
function renderNativePayload(sizes, sources) {
  validateSizes(sizes);
  const files = [...sizes.keys()].sort();
  const totalBytes = [...sizes.values()].reduce((total, size) => total + size, 0);
  if (!Number.isSafeInteger(totalBytes)) throw Error('Payload size exceeds supported range');
  // Package self-check and installation share one function. Expanding File
  // instructions twice makes NSIS reread/recompress the complete runtime.
  const lines = ['; Generated from the exact verified Windows payload; do not edit.', '!include "LogicLib.nsh"',
    '!macro soduWorkExtractPayload ROOT', 'Push "${ROOT}"', 'Call soduWorkExtractPayload', '!macroend',
    'Function soduWorkExtractPayload', 'Exch $R8', 'Push $0'];
  let previous, completedBytes = 0, previousPercent = -1, previousCompleted = 0;
  const progress = (percent, completed) => {
    if (percent === previousPercent && completed - previousCompleted < 128 && completed !== files.length) return;
    // Constants are calculated in JavaScript, not 32-bit NSIS byte arithmetic.
    // Bound snapshots by percentage changes plus one per 128 small files. File
    // counts keep moving through dependency folders without per-file IPC/IO.
    lines.push('!ifmacrodef soduWorkProgress', `!insertmacro soduWorkProgress ${percent} ${completed} ${files.length}`, '!endif');
    previousPercent = percent;
    previousCompleted = completed;
  };
  progress(0, 0);
  for (const [index, file] of files.entries()) {
    validatePath(file);
    const parent = path.posix.dirname(file);
    if (parent !== previous) {
      const relative = parent === '.' ? '' : '\\' + literal(parent.replaceAll('/', '\\'));
      lines.push('SetOutPath "\\\\?\\$R8' + relative + '"');
      // NSIS sets an error when changing the process working directory beyond
      // MAX_PATH, even though it creates the extended output path correctly.
      // Check that directory with the wide Win32 API before clearing that flag.
      lines.push('System::Call \'kernel32::GetFileAttributesW(w "\\\\?\\$R8' + relative + '") i .r0\'',
        '${If} $0 == -1', 'SetErrors', 'Goto soduWorkNativeDone', '${EndIf}',
        'IntOp $0 $0 & 0x10', '${If} $0 == 0', 'SetErrors', 'Goto soduWorkNativeDone', '${EndIf}', 'ClearErrors');
      previous = parent;
    }
    if (!sources.has(file)) throw Error('Missing staged payload: ' + file);
    const source = literal(sources.get(file));
    lines.push('File "/oname=' + literal(path.posix.basename(file)) + '" "\\\\?\\' + source + '"');
    lines.push('IfErrors soduWorkNativeDone');
    completedBytes += sizes.get(file);
    const completed = index + 1;
    progress(totalBytes ? Math.floor(completedBytes / totalBytes * 70) : Math.floor(completed / files.length * 70), completed);
  }
  lines.push('SetOutPath "$R8"', 'soduWorkNativeDone:', 'Pop $0', 'Pop $R8', 'FunctionEnd', '');
  return lines.join('\n');
}
module.exports = { writeNativePayload, renderNativePayload, stagedSourcePath };

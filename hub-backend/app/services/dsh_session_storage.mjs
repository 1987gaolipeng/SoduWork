// SoduWork host-only compatibility for DSH's JSONL persistence backend.
// Retain its exclusive writer lease and atomic, write-through publication.
// Some Windows encryption filters classify .tmp and .jsonl/.zstd differently;
// keeping the original suffix prevents a same-directory EXDEV at publication.
import { randomBytes } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, toNamespacedPath } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function writeSyncedTempFile(finalPath, content) {
  // This stem cannot be mistaken for a committed session generation.
  const temporary = join(dirname(finalPath), '.soduwork-' + randomBytes(12).toString('hex') + '.tmp-' + basename(finalPath));
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  return temporary;
}

// Move without REPLACE_EXISTING preserves the create-if-absent guarantee on
// encryption-filtered volumes where hard links are unavailable. No copy fallback.
export function publishNewFile(move, lastError, source, target) {
  if (move(toNamespacedPath(source), toNamespacedPath(target), 8)) return;
  const win32Code = lastError();
  const code = ({ 2: 'ENOENT', 3: 'ENOENT', 5: 'EACCES', 17: 'EXDEV', 80: 'EEXIST', 183: 'EEXIST' })[win32Code] || 'EIO';
  const error = new Error('Atomic file creation failed (Win32 ' + win32Code + ')');
  Object.assign(error, { code, errno: win32Code, syscall: 'MoveFileExW', path: source, dest: target });
  throw error;
}

async function runtimeVersion(root) {
  // The ACP adapter owns the version contract. Reading the installed DSH
  // manifest keeps this loader aligned when the server ships a new runtime;
  // hard-coding an older storage package version makes repair/install loop
  // forever after a runtime upgrade.
  try {
    const runtime = JSON.parse(await readFile(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return String(runtime.version || '').trim();
  } catch (_) { return ''; }
}

async function verifiedEntry(root, name) {
  const directory = join(root, 'node_modules', '@deepseek-ai', name);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const expected = String(process.env.SODUWORK_DSH_STORAGE_VERSION || '').trim() || await runtimeVersion(root);
  if (manifest.name !== '@deepseek-ai/' + name || !expected || manifest.version !== expected) {
    throw new Error('DeepSeek Harness storage version does not match the bundled runtime; repair the runtime or update SoduWork before running.');
  }
  return join(directory, 'lib', 'index.js');
}

async function configureFileStaging(root) {
  const entry = await verifiedEntry(root, 'dsh-fs-local');
  const { LocalFileSystem } = await import(pathToFileURL(entry).href);
  const koffi = createRequire(entry)('koffi');
  const kernel = koffi.load('kernel32.dll');
  const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']);
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint', []);
  for (const method of ['writeText', 'editText']) {
    const original = LocalFileSystem?.prototype?.[method];
    if (typeof original !== 'function' || original.length !== 4) {
      throw new Error('DeepSeek Harness file interface changed; update its SoduWork adapter before running.');
    }
    LocalFileSystem.prototype[method] = function (...args) {
      // Retain upstream locking, version guards, sandbox checks, ACL handling,
      // flush and cleanup. Only staging names and no-replace publication differ.
      this.internals.tempName = path => '.soduwork-stage-' + basename(path);
      this.internals.linkFile = (source, target) => publishNewFile(move, lastError, source, target);
      return original.apply(this, args);
    };
  }
}

const runtimeRoot = process.env.SODUWORK_DSH_STORAGE_RUNTIME;
if (runtimeRoot) {
  // Runner set this dedicated preload after clearing inherited Node options.
  // Do not pass it to model-launched tools or unrelated child Node processes.
  delete process.env.SODUWORK_DSH_STORAGE_RUNTIME;
  delete process.env.NODE_OPTIONS;
  if (process.platform === 'win32') {
    const entry = await verifiedEntry(runtimeRoot, 'dsh-session-persistence-jsonl');
    const persistence = await import(pathToFileURL(entry).href);
    // DSH 0.2.x exposes the JSONL backend as a Cordis `apply` plugin and
    // owns its current atomic publication path internally. Older releases
    // exposed a default Persistence class that required our Windows staging
    // hook. Keep both contracts working so an adapter upgrade does not turn
    // every install into a permanent "storage interface changed" failure.
    const Persistence = persistence?.default;
    if (typeof Persistence?.prototype?.writeSyncedTempFile === 'function'
        && Persistence.prototype.writeSyncedTempFile.length === 2) {
      Persistence.prototype.writeSyncedTempFile = writeSyncedTempFile;
    } else if (typeof persistence?.apply !== 'function') {
      throw new Error('DeepSeek Harness storage interface is unsupported; update SoduWork before running.');
    }
    await configureFileStaging(runtimeRoot);
  }
}

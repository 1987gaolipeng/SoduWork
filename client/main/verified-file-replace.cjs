'use strict';

// Prefer atomic rename. Some managed Windows volumes report EXDEV even for
// adjacent files; only that error permits a checked copy with a recovery copy.
const fs = require('node:fs');
const asyncFs = require('node:fs/promises');
const crypto = require('node:crypto');
const missing = error => { if (error.code !== 'ENOENT') throw error; return null; };
function regular(stat) {
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('文件保存路径不是普通文件');
  return stat;
}
const equal = (a, b) => a.size === b.size && a.sha256 === b.sha256;
function verified(actual, expected) {
  if (!equal(actual, expected)) throw Error('文件保存完整性校验失败');
}
async function fingerprint(file) {
  const hash = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of fs.createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}
function fingerprintSync(file) {
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = fs.openSync(file, 'r'); let size = 0, count;
  try { while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
    size += count; hash.update(buffer.subarray(0, count));
  } } finally { fs.closeSync(fd); }
  return { size, sha256: hash.digest('hex') };
}

async function replaceFile(source, target, { expected, check = async () => {}, checkPath = async () => {} } = {}) {
  await check(); await checkPath();
  try { await asyncFs.rename(source, target); return; }
  catch (error) { if (error.code !== 'EXDEV') throw error; }
  regular(await asyncFs.lstat(source));
  const wanted = await fingerprint(source);
  if (expected) verified(wanted, expected);
  const old = regular(await asyncFs.lstat(target).catch(missing));
  const backup = target + '.replace-' + crypto.randomUUID() + '.bak';
  let backupReady = false, backupOccupied = false, changed = false, restored = false, occupied = false, oldDigest;
  try {
    if (old) {
      oldDigest = await fingerprint(target);
      try { await asyncFs.copyFile(target, backup, fs.constants.COPYFILE_EXCL); }
      catch (error) { backupOccupied = error.code === 'EEXIST'; throw error; }
      verified(await fingerprint(backup), oldDigest);
      backupReady = true; // A partial backup must never replace the original.
    }
    await check(); await checkPath();
    const present = regular(await asyncFs.lstat(target).catch(missing));
    if (!!present !== !!old) throw Error('文件保存期间目标已变化');
    if (present) verified(await fingerprint(target), oldDigest);
    if (old) await asyncFs.unlink(target);
    changed = true;
    // EXCL avoids following a target link created during the fallback.
    try { await asyncFs.copyFile(source, target, fs.constants.COPYFILE_EXCL); }
    catch (error) { occupied = error.code === 'EEXIST'; throw error; }
    verified(await fingerprint(target), wanted);
    await check(); await checkPath();
    await asyncFs.unlink(source);
  } catch (error) {
    if (changed && occupied && backupReady) error.recoveryPath = backup;
    if (changed && !occupied) {
      try {
        await checkPath();
        regular(await asyncFs.lstat(target).catch(missing));
        await asyncFs.unlink(target).catch(missing);
        if (backupReady) {
          await asyncFs.copyFile(backup, target, fs.constants.COPYFILE_EXCL);
          verified(await fingerprint(target), oldDigest);
        }
        restored = true;
      } catch (recoveryError) {
        error.recoveryError = recoveryError;
        if (backupReady) error.recoveryPath = backup;
      }
    }
    if (!backupOccupied && (!changed || restored)) await asyncFs.unlink(backup).catch(() => {});
    throw error;
  }
  await asyncFs.unlink(backup).catch(() => {});
}

function replaceFileSync(source, target) {
  try { fs.renameSync(source, target); return; }
  catch (error) { if (error.code !== 'EXDEV') throw error; }
  regular(fs.lstatSync(source));
  const wanted = fingerprintSync(source);
  let old;
  try { old = regular(fs.lstatSync(target)); } catch (error) { old = missing(error); }
  const backup = target + '.replace-' + crypto.randomUUID() + '.bak';
  let backupReady = false, backupOccupied = false, changed = false, restored = false, occupied = false, oldDigest;
  const remove = file => { try { fs.unlinkSync(file); } catch (error) { missing(error); } };
  try {
    if (old) {
      oldDigest = fingerprintSync(target);
      try { fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL); }
      catch (error) { backupOccupied = error.code === 'EEXIST'; throw error; }
      verified(fingerprintSync(backup), oldDigest);
      backupReady = true;
    }
    if (old) { verified(fingerprintSync(target), oldDigest); fs.unlinkSync(target); }
    changed = true;
    try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
    catch (error) { occupied = error.code === 'EEXIST'; throw error; }
    verified(fingerprintSync(target), wanted);
    fs.unlinkSync(source);
  } catch (error) {
    if (changed && occupied && backupReady) error.recoveryPath = backup;
    if (changed && !occupied) {
      try {
        try { regular(fs.lstatSync(target)); } catch (checkError) { missing(checkError); }
        remove(target);
        if (backupReady) {
          fs.copyFileSync(backup, target, fs.constants.COPYFILE_EXCL);
          verified(fingerprintSync(target), oldDigest);
        }
        restored = true;
      } catch (recoveryError) {
        error.recoveryError = recoveryError;
        if (backupReady) error.recoveryPath = backup;
      }
    }
    if (!backupOccupied && (!changed || restored)) { try { remove(backup); } catch (_) {} }
    throw error;
  }
  try { remove(backup); } catch (_) {}
}

async function writeFile(target, bytes, options = {}) {
  const temporary = target + '.' + crypto.randomUUID() + '.tmp';
  try {
    await asyncFs.writeFile(temporary, bytes, { ...options, flag: 'wx' });
    await replaceFile(temporary, target);
  } finally { await asyncFs.unlink(temporary).catch(() => {}); }
}
module.exports = { replaceFile, replaceFileSync, writeFile };

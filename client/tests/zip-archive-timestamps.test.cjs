'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archive = require('../main/conversation/zip-archive');

function timestamp(bytes, offset) {
  const time = bytes.readUInt16LE(offset), date = bytes.readUInt16LE(offset + 2);
  return [1980 + (date >>> 9), (date >>> 5) & 15, date & 31,
    time >>> 11, (time >>> 5) & 63, (time & 31) * 2];
}

function assertTimestamps(bytes, expected) {
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const footer = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(footer), 0x06054b50);
  const central = bytes.readUInt32LE(footer + 16);
  assert.equal(bytes.readUInt32LE(central), 0x02014b50);
  assert.deepEqual(timestamp(bytes, 10), expected, 'local header timestamp');
  assert.deepEqual(timestamp(bytes, central + 12), expected, 'central directory timestamp');
}

test('both ZIP entry encoders clamp DOS timestamps and retain representable local dates', async context => {
  const cases = [
    ['before 1980', new Date(1979, 11, 31, 23, 59, 58).getTime(), [1980, 1, 1, 0, 0, 0]],
    ['Unix epoch', 0, [1980, 1, 1, 0, 0, 0]],
    ['invalid timestamp', NaN, [1980, 1, 1, 0, 0, 0]],
    ['after 2107', new Date(2108, 0, 1).getTime(), [2107, 12, 31, 23, 59, 58]],
    ['first representable date', new Date(1980, 0, 1).getTime(), [1980, 1, 1, 0, 0, 0]],
    ['leap day with odd seconds', new Date(2024, 1, 29, 12, 34, 57).getTime(), [2024, 2, 29, 12, 34, 56]],
    ['last representable date', new Date(2107, 11, 31, 23, 59, 59).getTime(), [2107, 12, 31, 23, 59, 58]],
  ];
  for (const [name, mtimeMs, expected] of cases) {
    await context.test(name, async () => {
      const entries = [{ name: 'report.txt', bytes: Buffer.from('fixture'), st: { mtimeMs } }];
      assertTimestamps(archive.createEntriesSync(entries), expected);
      assertTimestamps(await archive.createEntries(entries), expected);
    });
  }
});

test('folder ZIPs clamp a real pre-1980 file timestamp in synchronous and worker paths', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-zip-timestamps-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'report.txt');
  fs.writeFileSync(filename, 'fixture');
  const modified = new Date(1979, 0, 2, 3, 4, 6);
  fs.utimesSync(filename, modified, modified);
  assert.ok(fs.statSync(filename).mtimeMs < new Date(1980, 0, 1).getTime());
  assertTimestamps(archive.createZip(root).data, [1980, 1, 1, 0, 0, 0]);
  const result = await archive.createZipAsync(root);
  assertTimestamps(Buffer.from(result.base64, 'base64'), [1980, 1, 1, 0, 0, 0]);
});

test('Windows folder and delivery workers preserve native times across the unsigned seconds wrap',
  { skip: process.platform !== 'win32' }, async t => {
    const { execFileSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-zip-dates-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = path.join(root, 'files');
    fs.mkdirSync(cwd);
    const min = new Date(1980, 0, 1), max = new Date(2107, 11, 31, 23, 59, 58);
    const wrap = 2 ** 32 * 1000;
    const cases = [
      ["before [纪元] ' $.txt", -2000, min], ['epoch.txt', 0, min],
      ['wrap-before.txt', wrap - 2000, new Date(wrap - 2000)],
      ['wrap.txt', wrap, new Date(wrap)], ['wrap-after.txt', wrap + 2000, new Date(wrap + 2000)],
      ['last.txt', max.getTime(), max], ['future.txt', new Date(2108, 0, 1).getTime(), max],
      ['leap.txt', new Date(2024, 1, 29, 12, 34, 57).getTime(), new Date(2024, 1, 29, 12, 34, 56)],
    ].map(([name, ms, want]) => ({
      name, ms, fields: [want.getFullYear(), want.getMonth() + 1, want.getDate(), want.getHours(), want.getMinutes(), want.getSeconds()],
    }));
    for (const { name } of cases) fs.writeFileSync(path.join(cwd, name), name);
    const native = script => execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; " + script], {
        windowsHide: true, cwd: root, env: { ...process.env, ZIP_CASES: JSON.stringify(cases) },
      });
    native(`
      foreach ($c in (ConvertFrom-Json $env:ZIP_CASES)) {
        $p = Join-Path (Resolve-Path files) $c.name
        [IO.File]::SetLastWriteTimeUtc($p, [DateTimeOffset]::FromUnixTimeMilliseconds($c.ms).UtcDateTime)
        if (([DateTimeOffset][IO.File]::GetLastWriteTimeUtc($p)).ToUnixTimeMilliseconds() -ne $c.ms) { throw "Fixture time: $p" }
      }`);
    const outputs = require('../main/pi-session/outputs');
    const session = { cwd, sessionId: 'zip-dates', snapshot: () => ({ status: 'idle' }), outputSnapshot: () => outputs.scan(cwd, 0, 0) };
    const ids = require('../main/conversation/artifact-runtime').snapshot(session).items.map(file => file.artifactId);
    const folder = await archive.createZipAsync(cwd);
    const delivery = await require('../main/conversation/delivery-package-worker').prepare(session, ids);
    for (const [route, bytes] of [['folder', Buffer.from(folder.base64, 'base64')], ['delivery', delivery.bytes]]) {
      const eocd = bytes.length - 22;
      assert.equal(bytes.readUInt16LE(eocd + 10), cases.length);
      let central = bytes.readUInt32LE(eocd + 16);
      for (let i = 0; i < cases.length; i++) {
        const nameLength = bytes.readUInt16LE(central + 28);
        const name = bytes.toString('utf8', central + 46, central + 46 + nameLength);
        const { fields } = cases.find(file => file.name === name);
        assert.deepEqual(timestamp(bytes, bytes.readUInt32LE(central + 42) + 10), fields, route + ' local: ' + name);
        assert.deepEqual(timestamp(bytes, central + 12), fields, route + ' central: ' + name);
        central += 46 + nameLength + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32);
      }
      fs.writeFileSync(path.join(root, route + '.zip'), bytes);
    }
    native(`
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      foreach ($route in 'folder','delivery') {
        $dest = Join-Path $PWD $route
        [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $PWD "$route.zip"), $dest)
        foreach ($c in (ConvertFrom-Json $env:ZIP_CASES)) {
          $p = Join-Path $dest $c.name
          if ([IO.File]::GetLastWriteTime($p).ToString('yyyy-M-d-H-m-s') -ne ($c.fields -join '-') -or
              [IO.File]::ReadAllText($p) -cne $c.name) { throw "Extracted file mismatch: $p" }
        }
      }`);
  });

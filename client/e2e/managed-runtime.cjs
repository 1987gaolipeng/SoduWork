'use strict';
// Runs real portable runtimes with no developer directories on PATH. This is
// component evidence, not a substitute for installation on a clean OS VM.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { environment } = require('../main/managed-runtime.cjs');
function verify(resourcesPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-portable-smoke-'));
  try {
    const env = environment({ SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: tmp, TMP: tmp, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, LOCALAPPDATA: tmp,
      PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin' }, { resourcesPath });
    const node = path.join(resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    const npm = path.join(resourcesPath, 'node', process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
    const python = env.SODUWORK_MANAGED_PYTHON;
    assert.ok(python, 'Portable Python is required');
    const run = (bin, args) => {
      const result = spawnSync(bin, args, { cwd: tmp, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 0, `${path.basename(bin)}: ${result.error || result.stderr}`);
      return result.stdout.trim();
    };
    const nodeVersion = run(node, ['--version']);
    const npmVersion = run(node, [npm, '--version']);
    run(node, ['-e', "require('node:child_process').execFileSync('node',['-e','console.log(42)'],{stdio:'pipe'});"]);
    run(python, ['-I', '-B', '-c', [
      'from docx import Document', 'from openpyxl import Workbook, load_workbook',
      'from pptx import Presentation', 'from pathlib import Path', 'import sys',
      'd=Document(); d.add_paragraph("portable"); d.save("test.docx")',
      'assert Document("test.docx").paragraphs[0].text == "portable"',
      'w=Workbook(); w.active["A1"]="portable"; w.save("test.xlsx")',
      'assert load_workbook("test.xlsx").active["A1"].value == "portable"',
      'p=Presentation(); p.slides.add_slide(p.slide_layouts[0]); p.save("test.pptx")',
      'assert len(Presentation("test.pptx").slides)==1', 'print(sys.version)',
    ].join('\n')]);
    return { ok: true, nodeVersion, npmVersion, python: run(python, ['--version']), officeRoundtrip: true, systemDeveloperTools: false };
  } finally {
    assert.equal(path.dirname(tmp), os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try { console.log(JSON.stringify(verify(path.resolve(process.argv[2] || path.join(__dirname, '../.runtime'))))); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = { verify };

'use strict';

// Preserve npm's locked production layout, including hoisted SDK dependencies.
// Copy only installed production packages; no install hooks or network access.
const fs = require('node:fs');
const path = require('node:path');

function preparePiRuntime(client = path.resolve(__dirname, '..')) {
  client = fs.realpathSync(client);
  const lock = JSON.parse(fs.readFileSync(path.join(client, 'package-lock.json'), 'utf8'));
  const output = path.join(client, '.runtime', 'pi');
  for (const target of [path.dirname(output), output]) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error('Runtime staging must not follow a directory link: ' + target);
    }
  }
  if (!output.startsWith(client + path.sep)) throw new Error('Unsafe runtime staging output');
  const rows = Object.entries(lock.packages).filter(([name, pkg]) => name && !pkg.dev);
  for (const [name, pkg] of rows) {
    if (pkg.link || !name.startsWith('node_modules/') || name.split('/').includes('..')) {
      throw new Error('Unsupported runtime package path: ' + name);
    }
    const source = path.join(client, name, 'package.json');
    if (!fs.existsSync(source)) {
      if (pkg.optional) continue;
      throw new Error('Missing locked runtime package: ' + name + '; run npm ci');
    }
    const installed = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (installed.version !== pkg.version) throw new Error('Installed runtime version differs from lock: ' + name);
  }
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const copied = [];
  for (const [name] of rows) {
    const source = path.join(client, name);
    if (!fs.existsSync(path.join(source, 'package.json'))) continue;
    fs.cpSync(source, path.join(output, name), {
      recursive: true,
      filter: file => file === source || !path.relative(source, file).split(path.sep).includes('node_modules'),
    });
    copied.push(name);
  }
  fs.writeFileSync(path.join(output, 'runtime-packages.json'), JSON.stringify({
    schema: 1, sdk: lock.packages['node_modules/@earendil-works/pi-coding-agent'].version,
    packages: copied,
  }, null, 2) + '\n');
  return { output, packages: copied };
}

module.exports = { preparePiRuntime };
if (require.main === module) console.log(JSON.stringify(preparePiRuntime()));

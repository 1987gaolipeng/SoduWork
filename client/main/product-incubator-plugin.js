'use strict';
const fs = require('node:fs'), path = require('node:path');
const FILES = ['SKILL.md', 'references/delivery-contract.md', 'scripts/release-check.cjs'];
let cached;
function body(app) {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'skills', 'product-incubator')
    : path.resolve(__dirname, '../../skills/product-incubator');
  // One canonical workflow for desktop and enterprise; packaging copies it verbatim.
  const manifestPath = app.isPackaged ? path.join(process.resourcesPath, 'product-incubator-plugin.json')
    : path.resolve(__dirname, '../../hub-backend/plugins/product-incubator.json');
  const stamp = [manifestPath, ...FILES.map(name => path.join(root, name))].map(name => {
    const stat = fs.statSync(name); return name + ':' + stat.mtimeMs + ':' + stat.size;
  }).join('|');
  if (cached?.stamp === stamp) return structuredClone(cached.body);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const value = {
    template: 'workflow', key: manifest.key, name: manifest.name, version: manifest.version,
    description: manifest.description,
    instructions: manifest.instructions + '\n本轮随包指南位于 references/incubator/GUIDE.md，校验脚本位于 references/incubator/scripts/release-check.cjs。',
    entrypoints: manifest.entrypoints, inputs: manifest.inputs, workflow: manifest.workflow,
    skills: manifest.capabilities.skills, mcpServers: manifest.capabilities.mcpServers,
    runtimeCapabilities: manifest.capabilities.runtime,
    resources: FILES.map(name => ({path: 'references/incubator/' + (name === 'SKILL.md' ? 'GUIDE.md' : name),
      kind: name.startsWith('scripts/') ? 'script' : 'reference', encoding: 'base64',
      content: fs.readFileSync(path.join(root, name)).toString('base64')})),
  };
  cached = { stamp, body: value };
  return structuredClone(value);
}
module.exports = { body, FILES };

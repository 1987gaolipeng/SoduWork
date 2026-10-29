'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { safeFile } = require('./personal-plugin-debug-runner');
// Approval refers to these immutable outputs, never just the currently displayed text.
function verify(record, gate, cwd) {
  const ancestors = new Set();
  const visit = key => {
    if (ancestors.has(key)) return;
    ancestors.add(key);
    const node = record.nodes.find(item => item.key === key);
    if (!node || node.status !== 'completed') throw Error('上游步骤尚未完成，不能确认交付');
    for (const parent of node.dependsOn) visit(parent);
  };
  for (const key of gate.dependsOn) visit(key);
  return record.nodes.filter(node => ancestors.has(node.key)).flatMap(node =>
    (node.outputsFound || []).map(output => {
      if (!output.path) return { nodeKey: node.key, key: output.key, text: output.text, url: output.url, commit: output.commit };
      const file = safeFile(cwd, output.path);
      if (fs.statSync(file).size > 24 * 1024 * 1024) throw Error('成果文件已变化，请重新核验后确认');
      const data = fs.readFileSync(file), sha256 = crypto.createHash('sha256').update(data).digest('hex');
      if (sha256 !== output.sha256 || data.length !== output.size) throw Error('成果文件已变化，请重新执行受影响的步骤后确认：' + output.label);
      return { nodeKey: node.key, key: output.key, path: output.path, sha256, size: data.length };
    }));
}
module.exports = { verify };

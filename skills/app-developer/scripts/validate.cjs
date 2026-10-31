'use strict';
// Read-only authoring check. The bundled modules are the installer's exact
// source bytes; no separate permissive resource validator is maintained here.
const fs = require('node:fs'), path = require('node:path');
const { TextDecoder } = require('node:util');
function modules() {
  const bundled = path.resolve(__dirname, '../validation');
  const root = fs.existsSync(path.join(bundled, 'main/plugin-resources.js'))
    ? bundled : path.resolve(__dirname, '../../../client');
  const resources = require(path.join(root, 'main/plugin-resources.js'));
  const schema = require(path.join(root, 'main/personal-plugin-schema.cjs')).create({
    pluginResources: resources,
    pluginWorkflow: require(path.join(root, 'main/personal-plugin-workflow.js')),
    pluginPlatforms: require(path.join(root, 'core/plugin-platforms.js')),
  });
  return { resources, schema };
}
function validate(draft, workRoot = path.dirname(path.resolve(draft))) {
  const file = path.resolve(draft), root = path.resolve(workRoot);
  const { resources, schema } = modules();
  resources.assertNoLinks(root, file);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 24 * 1024 * 1024) {
    throw Error('应用草稿须为不超过 24MB 的 JSON 文件');
  }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
  if (body?.template !== 'app') throw Error('应用草稿必须使用 template: "app"');
  const collected = resources.collect(body, file, root);
  const normalized = schema.normalizeBody(collected);
  if (!normalized.icon) throw Error('应用缺少专属彩色图标：请生成 PNG 并写入草稿顶层 icon 后重新校验');
  return { ok: true, key: normalized.key, version: normalized.version,
    resources: resources.summary(normalized.resources || []),
    installed: false, runtimeTested: false };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--draft', '--work-root'].includes(args[i]) || !args[i + 1]) {
        throw Error('用法：--draft 草稿绝对路径 [--work-root 当前会话目录]');
      }
      options[args[i]] = args[i + 1];
    }
    if (!options['--draft']) throw Error('请通过 --draft 指定实际生成的应用草稿');
    console.log(JSON.stringify(validate(options['--draft'], options['--work-root']), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validate };

'use strict';

// Check versioned source, not a developer's ignored runtime or business files.
const fs = require('node:fs');
const path = require('node:path');
const { sourceFiles } = require('./source-files.cjs');
const root = path.resolve(__dirname, '..');
const SOURCE_ROOTS = new Set(['client', 'hub-backend', 'hub-frontend', 'skills', 'docs', 'ops', 'tools', 'third-party']);
const GITHUB_FILES = new Set([
  '.github/README.md', '.github/dependabot.yml', '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/workflows/ci.yml', '.github/workflows/security.yml',
]);
const RETIRED = new Set([
  'SOURCE-MANIFEST.json', 'PUBLIC-SOURCE.json', 'Dockerfile.server',
  'deploy.py', 'deploy.cmd', 'deploy.sh',
  'client/app-window-corner.html',
  'hub-frontend/public/soduwork.svg', 'hub-frontend/public/favicon.ico',
  'client/pi-chat-preload.js', 'client/e2e/pi-locale.cjs',
  'client/scripts/prepare-opencode-runtime.cjs',
  'client/components/panels/panels-milestone.js',
  'client/components/panels/panels-ms-agent.js',
  'client/components/panels/panels-desk-side.js',
  'client/components/panels/panels-desk-side.css',
  'client/components/panels/panels-work-items.js',
  'client/components/task-area/task-area.js',
  'client/components/task-area/task-area.css',
  'client/components/task-area/layouts/quad.js',
  'client/components/task-area/layouts/kanban.js',
  'client/components/panels/panels-thread.js',
  'client/components/panels/task-detail-support.js',
  'client/components/panels/panels-journey.js',
  'client/components/panels/panels-journey.css',
  'client/components/panels/panels-detail.css',
  'client/components/panels/panels-desk-session.js',
  'client/components/panels/desk-task-view.js',
  'client/components/panels/work-delivery-sheet.js',
  'hub-backend/app/work_item_models.py', 'hub-backend/app/api/work_items.py',
  'hub-backend/app/services/work_items.py',
  'hub-backend/app/services/local_pipe_drain.py',
  'hub-backend/app/services/openai_proxy.py',
]);
const GENERATED = /(?:^|\/)(?:node_modules|\.venv|__pycache__)(?:\/|$)|^(?:outputs|work)\/|^client\/(?:dist[^/]*|\.runtime(?:-cache)?|pi-chat(?:-src)?)\/|^hub-(?:frontend\/dist|backend\/(?:uploads|downloads|releases|workspaces))\/|^skin-server\/data\//;

function auditFiles(files) {
  const errors = [];
  for (const name of files) {
    const first = name.split('/')[0];
    if (name.includes('/') && !SOURCE_ROOTS.has(first) && !GITHUB_FILES.has(name)) errors.push('Undocumented source root: ' + first);
    if (GENERATED.test(name) || (name.startsWith('client/runner/') && name !== 'client/runner/README.md') ||
        (name.startsWith('mobile-web-dist/') && name !== 'mobile-web-dist/.gitkeep')) {
      errors.push('Generated or runtime file tracked as source: ' + name);
    }
    if (RETIRED.has(name)) errors.push('Retired implementation returned: ' + name);
  }
  return [...new Set(errors)];
}

function auditPackaging(pkg) {
  const errors = [];
  for (const hook of ['prebuild', 'prebuild-portable', 'prebuild:linux']) {
    if (!/^npm run prepare:runner(?:\s*&&|$)/.test(pkg.scripts?.[hook] || '')) {
      errors.push(hook + ' must build Runner before packaging');
    }
  }
  if (pkg.scripts?.['build:mac'] !== 'node scripts/build-macos.cjs') {
    errors.push('build:mac must compile and verify a matching Runner for each architecture');
  }
  const files = pkg.build?.files || [];
  if (Object.entries(pkg.scripts || {}).some(([name, value]) =>
    name.includes('build-light') || /prepare.opencode-runtime|SODUWORK_BUNDLE_LIGHT/.test(value))) {
    errors.push('Use one lightweight build; retired OpenCode bundling must not return');
  }
  if ((pkg.build?.extraResources || []).some(row => /opencode/i.test(String(row.from) + '/' + String(row.to)))) {
    errors.push('Optional OpenCode must not be bundled in the application');
  }
  const catalog = (pkg.build?.extraResources || []).find(row => row.to === 'agent_catalog.json');
  if (!catalog || catalog.from !== '../hub-backend/app/agent_catalog.json' || catalog.filter) {
    errors.push('Package the shared Agent catalog from its authoritative source');
  }
  if (files.some(name => /pi-chat|runner\//.test(name))) errors.push('Old chat or generated Runner included in application source');
  for (const rule of ['!**/*.test.js', '!**/*.test.cjs']) {
    if (!files.includes(rule)) errors.push('Exclude test code from the release: ' + rule);
  }
  // Runner copy rules live in the platform sections: every build must select
  // its own single-file executable instead of sharing one root entry.
  if ((pkg.build?.extraResources || []).some(row => row.from === 'runner')) {
    errors.push('Runner resources must stay in platform sections so each build selects its own binary');
  }
  const runnerSections = [
    ['win', ['soduwork-runner.exe', 'soduwork-runner'],
      'Windows Runner resources must explicitly select the single-file executable'],
    ['mac', ['soduwork-runner'],
      'macOS Runner resources must select the macOS single-file executable only'],
    ['linux', ['soduwork-runner'],
      'Linux Runner resources must select the Linux single-file executable only'],
  ];
  for (const [section, allowed, message] of runnerSections) {
    const runner = (pkg.build?.[section]?.extraResources || []).find(row => row.from === 'runner');
    if (!runner || !Array.isArray(runner.filter) ||
        !allowed.every(name => runner.filter.includes(name)) ||
        runner.filter.some(name => !allowed.includes(name))) {
      errors.push(message);
    }
  }
  return errors;
}

function check() {
  const files = sourceFiles(root)
    .filter(name => name && fs.statSync(path.join(root, name), { throwIfNoEntry: false })?.isFile());
  const errors = [...auditFiles(files), ...auditPackaging(JSON.parse(fs.readFileSync(path.join(root, 'client/package.json'), 'utf8')))];
  return { ok: errors.length === 0, sourceFiles: files.length, errors };
}

if (require.main === module) {
  try { const result = check(); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { auditFiles, auditPackaging, check };

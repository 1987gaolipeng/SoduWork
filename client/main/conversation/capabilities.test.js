'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const capabilities = require('./capabilities');
const sessionSpec = require('./session-spec');
const agentContract = require('./agent-contract');
const piSession = require('../pi-session/session');

const skillDirs = [
  'C:/soduwork-skills/browser-use',
  'C:/soduwork-skills/computer-use',
  'C:/soduwork-skills/office',
  'C:/soduwork-skills/delivery-check',
];
const policy = {
  ok: true,
  skills: [
    { name: 'browser-use' }, { name: 'computer-use' },
    { name: 'office' }, { name: 'delivery-check' },
  ],
  enabled: ['delivery-check'],
};

function deps(officeOk = true, skillReadable = true) {
  return {
    platform: 'win32',
    env: { SODUWORK_BROWSER: 'C:/Program Files/Browser/chrome.exe' },
    exists(target) {
      const value = String(target).replace(/\\/g, '/');
      return value.endsWith('/SKILL.md') || value.endsWith('/scripts/screen.ps1') ||
        value.endsWith('/Browser/chrome.exe');
    },
    read() {
      if (!skillReadable) throw new Error('encrypted');
      return '---\nname: smoke\ndescription: smoke capability\n---\n';
    },
    run(command, args) {
      if (command === 'node') return { status: 0, stdout: 'v24.4.0\n', stderr: '' };
      if (/^(?:python|py)(?:\.exe)?$/i.test(command)) {
        assert.equal(args.at(-2), '-c');
        return officeOk
          ? { status: 0, stdout: 'python-docx + openpyxl + python-pptx\n', stderr: '' }
          : { status: 1, stdout: '', stderr: 'not found' };
      }
      return { status: 1, stdout: '', stderr: 'unknown command' };
    },
  };
}

async function main() {
  const view = await capabilities.inspect({ policy, skillDirs, deps: deps() });
  const byId = new Map(view.items.map((item) => [item.id, item]));
  assert.equal(view.policyOk, true);
  assert.equal(byId.get('browser').selectable, true);
  assert.equal(byId.get('browser').selected, true);
  assert.match(byId.get('browser').detail, /Node 24\.4\.0/);
  assert.equal(byId.get('computer').selectable, true);
  assert.equal(byId.get('computer').selected, false, 'desktop control must require explicit consent');
  assert.equal(byId.get('computer').grantRequired, true);
  assert.equal(byId.get('office').selectable, true);
  assert.equal(byId.get('office').selected, true, 'local Office is a standard conversation capability');
  assert.match(byId.get('office').detail, /免费本地引擎/);

  const legacy = await capabilities.inspect({
    policy: { ok: true, skills: [{ name: 'officecli' }], enabled: [] },
    skillDirs: ['C:/soduwork-skills/officecli'], deps: deps(),
  });
  assert.equal(legacy.items.find((item) => item.id === 'office').selectable, true,
    'legacy policy names remain a compatibility alias');

  const normal = await capabilities.resolve({ policy, skillDirs, deps: deps() });
  assert.deepEqual(normal.capabilityIds, ['browser', 'office']);
  assert(normal.skillDirs.some((item) => path.basename(item) === 'delivery-check'));
  assert(!normal.skillDirs.some((item) => path.basename(item) === 'computer-use'));
  assert.deepEqual(normal.optionalSkillDirs, ['C:/soduwork-skills/delivery-check']);
  const explicitSkill = await capabilities.resolve({
    policy, skillDirs, deps: deps(), selectedSkills: ['delivery-check'],
  });
  assert.deepEqual(explicitSkill.optionalSkillDirs, []);
  assert(explicitSkill.skillDirs.includes('C:/soduwork-skills/delivery-check'));
  const untrustedComputer = await capabilities.resolve({
    policy, skillDirs, deps: deps(), requested: ['computer'],
  });
  assert(!untrustedComputer.capabilityIds.includes('computer'));
  assert(untrustedComputer.warnings.some((item) => item.includes('尚未明确授权')),
    'a renderer request cannot bypass the trusted device grant');
  const explicitBrowser = await capabilities.resolve({
    policy, skillDirs, deps: deps(), requested: ['browser'],
  });
  assert.deepEqual(explicitBrowser.capabilityIds, ['browser']);

  const elevated = await capabilities.resolve({
    policy, skillDirs, deps: deps(), requested: ['browser', 'computer', 'office'],
    deviceGrants: ['browser', 'computer'],
  });
  assert(elevated.skillDirs.some((item) => path.basename(item) === 'computer-use'));
  assert(elevated.skillDirs.some((item) => path.basename(item) === 'office'));

  const noOffice = await capabilities.inspect({ policy, skillDirs, deps: deps(false) });
  assert.equal(noOffice.items.find((item) => item.id === 'office').selectable, false);
  assert.match(noOffice.items.find((item) => item.id === 'office').reason, /免费办公文档引擎/);

  const unreadable = await capabilities.inspect({ policy, skillDirs, deps: deps(true, false) });
  assert.equal(unreadable.items.find((item) => item.id === 'browser').selectable, false);
  assert.match(unreadable.items.find((item) => item.id === 'browser').reason, /无法读取/);

  const denied = await capabilities.inspect({
    policy: { ok: true, skills: [{ name: 'browser-use' }], enabled: [] },
    skillDirs, deps: deps(),
  });
  assert.equal(denied.items.find((item) => item.id === 'computer').selectable, true,
    'foundation capabilities are not hidden by the enterprise Skill catalog');
  assert.equal(denied.items.find((item) => item.id === 'computer').grantRequired, true);

  const offlineView = await capabilities.inspect({
    policy: { ok: false, skills: [], enabled: [], reason: 'offline' },
    skillDirs, deps: deps(),
  });
  assert.equal(offlineView.items.find((item) => item.id === 'browser').selectable, true);
  assert.equal(offlineView.items.find((item) => item.id === 'office').selectable, true);

  const offline = await capabilities.resolve({
    policy: { ok: false, skills: [], enabled: [], reason: 'offline' },
    skillDirs, deps: deps(), requested: ['computer'],
  });
  assert.deepEqual(offline.capabilityIds, []);
  assert(!offline.skillDirs.some((item) => path.basename(item) === 'computer-use'));
  assert(offline.warnings.some((item) => item.includes('offline')));
  const offlineBrowser = await capabilities.resolve({
    policy: { ok: false, skills: [], enabled: [], reason: 'offline' },
    skillDirs, deps: deps(), requested: ['browser'],
  });
  assert.deepEqual(offlineBrowser.capabilityIds, ['browser']);
  const offlineBusiness = await capabilities.resolve({
    policy: { ok: false, skills: [], enabled: [], reason: 'offline' },
    skillDirs, deps: deps(), selectedSkills: ['delivery-check'],
  });
  assert.equal(offlineBusiness.skills.length, 0,
    'business Skills must fail closed when enterprise policy is unavailable');
  assert(!offlineBusiness.skillDirs.some((item) => path.basename(item) === 'delivery-check'));
  assert.deepEqual(offlineBusiness.selectedSkills, []);

  const spec = sessionSpec.build({ modelName: 'company-model', capabilities: ['browser'] }, normal, {
    cwd: 'C:/work', readOnly: true,
  });
  assert(Object.isFrozen(spec) && Object.isFrozen(spec.capabilityIds));
  assert.equal(spec.modelName, 'company-model');
  assert.deepEqual([...spec.capabilityIds], ['browser', 'office']);
  assert.throws(() => spec.capabilityIds.push('computer'), TypeError);
  assert.deepEqual(spec.optionalSkillDirs, normal.optionalSkillDirs);
  assert(Object.isFrozen(spec.optionalSkillDirs));
  const untrustedSpec = sessionSpec.build({ optionalSkillDirs: explicitSkill.skillDirs }, explicitSkill, {});
  assert.deepEqual(untrustedSpec.optionalSkillDirs, []);

  let loaderOptions = null;
  const fakeSdk = {
    SettingsManager: { create: (cwd, agentDir) => ({ cwd, agentDir }) },
    DefaultResourceLoader: class {
      constructor(options) { loaderOptions = options; }
      async reload() {}
      getSkills() {
        return { skills: [
          { name: 'browser-use', filePath: 'C:/skills/browser-use/SKILL.md' },
          { name: 'officecli', filePath: 'C:/skills/officecli/SKILL.md' },
        ], diagnostics: [] };
      }
    },
  };
  const resources = await piSession.sessionResources(fakeSdk, 'C:/work', 'C:/agent',
    ['C:/skills/browser-use', 'C:/skills/officecli', 'C:/skills/browser-use'],
    agentContract.prompts({ readOnly: false }));
  assert.equal(loaderOptions.noSkills, true);
  assert.equal(loaderOptions.additionalSkillPaths.length, 2);
  assert.equal(loaderOptions.cwd, 'C:/work');
  assert.match(loaderOptions.appendSystemPrompt[0], /最终答复必须以结果开头/);
  assert.equal(loaderOptions.appendSystemPrompt.at(-1), agentContract.OUTPUT_LANGUAGE);
  assert.match(loaderOptions.appendSystemPrompt.at(-1), /Let me/);
  assert.deepEqual([...resources.skills], ['browser-use', 'officecli']);
  assert(Object.isFrozen(resources.skills));

  const originalFetch = global.fetch;
  const waits = [];
  global.fetch = () => new Promise((resolve) => waits.push(resolve));
  const identity = {
    hub: 'http://policy-cache.test', clientId: 'u-policy-race', session: 'short-session',
  };
  try {
    const staleRequest = capabilities.fetchPolicy(identity);
    await new Promise((resolve) => setImmediate(resolve));
    const freshRequest = capabilities.fetchPolicy(identity, 4500, global.fetch, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(waits.length, 2, 'force refresh must start a new policy request');
    waits[1]({
      ok: true,
      async json() { return { skills: [{ name: 'fresh-skill' }], enabled: ['fresh-skill'] }; },
    });
    const fresh = await freshRequest;
    assert.deepEqual(fresh.enabled, ['fresh-skill']);
    waits[0]({
      ok: true,
      async json() { return { skills: [{ name: 'stale-skill' }], enabled: ['stale-skill'] }; },
    });
    await staleRequest;
    const cached = await capabilities.fetchPolicy(identity);
    assert.deepEqual(cached.enabled, ['fresh-skill'],
      'a late stale request must not overwrite the forced refresh');
    assert.equal(waits.length, 2, 'fresh policy must remain cached after the stale request settles');
  } finally {
    global.fetch = originalFetch;
    capabilities._policyCache.clear();
    capabilities._policyPending.clear();
  }

  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-capability-'));
  const browserDir = path.join(probeRoot, 'browser-use');
  fs.mkdirSync(browserDir, { recursive: true });
  fs.writeFileSync(path.join(browserDir, 'SKILL.md'), '---\nname: browser-use\n---\n');
  const previousBrowser = process.env.SODUWORK_BROWSER;
  process.env.SODUWORK_BROWSER = process.execPath;
  try {
    const definition = capabilities.DEFINITIONS.find((item) => item.id === 'browser');
    const first = capabilities._probeCachedAsync(definition, browserDir);
    const second = capabilities._probeCachedAsync(definition, browserDir);
    assert.strictEqual(first, second, 'concurrent capability probes share one child process');
    const result = await first;
    assert.equal(result.ok, true);
    assert.match(result.detail, /Node \d+/);
  } finally {
    if (previousBrowser == null) delete process.env.SODUWORK_BROWSER;
    else process.env.SODUWORK_BROWSER = previousBrowser;
    capabilities._probePending.clear();
    capabilities._probeCache.clear();
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }

  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-alias-'));
  try {
    const required = path.join(aliasRoot, 'required-skill'), optional = path.join(aliasRoot, 'default-alias');
    fs.mkdirSync(required);
    fs.symlinkSync(required, optional, process.platform === 'win32' ? 'junction' : 'dir');
    const alias = await capabilities.resolve({
      policy: { ok: true, skills: [{ name: 'required-skill' }, { name: 'default-alias' }], enabled: ['default-alias'] },
      skillDirs: [required, optional], selectedSkills: ['required-skill'], requested: [], deps: deps(),
    });
    assert.deepEqual(alias.optionalSkillDirs, [], 'a default junction cannot weaken explicit validation');
  } finally { fs.rmSync(aliasRoot, { recursive: true, force: true }); }
  console.log('conversation capabilities: passed');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});

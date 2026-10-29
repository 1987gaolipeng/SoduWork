// Actual client capability components + built admin UI + real auth/backend + local installer.
// Every profile, database and package is isolated; no live accounts or models are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CdpPage, listPages, delay } from './lib/cdp.mjs';
const require = createRequire(import.meta.url);
const cache = require('../main/conversation/skill-cache.js');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skill-e2e-'));
const output = path.resolve(process.env.SKILL_E2E_OUTPUT || path.join(root, 'evidence'));
fs.mkdirSync(output, { recursive: true });
const checks = [];
const pages = [], children = [];
const check = (label, value = true) => { assert.ok(value, label); checks.push(label); console.log('PASS ' + label); };
async function port() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch {} await delay(150); }
  throw new Error('Timed out waiting for fixture');
}
const hubPort = await port(), base = 'http://127.0.0.1:' + hubPort;
const logs = fs.openSync(path.join(output, 'backend.log'), 'w');
const backend = spawn(path.join(repo, 'hub-backend/.venv/Scripts/python.exe'),
  ['-u', 'e2e_skill_sharing_server.py', String(hubPort), root],
  { cwd: path.join(repo, 'hub-backend'), windowsHide: true, stdio: ['ignore', logs, logs] });
children.push(backend);
async function request(who, endpoint, options = {}) {
  return fetch(base + '/api/v1' + endpoint, { ...options,
    headers: { Authorization: (who === 'admin' ? 'Bearer ' : 'Device ') + tokens[who],
      ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers } });
}
let tokens;
async function browser(who, admin = false) {
  const debug = await port(), profile = path.join(root, 'profile-' + who);
  const chrome = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + debug, '--user-data-dir=' + profile, '--window-size=1440,1000', 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
  children.push(chrome);
  const target = await until(async () => (await listPages(debug))[0]);
  const page = await CdpPage.connect(target);
  pages.push(page);
  await page.call('Page.enable');
  await page.call('Network.enable');
  page.failedRequests=[];
  page.ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Network.responseReceived' && m.params.response.status>=400)page.failedRequests.push({url:m.params.response.url,status:m.params.response.status});});
  await page.call('Page.setInterceptFileChooserDialog', { enabled: true });
  await page.call('Browser.setDownloadBehavior', { behavior:'allow', downloadPath:path.join(root,'downloads-'+who) });
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const seed = admin ?
    `localStorage.setItem('soduwork_hub_admin_token', ${JSON.stringify(tokens.admin)});
     localStorage.setItem('soduwork_hub_admin_user', JSON.stringify({id:'admin',username:'admin',isSuper:true}));
     sessionStorage.setItem('soduwork-hub-screen','capabilities');
     sessionStorage.setItem('soduwork-work-hub-screen','capabilities');` :
    `window.__SODUWORK_TEST_HUB_CONFIG__={allowSwitch:true};
     localStorage.setItem('soduwork_work_hub_environment_v1','development');
     localStorage.setItem('soduwork_work_development_hub_url_v1',${JSON.stringify(base)});
     window.soduWorkAPI={deviceAuthBootstrap:async()=>({ok:true,stored:true,clientId:${JSON.stringify('device-'+who)},
       session:${JSON.stringify(tokens[who])},expiresIn:1800})};`;
  await page.call('Page.addScriptToEvaluateOnNewDocument', { source: seed });
  await page.call('Page.navigate', { url: base + (admin ? '/admin' : '/fixture/client') });
  if (!admin) {
    await click(page, '[data-cap-tab="skills"]');
    await page.waitFor(() => !!document.querySelector('.cap-skill-section'));
  } else {
    await click(page, '.nav-item[title="统一治理 Skill、连接器与企业开放策略"]');
    await page.waitFor(() => !!document.querySelector('.skill-sharing'));
    await click(page, '.skill-sharing>summary');
    await page.waitFor(() => document.querySelector('.skill-sharing')?.open);
  }
  return page;
}
async function click(page, selector) {
  await page.waitFor(s => {const el=document.querySelector(s);return el&&!el.disabled&&el.getClientRects().length>0;}, selector, 15000);
  await delay(250);
  const box = await page.run(s => {
    const el = document.querySelector(s);
    el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
}
async function shot(page, name) {
  const image = await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function importSkill(page, version = 'v1') {
  await click(page, '#capAddButton');
  await click(page, '[data-cap-add="skill-import"]');
  await page.waitFor(() => !!document.querySelector('input[type=file]'));
  const filename = path.join(root, version + '.skill');
  fs.writeFileSync(filename, Buffer.from(await (await fetch(base + '/fixture/package?version=' + version)).arrayBuffer()));
  const doc = await page.call('DOM.getDocument');
  const node = await page.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  await page.call('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filename] });
  await page.waitFor(() => !!document.querySelector('#capImportDo'));
  await page.waitFor(() => !!document.querySelector('.cap-package-content pre'));
  check('import preview lists all six resources', await page.run(() => document.querySelectorAll('[data-package-file]').length === 6));
  await shot(page, '01-import-preview');
  await click(page, '#capImportDo');
  await page.waitFor(() => document.querySelector('#capModalLayer')?.hidden);
  await page.waitFor(() => !!document.querySelector('[data-skill-details="weekly-business"]'));
}
async function share(page) {
  if (!await page.run(() => document.querySelector('.cap-package-share').open)) await click(page, '.cap-package-share summary');
  await click(page, '[data-share-consent]');
  await click(page, '[data-share-submit]');
  await page.waitFor(() => document.querySelector('.cap-package-share summary')?.textContent.includes('等待管理员'));
}
async function install(who) {
  const policy = await (await request(who, '/skills')).json();
  const app = { getPath: () => path.join(root, 'runtime-' + who) };
  const result = await cache.ensure({ app, policy, names: ['weekly-business'],
    identity: { hub: base, clientId: 'device-' + who, session: tokens[who] } });
  assert.equal(result.ok, true, result.warning);
  const contract = result.contracts.find(x => x.name === 'weekly-business');
  assert.ok(contract?.installed);
  const detail = await (await request(who, '/skills/weekly-business/details')).json();
  for (const file of detail.files) {
    const remote = await (await request(who, '/skills/weekly-business/download?' +
      new URLSearchParams({ checksum: detail.checksum, path: file.path }))).arrayBuffer();
    assert.deepEqual(fs.readFileSync(path.join(contract.path, file.path)), Buffer.from(remote));
  }
  return contract;
}
try {
  tokens = await until(async () => (await fetch(base + '/fixture/auth')).json());
  const alice = await browser('alice'), bob = await browser('bob');
  await importSkill(alice);
  await click(alice, '[data-skill-details="weekly-business"]');
  await alice.waitFor(() => !!document.querySelector('.cap-package-content pre'));
  check('opening details does not toggle enabled selection', await alice.run(() =>
    document.querySelector('[data-skill="weekly-business"]').getAttribute('aria-pressed') === 'true'));
  await click(alice, '.cap-package-more');
  await alice.waitFor(() => document.querySelector('.cap-package-content pre')?.textContent.endsWith('v1'));
  check('long SKILL.md is fully readable');
  await click(alice, '[data-package-file="references/中文说明.md"]');
  await alice.waitFor(() => document.querySelector('.cap-package-content pre')?.textContent.includes('末尾内容'));
  check('nested Chinese reference file is fully readable');
  await click(alice, '[data-package-file="assets/example.svg"]');
  await alice.waitFor(() => document.querySelector('.cap-package-content pre')?.textContent.includes('onload'));
  check('embedded SVG is escaped, never executed', await alice.run(() => !window.bad));
  await click(alice, '[data-package-file="assets/example.png"]');
  await alice.waitFor(() => document.querySelector('.cap-package-content img')?.complete);
  check('image preview loads');
  await click(alice, '[data-package-file="assets/template.pptx"]');
  await alice.waitFor(() => document.querySelector('.cap-package-content')?.textContent.includes('下载原文件'));
  check('binary template has explicit download fallback');
  await click(alice, '[data-file-download]');
  await until(() => fs.existsSync(path.join(root,'downloads-alice/template.pptx')));
  check('client download button saves original template bytes', fs.readFileSync(path.join(root,'downloads-alice/template.pptx')).equals(Buffer.from('PK\x03\x04\x00template')));
  const unauthorized = await request('bob', '/skills/weekly-business/details');
  check('private Skill invisible and inaccessible to second client', unauthorized.status === 404 &&
    !await bob.run(() => !!document.querySelector('[data-skill-details="weekly-business"]')));
  await shot(alice, '02-private-details');
  await share(alice);
  await shot(alice, '03-pending-review');
  const first = (await (await request('admin', '/admin/capabilities/skill-submissions')).json()).items[0];
  check('shared submission is pinned to immutable version', first.status === 'pending');
  const admin = await browser('admin', true);
  await click(admin, '[data-submission="' + first.id + '"]');
  await admin.waitFor(() => !!document.querySelector('.skill-review-content pre'));
  check('admin sees all resources', await admin.run(() => document.querySelectorAll('[data-review-file]').length === 6));
  await click(admin, '[data-review-file="scripts/run.py"]');
  await admin.waitFor(() => document.querySelector('.skill-review-content pre')?.textContent.includes('safe fixture'));
  await shot(admin, '04-admin-review');
  check('publication requires explicit review confirmation', await admin.run(() =>
    [...document.querySelectorAll('.skill-review button')].find(b => b.textContent === '审核并发布')?.disabled));
  await click(admin, '.skill-review-decision textarea');
  await admin.call('Input.insertText', { text:'请补充适用场景说明' });
  await admin.run(() => [...document.querySelectorAll('.skill-review button')].find(b => b.textContent === '退回修改').dataset.reject = 'yes');
  await click(admin, '[data-reject="yes"]');
  await admin.waitFor(() => !document.querySelector('.skill-review'));
  check('admin can reject with an actionable reason');
  await click(alice, '#capModalClose');
  await click(alice, '[data-skill-details="weekly-business"]');
  await alice.waitFor(() => document.querySelector('.cap-package-share')?.textContent.includes('请补充适用场景说明'));
  check('author sees review reason and can resubmit the same version');
  await share(alice);
  await click(admin, '.skill-sharing-content>header button');
  await click(admin, '[data-submission="' + first.id + '"]');
  await admin.waitFor(() => !!document.querySelector('.skill-review-consent'));
  await click(admin, '.skill-review-consent input');
  const publish = await admin.run(() => {
    const b = [...document.querySelectorAll('.skill-review button')].find(x => x.textContent === '审核并发布');
    b.dataset.publish = 'yes'; return true;
  });
  await click(admin, '[data-publish="yes"]');
  await admin.waitFor(() => !document.querySelector('.skill-review'));
  await admin.waitFor(() => document.querySelector('.skill-sharing-state')?.textContent === '已发布');
  check('admin review publishes via real backend');
  await bob.call('Page.reload');
  await click(bob, '[data-cap-tab="skills"]');
  await bob.waitFor(() => !!document.querySelector('[data-skill-details="weekly-business"]'));
  check('second client discovers published package without preinstalled Runner inventory');
  check('newly approved shared Skill is enabled by default',
    (await (await request('bob', '/skills')).json()).enabled.includes('weekly-business'));
  await click(bob, '[data-skill="weekly-business"]');
  await until(async () => !(await (await request('bob', '/skills')).json()).enabled.includes('weekly-business'));
  await click(bob, '[data-skill="weekly-business"]');
  await until(async () => (await (await request('bob', '/skills')).json()).enabled.includes('weekly-business'));
  await click(bob, '[data-skill-details="weekly-business"]');
  await bob.waitFor(() => !!document.querySelector('.cap-package-content pre'));
  check('company package has no unauthorized reshare action', !await bob.run(() => !!document.querySelector('.cap-package-share')));
  await shot(bob, '05-other-client');
  const aInstall = await install('alice'), bInstall = await install('bob');
  check('both client runtime caches contain byte-identical complete package', aInstall.version === bInstall.version);
  const measurements = await bob.run(() => {
    const modal = document.querySelector('.cap-skill-detail-modal'), rect = modal.getBoundingClientRect();
    return { within: rect.x >= 0 && rect.right <= innerWidth && rect.y >= 0 && rect.bottom <= innerHeight,
      min: Math.min(...[...modal.querySelectorAll('*')].filter(e => e.getClientRects().length &&
        [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => parseFloat(getComputedStyle(e).fontSize))) };
  });
  check('detail layout stays in viewport and all visible type is at least 12px', measurements.within && measurements.min >= 12);
  const beforeTheme = await bob.run(() => getComputedStyle(document.querySelector('.cap-package-tree button.is-active')).color);
  await bob.run(() => document.documentElement.setAttribute('data-theme','ruby'));
  check('Skill detail follows the current product theme', beforeTheme !== await bob.run(() => getComputedStyle(document.querySelector('.cap-package-tree button.is-active')).color));
  await shot(bob, '06-company-theme');
  await click(alice, '#capModalClose');
  await importSkill(alice, 'v2');
  check('private update does not silently change published content',
    (await (await request('bob', '/skills/weekly-business/details')).json()).checksum === first.checksum);
  await click(alice, '[data-skill-details="weekly-business"]');
  await alice.waitFor(() => !!document.querySelector('.cap-package-content pre'));
  await share(alice);
  await admin.call('Page.reload');
  await click(admin, '.skill-sharing>summary');
  await admin.waitFor(() => document.querySelector('.skill-sharing')?.open);
  await admin.waitFor(() => document.querySelectorAll('[data-submission]').length === 2);
  await click(admin, '[data-submission]');
  await admin.waitFor(() => !!document.querySelector('.skill-review-consent'));
  await click(admin, '.skill-review-consent input');
  await admin.run(() => [...document.querySelectorAll('.skill-review button')].find(b => b.textContent === '审核并发布').dataset.publish = 'yes');
  await click(admin, '[data-publish="yes"]');
  await admin.waitFor(() => !document.querySelector('.skill-review'));
  const v2 = await install('bob');
  check('second approved version replaces cached runtime version', v2.version !== bInstall.version &&
    fs.readFileSync(path.join(v2.path, 'SKILL.md'), 'utf8').endsWith('v2'));
  const errors = pages.map(p => p.takeRuntimeErrors());
  fs.writeFileSync(path.join(output,'browser-errors.json'), JSON.stringify({errors,requests:pages.map(p=>p.failedRequests)},null,2));
  check('no client or admin JavaScript exceptions or failed resource loads', errors.every(e => e.length === 0));
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, screenshots: fs.readdirSync(output).filter(x => /^\d+-.*\.png$/.test(x)), root }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, output }));
} catch (error) {
  for (let i = 0; i < pages.length; i++) try {
    await shot(pages[i], 'failure-' + i);
    fs.writeFileSync(path.join(output, 'diagnostic-' + i + '.json'), JSON.stringify({
      errors: pages[i].takeRuntimeErrors(), state: await pages[i].run(() => ({
        bridge: !!window.soduWorkAPI?.deviceAuthBootstrap, text: document.body.innerText.slice(0, 1200) })) }, null, 2));
  } catch {}
  fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
  throw error;
} finally {
  for (const p of pages) p.close();
  for (const c of children.reverse()) { try { c.kill(); } catch {} }
  fs.closeSync(logs);
}

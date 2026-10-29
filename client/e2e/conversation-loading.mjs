import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CdpPage, listPages, delay } from './lib/cdp.mjs';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-history-page-'));
const browser = process.env.SODUWORK_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  '--user-data-dir=' + profile, '--window-size=1360,950', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let page;
let launchError;
child.on('error', error => { launchError = error; });
try {
  let port;
  for (let i = 0; i < 80; i++) {
    if (launchError) throw launchError;
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (port) break;
    await delay(100);
  }
  if (!port) throw Error('Isolated browser did not start');
  page = await CdpPage.connect((await listPages(port))[0]);
  await page.call('Page.navigate', { url: new URL('../tests/conversation-loading.html', import.meta.url).href });
  await page.waitFor(() => window.testComplete, null, 15000);
  const result = await page.run(() => JSON.parse(document.querySelector('#out').textContent));
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length || result.results.some(row => !row.ok)) throw Error('History loading regression failed');
  for (const fixture of ['new-conversation', 'chat-task-suggestion']) {
    await page.call('Page.navigate', { url: new URL('../tests/' + fixture + '.html', import.meta.url).href });
    await page.waitFor(() => document.querySelector('#out')?.textContent.includes('failed'), null, 15000);
    const text = await page.run(() => document.querySelector('#out').textContent);
    console.log(text);
    if (text.includes('FAIL') || !text.includes('0 failed')) throw Error(fixture + ' regression failed');
  }
  const errors = page.takeRuntimeErrors();
  if (errors.length) throw Error(errors.join('\n'));
} finally {
  if (page) { await page.call('Browser.close').catch(() => {}); page.close(); }
  else child.kill();
}

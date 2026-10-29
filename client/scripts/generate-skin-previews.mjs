#!/usr/bin/env node
/*
 * Generate localized skin screenshots with the isolated headless preview harness. Write
 * locale-specific images while preserving Chinese fallback originals; skip text-free
 * previews.
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {CdpPage, listPages, delay} from '../e2e/lib/cdp.mjs';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewsDir = path.join(client, 'components/skin-manager/previews');
const locales = (process.argv.includes('--locales')
  ? process.argv[process.argv.indexOf('--locales') + 1] : 'en-US,ja-JP,ko-KR').split(',');
/* Match registry shotFile identifiers and original preview dimensions. */
const SHOTS = [
  { skin: 'bear-vivid', shotFile: 'bear', w: 882, h: 1401 },
  { skin: 'box-biz', shotFile: 'box', w: 882, h: 1401 },
  { skin: 'diamond-ice', shotFile: 'diamond', w: 882, h: 1401 },
  { skin: 'bear-ruby', shotFile: 'ruby-ball', w: 732, h: 843 },
  { skin: 'box-ruby', shotFile: 'ruby-box', w: 732, h: 843 },
  { skin: 'flat-azure', shotFile: 'flat-azure', w: 732, h: 860 }
];
const han = /[\u3400-\u9fff]/;   /* Detect Han characters in English and Korean previews; Japanese legitimately uses them. */

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-skin-previews-browser-'));
const browser = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile,
  '--window-size=940,1440', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
/* Serve source through Node HTTP so managed Windows files are read through the authorized process. */
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(client, '.' + requested);
  if (!file.startsWith(client + path.sep) || !(/\.(html|js|css|woff2?|ttf|png|svg)$/.test(file))) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html;charset=utf-8' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

let page;
const written = [];
try {
  let port;
  for (let i = 0; i < 80; i++) {
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); if (port) break; } catch {}
    await delay(100);
  }
  assert.ok(port, 'isolated browser starts');
  page = await CdpPage.connect((await listPages(port))[0]);
  await page.call('Page.bringToFront');

  for (const locale of locales) {
    for (const shot of SHOTS) {
      await page.call('Emulation.setDeviceMetricsOverride', { width: shot.w, height: shot.h, deviceScaleFactor: 1, mobile: false });
      await page.call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/tests/skin-preview-harness.html?skin=' + shot.skin + '&locale=' + locale });
      await page.waitFor(() => window.__READY__ === true, null, 10000);
      await delay(160);   /* Wait for SVG gradients and fonts to settle. */
      /* Reject unexpected Han text in English and Korean layouts and kana in Korean layouts. */
      const text = await page.run(() => document.getElementById('board').innerText + '|' + document.querySelector('.khead .lb, .qhead .lb').textContent);
      if (locale !== 'ja-JP') assert.ok(!han.test(text), locale + ' preview of ' + shot.shotFile + ' still contains Han characters: ' + text);
      const out = path.join(previewsDir, locale, shot.shotFile + '.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const s = await page.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(out, Buffer.from(s.data, 'base64'));
      written.push(path.relative(client, out));
      console.log('✓', path.relative(client, out), shot.w + 'x' + shot.h);
    }
  }
  console.log('\nDone:', written.length, 'files under', path.relative(client, path.join(previewsDir, locales[0])));
} finally {
  try { if (page) await page.call('Browser.close'); } catch {}
  child.kill();
  server.close();
}

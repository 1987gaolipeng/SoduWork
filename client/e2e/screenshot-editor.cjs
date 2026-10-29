'use strict';

// Real Chromium DOM, keyboard, pointer and Canvas verification of production
// editor assets. The desktop pixels and isolated screenshot API are FIXTURES;
// this does not certify native screen capture, system clipboard or save dialogs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

function playwright() {
  const bundledRoot = path.join(os.homedir(), 'AppData/Local/OpenAI/Codex/runtimes/cua_node');
  const bundled = fs.existsSync(bundledRoot) ? fs.readdirSync(bundledRoot).map(name => path.join(bundledRoot, name, 'bin/node_modules/playwright')) : [];
  for (const candidate of [process.env.SODUWORK_PLAYWRIGHT, 'playwright', ...bundled].filter(Boolean)) {
    try { return require(candidate); } catch (_) {}
  }
  throw new Error('Install Playwright or set SODUWORK_PLAYWRIGHT to its local package directory.');
}
const browserPath = [process.env.SODUWORK_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && fs.existsSync(value));
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'soduwork-screenshot-editor-e2e'));
const editorUrl = pathToFileURL(path.resolve(__dirname, '../components/screenshot/screenshot.html')).href;
const report = { fixture: 'Synthetic desktop PNG and screenshot IPC API; real production renderer in headless Chromium', checks: [], errors: [], screenshots: [] };
const digest = value => createHash('sha256').update(value).digest('hex');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await playwright().chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await context.addInitScript(() => {
    // Fixture image deliberately has high-frequency content so a mosaic which
    // only draws a frame, or exports the original image, cannot pass pixel tests.
    const width = innerWidth * 2, height = innerHeight * 2;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4, value = (x * 13 + y * 7) % 256;
      pixels.data[offset] = value; pixels.data[offset + 1] = 255 - value;
      pixels.data[offset + 2] = x * 5 % 256; pixels.data[offset + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    window.fixtureCapture = { width, height, dataUrl: canvas.toDataURL('image/png'), theme: { accent: '#7955b9' } };
    window.fixtureCalls = { claims: 0, finishes: [], cancellations: 0 };
    window.screenshotAPI = {
      getCapture: async () => window.fixtureCapture,
      claim: async () => { window.fixtureCalls.claims++;
        return window.fixtureClaimRejected ? { ok: false, error: '测试夹具：请在已选择的显示器中完成截图' } : { ok: true }; },
      finish: async value => {
        window.fixtureCalls.finishes.push(value);
        if (window.fixtureFinishMode === 'cancel-save') return { ok: false, cancelled: true };
        if (window.fixtureFinishMode === 'fail') return { ok: false, error: '测试夹具：剪贴板暂不可用' };
        return { ok: true };
      },
      cancel: async () => { window.fixtureCalls.cancellations++; return { ok: true }; },
    };
  });
  async function open(width = 800, height = 600) {
    await page.setViewportSize({ width, height }); await page.goto(editorUrl);
    await page.waitForFunction(() => window.ScreenshotEditor?.getState().ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function drag(a, b) {
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  }
  async function select(a = { x: 80, y: 60 }, b = { x: 360, y: 240 }) {
    await drag(a, b); await page.locator('#toolbar').waitFor({ state: 'visible' });
  }
  const state = () => page.evaluate(() => window.ScreenshotEditor.getState());
  const exported = () => page.evaluate(() => window.ScreenshotEditor.exportPng());
  async function pixels(rect) {
    return page.evaluate(async area => {
      const dataUrl = ScreenshotEditor.exportPng();
      const img = new Image(); await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const selection = ScreenshotEditor.getState().selection;
      const r = area || { x: 0, y: 0, width: canvas.width, height: canvas.height };
      const actual = ctx.getImageData(r.x, r.y, r.width, r.height).data;
      const original = document.createElement('canvas'); original.width = r.width; original.height = r.height;
      const baseline = original.getContext('2d');
      baseline.drawImage(document.getElementById('desktopImage'), Math.floor(selection.x) + r.x, Math.floor(selection.y) + r.y,
        r.width, r.height, 0, 0, r.width, r.height);
      const expected = baseline.getImageData(0, 0, r.width, r.height).data;
      let changed = 0, red = 0, transparent = 0; const colors = new Set(), originalColors = new Set();
      for (let i = 0; i < actual.length; i += 4) {
        if (actual[i] !== expected[i] || actual[i + 1] !== expected[i + 1] || actual[i + 2] !== expected[i + 2] || actual[i + 3] !== expected[i + 3]) changed++;
        if (actual[i] === 237 && actual[i + 1] === 71 && actual[i + 2] === 71) red++;
        if (actual[i + 3] !== 255) transparent++;
        colors.add(actual[i] + ',' + actual[i + 1] + ',' + actual[i + 2]);
        originalColors.add(expected[i] + ',' + expected[i + 1] + ',' + expected[i + 2]);
      }
      return { width: img.naturalWidth, height: img.naturalHeight, changed, red, transparent, colors: colors.size, originalColors: originalColors.size, total: actual.length / 4 };
    }, rect);
  }
  async function screenshot(name) {
    const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file);
  }
  async function check(name, run) {
    const evidence = await run(); report.checks.push({ name, ...evidence }); console.log('PASS ' + name);
  }
  try {
    await open();
    await check('2× pixel mapping, reverse drag and pristine export exclude shade/toolbar', async () => {
      await select({ x: 360, y: 240 }, { x: 80, y: 60 });
      const current = await state(); assert.deepEqual(current.selection, { x: 160, y: 120, width: 560, height: 360 });
      const result = await pixels(); assert.equal(result.width, 560); assert.equal(result.height, 360);
      assert.equal(result.changed, 0); assert.equal(result.transparent, 0);
      return result;
    });
    await check('rectangle, ellipse, arrow and pen export actual annotation pixels', async () => {
      for (const [tool, start, end] of [
        ['rect', { x: 100, y: 80 }, { x: 170, y: 140 }],
        ['ellipse', { x: 190, y: 80 }, { x: 270, y: 140 }],
        ['arrow', { x: 110, y: 180 }, { x: 200, y: 160 }],
        ['pen', { x: 240, y: 180 }, { x: 310, y: 210 }],
      ]) {
        await page.locator(`[data-tool="${tool}"]`).click(); await drag(start, end);
      }
      const current = await state(); assert.deepEqual(current.marks.map(mark => mark.type), ['rect', 'ellipse', 'arrow', 'pen']);
      const result = await pixels(); assert.ok(result.changed > 4000); assert.ok(result.red > 1500); assert.equal(result.transparent, 0);
      fs.writeFileSync(path.join(output, 'annotated-export.png'), Buffer.from((await exported()).split(',')[1], 'base64'));
      await screenshot('annotations'); return result;
    });
    await check('undo and redo restore exact PNG bytes', async () => {
      const before = digest(await exported());
      await page.keyboard.press('Control+z'); assert.equal((await state()).marks.length, 3);
      const undone = digest(await exported()); assert.notEqual(undone, before);
      await page.keyboard.press('Control+Shift+z'); assert.equal((await state()).marks.length, 4);
      assert.equal(digest(await exported()), before);
      await page.locator('[data-action="undo"]').click(); assert.equal((await state()).marks.length, 3);
      await page.locator('[data-action="redo"]').click(); assert.equal(digest(await exported()), before);
      return { annotatedSha256: before, undoneSha256: undone };
    });
    await check('mosaic replaces image pixels with blocks and undo restores original', async () => {
      await open(); await select(); const before = digest(await exported());
      await page.locator('[data-tool="mosaic"]').click(); await drag({ x: 140, y: 100 }, { x: 260, y: 180 });
      const result = await pixels({ x: 130, y: 90, width: 20, height: 20 });
      assert.ok(result.changed > result.total * .9); assert.ok(result.colors < 10, JSON.stringify(result));
      assert.ok(result.originalColors > 100, JSON.stringify(result));
      await screenshot('mosaic'); await page.keyboard.press('Control+z'); assert.equal(digest(await exported()), before);
      return result;
    });
    await check('text accepts ordinary letters, newline and IME without accidental finish', async () => {
      await open(); await select({ x: 50, y: 60 }, { x: 480, y: 330 });
      await page.locator('[data-tool="text"]').click(); await page.mouse.click(85, 95);
      const text = page.locator('#textEditor'); await text.waitFor({ state: 'visible' });
      await page.keyboard.insertText('第一行 bmt123'); await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('第二行 中文输入');
      assert.match(await text.inputValue(), /bmt123\n第二行/);
      await text.evaluate(node => { node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true })); });
      assert.equal((await state()).editingText, true); assert.equal((await state()).marks.length, 0);
      assert.equal(await page.evaluate(() => fixtureCalls.finishes.length), 0);
      await text.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true })));
      await page.keyboard.press('Enter'); const current = await state();
      assert.equal(current.editingText, false); assert.equal(current.marks.length, 1);
      assert.equal(current.marks[0].type, 'text'); assert.match(current.marks[0].text, /bmt123\n第二行 中文输入/);
      assert.equal(await page.evaluate(() => fixtureCalls.finishes.length), 0);
      const result = await pixels(); assert.ok(result.changed > 1500); await screenshot('multiline-text');
      return { ...result, text: current.marks[0].text, ime: 'DOM composition events; OS IME not certified' };
    });
    await check('Enter finishes exactly once after text commit; Save and Escape call only isolated fixture API', async () => {
      await page.locator('body').evaluate(node => { document.activeElement?.blur(); node.tabIndex = -1; node.focus(); });
      await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => fixtureCalls.finishes.length), 1);
      const copy = await page.evaluate(() => fixtureCalls.finishes[0]); assert.equal(copy.action, 'copy'); assert.equal(copy.dataUrl, await exported());
      await page.keyboard.press('Control+s'); assert.equal(await page.evaluate(() => fixtureCalls.finishes[1].action), 'save');
      await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => fixtureCalls.cancellations), 1);
      return { copy: 1, save: 1, cancel: 1, nativeSideEffects: false };
    });
    await check('toolbar stays visible and every control reachable at four corners and narrow sizes', async () => {
      const evidence = [];
      for (const [width, height] of [[800, 600], [420, 640], [360, 480]]) {
        for (const corner of ['nw', 'ne', 'sw', 'se']) {
          await open(width, height);
          const left = corner.endsWith('w') ? 2 : width - 162, top = corner.startsWith('n') ? 2 : height - 102;
          await select({ x: left, y: top }, { x: left + 160, y: top + 100 });
          await page.locator('[data-tool="rect"]').click();
          const result = await page.evaluate(() => {
            const toolbar = document.getElementById('toolbar'), bounds = toolbar.getBoundingClientRect();
            const controls = [...toolbar.querySelectorAll('button,select')].filter(node => node.getClientRects().length && !node.disabled)
              .map(node => { const rect = node.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
                return { name: node.getAttribute('aria-label'), accessible: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && node.contains(document.elementFromPoint(x, y)) }; });
            return { bounds: { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom }, controls, overflow: toolbar.scrollWidth > toolbar.clientWidth + 1 };
          });
          assert.ok(result.bounds.x >= 0 && result.bounds.y >= 0 && result.bounds.right <= width && result.bounds.bottom <= height, JSON.stringify(result));
          assert.equal(result.overflow, false, width + ' ' + corner + ' horizontal overflow');
          assert.deepEqual(result.controls.filter(control => !control.accessible), [], width + ' ' + corner);
          evidence.push({ width, height, corner, bounds: result.bounds, controls: result.controls.length });
        }
        await screenshot('toolbar-' + width);
      }
      return { viewports: evidence };
    });
    await check('cancelled save and failed finish retain editing and permit retry', async () => {
      await open(); await select(); await page.locator('[data-tool="rect"]').click();
      await drag({ x: 110, y: 90 }, { x: 210, y: 150 }); const before = digest(await exported());
      await page.evaluate(() => { window.fixtureFinishMode = 'cancel-save'; });
      await page.locator('[data-action="save"]').click();
      await page.waitForFunction(() => !ScreenshotEditor.getState().busy);
      assert.equal(digest(await exported()), before);
      assert.match(await page.locator('#editorStatus').textContent(), /已取消保存/);
      await page.evaluate(() => { window.fixtureFinishMode = 'fail'; });
      await page.locator('[data-action="copy"]').click();
      await page.waitForFunction(() => !ScreenshotEditor.getState().busy);
      assert.equal(digest(await exported()), before);
      assert.match(await page.locator('#editorStatus').textContent(), /剪贴板暂不可用/);
      await page.evaluate(() => { window.fixtureFinishMode = ''; });
      await page.locator('[data-action="copy"]').click();
      const calls = await page.evaluate(() => fixtureCalls);
      assert.deepEqual(calls.finishes.map(value => value.action), ['save', 'copy', 'copy']);
      assert.equal(digest(calls.finishes[2].dataUrl), before); assert.equal(calls.cancellations, 0);
      return { retainedPngSha256: before, retries: calls.finishes.length - 1 };
    });
    await check('a rejected display claim restores selection and allows a fresh attempt', async () => {
      await open(); await page.evaluate(() => { window.fixtureClaimRejected = true; });
      await drag({ x: 80, y: 60 }, { x: 360, y: 240 });
      await page.waitForFunction(() => ScreenshotEditor.getState().selection === null);
      assert.match(await page.locator('#editorStatus').textContent(), /已选择的显示器/);
      assert.equal(await page.locator('#toolbar').isVisible(), false);
      await page.evaluate(() => { window.fixtureClaimRejected = false; });
      await select(); assert.equal(await page.evaluate(() => fixtureCalls.claims), 2);
      return { rejected: true, reselected: true };
    });
    await check('toolbar can move away from artwork without modifying the crop', async () => {
      await open(); await select(); const before = digest(await exported());
      const grip = await page.locator('#toolbarGrip').boundingBox();
      await drag({ x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, { x: 30, y: 20 });
      const bounds = await page.locator('#toolbar').boundingBox();
      assert.ok(bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= 792 && bounds.y + bounds.height <= 592);
      assert.equal(digest(await exported()), before); return { toolbar: bounds, retainedCrop: true };
    });
    await check('reselection confirms destructive clearing and supports retaining work', async () => {
      await open(); await select(); await page.locator('[data-tool="rect"]').click();
      await drag({ x: 110, y: 90 }, { x: 210, y: 150 }); const before = digest(await exported());
      await page.locator('[data-action="reselect"]').click(); await page.locator('#reselectConfirm').waitFor({ state: 'visible' });
      await page.locator('[data-action="keep"]').click(); assert.equal(digest(await exported()), before);
      await page.locator('[data-action="reselect"]').click(); await page.locator('[data-action="clear-reselect"]').click();
      assert.equal((await state()).selection, null); assert.equal((await state()).marks.length, 0);
      await select(); return { retained: true, clearConfirmed: true, canSelectAgain: true };
    });
    assert.deepEqual(report.errors, []); report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = error.stack; await screenshot('failure'); throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    await context.close(); await browser.close();
    console.log('Evidence: ' + output);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

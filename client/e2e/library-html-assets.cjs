'use strict';
// Production HTML assembly in real Chromium; fixture archive bytes only.
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 90000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
  const client = path.resolve(__dirname, '..'), output = path.resolve(client, '../outputs/library-html-assets');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-library-assets-'));
  fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(temporary, 'profile'));
  const report = { ok: false, boundary: 'Real DOMParser, production builder and opaque iframe; fixture archive bytes, no live accounts or network.', cases: [] };
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const run = fn => js('(' + fn.toString() + ')()');
  app.whenReady().then(async () => {
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => done({ cancel: true }));
    await win.loadURL('data:text/html,<!doctype html><title>Asset fixture</title><body></body>');
    await js(fs.readFileSync(path.join(client, 'components/panels/library-delivery.js'), 'utf8') + '\nvoid 0;');
    const resolved = await run(async () => {
      const values = {
        'site/styles/main.css': '@import "./nested/base.css?v=1";#entry{background-image:url(../img/picture%20one.svg#icon)}',
        'site/styles/nested/base.css': '@font-face{font-family:fixture;src:url(../../font/demo.woff2)}#entry{color:rgb(20, 40, 60)}',
        'site/img/picture one.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect id="icon" width="2" height="2" fill="red"/></svg>',
        'site/font/demo.woff2': 'fixture-font',
        'site/scripts/main.js': 'document.querySelector("#entry").textContent="Script ran";window.fixtureAssetReady=true;',
        'other/site/scripts/main.js': 'throw Error("wrong sibling")'
      };
      const files = Object.entries(values).map(([path, value]) => ({ path, size: value.length, contentType: 'application/octet-stream' }));
      for (let i = 0; i < 2000; i++) files.push({ path: 'irrelevant/' + i + '.txt', size: 20 });
      const reads = [];
      const source = '<html><head><link rel="stylesheet" href="../styles/main.css?cache=1"><style>.inline{background:url(../img/picture%20one.svg)}</style></head><body><div id="entry">Original</div><img src="../img/picture%20one.svg#icon"><script src="../scripts/main.js"></script><script>try{parent.document.body.dataset.leaked="yes"}catch(e){window.fixtureIsolated=true}</script></body></html>';
      const html = await LibraryDelivery.buildHtmlDocument(source, files, { path: 'site/pages/index.html' }, async path => { reads.push(path); if (!(path in values)) throw Error('unexpected read'); return new Blob([values[path]]); });
      window.fixtureHtml = html;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const decode = url => atob(url.split(',')[1].split('#')[0]);
      const cssUrl = doc.querySelector('link[rel=stylesheet]').getAttribute('href');
      const css = cssUrl.startsWith('data:') ? decode(cssUrl) : '';
      const importUrl = css.match(/data:text\/css;base64,[A-Za-z0-9+/=]+/)?.[0];
      return { reads, cssUrl, css, imported: importUrl ? decode(importUrl) : '', script: doc.querySelector('script[src]').getAttribute('src'), image: doc.querySelector('img').getAttribute('src') };
    });
    assert.deepEqual([...resolved.reads].sort(), ['site/font/demo.woff2', 'site/img/picture one.svg', 'site/scripts/main.js', 'site/styles/main.css', 'site/styles/nested/base.css'].sort());
    assert.match(resolved.cssUrl, /^data:text\/css;base64,/); assert.match(resolved.css, /data:image\/svg\+xml;base64,/);
    assert.match(resolved.imported, /data:font\/woff2;base64,/); assert.match(resolved.script, /^data:text\/javascript;base64,/);
    assert.match(resolved.image, /^data:image\/svg\+xml;base64,.*#icon$/);
    report.cases.push('Only exact referenced members load; nested CSS, encoded filenames, parent paths, queries and SVG fragments resolve from their owning file');

    await js('(()=>{const frame=document.createElement("iframe");frame.sandbox="allow-scripts";frame.srcdoc=fixtureHtml;document.body.append(frame)})();');
    let frame;
    for (let i = 0; i < 100; i++) {
      for (const candidate of win.webContents.mainFrame.frames) if (await candidate.executeJavaScript('Boolean(window.fixtureAssetReady)').catch(() => false)) frame = candidate;
      if (frame) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(frame, 'External static JavaScript runs from its inlined data URL');
    const rendered = await frame.executeJavaScript('({text:document.querySelector("#entry").textContent,color:getComputedStyle(document.querySelector("#entry")).color,isolated:window.fixtureIsolated})');
    assert.equal(rendered.text, 'Script ran'); assert.equal(rendered.color, 'rgb(20, 40, 60)'); assert.equal(rendered.isolated, true);
    assert.equal(await js('document.body.dataset.leaked||""'), '');
    report.cases.push('Inlined static JavaScript and imported CSS execute/render inside the opaque sandbox without parent access');

    const safe = await run(async () => {
      const reads = [], files = [{ path: 'escape.js', size: 3 }, { path: 'site/asset.svg', size: 3 }];
      const source = '<base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><form><input></form><iframe src="https://evil.test"></iframe><img onload="alert(1)" src="../../../escape.js"><script src="https://evil.test/escape.js"></script><img src="//evil.test/a"><img src="%2e%2e/%2e%2e/escape.js"><div style="background:url(https://evil.test/a)"></div>';
      const html = await LibraryDelivery.buildHtmlDocument(source, files, { path: 'site/index.html' }, async path => { reads.push(path); return new Blob(['bad']); });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { reads, unsafe: doc.querySelectorAll('base,form,iframe,[onload],meta[http-equiv="refresh"]').length, policy: doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content };
    });
    assert.deepEqual(safe.reads, []); assert.equal(safe.unsafe, 0); assert.match(safe.policy, /connect-src 'none'/); assert.match(safe.policy, /default-src 'none'/);
    report.cases.push('Traversal and network references never reach the archive reader; unsafe document elements/handlers are removed and CSP is retained');

    const navigation = await run(async () => {
      const paths = ['site/pages/start.html', 'site/pages/next.html', 'site/readme.md',
        'site/中文/index.html', 'site/section/index.htm', 'site/pages/index.html', 'index.html'];
      const source = '<a id="relative" href="./next.html?cache=1#details">Next</a>' +
        '<a id="parent" href="../readme.md">Readme</a><a id="unicode" href="../%E4%B8%AD%E6%96%87/#%E6%A0%87%E9%A2%98">中文</a>' +
        '<a id="directory" href="../section/">Section</a><a id="current" href="./">Current folder</a>' +
        '<a id="root" href="/">Root</a><a id="query" href="?mode=1#details">Current page</a>' +
        '<a id="fragment" href="#details" data-soduwork-preview-path="spoof.html">Section</a>' +
        '<a id="external" href="https://example.test/next.html" data-soduwork-preview-path="site/pages/next.html" data-soduwork-preview-fragment="#spoof">External</a>' +
        '<a id="escape" href="../../../index.html">Escape</a><a id="missing" href="missing.html">Missing</a>' +
        '<a id="encodedEscape" href="%2e%2e/%2e%2e/%2e%2e/index.html">Encoded escape</a>' +
        '<a id="encodedExternal" href="https%3A%2F%2Fexample.test/next.html">Encoded external</a>' +
        '<div id="forged" data-soduwork-preview-path="site/pages/next.html" data-soduwork-preview-fragment="#spoof">Forged</div>';
      let reads = 0;
      const html = await LibraryDelivery.buildHtmlDocument(source, paths.map(path => ({ path })),
        { path: 'site/pages/start.html' }, async () => { reads++; throw Error('links must not download pages'); }, { navigation: true });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { reads, nodes: Object.fromEntries([...doc.querySelectorAll('[id]')].map(node => [node.id, {
        href: node.getAttribute('href'), path: node.getAttribute('data-soduwork-preview-path'),
        fragment: node.getAttribute('data-soduwork-preview-fragment')
      }])) };
    });
    assert.equal(navigation.reads, 0);
    for (const [id, expectedPath, fragment] of [
      ['relative', 'site/pages/next.html', '#details'], ['parent', 'site/readme.md', ''],
      ['unicode', 'site/中文/index.html', '#%E6%A0%87%E9%A2%98'], ['directory', 'site/section/index.htm', ''],
      ['current', 'site/pages/index.html', ''], ['root', 'index.html', ''],
      ['query', 'site/pages/start.html', '#details']
    ]) assert.deepEqual(navigation.nodes[id], { href: '#', path: expectedPath, fragment }, id);
    assert.deepEqual(navigation.nodes.fragment, { href: '#details', path: null, fragment: null });
    for (const id of ['external', 'escape', 'missing', 'encodedEscape', 'encodedExternal', 'forged']) {
      assert.deepEqual(navigation.nodes[id], { href: null, path: null, fragment: null }, id);
    }
    report.cases.push('Opt-in navigation marks only real archive members, resolves relative/parent/Unicode/directory links, and strips forged navigation markers');

    const legacyLinks = await run(async () => {
      const html = await LibraryDelivery.buildHtmlDocument('<a href="next.html" data-soduwork-preview-path="next.html">Next</a><a href="#here">Here</a>',
        [{ path: 'next.html' }], { path: 'index.html' }, async () => { throw Error('unexpected read'); });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return [...doc.querySelectorAll('a')].map(node => ({ href: node.getAttribute('href'), path: node.getAttribute('data-soduwork-preview-path') }));
    });
    assert.deepEqual(legacyLinks, [{ href: null, path: null }, { href: '#here', path: null }]);
    report.cases.push('Existing four-argument callers retain disabled document navigation and local fragment links');

    const responsiveImages = await run(async () => {
      const values = { 'site/images/small.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="5"/>',
        'site/images/大 图.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="10"/>' };
      const inline = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220,0,7,5%22%3E%3C/svg%3E';
      const reads = [];
      const source = '<picture><source id="widths" srcset="../images/small.svg 320w, ../images/%E5%A4%A7%20%E5%9B%BE.svg?version=1 640w">' +
        '<img id="density" srcset="' + inline + ' 1x, ../images/%E5%A4%A7%20%E5%9B%BE.svg 2x"></picture>' +
        '<img id="descriptorless" srcset="' + inline + ', ../images/small.svg 2x">' +
        '<img id="mixed" srcset="missing.svg 1x, ../images/small.svg 2x, ../images/small.svg -3x">' +
        '<img id="invalid" srcset="https://example.test/a.svg 1x, ../../../escape.svg 2x, missing.svg 3x">';
      const html = await LibraryDelivery.buildHtmlDocument(source, Object.keys(values).map(path => ({ path })),
        { path: 'site/pages/index.html' }, async path => { reads.push(path); return new Blob([values[path]]); });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { reads, inline, widths: doc.querySelector('#widths').getAttribute('srcset'),
        density: doc.querySelector('#density').getAttribute('srcset'), descriptorless: doc.querySelector('#descriptorless').getAttribute('srcset'),
        mixed: doc.querySelector('#mixed').getAttribute('srcset'), invalid: doc.querySelector('#invalid').getAttribute('srcset') };
    });
    assert.deepEqual(responsiveImages.reads.sort(), ['site/images/small.svg', 'site/images/大 图.svg'].sort());
    assert.match(responsiveImages.widths, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+ 320w, data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+ 640w$/);
    assert.ok(responsiveImages.density.startsWith(responsiveImages.inline + ' 1x, '), 'Commas inside a data URL must survive');
    assert.match(responsiveImages.density, /, data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+ 2x$/);
    assert.ok(responsiveImages.descriptorless.startsWith(responsiveImages.inline + ', '));
    assert.match(responsiveImages.mixed, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+ 2x$/);
    assert.equal(responsiveImages.invalid, null);
    report.cases.push('Image and picture source srcset resolve each candidate, preserve width/density descriptors and data URL commas, and reject unavailable/external candidates');

    const cycle = await run(async () => {
      const values = { 'a.css': '@import "b.css";.a{color:red}', 'b.css': '@import url(a.css);.b{color:blue}' }, reads = [];
      await LibraryDelivery.buildHtmlDocument('<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="a.css">', Object.keys(values).map(path => ({ path, size: values[path].length })), { path: 'index.html' }, async path => { reads.push(path); return new Blob([values[path]]); });
      return reads;
    });
    assert.deepEqual(cycle.sort(), ['a.css', 'b.css']); report.cases.push('Duplicate references are read once and cyclic CSS imports terminate');

    const limits = await run(async () => {
      const run = async (count, advertised, actual) => {
        const files = Array.from({ length: count }, (_, i) => ({ path: i + '.png', size: advertised }));
        let reads = 0;
        const html = await LibraryDelivery.buildHtmlDocument(files.map(file => '<img src="' + file.path + '">').join(''), files, { path: 'index.html' }, async () => { reads++; return new Blob([new Uint8Array(actual)]); });
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return { reads, embedded: [...doc.querySelectorAll('img')].filter(img => img.getAttribute('src').startsWith('data:image/png;base64,')).length };
      };
      return { count: await run(140, 1, 1), individual: await run(1, 2 * 1024 * 1024 + 1, 1), actual: await run(1, 1, 2 * 1024 * 1024 + 1), aggregate: await run(5, 2 * 1024 * 1024, 2 * 1024 * 1024) };
    });
    assert.deepEqual(limits.count, { reads: 128, embedded: 128 }); assert.deepEqual(limits.individual, { reads: 0, embedded: 0 });
    assert.deepEqual(limits.actual, { reads: 1, embedded: 0 }); assert.deepEqual(limits.aggregate, { reads: 4, embedded: 4 });
    report.cases.push('Support assets obey 128 reads, 2 MiB per asset and 8 MiB aggregate bounds using actual bytes as well as metadata');

    const expansion = await run(async () => {
      let reads = 0;
      const html = await LibraryDelivery.buildHtmlDocument('<img src="large.png">'.repeat(1000), [{ path: 'large.png', size: 2 * 1024 * 1024 }], { path: 'index.html' }, async () => { reads++; return new Blob([new Uint8Array(2 * 1024 * 1024)]); });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { reads, embedded: [...doc.querySelectorAll('img')].filter(img => img.getAttribute('src').startsWith('data:image/png;base64,')).length, size: html.length };
    });
    assert.equal(expansion.reads, 1); assert.ok(expansion.embedded >= 1 && expansion.embedded <= 5);
    assert.ok(expansion.size < 17 * 1024 * 1024);
    report.cases.push('Repeated references cannot amplify a small archive into unbounded HTML; expanded asset output is limited to 16 MiB');

    const stale = await run(async () => {
      try {
        await LibraryDelivery.buildHtmlDocument('<img src="image.png">', [{ path: 'image.png', size: 1 }], { path: 'index.html' }, async () => { throw Object.assign(Error('changed'), { code: 'STALE_TASK_SCOPE' }); });
        return '';
      } catch (error) { return error.code; }
    });
    assert.equal(stale, 'STALE_TASK_SCOPE'); report.cases.push('Account-scope cancellation is propagated rather than swallowed as a missing image');
    report.ok = true;
  }).catch(error => { report.error = String(error.stack || error); }).finally(() => {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (win && !win.isDestroyed()) win.destroy(); app.exit(report.ok ? 0 : 1);
  });
}

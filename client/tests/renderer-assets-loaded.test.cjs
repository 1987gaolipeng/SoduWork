'use strict';













const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

/*
 * Exclude directories with separate loading or build mechanisms, including vendors,
 * Runner, dependencies, output, and Node tests.
 */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'tests', 'runner']);

/* Document each intentionally unloaded source file in this exception list. */
const ALLOWED = new Set([]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + '/' + entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(rel, out);
    } else if (/\.(js|css)$/.test(entry.name) && !entry.name.endsWith('.test.js')) {
      out.push(rel);
    }
  }
  return out;
}

function pages() {
  const names = fs.readdirSync(root).filter((name) => name.endsWith('.html'));
  assert.ok(names.length >= 2, '至少应该有 desk.html 和 index.html 两个入口');
  // Screenshot service opens its sandboxed editor as a separate BrowserWindow.
  names.push('components/screenshot/screenshot.html');
  return names.map(name => ({ name, html: fs.readFileSync(path.join(root, name), 'utf8') }));
}


// Only imports reachable from a loaded stylesheet count; orphan CSS cannot
// make another orphan appear loaded. Resolve relative imports with cycle guards.
function loadedAssets(html, readAsset = rel => fs.readFileSync(path.join(root, rel), 'utf8'), page = '') {
  const loaded = new Set();
  function visit(raw, from = '') {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(raw)) return;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from || '.'), raw.split(/[?#]/)[0]));
    if (!/\.(?:js|css)$/.test(rel)) return;
    assert.ok(rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel), 'Asset stays in the client: ' + raw);
    if (loaded.has(rel)) return;
    loaded.add(rel);
    const source = readAsset(rel);
    if (!rel.endsWith('.css')) return;
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"'\s);]+)["']?\s*\)?/g)) visit(match[1], rel);
  }
  for (const match of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) visit(match[1], page);
  return loaded;
}

test('asset reachability follows nested CSS imports without counting orphan or commented imports', () => {
  const files = {
    'styles/main.css': '@import url("./nested/one.css"); /* @import "./unused.css"; */',
    'styles/nested/one.css': '@import "../shared.css" screen; @import url(../main.css);',
    'styles/shared.css': '.shared{color:inherit}',
    'styles/unused.css': '@import "./also-unused.css";',
    'styles/also-unused.css': '.unused{}',
    'app.js': '',
  };
  const reached = loadedAssets('<link href="styles/main.css?v=1"><script src="app.js"></script>', rel => {
    assert.ok(Object.hasOwn(files, rel), 'Referenced fixture exists: ' + rel);
    return files[rel];
  });
  assert.deepEqual([...reached].sort(), ['app.js', 'styles/main.css', 'styles/nested/one.css', 'styles/shared.css']);
  assert.throws(() => loadedAssets('<link href="missing.css">', () => { throw Error('missing imported file'); }), /missing imported file/);
  assert.throws(() => loadedAssets('<link href="../outside.css">', () => ''), /Asset stays in the client/);
});

test('组件目录里的每个 js/css 都得被某个页面真的加载', () => {
  const loaded = new Set(pages().flatMap(({ name, html }) => [...loadedAssets(html, undefined, name)]));
  const files = ['components', 'core']
    .filter((dir) => fs.existsSync(path.join(root, dir)))
    .flatMap((dir) => walk(dir, []));
  assert.ok(files.length > 50, '扫描没找到组件文件，路径可能变了：' + files.length);
  const orphans = files.filter((rel) => !ALLOWED.has(rel) && !loaded.has(rel));
  assert.deepEqual(orphans, [],
    '这些文件在仓库里但没有任何页面加载它们（等于死代码，界面上就是"点了没反应"）：'
    + orphans.join('、'));
});

test('independent screenshot window resolves assets relative to its own document', () => {
  const name = 'components/screenshot/screenshot.html';
  const loaded = loadedAssets(fs.readFileSync(path.join(root, name), 'utf8'), undefined, name);
  assert.deepEqual([...loaded].sort(), ['screenshot-editor.js', 'screenshot-model.js', 'screenshot-paint.js', 'screenshot.css']
    .map(file => 'components/screenshot/' + file).sort());
  assert.equal(loaded.has('screenshot-editor.js'), false);
});

test('任务全链路那几个组件在两个入口都齐（覆盖窗也要能渲染）', () => {
  /*
   * Register shared task-detail dependencies in both workspace and desktop-overlay pages.
   */
  const shared = [
    'components/panels/task-trace-execution-details.js',
    'components/panels/task-trace-view.js',
    'components/panels/task-trace-runtime.js',
    'components/panels/task-evolution-view.js',
    'components/panels/task-trace-view.css',
    'components/panels/task-evolution-view.css',
  ];
  for (const name of ['desk.html', 'index.html']) {
    const html = fs.readFileSync(path.join(root, name), 'utf8');
    for (const rel of shared) {
      assert.ok(html.includes(rel), name + ' 没有加载 ' + rel);
    }
  }
});

test('TaskEvolutionView 挂在 window 上，且排在 task-trace-view.js 之后', () => {
  const source = fs.readFileSync(
    path.join(root, 'components/panels/task-evolution-view.js'), 'utf8');
  assert.match(source, /window\.TaskEvolutionView\s*=/,
    'task-trace-view.js 是按 window.TaskEvolutionView 读取它的');
  for (const name of ['desk.html', 'index.html']) {
    const html = fs.readFileSync(path.join(root, name), 'utf8');
    const view = html.indexOf('components/panels/task-trace-view.js');
    const evolution = html.indexOf('components/panels/task-evolution-view.js');
    assert.ok(view >= 0 && evolution > view,
      name + ' 里 task-evolution-view.js 必须排在 task-trace-view.js 之后');
  }
});

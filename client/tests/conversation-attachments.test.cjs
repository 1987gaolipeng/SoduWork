const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const attachments = require('../main/pi-session/attachments');

test('conversation attachments are staged inside the real session workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-attachments-'));
  const sourceDir = path.join(root, 'source');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(sourceDir); fs.mkdirSync(cwd);
  const source = path.join(sourceDir, '需求原稿.md');
  fs.writeFileSync(source, '# 真实需求', 'utf8');
  try {
    const result = await attachments.stage(cwd, [{ name: '需求?.md', path: source }]);
    assert.equal(result.files.length, 1);
    assert.equal(result.warnings.length, 0);
    assert.equal(attachments.inside(cwd, result.files[0].path), true);
    assert.equal(fs.readFileSync(result.files[0].path, 'utf8'), '# 真实需求');
    assert.match(result.files[0].relative, /^\.soduwork-inputs\//);
    assert.match(attachments.prompt(result.files), /用户在开始本次会话时提供/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('folders are accepted by reference instead of being rejected', async () => {


  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-att-dir-'));
  const cwd = path.join(root, 'work');
  const dir = path.join(root, 'build-ui');
  fs.mkdirSync(cwd); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x', 'utf8');
  try {
    const result = await attachments.stage(cwd, [{ name: 'build-ui', path: dir }]);
    assert.equal(result.warnings.length, 0);          // Do not reject the whole send.
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].kind, 'dir');
    assert.equal(result.files[0].path, path.resolve(dir));   // Reference the original directory without copying.
    assert.equal(fs.existsSync(path.join(cwd, '.soduwork-inputs')), false);
    const text = attachments.prompt(result.files);
    assert.match(text, /（文件夹）/);
    assert.match(text, /直接列目录/);
    const imgs = await attachments.images(result.files); // Never route directories through image handling.
    assert.equal(imgs.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('files already inside the chosen workspace are not copied or renamed', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-workspace-'));
  const source = path.join(cwd, '现有资料.txt');
  fs.writeFileSync(source, 'source', 'utf8');
  try {
    const result = await attachments.stage(cwd, [{ name: '现有资料.txt', path: source }]);
    assert.equal(result.files[0].path, source);
    assert.equal(result.files[0].relative, '现有资料.txt');
    assert.equal(fs.existsSync(path.join(cwd, '.soduwork-inputs')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('external inputs for a chosen workspace use managed sidecar storage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sidecar-'));
  const cwd = path.join(root, 'project');
  const inputDir = path.join(root, 'managed', '.soduwork-inputs');
  const source = path.join(root, 'brief.txt');
  fs.mkdirSync(cwd); fs.writeFileSync(source, 'brief', 'utf8');
  try {
    const result = await attachments.stage(cwd, [{ name: 'brief.txt', path: source }], { stagingDir: inputDir });
    assert.equal(result.files.length, 1);
    assert.equal(attachments.inside(cwd, result.files[0].path), false);
    assert.equal(attachments.inside(inputDir, result.files[0].path), true);
    assert.equal(fs.existsSync(path.join(cwd, '.soduwork-inputs')), false);
    assert.equal(result.files[0].relative, result.files[0].path);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

});
test('pasted binary images are staged and forwarded to the model without exposing a source path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-paste-'));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  try {
    const result = await attachments.stage(cwd, [{
      name: '粘贴图片.png', type: 'image/png', data: new Uint8Array(bytes),
    }]);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].mimeType, 'image/png');
    assert.equal(result.files[0].relative.startsWith('.soduwork-inputs/'), true);
    assert.deepEqual(fs.readFileSync(result.files[0].path), bytes);
    const images = await attachments.images(result.files);
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, 'image/png');
    assert.equal(Buffer.from(images[0].data, 'base64').equals(bytes), true);
    const preview = await attachments.readImage(result.files[0].path);
    assert.equal(preview.mimeType, 'image/png');
    assert.equal(preview.data.equals(bytes), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sent image attachments render as clickable previews even when clipboard MIME is missing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'panels',
    'conversation-attachments.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const api = context.window.ConversationAttachments;
  const html = api.messageHtml([{
    name: '审计证据.jpg', type: '', size: 2048, previewRef: 'att1.preview',
  }]);
  assert.match(html, /data-catt-message-image='att1\.preview'/);
  assert.match(html, /nuser-att-image/);
  assert.match(html, /点击查看大图/);
  assert.match(html, /2\.0 KB/);
});

test('attachment tray exposes a concise material role hint without claiming files were understood', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'panels',
    'conversation-attachments.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const hint = context.window.ConversationAttachments.understandingHint;
  assert.equal(typeof hint, 'function');
  assert.match(hint(1, ''), /可以补一句说明/);
  assert.match(hint(2, ''), /哪份是步骤，哪份是要处理的文件/);
  assert.match(hint(1, '请汇总'), /文字说明一起发送/);
  assert.equal(hint(0, ''), '');
  assert.doesNotMatch(hint(2, ''), /已理解|已读取正文/);
});

test('attachment hint follows later typing without changing the attachment rail layout', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'components', 'panels',
    'conversation-attachments.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const events = {};
  const input = { value: '', addEventListener(name, handler) { events[name] = handler; } };
  const hint = { hidden: true, textContent: '' };
  const tray = { innerHTML: '', classList: { toggle() {} }, addEventListener() {} };
  const picker = context.window.ConversationAttachments.create({ input, tray,
    materialHint: true, hint, onChange() {} });
  picker.add([
    new File(['steps'], '步骤.txt', { type: 'text/plain' }),
    new File(['data'], '数据.txt', { type: 'text/plain' }),
  ]);
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /哪份是步骤/);
  input.value = '只处理第二张表';
  events.input({ isComposing: false });
  assert.doesNotMatch(hint.textContent, /哪份是步骤/);
  assert.match(hint.textContent, /文字说明一起发送/);
});

test('initial and follow-up composers accept clipboard files and forward attachment payloads', () => {
  const root = path.join(__dirname, '..');
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
  const desk = read('desk.html');
  const picker = read('components', 'panels', 'conversation-attachments.js');
  const compose = read('components', 'panels', 'panels-compose.js');
  const workActions = read('components', 'panels', 'panels-compose-work-actions.js');
  const chat = read('components', 'panels', 'panels-chat.js');
  const chatActions = read('components', 'panels', 'panels-chat-work-actions.js');
  const preload = read('preload.js');
  assert.match(desk, /conversation-attachments.css/);
  assert.match(desk, /conversation-attachments.js/);
  assert.match(picker, /clipboardData/);
  assert.match(picker, /event\.preventDefault\(\); add\(files, 'paste'\)/);
  assert.match(picker, /async function openMessageImage/);
  assert.match(picker, /async function copyImageFile/);
  assert.match(picker, /createImageBitmap/);
  assert.match(picker, /copyAttachmentImage/);
  assert.match(picker, /hydrateMessageImages/);
  assert.match(picker, /item.kind === 'file'/);
  assert.match(picker, /input\.addEventListener\('paste'/);
  assert.match(picker, /arrayBuffer/);
  assert.match(picker, /async function analysis\(\)/);
  assert.match(picker, /ANALYSIS_MAX_FILES/);
  assert.match(picker, /item\.mode = 'text'/);
  assert.match(picker, /item\.mode = image \? 'image' : 'document'/);
  assert.match(picker, /item\.mode = 'metadata'/);
  assert.match(compose, /await (?:ctx\.)?_attachments.refs/);
  assert.match(compose, /ComposeWorkActions\.route\(/);
  assert.match(workActions, /await attachments\.analysis\(\)/);
  assert.match(chatActions, /await o\.attachments\.analysis\(\)/);
  assert.match(chat, /const submissionRef = retainedRef \|\| (?:ctx\.)?_ref/);
  assert.match(chat, /ConversationAttachments\.openMessageImage/);
  assert.match(chat, /ConversationAttachments\.hydrateMessageImages/);
  assert.match(chat, /api\.send\(submissionRef, text, attachmentRefs, \{\s*plugins: resolvedPlugins,\s*sentAt,\s*projectId:/);
  assert.match(preload, /pi-session-send', ref, text, attachments/);
  assert.match(preload, /pi-session-attachment-image/);
  assert.match(preload, /pi-session-copy-attachment-image/);
});

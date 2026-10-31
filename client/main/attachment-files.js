'use strict';

/* Task attachment viewing belongs to Electron's trusted main process.
   The renderer only submits the short-lived attachment URL it received from Hub.
   This module binds that URL to the active Hub, fetches it without cookies, and
   chooses a safe native preview or an explicit system-app handoff. */
const fs = require('fs');
const path = require('path');
const { marked } = require('../vendor/markdown/marked.umd.js');

const ATTACHMENT_PATH = /^\/api\/v1\/attachments\/([A-Za-z0-9-]{8,64})$/;
const TICKET = /^[A-Za-z0-9._~-]{16,4096}$/;
const INLINE_PREVIEW_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/bmp', 'image/avif', 'image/x-icon',
  'application/pdf', 'application/json',
  'text/plain', 'text/markdown', 'text/csv',
]);
// Opening received files is not permission to execute programs or shell scripts.
const SYSTEM_OPEN_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.html', '.htm', '.rtf']);
function canOpenWithSystem(filename) { return SYSTEM_OPEN_EXTENSIONS.has(path.extname(String(filename || '')).toLowerCase()); }
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_MARKDOWN_PREVIEW_BYTES = 2 * 1024 * 1024;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

let DEPS = null;
let TEMP_ROOT = '';
const PREVIEWS = new Map();

function normalizedType(raw) {
  return String(raw || '').split(';', 1)[0].trim().toLowerCase();
}

function isInlinePreview(raw) {
  return INLINE_PREVIEW_TYPES.has(normalizedType(raw));
}

function isMarkdownFilename(filename) {
  return /\.(?:md|markdown|mdown)$/i.test(String(filename || ''));
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function renderMarkdownPreview(filename, data) {
  const source = Buffer.from(data || []).subarray(0, MAX_MARKDOWN_PREVIEW_BYTES)
    .toString('utf8').replace(/^\uFEFF/, '');
  const renderer = new marked.Renderer();
  // Markdown attachments are untrusted shared bytes. Keep the preview static,
  // strip raw HTML and images, and leave links inert behind the native window's
  // navigation guard. This gives headings, lists and code blocks a useful view
  // without turning a shared document into executable content.
  renderer.html = token => escapeHtml(token.text || '');
  renderer.image = token => escapeHtml(token.text || '');
  renderer.link = function (token) {
    const label = this.parser.parseInline(token.tokens || [], this.parser.textRenderer);
    const href = String(token.href || '');
    if (!/^(?:https?:|mailto:)/i.test(href)) return label;
    const title = token.title ? ' title="' + escapeHtml(token.title) + '"' : '';
    return '<a href="' + escapeHtml(href) + '"' + title + ' rel="noreferrer noopener">' + label + '</a>';
  };
  let body;
  try { body = marked.parse(source, { gfm: true, breaks: false, renderer }); }
  catch (_) { body = '<pre>' + escapeHtml(source) + '</pre>'; }
  const title = escapeHtml(path.basename(filename || 'Markdown'));
  const truncated = Buffer.from(data || []).length > MAX_MARKDOWN_PREVIEW_BYTES;
  const notice = truncated ? '<p class="notice">仅显示前 2 MB，完整内容请下载原文件。</p>' : '';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\';">' +
    '<title>' + title + '</title><style>' +
    ':root{color-scheme:light dark}body{margin:0;padding:32px 40px;background:#fff;color:#1f2329;font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere}' +
    'main{max-width:960px;margin:0 auto}h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.3em 0 .55em}h1{font-size:2em;border-bottom:1px solid #d8dee4;padding-bottom:.25em}h2{font-size:1.55em;border-bottom:1px solid #d8dee4;padding-bottom:.2em}p,ul,ol,blockquote,pre,table{margin:0 0 1em}blockquote{border-left:4px solid #d0d7de;color:#57606a;padding:0 1em;margin-left:0}code{padding:.15em .35em;background:#f0f2f4;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:max(12px,.9em)}pre{padding:14px 16px;overflow:auto;background:#f6f8fa;border-radius:8px}pre code{padding:0;background:transparent}a{color:#0969da}table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #d0d7de;padding:6px 12px;text-align:left}.notice{padding:10px 12px;color:#9a6700;background:#fff8c5;border:1px solid #d4a72c;border-radius:6px}' +
    '@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}h1,h2{border-color:#30363d}blockquote{border-color:#3b434b;color:#8b949e}code,pre{background:#161b22}a{color:#58a6ff}.notice{color:#d29922;background:#3b2f00;border-color:#6e5c00}}' +
    '</style></head><body><main data-user-content>' + notice + body + '</main></body></html>';
}

function safeFilename(raw, fallback) {
  let name = path.basename(String(raw || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  name = name.replace(/[. ]+$/g, '').slice(0, 180);
  if (!name || WINDOWS_RESERVED.test(name)) name = String(fallback || 'attachment');
  return name;
}

function parseAttachmentUrl(raw, trustedHub, mode) {
  let hub;
  let target;
  try {
    hub = new URL(String(trustedHub || '').trim());
    target = new URL(String(raw || '').trim(), hub.origin);
  } catch (_) {
    throw new Error('\u9644\u4ef6\u5730\u5740\u65e0\u6548\uff0c\u8bf7\u5237\u65b0\u4efb\u52a1\u540e\u91cd\u8bd5');
  }
  if (!/^https?:$/.test(hub.protocol) || target.origin !== hub.origin ||
      target.username || target.password || target.hash) {
    throw new Error('\u9644\u4ef6\u4e0d\u5c5e\u4e8e\u5f53\u524d SoduWork \u73af\u5883');
  }
  const match = ATTACHMENT_PATH.exec(target.pathname);
  if (!match) throw new Error('\u9644\u4ef6\u5730\u5740\u4e0d\u5728\u5141\u8bb8\u7684\u8303\u56f4\u5185');
  const ticket = String(target.searchParams.get('ticket') || '');
  if (!TICKET.test(ticket)) throw new Error('\u9644\u4ef6\u8bbf\u95ee\u51ed\u8bc1\u5df2\u5931\u6548\uff0c\u8bf7\u5237\u65b0\u4efb\u52a1\u540e\u91cd\u8bd5');
  const clean = new URL(hub.origin + target.pathname);
  clean.searchParams.set('ticket', ticket);
  if (mode === 'preview') clean.searchParams.set('mode', 'preview');
  return { id: match[1], url: clean.href };
}

function identityFor(event) {
  const identity = DEPS.identityOf(DEPS.app);
  if (!identity || !identity.hub) throw new Error('\u5f53\u524d\u73af\u5883\u5c1a\u672a\u5b8c\u6210\u8bbe\u5907\u8ba4\u8bc1');
  const parent = DEPS.BrowserWindow.fromWebContents(event.sender);
  if (!parent || parent.isDestroyed()) throw new Error('\u5f53\u524d\u7a97\u53e3\u5df2\u7ecf\u5173\u95ed');
  const owner = (DEPS.ownerOf || require('./device-auth').localOwner)(DEPS.app);
  // Capture an immutable identity snapshot so account changes cannot mutate away delayed-result checks.
  return { identity: { ...identity }, owner, parent };
}

function assertCurrent(event, found) {
  let current;
  try { current = identityFor(event); } catch (_) {}
  if (!current || current.parent !== found.parent || current.owner !== found.owner ||
      ['hub', 'clientId', 'secret'].some(key => current.identity[key] !== found.identity[key])) {
    throw Object.assign(new Error('附件操作已取消：账号、服务或窗口已切换，请重新打开附件'), { code: 'ATTACHMENT_CONTEXT_CHANGED' });
  }
}

function statusError(status) {
  if (status === 401 || status === 403) return '\u9644\u4ef6\u8bbf\u95ee\u51ed\u8bc1\u5df2\u5931\u6548\uff0c\u8bf7\u5237\u65b0\u4efb\u52a1\u540e\u91cd\u8bd5';
  if (status === 404) return '\u9644\u4ef6\u4e0d\u5b58\u5728\u6216\u4f60\u6ca1\u6709\u67e5\u770b\u6743\u9650';
  if (status === 413) return '\u9644\u4ef6\u592a\u5927\uff0c\u65e0\u6cd5\u5728\u5ba2\u6237\u7aef\u4e2d\u6253\u5f00';
  return '\u9644\u4ef6\u6682\u65f6\u6ca1\u6709\u52a0\u8f7d\u6210\u529f\uff08HTTP ' + status + '\uff09';
}

async function fetchAttachment(url) {
  const response = await DEPS.net.fetch(url, { redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('\u9644\u4ef6\u670d\u52a1\u8fd4\u56de\u4e86\u4e0d\u5b89\u5168\u7684\u8df3\u8f6c');
  }
  if (!response.ok) {
    // Keep the known missing-object error distinct from an ACL/record 404.
    // Never display arbitrary proxy HTML or unbounded server error bodies.
    let missingFile = false;
    if (response.status === 404) {
      try {
        const body = await require('./library-binary.cjs').readResponse(response, 16 * 1024);
        missingFile = JSON.parse(body.toString('utf8')).detail === '附件文件已丢失';
      } catch (_) {}
    }
    throw new Error(missingFile
      ? '源文件已丢失，请从原执行电脑或服务器备份恢复附件后重试'
      : statusError(response.status));
  }
  const data = await require('./library-binary.cjs').readResponse(response, MAX_ATTACHMENT_BYTES);
  const rawType = response.headers.get('content-type') || '';
  const charset = /;\s*charset\s*=\s*"?([a-z0-9_-]{1,40})(?:"|\s|;|$)/i.exec(rawType);
  return { data, contentType: normalizedType(rawType), charset: charset ? charset[1] : 'utf-8' };
}

function previewKey(event) {
  return String(event.sender.id);
}

function closePreview(key) {
  const current = PREVIEWS.get(key);
  PREVIEWS.delete(key);
  if (current && !current.isDestroyed()) current.close();
}

async function showInline(event, filename, result, found) {
  assertCurrent(event, found);
  const key = previewKey(event);
  closePreview(key);
  const win = new DEPS.BrowserWindow({
    parent: found.parent,
    modal: false,
    width: 1040,
    height: 760,
    minWidth: 620,
    minHeight: 420,
    show: false,
    title: 'SoduWork \u00b7 ' + filename,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
      webSecurity: true,
      plugins: true,
      spellcheck: false,
      partition: 'soduwork-attachment-preview-' + key,
    },
  });
  PREVIEWS.set(key, win);
  const previewSession = win.webContents.session;
  const denyDownload = (downloadEvent) => downloadEvent.preventDefault();
  win.on('closed', () => {
    if (PREVIEWS.get(key) === win) PREVIEWS.delete(key);
    previewSession.removeListener('will-download', denyDownload);
  });
  previewSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.on('will-download', denyDownload);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (navigationEvent, url) => {
    if (/^data:/i.test(url)) return;
    navigationEvent.preventDefault();
  });
  // Markdown gets a static, sanitized document so shared headings, lists and
  // code blocks are readable. Other text formats remain literal text.
  const markdown = isMarkdownFilename(filename);
  const mime = markdown ? 'text/html;charset=utf-8' : (/^(?:text\/|application\/json$)/.test(result.contentType)
    ? 'text/plain;charset=' + result.charset : result.contentType);
  const payload = markdown ? Buffer.from(renderMarkdownPreview(filename, result.data), 'utf8') : result.data;
  const dataUrl = 'data:' + mime + ';base64,' + payload.toString('base64');
  const closeOwnWindow = () => {
    if (PREVIEWS.get(key) === win) closePreview(key);
    else if (!win.isDestroyed()) win.close();
  };
  // Revalidate identity before showing a native window, not only when download starts.
  win.once('ready-to-show', () => {
    try { assertCurrent(event, found); if (!win.isDestroyed()) win.show(); }
    catch (_) { closeOwnWindow(); }
  });
  try {
    await win.loadURL(dataUrl);
    assertCurrent(event, found);
    if (win.isDestroyed()) throw new Error('预览窗口已关闭');
  } catch (error) {
    closeOwnWindow();
    if (error.code === 'ATTACHMENT_CONTEXT_CHANGED') throw error;
    throw new Error('附件预览窗口加载失败，请下载后查看');
  }
}

function ensureTempRoot() {
  if (TEMP_ROOT) return TEMP_ROOT;
  const base = path.join(DEPS.app.getPath('temp'), 'SoduWork', 'attachment-preview');
  fs.mkdirSync(base, { recursive: true });
  TEMP_ROOT = fs.mkdtempSync(path.join(base, 'session-'));
  return TEMP_ROOT;
}

async function openWithSystem(event, parsed, filename, downloaded, found) {
  if (!canOpenWithSystem(filename)) throw new Error('此类附件不支持直接打开，请下载后自行检查；不会自动运行程序或脚本');
  const result = downloaded || await fetchAttachment(parsed.url);
  assertCurrent(event, found);
  const dir = path.join(ensureTempRoot(), parsed.id);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, safeFilename(filename, parsed.id));
  fs.writeFileSync(target, result.data, { mode: 0o600 });
  const error = await DEPS.shell.openPath(target);
  if (error) throw new Error('\u7cfb\u7edf\u6ca1\u6709\u53ef\u6253\u5f00\u8fd9\u4e2a\u6587\u4ef6\u7684\u5e94\u7528\uff1a' + error);
  return { ok: true, external: true };
}

async function preview(event, raw) {
  const payload = raw || {};
  const found = identityFor(event);
  const parsed = parseAttachmentUrl(payload.url, found.identity.hub, 'preview');
  const filename = safeFilename(payload.filename, parsed.id);
  const result = await fetchAttachment(parsed.url);
  assertCurrent(event, found);
  if (payload.inlineText === true) {
    if (!/\.(?:md|markdown|txt)$/i.test(filename)) return { ok: false, reason: '这份附件不支持文本预览' };
    const cap = 2 * 1024 * 1024;
    return { ok: true, text: result.data.subarray(0, cap).toString('utf8'),
      tooBig: result.data.length > cap, size: result.data.length };
  }
  // Opt-in from the shared renderer preview; never return HTML/SVG as image data.
  if (payload.inlineImage === true && isInlinePreview(result.contentType) &&
      result.contentType.startsWith('image/')) {
    if (result.data.length > 20 * 1024 * 1024) return { ok: false, reason: '图片超过 20 MB，请下载后查看' };
    return { ok: true, mimeType: result.contentType, data: result.data.toString('base64') };
  }
  if (payload.inlineImage === true) return { ok: false, reason: '这份附件不是支持内嵌预览的图片' };
  if (!isInlinePreview(result.contentType) && !isMarkdownFilename(filename)) {
    const downloadUrl = parseAttachmentUrl(payload.url, found.identity.hub);
    return openWithSystem(event, downloadUrl, filename, result, found);
  }
  await showInline(event, filename, result, found);
  return { ok: true, native: true };
}

async function download(event, raw) {
  const payload = raw || {};
  const found = identityFor(event);
  const parsed = parseAttachmentUrl(payload.url, found.identity.hub);
  const filename = safeFilename(payload.filename, parsed.id);
  const picked = await DEPS.dialog.showSaveDialog(found.parent, require("./native-locale.cjs").dialogOptions({
    title: '\u4e0b\u8f7d\u9644\u4ef6',
    defaultPath: path.join(DEPS.app.getPath('downloads'), filename),
    buttonLabel: '\u4fdd\u5b58',
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }));
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  assertCurrent(event, found);
  const result = await fetchAttachment(parsed.url);
  assertCurrent(event, found);
  fs.writeFileSync(picked.filePath, result.data);
  return { ok: true };
}

async function readBinary(event, raw) {
  const payload = raw || {};
  const found = identityFor(event);
  const parsed = parseAttachmentUrl(payload.url, found.identity.hub);
  const filename = safeFilename(payload.filename, parsed.id);
  const result = await fetchAttachment(parsed.url);
  assertCurrent(event, found);
  return { ok: true, name: filename, size: result.data.length,
    mimeType: result.contentType || 'application/octet-stream', data: result.data.toString('base64') };
}

function cleanup() {
  PREVIEWS.forEach((_win, key) => closePreview(key));
  if (!TEMP_ROOT) return;
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  TEMP_ROOT = '';
}

function install(deps) {
  DEPS = deps;
  deps.ipcMain.handle('attachment-preview', preview);
  deps.ipcMain.handle('attachment-download', download);
  deps.ipcMain.handle('attachment-read-binary', readBinary);
  deps.app.once('before-quit', cleanup);
}

module.exports = {
  install,
  normalizedType,
  isInlinePreview,
  safeFilename,
  parseAttachmentUrl,
  MAX_ATTACHMENT_BYTES, canOpenWithSystem,
  isMarkdownFilename, renderMarkdownPreview,
};

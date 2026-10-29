'use strict';

// Metadata comes from the indexed file, never conversation prose or executed JS.
const fs = require('fs');
const path = require('path');
const READ_CAP = 64 * 1024;
const CACHE_CAP = 128;
const cache = new Map();
const entities = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', middot: '·', bull: '•', hellip: '…', copy: '©', reg: '®', trade: '™' });

function text(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return Object.hasOwn(entities, name) ? entities[name] : whole;
    const number = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
      ? String.fromCodePoint(number) : '\ufffd';
  }).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function htmlTitle(html) {
  let cursor = 0;
  const ignored = [];
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) return '';
      cursor = end + 3; continue;
    }
    const match = /^<(\/?)([a-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(html.slice(start));
    if (!match) {
      if (/^<!|^<\?/.test(html.slice(start, start + 2))) {
        const end = html.indexOf('>', start + 2);
        if (end < 0) return '';
        cursor = end + 1;
      } else {
        if (/^<\/?[a-z]/i.test(html.slice(start, start + 3))) return '';
        cursor = start + 1;
      }
      continue;
    }
    cursor = start + match[0].length;
    const name = match[2].toLowerCase(), closing = Boolean(match[1]);
    if (['script', 'style', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(name) && !closing) {
      const close = new RegExp('</' + name + '\\s*>', 'ig'); close.lastIndex = cursor;
      const end = close.exec(html);
      if (!end) return '';
      cursor = close.lastIndex; continue;
    }
    if (['template', 'svg', 'math'].includes(name)) {
      if (closing && ignored.at(-1) === name) ignored.pop();
      else if (!closing && !/\/\s*>$/.test(match[0])) ignored.push(name);
      continue;
    }
    if (ignored.length) continue;
    if (name === 'body' || name === 'plaintext' || (name === 'head' && closing)) return '';
    if (name === 'title' && !closing) {
      const end = /<\/title\s*>/ig; end.lastIndex = cursor;
      const found = end.exec(html);
      return found ? text(html.slice(cursor, found.index)) : '';
    }
  }
  return '';
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function fromFile(cwd, file) {
  if (!cwd || !file?.path || !/\.html?$/i.test(file.path)) return '';
  let descriptor;
  try {
    const root = path.resolve(cwd), target = path.resolve(file.path);
    if (!inside(root, target)) return '';
    const realpath = fs.realpathSync.native || fs.realpathSync;
    const realRoot = realpath(root), realTarget = realpath(target);
    if (!inside(realRoot, realTarget)) return '';
    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) return '';
    const stamp = version(stat), key = realRoot + '\0' + realTarget;
    const saved = cache.get(key);
    if (saved?.version === stamp) return saved.title;
    descriptor = fs.openSync(realTarget, 'r');
    if (version(fs.fstatSync(descriptor)) !== stamp) return '';
    const buffer = Buffer.alloc(Math.min(READ_CAP, stat.size));
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (version(fs.fstatSync(descriptor)) !== stamp || realpath(target) !== realTarget) return '';
    const html = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size), { stream: size === READ_CAP });
    const title = htmlTitle(html);
    cache.delete(key); cache.set(key, { version: stamp, title });
    if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
    return title;
  } catch (_) { return ''; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function decorate(cwd, file) {
  if (String(file?.title || '').trim()) return file;
  const title = fromFile(cwd, file);
  return title ? { ...file, title } : file;
}

module.exports = { fromFile, decorate };

'use strict';
const crypto = require('node:crypto');
const { plain } = require('./validation.cjs');
function object(payload) { if (!plain(payload)) throw Error('连接器请求内容应为对象'); }
function text(value) { if (typeof value !== 'string') throw Error('连接器请求内容应为文本'); return value; }
function mailbox(value) {
  // Accept one plain email address; reject newlines, display names, and lists to prevent header injection.
  if (typeof value !== 'string' || !/^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
    || value.length > 254 || value.includes('..')) throw Error('邮件地址无效，请填写单个邮箱');
  return value;
}
// Use built-in encoders only; callers cannot supply MIME types or executable serialization.
function encode(kind, payload) {
  if (kind === 'jira-issue') {
    object(payload); object(payload.fields);
    const fields = { ...payload.fields };
    if (Object.hasOwn(fields, 'description')) {
      // Build Jira v3 ADF while preserving Unicode, blank lines, and special characters as text.
      const lines = text(fields.description).split(/\r\n|\r|\n/);
      fields.description = { type: 'doc', version: 1, content: lines.map(line => ({
        type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [],
      })) };
    }
    return { body: JSON.stringify({ ...payload, fields }), contentType: 'application/json' };
  }
  if (kind === 'form') {
    object(payload);
    const entries = Object.entries(payload).filter(([, value]) => value !== undefined).map(([key, value]) => {
      if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw Error('表单字段应为文本、数字或布尔值');
      return [key, String(value)];
    });
    return { body: new URLSearchParams(entries).toString(), contentType: 'application/x-www-form-urlencoded' };
  }
  if (kind === 'text') return { body: text(payload), contentType: 'text/plain; charset=utf-8' };
  if (kind === 'gmail') {
    object(payload);
    const to = mailbox(payload.to), from = mailbox(payload.from), subject = text(payload.subject), body = text(payload.body);
    // Limit Base64 lines to 76 characters per RFC 2045; split UTF-8 subjects within encoded-word limits.
    const subjects = []; let current = '';
    for (const character of subject) {
      if (Buffer.byteLength(current + character) > 42) { subjects.push(current); current = ''; }
      current += character;
    }
    if (current || !subjects.length) subjects.push(current);
    const encodedSubject = subjects.map(part => '=?UTF-8?B?' + Buffer.from(part).toString('base64') + '?=').join('\r\n ');
    const encodedBody = Buffer.from(body).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
    const lines = ['To: ' + to, 'From: ' + from, 'Subject: ' + encodedSubject,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedBody];
    return { body: JSON.stringify({ raw: Buffer.from(lines.join('\r\n')).toString('base64url') }), contentType: 'application/json' };
  }
  if (kind === 'drive-multipart') {
    object(payload);
    if (typeof payload.mimeType !== 'string' || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(payload.mimeType)) throw Error('文件 MIME 类型无效');
    const name = text(payload.name), content = text(payload.content);
    const boundary = 'soduwork_' + crypto.randomBytes(20).toString('hex');
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name })
      + '\r\n--' + boundary + '\r\nContent-Type: ' + payload.mimeType + '\r\n\r\n' + content + '\r\n--' + boundary + '--\r\n';
    return { body, contentType: 'multipart/related; boundary=' + boundary };
  }
  if (kind && kind !== 'json') throw Error('连接器编码尚未支持');
  return { body: JSON.stringify(payload), contentType: 'application/json' };
}
module.exports = { encode };

'use strict';
function normalize(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f]/.test(value)) throw Error('封面地址必须是有效的 HTTP(S) 图片地址');
  let url;
  try { url = new URL(value); } catch (_) { throw Error('封面地址必须是有效的 HTTP(S) 图片地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error('封面地址必须是有效的 HTTP(S) 图片地址');
  return value;
}
module.exports = { normalize };

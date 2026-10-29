'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const media = require('../components/panels/chat-media.js');
test('explicit media accepts signed HTTP URLs without relying on a filename extension', () => {
  const signed = 'https://storage.example/object?signature=a%2Bb&expires=123';
  assert.equal(media.spec({ type: 'video', items: [{ url: signed }] }).items[0].url, signed);
  assert.equal(media.spec({ type: 'image', items: [{ url: 'http://10.40.0.215/image' }] }).type, 'image');
});
test('invalid declarations cannot promote scripts, local paths or credential URLs into media', () => {
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,AA==', 'file:///C:/secret', 'C:/secret.png', '//storage.example/a', 'https://user:password@example.com/a']) {
    assert.equal(media.spec({ type: 'image', items: [{ url }] }), null, url);
  }
  for (const declaration of [{}, { type: 'iframe', items: [{ url: 'https://example.com/a' }] },
    { type: 'image', items: [] }, { type: 'video', items: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }] }]) {
    assert.equal(media.spec(declaration), null);
  }
});
test('gallery preserves order and all images beyond nine; invalid members reject the whole declaration', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ url: 'https://example.com/' + i, title: String(i) }));
  assert.deepEqual(media.spec({ type: 'gallery', items }).items.map(item => item.title), items.map(item => item.title));
  assert.equal(media.spec({ type: 'gallery', items: [...items, { url: 'file:///private.png' }] }), null);
});
test('media identity includes the owning conversation', () => {
  assert.ok(media.same({ dataset: { chatMedia: 'conversation-a:media' } }, { dataset: { chatMedia: 'conversation-a:media' } }));
  assert.equal(media.same({ dataset: { chatMedia: 'conversation-a:media' } }, { dataset: { chatMedia: 'conversation-b:media' } }), false);
});
test('media declaration accepts the app sidebar quote-escaped JSON without relaxing URL checks', () => {
  const data = { type: 'video', items: [{ url: 'https://example.com/clip.mp4', muted: true }] };
  assert.equal(media.declaration(JSON.stringify(data)).type, 'video');
  assert.equal(media.declaration(JSON.stringify(data).replaceAll('"', '\\"')).items[0].url, data.items[0].url);
  assert.equal(media.declaration('{\\"type\\":\\"video\\",\\"items\\":[{\\"url\\":\\"javascript:alert(1)\\"}]}'), null);
  assert.equal(media.declaration('{\\"type\\":'), null);
});

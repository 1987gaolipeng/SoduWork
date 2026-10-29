'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const panel = fs.readFileSync(path.join(__dirname, '../components/panels/panels-desk.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../components/panels/notice-surface.css'), 'utf8');

test('notification panel exposes a guarded private follow-up action', () => {
  assert.match(panel, /data-notice-follow-up/);
  assert.match(panel, /MessageFollowUp\?\.openInNewSession/);
  assert.match(panel, /WorkspaceHost\.open\('create', payload\)/);
  assert.match(panel, /openComposePanel\(payload\)/);
  assert.match(panel, /setAttribute\('aria-busy', 'true'\)/);
  assert.match(panel, /setAttribute\('aria-label', '基于此继续'\)/);
  assert.match(panel, /_noticeFolder !== 'received'/);
  /* Render this entry only for colleague messages with attachments. */
  assert.match(panel, /!files\.length\) return/);
  assert.match(panel, /className = 'np-chat-clip'/);
  assert.match(panel, /meta\.insertBefore\(button, meta\.firstChild\)/);
  assert.match(panel, /sourceScope = _syncNoticeScope\(\)/);
  assert.match(css, /\.np-chat-clip/);
  assert.match(css, /\.np-chat-clip:disabled/);
});

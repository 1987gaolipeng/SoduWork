'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/*
 * Extract the production count and compact helpers into a sandbox with real Intl. Verify
 * locale units and preserve exact Chinese spacing and threshold behavior.
 */

const src = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'panels', 'panels-usage.js'),
  'utf8',
);

function extractFn(name) {
  const head = 'function ' + name + '(';
  const start = src.indexOf(head);
  assert.ok(start >= 0, 'source contains function ' + name);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail('unbalanced braces in ' + name);
}

const count = new Function('return (' + extractFn('count') + ')')();
const compact = new Function(
  'count',
  extractFn('count') + '\n' + extractFn('compact') + '\nreturn compact;',
)(count);

function withLocale(locale, fn) {
  const prev = global.SoduWorkI18n;
  global.SoduWorkI18n = locale === undefined ? undefined : { getLocale: () => locale };
  try {
    fn();
  } finally {
    if (prev === undefined) delete global.SoduWorkI18n;
    else global.SoduWorkI18n = prev;
  }
}

test('compact keeps zh-CN rendering byte-identical (万/亿 with space)', () => {
  withLocale('zh-CN', () => {
    assert.equal(compact(780000000), '7.8 亿');
    assert.equal(compact(11640000), '1164 万');
    assert.equal(compact(2330000), '233 万');
    assert.equal(compact(7.8e12), '7.8 万亿');
    assert.equal(compact(9999), '9,999');
    assert.equal(compact(10000), '1 万');
  });
});

test('compact uses Intl compact notation for en-US', () => {
  withLocale('en-US', () => {
    assert.equal(compact(780000000), '780M');
    assert.equal(compact(11640000), '11.6M');
    assert.equal(compact(2330000), '2.3M');
    assert.equal(compact(6900000000), '6.9B');
    assert.equal(compact(7.8e12), '7.8T');
    assert.equal(compact(9999), '9,999');
  });
});

test('compact uses Intl compact notation for ja-JP and ko-KR', () => {
  withLocale('ja-JP', () => {
    assert.equal(compact(780000000), '7.8億');
    assert.equal(compact(11640000), '1164万');
    assert.equal(compact(2330000), '233万');
  });
  withLocale('ko-KR', () => {
    assert.equal(compact(780000000), '7.8억');
    assert.equal(compact(11640000), '1164만');
    assert.equal(compact(2330000), '233만');
  });
});

test('compact survives an unknown locale (Intl tolerant fallback)', () => {
  withLocale('xx-YY', () => {
    // Assert a valid result when ICU falls back from an unsupported locale.
    assert.equal(typeof compact(780000000), 'string');
    assert.ok(compact(780000000).length > 0);
  });
  withLocale(undefined, () => {
    assert.equal(compact(780000000), '7.8 亿');
  });
});

test('compact never leaks simplified-Chinese units into non-zh locales', () => {
  withLocale('en-US', () => {
    for (const n of [11640000, 2330000, 780000000, 6900000000, 7.8e12]) {
      assert.doesNotMatch(compact(n), /[万亿]/, 'value ' + n);
    }
  });
  withLocale('ko-KR', () => {
    for (const n of [11640000, 2330000, 780000000, 6900000000, 7.8e12]) {
      assert.doesNotMatch(compact(n), /[万亿]/, 'value ' + n);
    }
  });
  // Japanese compact units may use Han characters but must not use the simplified Chinese hundred-million form.
  withLocale('ja-JP', () => {
    for (const n of [11640000, 2330000, 780000000, 6900000000, 7.8e12]) {
      assert.doesNotMatch(compact(n), /亿/, 'value ' + n);
    }
  });
});

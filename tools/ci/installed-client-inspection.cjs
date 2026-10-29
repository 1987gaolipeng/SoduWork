'use strict';
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForRenderer(call, { timeoutMs = 30000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  do {
    const value = await call('Runtime.evaluate', { returnByValue: true, expression:
      '({title:document.title,url:location.href,ready:document.readyState,body:document.body?.innerText.slice(0,800),scripts:document.scripts.length,bridge:typeof window.soduWorkAPI})' });
    assert.equal(value.exceptionDetails, undefined);
    const dom = value.result.value;
    lastState = JSON.stringify({ ready: dom.ready, scripts: dom.scripts, bodyChars: dom.body?.length || 0, url: dom.url });
    // DOM navigation and application readiness are separate, particularly under CPU translation.
    // Wait for the full existing readiness condition; a persistently blank page is not success.
    if (dom.ready === 'complete' && dom.scripts > 0 && dom.body?.length > 0) return dom;
    await delay(pollMs);
  } while (Date.now() < deadline);
  throw Error('Installed renderer did not finish loading within ' + timeoutMs + 'ms; last state: ' + lastState);
}

module.exports = { waitForRenderer };

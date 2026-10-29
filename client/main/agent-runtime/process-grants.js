'use strict';

// A grant crosses the execution boundary as a lease and explicit redaction
// rules. Its cleanup closure and device credentials stay with its owner.
const REDACTIONS = Symbol.for('soduwork.runtime.redactions');
function attach(grant, rules = []) {
  Object.defineProperty(grant, REDACTIONS, { value: rules.filter(row => row?.value)
    .map(row => ({ value: String(row.value), replacement: String(row.replacement || '[hidden]') })) });
  return grant;
}
function redact(text, rules) {
  return rules.reduce((value, rule) => value.split(rule.value).join(rule.replacement), String(text || ''));
}
module.exports = { REDACTIONS, attach, redact };

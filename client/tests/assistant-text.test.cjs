'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {clean} = require('../main/agent-runtime/assistant-text.cjs');
test('only the known native metadata preamble is removed, preserving the real response',()=>{
  const warning='Warning: Model metadata for `test-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
  assert.equal(clean(warning+'\n\nFile saved.'),'File saved.');
  assert.equal(clean(warning),'');
  assert.equal(clean('Quoted log:\n'+warning),'Quoted log:\n'+warning);
  assert.equal(clean('Warning: this operation deletes data.'),'Warning: this operation deletes data.');
});

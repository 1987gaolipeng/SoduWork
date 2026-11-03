import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseArguments, formatArguments } from '../src/screens/mcp-arguments.js'
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/connector-arguments.json', import.meta.url), 'utf8'))
test('connector argument text preserves argv boundaries and round-trips existing arrays', () => {
  for (const { text, args } of cases.valid) {
    assert.deepEqual(parseArguments(text), args)
    assert.deepEqual(parseArguments(formatArguments(args)), args)
  }
})
test('malformed argument quotes are rejected before sending', () => {
  for (const text of cases.invalid) assert.throws(() => parseArguments(text))
})

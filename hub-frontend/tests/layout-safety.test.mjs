import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import postcss from 'postcss'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const main = fs.readFileSync(path.join(root, 'src', 'main.jsx'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src', 'layout-safety.css'), 'utf8')

test('layout safety loads after all visual layers', () => {
  const safety = main.indexOf("import './layout-safety.css'")
  assert.ok(safety > main.indexOf("import './landing.css'"), 'layout safety must be the final CSS layer')
})

test('shared shell lets long content shrink without hiding page overflow', () => {
  assert.match(css, /\.side-context\s*>\s*div[\s\S]*?width:\s*0/)
  assert.match(css, /\.tablewrap[\s\S]*?overflow-x:\s*auto/)
  assert.match(css, /\.toolbar\s*>\s*\.hintline[\s\S]*?overflow-wrap:\s*anywhere/)
  assert.doesNotMatch(css, /body[^{}]*\{[^{}]*overflow-x:\s*hidden/)
})

test('known long-content pages have explicit containment', () => {
  for (const screen of ['operations', 'usage', 'repositories', 'skills', 'capabilities', 'work-catalog', 'insights']) {
    assert.match(css, new RegExp(`data-screen=["']${screen}["']`), `${screen} needs a layout guard`)
  }
  assert.match(css, /\.ops-runner-name[\s\S]*?width:\s*0/)
  assert.match(css, /\.ugc-recent-list[\s\S]*?overflow:\s*hidden/)
  assert.match(css, /\.rc-source-id[\s\S]*?width:\s*0/)
  assert.match(css, /\.wc-scenario-grid[\s\S]*?min-width:\s*980px/)
  assert.match(css, /oi-shimmer-safe/)
})

test('later layout layers do not replace measured table height with a viewport percentage', () => {
  for (const file of ['design-system.css', 'page-layouts.css', 'layout-safety.css']) {
    const sheet = postcss.parse(fs.readFileSync(path.join(root, 'src', file), 'utf8'))
    sheet.walkRules((rule) => {
      if (!rule.selectors.some((selector) => selector.trim() === '.tablewrap .tscroll')) return
      rule.walkDecls('max-height', (decl) => {
        assert.ok(decl.value.includes('var(--viewport-list-height,'), `${file} overrides the table height budget`)
      })
    })
  }
})

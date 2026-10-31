import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import postcss from 'postcss'

// Source-level layout contracts, paired with synthetic resize tests. These do
// not claim browser measurements or replace visual checks on real monitors.
test('measured lists are not capped below their available height on large monitors', async () => {
  const cases = [
    ['design-system.css', '.tablewrap .tscroll'],
    ['screens/model-runtime.css', '.model-provider-grid'],
    ['screens/plugin-unified.css', '.plugin-card-grid'],
    ['screens/overview.css', '.gov-departments'],
    ['responsive-pages.css', '.content .admin-viewport-list'],
  ]
  for (const [file, selector] of cases) {
    const sheet = postcss.parse(await fs.readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'))
    let measured = false
    sheet.walkRules((rule) => {
      if (!rule.selectors.includes(selector) || rule.parent.type === 'atrule') return
      rule.walkDecls('max-height', (decl) => {
        measured = true
        assert.match(decl.value, /^var\(--viewport-list-height,/, `${file} must consume the full measured height, without a pixel ceiling`)
      })
    })
    assert.ok(measured, `${selector} must use the viewport budget`)
  }
})

test('dialog and secondary layouts load before the final containment guards', async () => {
  const source = await fs.readFile(new URL('../src/main.jsx', import.meta.url), 'utf8')
  const end = source.indexOf("import './layout-safety.css'")
  for (const file of ['responsive-pages.css', 'dialog-layout.css', 'screens/detail-layout.css']) {
    const index = source.indexOf(`import './${file}'`)
    assert.ok(index > 0 && index < end, `${file} must be part of the shared entry`)
  }
})

test('org directory title keeps a shrink floor so the nowrap create button wraps instead of overlapping', async () => {
  const sheet = postcss.parse(await fs.readFile(new URL('../src/screens/org-governance.css', import.meta.url), 'utf8'))
  let declared = false
  sheet.walkRules((rule) => {
    if (!rule.selectors.includes('.og-directory>header>div:first-child')) return
    rule.walkDecls('min-width', (decl) => {
      declared = true
      assert.doesNotMatch(decl.value, /^0$/, 'min-width:0 lets the create button crush the title into a character column')
    })
  })
  assert.ok(declared, 'the directory title block must declare an intrinsic shrink floor')
})

test('capability workspace rows do not take the intrinsic height of the complete catalog', async () => {
  const sheet = postcss.parse(await fs.readFile(new URL('../src/screens/capability-center.css', import.meta.url), 'utf8'))
  let tracks = 0
  sheet.walkRules((rule) => {
    if (!rule.selector.startsWith('.cap-admin-skill-body')) return
    rule.walkDecls('grid-template-rows', (decl) => {
      tracks++
      assert.doesNotMatch(decl.value, /min-content|max-content|auto/, 'scroll panes must have finite track minimums')
    })
  })
  assert.ok(tracks >= 2, 'check both the discovered-only and personal-submission layouts')
})

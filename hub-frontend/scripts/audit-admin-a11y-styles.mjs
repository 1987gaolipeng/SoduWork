// Source-level guardrails; these do not replace computed-style/axe browser checks.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { parse } from '@babel/parser'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name)
  return entry.isDirectory() ? files(file) : [file]
})
const issues = [], sources = files(root).filter((file) => !/[/\\](landing\.css|Landing\.jsx)$/.test(file))
let fontDeclarations = 0
function checkFont(value, file, line) {
  fontDeclarations++
  const match = String(value).match(/^(\d+(?:\.\d+)?)(?:px)?$/)
  if (match && +match[1] > 0 && +match[1] < 12) issues.push(`${path.relative(root, file)}:${line}: font ${value} < 12px`)
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit))
    else if (value && typeof value === 'object') walk(value, visit)
  }
}
for (const file of sources) {
  const source = fs.readFileSync(file, 'utf8')
  if (file.endsWith('.css')) postcss.parse(source).walkDecls((decl) => {
    if (decl.prop === 'font-size') checkFont(decl.value, file, decl.source.start.line)
    if (decl.prop === 'font') {
      const match = decl.value.match(/\b(\d+(?:\.\d+)?)px\b/)
      if (match) checkFont(match[1], file, decl.source.start.line)
    }
  })
  if (file.endsWith('.jsx')) walk(parse(source, { sourceType: 'module', plugins: ['jsx'] }), (node) => {
    if (node.type === 'ObjectProperty' && (node.key.name || node.key.value) === 'fontSize') {
      if (['NumericLiteral', 'StringLiteral'].includes(node.value.type)) checkFont(node.value.value, file, node.loc.start.line)
    }
    if (node.type === 'JSXAttribute' && node.name.name === 'fontSize') {
      const value = node.value?.expression || node.value
      if (value && 'value' in value) checkFont(value.value, file, node.loc.start.line)
    }
  })
}

const cssFiles = [...fs.readFileSync(path.join(root, 'main.jsx'), 'utf8').matchAll(/import ['"]\.\/(.+\.css)['"]/g)].map((match) => path.join(root, match[1]))
function themeTokens(theme) {
  const tokens = {}, priority = {}
  for (const file of cssFiles) postcss.parse(fs.readFileSync(file, 'utf8')).walkRules((rule) => {
    // Ignore duplicate OS-dark overrides; explicit user selection is authoritative.
    if (rule.parent.type === 'atrule') return
    const applicable = rule.selector.split(',').map((s) => s.trim()).filter((s) => s === ':root' || s === `:root[data-theme="${theme}"]`)
    if (!applicable.length) return
    const specificity = applicable.some((s) => s !== ':root') ? 2 : 1
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--') && specificity >= (priority[decl.prop] || 0)) {
        tokens[decl.prop] = decl.value; priority[decl.prop] = specificity
      }
    })
  })
  return tokens
}
function rgb(value, tokens) {
  if (value.startsWith('var(')) return rgb(tokens[value.slice(4, -1)], tokens)
  if (value.startsWith('#')) {
    let hex = value.slice(1)
    if (hex.length === 3) hex = [...hex].map((char) => char + char).join('')
    return hex.match(/../g).map((pair) => parseInt(pair, 16))
  }
  const match = value.match(/^rgba?\((.+)\)$/)
  if (match) return match[1].split(',').map(Number)
  throw new Error(`unsupported color ${value}`)
}
function composite(foreground, background) {
  const alpha = foreground[3] ?? 1
  return foreground.slice(0, 3).map((channel, index) => channel * alpha + background[index] * (1 - alpha))
}
function luminance(color) {
  return color.slice(0, 3).map((n) => n / 255).map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
    .reduce((total, n, index) => total + n * [.2126, .7152, .0722][index], 0)
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}
let colorPairs = 0, lowestRatio = Infinity
for (const theme of ['light', 'dark']) {
  const tokens = themeTokens(theme), color = (name) => rgb(tokens[name], tokens)
  function check(fg, bg, label) {
    const ratio = contrast(fg, bg); colorPairs++; lowestRatio = Math.min(lowestRatio, ratio)
    if (ratio < 4.5) issues.push(`${theme}: ${label} contrast ${ratio.toFixed(2)} < 4.5`)
  }
  const surfaces = ['--bg', '--surface', '--surface-1', '--surface-2', '--surface-3', '--raised', '--sidebar', '--sidebar-2']
  for (const foreground of ['--ink', '--ink-2', '--ink-3', '--ink-4', '--accent', '--ok', '--warn', '--crit', '--sidebar-muted']) {
    for (const background of surfaces) check(color(foreground), color(background), `${foreground}/${background}`)
  }
  for (const state of ['accent', 'ok', 'warn', 'crit']) {
    for (const surface of surfaces) check(color(`--${state}`), composite(color(`--${state}-soft`), color(surface)), `${state} on soft/${surface}`)
  }
  if (tokens['--text-purple']) {
    for (const foreground of ['--accent', '--ok', '--warn', '--crit', '--text-purple']) {
      check(color(foreground), composite([...color(foreground), .14], color('--surface')), `${foreground}/avatar tint`)
    }
  }
  for (const background of ['--accent', '--accent-2']) check(color('--on-accent'), color(background), `primary button/${background}`)
}
console.log(JSON.stringify({ scope: 'admin source fonts and shared theme token pairs; not a browser audit', fontDeclarations, colorPairs, lowestRatio: +lowestRatio.toFixed(2), issueCount: issues.length, issues: issues.slice(0, 25) }, null, 2))
if (issues.length) process.exitCode = 1

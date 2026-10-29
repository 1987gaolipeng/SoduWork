import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { messages } from '../src/locales/messages.js'
const require = createRequire(import.meta.url)
const parser = require('@babel/parser')
const traverse = require('@babel/traverse').default
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const han = /[\u3400-\u9fff]/
const ui = [], unmarked = []
const isCall = (p, name) => p?.isCallExpression() && p.node.callee.name === name
function isTranslatedLiteral(p) {
  // Only value branches reach tx. Conditions and nested data-building calls
  // remain subject to their normal literal review rules.
  while (p.parentPath?.isConditionalExpression() && ['consequent', 'alternate'].includes(p.key)) p = p.parentPath
  return isCall(p.parentPath, 'tx') && p.key === 0
}
const files = [path.join(root, 'src'), path.join(root, 'src/screens')].flatMap(dir =>
  fs.readdirSync(dir).filter(name => /\.(jsx|js)$/.test(name) && name !== 'i18n.js').map(name => path.join(dir, name)))
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['jsx'] })
  const record = (array, node, value, kind) => { array.push({ file: path.relative(root, file).replaceAll('\\', '/'), line: node.loc.start.line, kind, source: value }) }
  traverse(ast, {
    StringLiteral(p) {
      const value = p.node.value
      if (!han.test(value)) return
      if (isTranslatedLiteral(p)) return record(ui, p.node, value, 'message')
      if (p.parent.type === 'ObjectProperty' && p.key === 'key') return
      if (p.findParent(q => isCall(q, 'localeMap'))) return record(ui, p.node, value, 'constant-label')
      if (isCall(p.parentPath, 't')) return // Keyed shell dictionary.
      if (p.parent.type === 'BinaryExpression' && p.parent.operator !== '+') return
      if (p.parent.type === 'CallExpression' && ['includes', 'indexOf', 'startsWith', 'endsWith', 'replace', 'replaceAll', 'split', 'match', 'test'].includes(p.parent.callee.property?.name)) return
      const name = p.findParent(q => q.isVariableDeclarator())?.node.id.name
      const property = p.findParent(q => q.isObjectProperty())?.node.key.name
      if (['STARTER', 'defaults', 'blank'].includes(name)) return
      if (['title', 'name'].includes(property) && ['新的一步', '新分类'].includes(value)) return
      record(unmarked, p.node, value, 'literal-review')
    },
    JSXText(p) { if (han.test(p.node.value)) record(unmarked, p.node, p.node.value.trim(), 'jsx-text') },
    TemplateLiteral(p) {
      if (!p.node.quasis.some(q => han.test(q.value.cooked))) return
      record(unmarked, p.node, p.node.quasis.map(q => q.value.cooked).join('{…}'), 'template-review')
    },
  })
}
const missing = ui.filter(row => !(row.source.trim() in messages))
const unique = new Set(ui.map(row => row.source.trim()))
const report = { scannedFiles: files.length, uiOccurrences: ui.length, uniqueMessages: unique.size,
  missingMessages: [...new Set(missing.map(row => row.source.trim()))], missingOccurrences: missing, unmarked }
const output = process.argv[2]
if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ ...report, missingOccurrences: undefined, unmarked: unmarked.length }, null, 2))
if (missing.length || unmarked.length) process.exitCode = 1

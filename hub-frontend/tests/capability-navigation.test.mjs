import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const app = fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8')
const binding = fs.readFileSync(path.join(root, 'src', 'screens', 'PluginBindingDialog.jsx'), 'utf8')
const bindingCss = fs.readFileSync(path.join(root, 'src', 'screens', 'plugin-workshop-dialogs.css'), 'utf8')

test('后台能力目录统一承载 Skill 与 MCP，并保留旧入口兼容映射', () => {
  assert.match(app, /const Capabilities = lazy\(\(\) => import\('\.\/screens\/Skills\.jsx'\)\)/)
  assert.match(app, /id: 'capabilities', label: '能力目录'/)
  assert.match(app, /skills: 'capabilities', mcp: 'capabilities'/)
})

test('插件节点高级路由在不同宽度下完整展示并允许收窄', () => {
  assert.match(binding, /className="binding-node-advanced"/)
  assert.match(binding, /<AgentChoice /)
  assert.match(binding, /<ModelChoice /)
  assert.match(binding, /不可用时/)
  assert.match(binding, /限定执行机/)
  assert.match(bindingCss, /\.node-route-controls \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/s)
  assert.match(bindingCss, /\.node-route-controls \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
  assert.match(bindingCss, /\.route-grid, \.node-route-controls \{ grid-template-columns: 1fr; \}/)
  assert.match(bindingCss, /\.node-route-controls \.f-in \{[^}]*min-width: 0/s)
})

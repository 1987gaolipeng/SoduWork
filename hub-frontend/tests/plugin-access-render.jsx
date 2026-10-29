// Real production component and real isolated API; no business accounts or data.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import PluginAccessPolicy from '../src/screens/PluginAccessPolicy.jsx'
import { api } from '../src/api.js'
import '../src/styles.css'
import '../src/design-system.css'
import '../src/admin-controls.css'
import '../src/filter-controls.css'
import '../src/accessibility.css'

const origin = 'http://127.0.0.1:9096/api/v1'
async function request(method, path, body) {
  const response = await fetch(origin + path, { method, headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer isolated-fixture-only',
  }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  if (!response.ok) throw new Error(value.detail || `HTTP ${response.status}`)
  return value
}
api.pluginAccessPolicy = id => request('GET', `/admin/plugins/${id}/access-policy`)
api.pluginAccessCandidates = id => request('GET', `/admin/plugins/${id}/access-candidates`)
api.updatePluginAccessPolicy = (id, body) => request('PATCH', `/admin/plugins/${id}/access-policy`, body)

function App() {
  const [permissions, setPermissions] = useState(null)
  const [draft, setDraft] = useState('')
  return <main style={{ maxWidth: 1000, margin: '32px auto', padding: 16 }}>
    <h1 style={{ fontSize: 23 }}>插件权限</h1><p style={{ color: 'var(--ink-3)', marginTop: 8 }}>隔离测试 · 临时数据，不修改业务插件</p>
    <PluginAccessPolicy pluginId="permission-plugin" />
    <section style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }} aria-label="员工视角验证">
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>员工视角验证</h2>
      <button className="btn btn-ghost" onClick={async () => setPermissions(await request('GET', '/plugins/permission-plugin/permissions'))}>核对员工权限</button>
      <button className="btn btn-ghost" onClick={async () => {
        try { const value = await request('GET', '/plugins/permission-plugin/draft'); setDraft(value.draft?.sourcePluginId === 'permission-plugin' ? '草稿读取成功' : '草稿格式异常') }
        catch (error) { setDraft(error.message) }
      }}>读取编辑草稿</button>
      {permissions && <p role="status" style={{ marginTop: 12 }}>使用：{permissions.canUse ? '允许' : '禁止'} · 编辑改进：{permissions.canEdit ? '允许' : '禁止'}</p>}
      {draft && <p role="status" style={{ marginTop: 12 }}>{draft}</p>}
    </section>
  </main>
}
const root = import.meta.hot?.data.root || createRoot(document.getElementById('root'))
if (import.meta.hot) import.meta.hot.data.root = root
root.render(<App />)

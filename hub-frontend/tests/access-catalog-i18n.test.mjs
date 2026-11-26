import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createComponentHarness } from './helpers/react-harness.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { messages } from '../src/locales/messages.js'
import { messagesByLocale } from '../src/locales/extra-languages.js'
import { getLocale, setLocale, translateText as tx } from '../src/i18n.js'

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hub-backend')
const read = (...parts) => fs.readFileSync(path.join(backend, ...parts), 'utf8')

// The admin UI renders these backend catalogs verbatim after a translateText pass. If the backend
// adds or renames an entry, this lock fails until en/ja/ko dictionary entries exist.
const permissionSource = read('app', 'permissions.py')
const permissionLabels = [...permissionSource.matchAll(/"label": "([^"]+)"/g)].map(m => m[1])
const permissionDescriptions = [...permissionSource.matchAll(/"description": "([^"]+)"/g)].map(m => m[1])
const permissionGroups = [...permissionSource.matchAll(/"group": "([^"]+)"/g)].map(m => m[1])

const workCatalogSource = read('app', 'services', 'work_catalog.py')
const profileBlock = workCatalogSource.slice(
  workCatalogSource.indexOf('PROFILE_DEFINITIONS = ['),
  workCatalogSource.indexOf('SCENARIO_DEFINITIONS = ['),
)
const profileNames = [...profileBlock.matchAll(/"name": "([^"]+)"/g)].map(m => m[1])

const rbacSource = read('app', 'services', 'rbac.py')
const domainBlock = rbacSource.slice(rbacSource.indexOf('SEED_DOMAINS = ['), rbacSource.indexOf('async def seed_domains'))
const domainNames = [...domainBlock.matchAll(/\("([^"]+)", \d+\)/g)].map(m => m[1])

const catalogStrings = [...new Set([...permissionLabels, ...permissionDescriptions, ...permissionGroups, ...profileNames, ...domainNames])]

test('every backend catalog label carries en, ja and ko entries', () => {
  assert.ok(catalogStrings.length >= 45, `catalog extraction broke: ${catalogStrings.length} entries`)
  const missing = []
  for (const label of catalogStrings) {
    if (!messages[label]) missing.push(`en: ${label}`)
    if (!messagesByLocale['ja-JP'][label]) missing.push(`ja: ${label}`)
    if (!messagesByLocale['ko-KR'][label]) missing.push(`ko: ${label}`)
  }
  assert.deepEqual(missing, [])
})

test('catalog labels resolve per locale and unknown business names stay verbatim', () => {
  assert.equal(messages['综合办公'], 'General office')
  setLocale('en-US')
  for (const label of catalogStrings) assert.notEqual(tx(label), label, `missing en entry for ${label}`)
  setLocale('ja-JP')
  assert.equal(tx('管理角色权限'), 'ロール権限の管理')
  assert.equal(tx('交付运维'), '納品・運用')
  setLocale('ko-KR')
  assert.equal(tx('管理角色权限'), '역할 권한 관리')
  assert.equal(tx('交付运维'), '전달 운영')
  // Catalog translation is display-only: administrator-created entries never match.
  assert.equal(tx('客户自研平台'), '客户自研平台')
  setLocale('zh-CN')
  assert.equal(getLocale(), 'zh-CN')
})

test('built-in permissions are read-only, expandable and described; custom roles remain editable', async () => {
  const catalog = Array.from({ length: 8 }, (_, i) => ({
    key: 'p' + i, label: 'Permission ' + i, description: 'Description ' + i, risk: 'high', group: 'Group',
  }))
  const role = { name: 'Built-in', isSystem: true, permissions: catalog.map(p => p.key) }
  const mount = (name, currentRole) => createComponentHarness(new URL('../src/screens/Roles.jsx', import.meta.url), {
    exportName: name, privateExports: [name], props: { role: currentRole, catalog },
    dependencies: { '../api.js': {}, '../ui.jsx': { Modal: 'section', Icon: 'i' },
      './admin-access-pages.css': {}, './role-card-actions.css': {} },
  })
  const preview = await mount('RolePermissions', role)
  const toggle = () => preview.nodes(node => node.type === 'button')[0]
  assert.equal(toggle().props['aria-expanded'], false)
  assert.doesNotMatch(renderToStaticMarkup(preview.render()), /Permission 7/)
  preview.act(toggle().props.onClick)
  assert.equal(toggle().props['aria-expanded'], true)
  assert.match(renderToStaticMarkup(preview.render()), /Description 7/)
  const builtin = await mount('RoleEditor', role)
  assert.equal(builtin.nodes(node => node.type === 'input').length, 0)
  assert.doesNotMatch(renderToStaticMarkup(builtin.render().props.foot), /保存/)
  const custom = await mount('RoleEditor', { ...role, isSystem: false })
  assert.equal(custom.nodes(node => node.props.type === 'checkbox').length, 8)
  assert.match(renderToStaticMarkup(custom.render().props.foot), /保存/)
})

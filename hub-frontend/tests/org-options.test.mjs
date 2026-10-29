import test from 'node:test'
import assert from 'node:assert/strict'
import { orgOptions, matchesOption } from '../src/org-options.js'

const orgs = [
  { id: 'root', name: '研发中心' },
  { id: 'platform', name: '平台组', parentId: 'root' },
  { id: 'deep', name: 'API Team', parentId: 'platform' },
  { id: 'sales', name: '销售中心' },
  { id: 'other', name: '平台组', parentId: 'sales' },
]
test('department options preserve depth and disambiguate duplicate names with full paths', () => {
  const options = orgOptions(orgs)
  assert.deepEqual(options.map(option => option.id), ['root', 'platform', 'deep', 'sales', 'other'])
  assert.equal(options[2].label, '　　API Team')
  assert.equal(options[2].path, '研发中心 / 平台组 / API Team')
  assert.notEqual(options[1].path, options[4].path)
})
test('parent choices exclude the edited department and every descendant', () => {
  assert.deepEqual(orgOptions(orgs, 'platform').map(option => option.id), ['root', 'sales', 'other'])
  assert.deepEqual(orgOptions(orgs, 'root').map(option => option.id), ['sales', 'other'])
})
test('search accepts partial names, ancestor keywords, whitespace and mixed case', () => {
  const path = orgOptions(orgs)[2].path
  for (const query of ['', '平台', '  研发 api ', 'ＡＰＩ', 'tEaM']) assert.ok(matchesOption(path, query), query)
  assert.equal(matchesOption(path, '销售'), false)
})
test('visible partial organization scope retains its root and cycles cannot recurse forever', () => {
  assert.equal(orgOptions([{ id: 'a', name: '可见部门', parentId: 'hidden' }])[0].path, '可见部门')
  assert.deepEqual(orgOptions([{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }]), [])
})

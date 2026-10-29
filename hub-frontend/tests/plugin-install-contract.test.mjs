import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'

const textOf = (node) => Array.isArray(node) ? node.map(textOf).join('')
  : React.isValidElement(node) ? textOf(node.props.children)
    : typeof node === 'string' || typeof node === 'number' ? String(node) : ''
const file = new URL('../src/screens/PluginInstallContract.jsx', import.meta.url)
const make = (version) => createComponentHarness(file, { props: { version } })
const fixture = () => ({
  id: 'version-immutable-1', version: '1.3.0', manifest: { setup: {
    title: '企业自定义偏好', description: '发布者提供的说明，不应被翻译。',
    preferences: [
      { key: 'language', label: '语言', type: 'select', required: true, default: 'zh-CN',
        options: [{ value: 'zh-CN', label: '中文' }, { value: 'en-US', label: 'English' }] },
      { key: 'enabled', label: '启用通知', type: 'boolean', default: false },
      { key: 'retries', label: '重试次数', type: 'number', default: 0, minimum: 0, maximum: 3 },
      { key: 'name', label: '显示名称', type: 'text', default: '', minLength: 0, maxLength: 80, placeholder: '团队名字' },
      { key: 'notes', label: '说明', type: 'textarea', default: 'first line\nsecond line', group: '团队设置' },
      { key: 'formats', label: '格式', type: 'multiselect', default: ['md', 'pdf'],
        options: [{ value: 'md', label: 'Markdown' }, { value: 'pdf', label: 'PDF' }] },
      { key: 'homepage', label: '主页', type: 'url', description: '公开主页链接' },
    ],
  } },
})

test('review shows every declared preference, constraints and falsy defaults without editable controls', async () => {
  setLocale('zh-CN')
  const version = fixture(), before = JSON.stringify(version), host = await make(version)
  const text = textOf(host.render())
  assert.equal(host.nodes((node) => node.type === 'li').length, 7)
  for (const value of ['安装设置清单', 'v1.3.0', '文本', '多行文本', '开关', '数字', '单选', '多选', '网址',
    '必填', '可选', '否', '空文本', '未设置', '最小值：0', '最大值：3', '最少字符：0', '最多字符：80',
    '中文 (zh-CN)', 'English (en-US)', 'Markdown (md)', 'PDF (pdf)', 'first line\nsecond line',
    '团队名字', '团队设置', '公开主页链接', '账号、密钥与 OAuth 授权由连接器单独管理']) assert.ok(text.includes(value), value)
  const retries = host.nodes((node) => node.type === 'li').find((node) => textOf(node).includes('retries'))
  assert.match(textOf(retries), /默认值0/)
  assert.equal(host.nodes((node) => ['input', 'textarea', 'select', 'button', 'form', 'a'].includes(node.type)).length, 0)
  assert.equal(host.nodes((node) => Object.keys(node.props).some((key) => /^on[A-Z]/.test(key) || key === 'dangerouslySetInnerHTML')).length, 0)
  assert.equal(JSON.stringify(version), before)
  host.unmount()
})

test('changing selected versions replaces the frozen contract; switching locale never translates publisher content', async () => {
  const version = fixture(), host = await make(version)
  setLocale('en-US')
  let text = textOf(host.render({ version }))
  for (const value of ['Installation settings', 'Single choice', 'Required', 'Optional', 'No', 'Minimum: 0',
    'Empty text', '企业自定义偏好', '发布者提供的说明，不应被翻译。', '语言', '中文 (zh-CN)', '团队设置']) assert.ok(text.includes(value), value)
  assert.ok(!text.includes('安装设置清单'))
  setLocale('zh-CN')
  text = textOf(host.render({ version }))
  assert.ok(text.includes('安装设置清单') && text.includes('取值限制'))
  const next = { id: 'version-2', version: '2.0.0', manifest: { setup: { preferences: [{ key: 'next', label: '下一版', type: 'boolean', default: true }] } } }
  text = textOf(host.render({ version: next }))
  assert.ok(text.includes('v2.0.0') && text.includes('下一版') && text.includes('默认值是'))
  assert.ok(!text.includes('retries') && !text.includes('企业自定义偏好'))
  assert.equal(host.nodes((node) => node.type === 'li').length, 1)
  host.unmount()
})

test('missing setup has an explicit empty state; unsupported or sensitive declarations never expose values', async () => {
  setLocale('zh-CN')
  const host = await make({ version: '0.1.0' })
  assert.ok(textOf(host.render()).includes('此版本未声明安装偏好。'))
  let text = textOf(host.render({ version: { manifest: { setup: { preferences: [
    null, { key: 'unsupported', type: 'secret', default: 'do-not-display-secret' },
    { key: 'sensitive', type: 'text', sensitive: true, default: 'do-not-display-personal' },
    { key: 'empty', type: 'multiselect', default: [] },
  ] } } } }))
  assert.ok(text.includes('不支持的字段类型'))
  assert.ok(text.includes('无选项'))
  assert.ok(!text.includes('do-not-display'))
  assert.equal(host.nodes((node) => node.type === 'li').length, 3)
  setLocale('en-US')
  text = textOf(host.render({ version: {} }))
  assert.ok(text.includes('This version declares no installation preferences.'))
  host.unmount()
  setLocale('zh-CN')
})

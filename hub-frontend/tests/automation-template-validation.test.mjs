import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale } from '../src/i18n.js'
const dependencies = {
  '../api.js': { api: {} },
  '../ui.jsx': { Modal: () => null, Confirm: () => null, Icon: () => null, Loading: () => null, SelectMenu: () => null, toast() {} },
  '../components/LocalesEditor.jsx': () => null, './automation-templates.css': {},
}
const valid = { id: 'daily-report', name: '日报', every: 'daily', note: 'Summarize', enabled: true, requiredCapabilities: [] }
const cases = [
  [{ id: '' }, 'id', /填写模板标识/], [{ id: 'a' }, 'id', /2–64/],
  [{ id: 'a'.repeat(65) }, 'id', /2–64/], [{ id: 'Daily-Report' }, 'id', /小写/],
  [{ id: ' daily-report' }, 'id', /空格/], [{ id: 'daily-report\n' }, 'id', /空格/],
  [{ id: '_daily' }, 'id', /开头/], [{ id: '每日' }, 'id', /小写/],
  [{ id: 'daily/report' }, 'id', /仅支持/], [{ id: 'daily report' }, 'id', /空格/],
  [{ name: ' 　' }, 'name', /不能全为空白/], [{ name: '' }, 'name', /填写/],
  [{ name: '报'.repeat(81) }, 'name', /80/], [{ name: '日报\n总结' }, 'name', /控制字符/],
  [{ name: '日报\u0000' }, 'name', /控制字符/],
]

test('date validation rejects malformed, impossible and reversed dates', async () => {
  setLocale('zh-CN')
  for (const changes of [{ startDate: '2030-02-29' }, { endDate: '2030-13-01' }, { startDate: '0000-01-01' },
    { startDate: true }, { endDate: ['2030-01-01'] }, { startDate: '2030-2-01' },
    { startDate: '2030-12-31', endDate: '2030-01-01' }]) {
    const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
      exportName: 'templateErrors', privateExports: ['templateErrors'], dependencies, props: { ...valid, ...changes },
    })
    try { assert.ok(page.render().startDate || page.render().endDate) } finally { page.unmount() }
  }
  for (const dates of [{}, { startDate: null, endDate: '' }, { startDate: '2032-02-29' }, { endDate: '2030-12-31' },
    { startDate: '2030-12-31', endDate: '2030-12-31' }]) {
    const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
      exportName: 'templateErrors', privateExports: ['templateErrors'], dependencies, props: { ...valid, ...dates },
    })
    try { assert.deepEqual(page.render(), {}) } finally { page.unmount() }
  }
})

test('date editor defaults to unlimited, validates ranges and clears limits explicitly', async () => {
  setLocale('zh-CN')
  let saves = 0, page
  let props = { value: { ...valid }, onChange(value) { props = { ...props, value }; page.render(props) },
    onCancel() {}, onSave() { saves++ } }
  page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
    exportName: 'Editor', privateExports: ['Editor'], dependencies, props,
  })
  const input = name => page.nodes(n => n.type === 'input' && n.props.name === name)[0]
  const submit = () => page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
  const set = (name, value) => page.act(() => input(name).props.onChange({ target: { value } }))
  try {
    assert.equal(input('unlimitedDates').props.checked, true)
    assert.equal(input('startDate').props.disabled, true)
    submit(); assert.equal(saves, 1)
    page.act(() => input('unlimitedDates').props.onChange({ target: { checked: false } }))
    submit(); assert.equal(saves, 1)
    assert.equal(input('startDate').props['aria-invalid'], true)
    set('startDate', '2030-12-01')
    submit(); assert.equal(saves, 2, 'start-only boundary is valid')
    set('endDate', '2030-11-30')
    submit(); assert.equal(saves, 2)
    assert.equal(input('endDate').props['aria-invalid'], true)
    set('endDate', '2030-12-31')
    submit(); assert.equal(saves, 3)
    page.act(() => input('unlimitedDates').props.onChange({ target: { checked: true } }))
    assert.equal(props.value.startDate, '')
    assert.equal(props.value.endDate, '')
    submit(); assert.equal(saves, 4)
  } finally { page.unmount() }
})

test('existing template dates are editable and keep date inputs enabled', async () => {
  const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
    exportName: 'Editor', privateExports: ['Editor'], dependencies,
    props: { value: { ...valid, updatedAt: '2030-01-01', endDate: '2030-12-31' }, onChange() {}, onCancel() {}, onSave() {} },
  })
  try {
    assert.equal(page.nodes(n => n.props.name === 'unlimitedDates')[0].props.checked, false)
    assert.equal(page.nodes(n => n.props.name === 'endDate')[0].props.disabled, false)
    assert.equal(page.nodes(n => n.props.name === 'endDate')[0].props.value, '2030-12-31')
  } finally { page.unmount() }
})

test('invalid identities show field errors and cannot submit, while correction clears feedback', async t => {
  setLocale('zh-CN')
  for (const [changes, field, expected] of cases) {
    const calls = []
    let props = { value: { ...valid, ...changes }, onChange() {}, onCancel() {}, onSave: () => calls.push('save') }
    const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
      exportName: 'Editor', privateExports: ['Editor'], dependencies, props,
    })
    try {
      assert.equal(page.nodes(n => n.props.className === 'at-field-error').length, 0, 'initial empty form is not covered in errors')
      page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
      assert.equal(calls.length, 0)
      assert.equal(page.nodes(n => n.type === 'input' && n.props.name === field)[0].props['aria-invalid'], true)
      assert.match(page.nodes(n => n.props.className === 'at-field-error')[0].props.children, expected)
      props = { ...props, value: valid }; page.render(props)
      assert.equal(page.nodes(n => n.props.className === 'at-field-error').length, 0)
      page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
      assert.deepEqual(calls, ['save'])
    } finally { page.unmount() }
  }
})

test('creation rejects existing IDs including disabled templates, but editing itself is valid', async () => {
  setLocale('zh-CN')
  const calls = []
  const props = { value: valid, items: [{ ...valid, enabled: false }], onChange() {}, onCancel() {}, onSave: () => calls.push('save') }
  const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
    exportName: 'Editor', privateExports: ['Editor'], dependencies, props,
  })
  try {
    page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
    assert.equal(calls.length, 0)
    assert.match(page.nodes(n => n.props.className === 'at-field-error')[0].props.children, /已存在/)
    page.render({ ...props, value: { ...valid, updatedAt: '2026-11-02' } })
    page.act(() => page.nodes(n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }))
    assert.deepEqual(calls, ['save'])
    assert.equal(page.nodes(n => n.props.name === 'id')[0].props.disabled, true)
  } finally { page.unmount() }
})

test('boundaries and multilingual names remain valid without silent rewriting', async () => {
  for (const value of [{ ...valid, id: 'a1', name: '报' }, { ...valid, id: 'a'.repeat(64), name: '报'.repeat(80) },
    { ...valid, id: '1.a_b-c', name: ' Weekly 日報 주간 / Review（2026） 📊 ' }, { ...valid, name: '📊'.repeat(80) }]) {
    const page = await createComponentHarness(new URL('../src/screens/AutomationTemplates.jsx', import.meta.url), {
      exportName: 'templateErrors', privateExports: ['templateErrors'], dependencies, props: value,
    })
    assert.deepEqual(page.render(), {}); page.unmount()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import * as appearance from '../src/client-appearance.js'

test('execution network opens employee devices on every visit, regardless of the previous tab', async (t) => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const saved = new Map([['soduwork-execution-tab', 'runners']])
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
  } })
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'sessionStorage', previousStorage)
    else delete globalThis.sessionStorage
  })
  const mount = () => createComponentHarness(new URL('../src/screens/Clients.jsx', import.meta.url), {
    dependencies: {
      '../client-appearance.js': appearance,
      '../api.js': { api: {}, can: () => true },
      '../FilterControls.jsx': { FilterInput: 'FilterInput', FilterSelect: 'FilterSelect' },
      '../ListPager.jsx': 'ListPager',
      '../ui.jsx': { Icon: 'Icon' },
      './RunnerBoard.jsx': 'RunnerBoard',
      './ClientAccessPolicy.jsx': 'ClientAccessPolicy',
      './MailSettings.jsx': 'MailSettings',
      './client-updates.css': {}, './execution-network.css': {},
    },
  })
  const tabs = page => page.nodes(node => node.props.role === 'tab')
  for (const alternate of [1, 2]) {
    const page = await mount()
    t.after(() => page.unmount())
    assert.equal(tabs(page)[0].props['aria-selected'], true, 'the first tab is selected on entry')
    page.act(() => tabs(page)[alternate].props.onClick())
    assert.equal(tabs(page)[alternate].props['aria-selected'], true, 'manual tab switching still works')
    page.render({})
    assert.equal(tabs(page)[alternate].props['aria-selected'], true, 'normal rerenders keep the current tab')
    page.unmount()

    // Simulate a fresh visit/refresh, including values left by an older version.
    saved.set('soduwork-execution-tab', alternate === 1 ? 'runners' : 'access')
    const reopened = await mount()
    t.after(() => reopened.unmount())
    assert.equal(tabs(reopened)[0].props['aria-selected'], true, 'reopening returns to employee devices')
    reopened.unmount()
  }
})

test('runner installation OS dropdown selects the matching generated command', async (t) => {
  const page = await createComponentHarness(new URL('../src/screens/RunnerBoard.jsx', import.meta.url), {
    exportName: 'EnrollPanel', privateExports: ['EnrollPanel'],
    props: { organizations: [{ id: 'fixture-org', name: 'Fixture organization' }], onClose() {} },
    dependencies: {
      '../api.js': { api: { enrollRunner: async () => ({ runnerId: 'fixture-runner', key: 'fixture-key', commands: { windows: 'windows-fixture-command', linux: 'linux-fixture-command' }, tags: [] }) } },
      '../ui.jsx': { Icon: 'Icon', SelectMenu: 'SelectMenu', toast() {} },
      '../FilterControls.jsx': { FilterInput: 'FilterInput', FilterSelect: 'FilterSelect' },
      '../ListPager.jsx': 'ListPager', './runner-board.css': {},
      './CloudRunnerManagement.jsx': 'CloudRunnerManagement',
    },
  })
  t.after(() => page.unmount())
  await page.nodes(node => node.type === 'button' && node.props.className === 'btn btn-primary')[0].props.onClick()
  await page.flush()
  const command = () => page.nodes(node => node.type === 'code').map(node => node.props.children)
  assert.ok(command().includes('windows-fixture-command'))
  const osSelect = () => page.nodes(node => node.type === 'SelectMenu' && ['windows', 'linux'].includes(node.props.value))[0]
  page.act(() => osSelect().props.onChange({ target: { value: 'linux' } }))
  assert.ok(command().includes('linux-fixture-command'))
  page.act(() => osSelect().props.onChange({ target: { value: 'windows' } }))
  assert.ok(command().includes('windows-fixture-command'))
})

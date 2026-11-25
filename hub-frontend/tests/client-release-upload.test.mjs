import assert from 'node:assert/strict'
import test from 'node:test'
import { createComponentHarness } from './helpers/react-harness.mjs'
import { setLocale, translateText } from '../src/i18n.js'

async function dialog(t, upload) {
  const messages = [], completed = []
  const page = await createComponentHarness(new URL('../src/screens/ClientReleases.jsx', import.meta.url), {
    exportName: 'UploadModal', privateExports: ['UploadModal'],
    props: { onClose() {}, onDone: () => completed.push(true) },
    dependencies: { '../api.js': { api: { uploadClientRelease: upload } },
      '../ui.jsx': { Modal: 'Modal', toast: message => messages.push(message) }, './client-releases.css': {} },
  })
  t.after(() => page.unmount())
  const submit = () => page.nodes(node => node.props.className === 'btn btn-primary', page.render().props.foot)[0].props.onClick()
  const choose = file => {
    const inputs = page.nodes(node => node.type === 'input' && node.props.type === 'file')
    assert.equal(inputs.length, 1, 'no separate manifest input')
    inputs[0].ref.current = { files: [file] }
    page.act(() => inputs[0].props.onChange({ target: { files: [file] } }))
  }
  return { page, submit, choose, messages, completed }
}

test('one installer is enough; transfer completion waits for server registration', async t => {
  setLocale('en-US'); t.after(() => setLocale('zh-CN'))
  let finish, options
  const installer = { name: 'SoduWork-9.8.7-Setup.exe' }
  const fixture = await dialog(t, (file, selected) => {
    assert.equal(file, installer); options = selected
    return new Promise(resolve => { finish = resolve })
  })
  fixture.choose(installer)
  fixture.page.act(() => fixture.page.nodes(node => node.type === 'select')[0].props.onChange({ target: { value: 'beta' } }))
  const pending = fixture.submit()
  assert.equal(options.channel, 'beta')
  options.onProgress(100, 100, true); fixture.page.render()
  assert.equal(fixture.completed.length, 0)
  assert.ok(fixture.page.nodes(node => node.type === 'span' && String(node.props.children).includes('inspecting, signing and registering')).length)
  finish({ created: true, release: { version: '9.8.7', platform: 'win32', arch: 'x64', enabled: false } })
  await pending
  assert.equal(fixture.completed.length, 1)
  assert.ok(fixture.messages[0].includes('9.8.7'))
})

test('failure retains the selected installer for retry and duplicates preserve release state', async t => {
  setLocale('en-US'); t.after(() => setLocale('zh-CN'))
  let calls = 0
  const fixture = await dialog(t, async () => {
    if (++calls === 1) throw Error('Signing configuration is unavailable')
    return { created: false, release: { version: '9.8.7', enabled: true } }
  })
  fixture.choose({ name: 'SoduWork-9.8.7-Setup.exe' })
  await fixture.submit()
  assert.equal(fixture.completed.length, 0)
  assert.equal(fixture.page.nodes(node => node.props.className === 'cr-upload-error')[0].props.children, 'Signing configuration is unavailable')
  assert.equal(fixture.page.nodes(node => node.props.className === 'cr-file-name')[0].props.children, 'SoduWork-9.8.7-Setup.exe')
  await fixture.submit()
  assert.equal(fixture.completed.length, 1)
  assert.equal(fixture.messages[0], 'This installer is already registered. Its release state is unchanged.')
})

test('upload guidance and processing state are translated in all admin languages', () => {
  try {
    for (const locale of ['en-US', 'ja-JP', 'ko-KR']) {
      setLocale(locale)
      for (const source of ['发布通道', '使用当前环境默认通道', '该安装包已登记，保留原有发布状态。',
        '文件已传输，后台正在解析、签名并登记…']) assert.notEqual(translateText(source), source)
    }
  } finally { setLocale('zh-CN') }
})

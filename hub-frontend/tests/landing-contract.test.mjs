import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/*
 * Protect the prelogin page's client-download and administrator-entry actions and their
 * live data bindings.
 */
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const jsx = fs.readFileSync(path.join(root, 'src', 'Landing.jsx'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src', 'landing.css'), 'utf8')

test('两个入口都在：下载走真实端点，进后台走 onLogin 回调', () => {
  assert.match(jsx, /\/api\/v1\/download\/client\b/, '下载必须指向真实下载端点')
  assert.match(jsx, /onLogin/, '进入后台必须调用 onLogin（App 据此切到登录页）')
  const logins = jsx.match(/onClick=\{onLogin\}|onClick=\{\(\) => onLogin\(\)\}/g) || []
  assert.ok(logins.length >= 2, '「进入管理后台」至少要在首屏与页尾各出现一次')
})

test('安装包信息取自服务端事实，且不可用时有体面空态', () => {
  assert.match(jsx, /\/api\/v1\/download\/client\/info/, '包大小/更新时间必须来自服务端')
  assert.match(jsx, /sizeText/, '要展示真实包体积')
  assert.match(jsx, /available/, '要按 available 决定按钮是否可点')
  /* Explain unavailable installers instead of leaving an inert download action. */
  assert.match(jsx, /正在发布中|尚未发布|暂未发布|联系[^，。]*管理员/, '安装包缺席时要说人话')
})

test('版本号来自 /healthz 的部署事实，不是写死的字符串', () => {
  assert.match(jsx, /\/healthz/)
  assert.match(jsx, /commit/)
})

test('页面使用本地资源，支持离线加载', () => {
  /*
   * Inspect actual network-request references rather than illustrative URL text in artwork.
   */
  const fetches = /(?:src|href)=["']https?:\/\/|url\(\s*["']?https?:\/\//gi
  for (const source of [jsx, css]) {
    const hits = (source.match(fetches) || [])
      .filter((hit) => !/w3\.org|schema\.org/.test(hit))   // SVG/XML namespace declarations do not initiate requests.
    assert.deepEqual(hits, [], '页面资源应支持离线加载：' + hits.join('、'))
  }
  assert.doesNotMatch(css, /@import\s+url\(/, '外部字体/样式表在内网取不到')
})

test('hover 不改变元素自身盒子（本项目的边缘闪烁老坑）', () => {
  /* Permit hover color, shadow, and transform changes without changing layout dimensions. */
  const hoverBlocks = css.match(/[^}]*:hover[^{]*\{[^}]*\}/g) || []
  const offenders = hoverBlocks.filter((block) =>
    /(?:^|[;{\s])(width|height|padding|margin|border-width|font-size)\s*:/.test(
      block.slice(block.indexOf('{'))))
  assert.deepEqual(offenders.map((x) => x.split('{')[0].trim()), [],
    'hover 改动自身盒子会让边缘反复重排闪烁')
})

const assert = require('node:assert/strict')

// Render the actual organization screen with nested, local-only departments.
// Pointer input must reach a usable text field; calling onChange alone would
// miss the regression where a CSS flex basis compressed the input to zero.
async function checkOrgTreeSearch({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results }) {
  const previous = fixtures['/admin/orgs']
  fixtures['/admin/orgs'] = [
    { id: 'fixture-org', name: 'Fixture organization', parentId: null },
    { id: 'research', name: '研发中心', parentId: 'fixture-org' },
    { id: 'platform', name: '平台组', parentId: 'research' },
    { id: 'quality', name: '质量组', parentId: 'research' },
    { id: 'finance', name: '财务部', parentId: 'fixture-org' },
    { id: 'regional', name: 'Regional Office', parentId: null },
    { id: 'remote', name: 'Remote Team', parentId: 'regional' },
  ]
  const record = (name, ok, evidence) => {
    results.push({ name, ok, evidence })
    assert.ok(ok, name + ': ' + JSON.stringify(evidence))
  }
  const names = () => js(`[...document.querySelectorAll('.og-tree-name')].map(e=>e.textContent)`)
  const type = async value => {
    const point = await js(`(() => {const e=document.querySelector('.og-search input'),r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await sleep(100)
    const focus = await js(`(() => {
      const input=document.querySelector('.og-search input'), hit=document.elementFromPoint(${point.x},${point.y});
      return {focused:document.activeElement===input,hit:hit?.outerHTML,active:document.activeElement?.tagName,documentFocused:document.hasFocus(),point:${JSON.stringify(point)},height:innerHeight,scrollY};
    })()`)
    record('organization search accepts pointer focus', focus.focused, focus)
    await js(`document.querySelector('.og-search input').select()`)
    await win.webContents.insertText(value)
    await waitFor(`document.querySelector('.og-search input').value === ${JSON.stringify(value)}`, 'organization query entered')
  }
  try {
    await win.loadURL(origin + '/?screen=orgs')
    await waitFor('document.querySelectorAll(".og-tree-name").length === 7', 'nested organization fixtures')
    await changeLocale('zh-CN')
    for (const size of [[1366,768], [1920,1080], [1280,720], [760,900], [390,844], [320,640]]) {
      win.setSize(...size); await sleep(180)
      const box = await js(`(() => {
        const e=document.querySelector('.og-search'), i=e.querySelector('input'), t=document.querySelector('.og-tree-tools');
        const r=e.getBoundingClientRect(), input=i.getBoundingClientRect(), tools=t.getBoundingClientRect();
        return {width:r.width,inputWidth:input.width,height:r.height,right:r.right,toolsLeft:tools.left,toolsRight:tools.right,viewport:innerWidth};
      })()`)
      await screenshot('org-search-width-' + size[0])
      record('organization search remains usable at ' + size.join('×'), box.inputWidth>=100 && box.right<=box.toolsLeft && box.toolsRight<=box.viewport, box)
    }
    win.setSize(1366,768); await sleep(150)
    await js(`document.querySelector('.og-tree-tools button:first-child').click()`)
    record('organization tree can collapse before search', (await names()).length===2)
    await type('平台')
    await waitFor('document.querySelectorAll(".og-tree-name").length === 3', 'matched branch expands')
    const matched = await names()
    record('organization search retains only match and ancestor path', matched.join('|')==='Fixture organization|研发中心|平台组', matched)
    await js(`[...document.querySelectorAll('.og-tree-row')].find(e=>e.querySelector('.og-tree-name').textContent==='平台组').click()`)
    record('organization search result opens the matching details', await js('document.querySelector(".og-title-row h2").textContent === "平台组"'))
    await screenshot('org-search-matched')
    await type('不存在的部门')
    await waitFor('!!document.querySelector(".og-tree-empty")', 'organization no matches')
    record('organization search shows explicit empty state', (await names()).length===0 && await js('document.querySelector(".og-tree-empty").innerText.includes("没有匹配的部门")'))
    await js(`document.querySelector('.og-search .filter-clear').click()`)
    record('clearing organization search restores collapsed state and focus', (await names()).length===2 && await js('document.querySelector(".og-search input").value === "" && document.activeElement === document.querySelector(".og-search input")'))
    await js(`document.querySelector('.og-tree-tools button:last-child').click()`)
    record('organization tree can expand after clearing search', (await names()).length===7)
    await type('  rEmOtE  ')
    const remote = await names()
    record('organization search ignores surrounding whitespace and case', remote.join('|')==='Regional Office|Remote Team', remote)
    await changeLocale('en-US')
  } finally {
    fixtures['/admin/orgs'] = previous
  }
}

module.exports = { checkOrgTreeSearch }

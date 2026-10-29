const assert = require('node:assert/strict')

async function checkDepartmentSelect({ win, js: execute, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results }) {
  const js = async code => {
    try { return await execute(code) }
    catch (error) { throw new Error('Department check failed: ' + code, { cause: error }) }
  }
  const previous = fixtures['/admin/orgs']
  const previousUsers = fixtures['/admin/users']
  fixtures['/admin/users'] = [{ id: 'department-test-user', username: 'fixture', displayName: '部门选择测试用户', orgId: 'fixture-org', isActive: true, positions: [], domains: [] }]
  fixtures['/admin/orgs'] = [
    { id: 'fixture-org', name: '研发中心' },
    { id: 'platform', name: '平台组', parentId: 'fixture-org' },
    { id: 'api', name: 'API Team', parentId: 'platform' },
    { id: 'sales', name: '销售中心' },
    { id: 'duplicate', name: '平台组', parentId: 'sales' },
    ...Array.from({ length: 24 }, (_, i) => ({ id: `dept-${i}`, name: `区域事业群第 ${i + 1} 分公司产品研发与客户交付联合团队`, parentId: 'sales' })),
  ]
  const click = text => js(`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`)
  const key = async code => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code })
    if (code === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code })
    await sleep(80)
  }
  const search = async value => {
    await js(`document.querySelector('.modal input[role=combobox]').focus();document.querySelector('.modal input[role=combobox]').select()`)
    await win.webContents.insertText(value)
    await sleep(100)
  }
  const options = () => js(`[...document.querySelectorAll('.select-menu-searchable [role=option]')].map(e=>e.textContent.trim())`)
  const check = (name, ok, evidence) => { assert.ok(ok, name + ': ' + JSON.stringify(evidence)); results.push({ name, ok, evidence }) }
  try {
    await win.loadURL(origin + '/?screen=orgs')
    await waitFor('!!document.querySelector(".og-create-department")', 'department page')
    await changeLocale('zh-CN')
    for (const size of [[1366, 768], [760, 560], [390, 640], [320, 540]]) {
      win.setSize(...size); await sleep(100)
      await click('新建下属部门')
      await js(`document.querySelector('.org-editor .select-menu-trigger').click()`)
      await waitFor('!!document.querySelector(".select-menu-searchable:popover-open")', 'top layer department menu')
      const bounds = await js(`(() => {
        const p=document.querySelector('.select-menu-searchable'), r=p.getBoundingClientRect(), input=document.querySelector('.modal input[role=combobox]');
        const inputRect=input.getBoundingClientRect();
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,
          focus:document.activeElement===input,hit:input===document.elementFromPoint(inputRect.left+8,inputRect.top+8),popupHit:p.contains(document.elementFromPoint(r.left+12,r.top+12)),sameWidth:Math.abs(r.width-inputRect.width)<2,inlineSearch:!p.querySelector('input'),
          bodyScroll:document.querySelector('.modal-body').scrollTop};
      })()`)
      check('department popup remains visible and interactive at ' + size.join('x'), bounds.left>=0 && bounds.right<=bounds.width && bounds.top>=0 && bounds.bottom<=bounds.height && bounds.hit && bounds.popupHit && bounds.sameWidth && bounds.inlineSearch && bounds.focus, bounds)
      await search('  研发 api  ')
      const found = await options()
      check('department search matches ancestor and case-insensitive partial name at ' + size[0], found.length===1 && found[0].includes('研发中心 / 平台组 / API Team'), found)
      await screenshot('department-search-' + size[0])
      await key('Down'); await key('Return')
      const selection = await js(`({dialog:!!document.querySelector('.org-editor'), popup:!!document.querySelector('.select-menu-popover'), value:document.querySelector('.org-editor .select-menu-trigger')?.value, active:document.activeElement?.outerHTML})`)
      check('department keyboard selection preserves dialog at ' + size[0], selection.dialog && !selection.popup && selection.value.includes('API Team'), selection)
      await js(`document.querySelector('.org-editor .select-menu-trigger').click()`)
      await search('不存在')
      check('department search has empty feedback', await js(`!!document.querySelector('.select-menu-empty')`))
      await key('Escape')
      check('unselected search restores committed department', await js(`document.querySelector('.org-editor input[role=combobox]').value === 'API Team'`))
      check('first Escape closes only the department menu', await js(`!!document.querySelector('.org-editor') && !document.querySelector('.select-menu-popover')`))
      await click('取消')
    }
    win.setSize(1366, 768)
    await js(`document.querySelector('.og-detail-actions .admin-text-action').click()`)
    await waitFor('!!document.querySelector(".org-editor")', 'edit department dialog')
    await js(`document.querySelector('.org-editor .select-menu-trigger').click()`)
    const parents = await options()
    check('editing excludes current department and descendants', !parents.some(name=>/研发中心|API Team/.test(name)) && parents.filter(name=>name==='平台组').length===1, parents.slice(0,5))
    await key('Escape'); await click('取消')
    await win.loadURL(origin + '/?screen=users')
    await waitFor('!!document.querySelector(".admin-access-page")', 'users page')
    await click('新建用户')
    await waitFor('!!document.querySelector(".modal [role=combobox]")', 'new user department field')
    await js(`document.querySelector('.modal [role=combobox]').click()`)
    await search('平台')
    const duplicates = await options()
    check('user departments disambiguate duplicate names with paths', duplicates.length===3 && duplicates.some(name=>name.includes('销售中心 / 平台组')) && duplicates.some(name=>name.includes('研发中心 / 平台组')), duplicates)
    await screenshot('user-department-search')
    await key('Escape')
    await js(`document.querySelector('.modal [role=combobox]').click()`)
    await key('Tab')
    check('Tab closes popup and retains dialog focus', await js(`!document.querySelector('.select-menu-popover') && document.querySelector('.modal').contains(document.activeElement)`))
    await click('取消')
    await js(`document.querySelector('.admin-row-actions button').click()`)
    await waitFor('!!document.querySelector(".modal [role=combobox]")', 'edit user department field')
    await js(`document.querySelector('.modal [role=combobox]').click()`)
    await search('销售 平台')
    check('editing user shares searchable department choices', (await options()).length===1)
    await key('Escape'); await click('取消')
    await changeLocale('en-US')
  } finally { fixtures['/admin/orgs'] = previous; fixtures['/admin/users'] = previousUsers }
}

module.exports = { checkDepartmentSelect }

// Exercises the built admin UI against the parent harness's read-only fixtures.
// Resize the same renderer repeatedly to cover switching monitors, not just load.
async function checkAdminLayout({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, requests, results }) {
  const record = (name, ok, evidence) => results.push({ name, ok, evidence })
  const navigate = async (screen, selector) => {
    await win.loadURL(origin + '/?screen=' + screen)
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`, screen + ' fixture')
    await sleep(180)
  }
  const pagerStyle = () => js(`(() => {
    const b = document.querySelector('.list-pager button'), s = getComputedStyle(b);
    return [s.fontSize, s.fontFamily, s.padding, s.borderRadius, s.backgroundColor];
  })()`)
  const selectStyle = selector => js(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)}), s = getComputedStyle(e.querySelector(':scope > span') || e);
    return [s.fontSize, s.fontFamily, s.fontWeight, s.lineHeight, e.getBoundingClientRect().height];
  })()`)

  await navigate('projects', '.pg-ledger')
  const projectSelect = await selectStyle('.pg-index-filters .select-menu-trigger')
  record('project group tabs use a dropdown', await js('!document.querySelector(".pg-index-filters .admin-segmented")'))
  await js(`document.querySelector('.pg-index-filters .select-menu-trigger').click()`)
  await waitFor('!!document.querySelector(".pg-index-filters [role=option]")', 'project group options')
  await js(`[...document.querySelectorAll('.pg-index-filters [role=option]')].find(e=>e.textContent.trim()==='Group 1').click()`)
  await waitFor('document.querySelectorAll(".pg-project-row").length === 30', 'project group applies immediately')
  record('project group filters immediately', await js(`[...document.querySelectorAll('.pg-project-name > div > span')].every(e=>e.textContent==='Group 1')`))
  await js(`(() => {const e=document.querySelector('.pg-index-filters input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Project 117');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await waitFor('document.querySelectorAll(".pg-project-row").length === 1', 'search within group')
  record('project search combines with group selection', await js('document.querySelector(".pg-project-name b").textContent === "Project 117"'))
  await js(`document.querySelector('.pg-index-filters .filter-input .filter-clear').click()`)
  await waitFor('document.querySelectorAll(".pg-project-row").length === 30', 'search clear retains group')
  await js(`document.querySelector('.pg-index-filters .select-menu .filter-clear').click()`)
  await waitFor('document.querySelectorAll(".pg-project-row").length === 121', 'group clear restores all projects')
  record('project group clear restores all projects', await js('!document.querySelector(".pg-index-filters .select-menu.has-clear")'))
  const heights = []
  for (const size of [[1366, 768], [1920, 1080], [2560, 1440], [1280, 720], [390, 844]]) {
    win.setSize(...size); await sleep(220)
    const g = await js(`(() => {
      const e = document.querySelector('.pg-ledger'), r = e.getBoundingClientRect();
      e.scrollTop = 160;
      return { viewport: [innerWidth, innerHeight], bottom: r.bottom, height: r.height,
        listScroll: e.scrollHeight, listClient: e.clientHeight, scrollTop: e.scrollTop,
        documentHeight: document.documentElement.scrollHeight, documentWidth: document.documentElement.scrollWidth,
        headerVisible: !!e.querySelector('header').getClientRects().length,
        stickyTop: e.querySelector('header').getBoundingClientRect().top, listTop: r.top };
    })()`)
    heights.push(g.height)
    record('project list bounds after resize ' + size.join('×'),
      g.listScroll > g.listClient && g.scrollTop > 0 && g.bottom <= g.viewport[1] + 1 &&
      g.documentHeight <= g.viewport[1] + 1 && g.documentWidth <= g.viewport[0] + 1 &&
      (!g.headerVisible || Math.abs(g.stickyTop - g.listTop) <= 2), g)
    await js(`document.querySelector('.pg-index-filters .select-menu-trigger').click()`)
    const menu = await js(`(() => {const r=document.querySelector('.pg-index-filters .select-menu-popover').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight}})()`)
    record('project group dropdown fits ' + size[0], menu.left>=0 && menu.right<=menu.width && menu.top>=0 && menu.bottom<=menu.height, menu)
    await screenshot('projects-long-' + size[0])
    await js(`document.querySelector('.pg-index-filters .select-menu-trigger').click()`)
  }
  record('project list grows and shrinks on monitor changes', heights[2] > heights[0] && heights[3] < heights[2], heights)

  for (const size of [[1280, 900], [760, 900], [390, 640]]) {
    win.setSize(...size); await sleep(150)
    await js(`document.querySelector('.side-foot').click()`)
    const g = await js(`(() => {
      const p = document.querySelector('.profile-menu'), s = p.querySelector('.locale-language-select');
      const box = e => { const r = e.getBoundingClientRect(); return [r.left,r.top,r.right,r.bottom]; };
      return { viewport:[innerWidth,innerHeight], menu:box(p), select:box(s),
        topLanguage:!!document.querySelector('.top-actions .locale-settings') };
    })()`)
    record('user menu language fits ' + size.join('×'), !g.topLanguage &&
      [g.menu, g.select].every(r => r[0] >= 0 && r[1] >= 0 && r[2] <= g.viewport[0] && r[3] <= g.viewport[1]), g)
    await js(`document.querySelector('.profile-menu .locale-language-select .select-menu-trigger').focus()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'DOWN' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'DOWN' })
    await waitFor('!!document.querySelector(".profile-menu .select-menu-popover")', 'language dropdown keyboard open')
    const dropdown = await js(`(() => {
      const root=document.querySelector('.locale-language-select'), popup=root.querySelector('.select-menu-popover');
      const selected=root.querySelector('[aria-selected="true"]'), other=root.querySelector('[aria-selected="false"]');
      const p=popup.getBoundingClientRect(), m=document.querySelector('.profile-menu').getBoundingClientRect();
      return {fits:p.left>=m.left&&p.right<=m.right&&p.top>=m.top&&p.bottom<=m.bottom,
        font:getComputedStyle(root.querySelector('.select-menu-trigger')).fontSize,
        selected:getComputedStyle(selected).backgroundColor,other:getComputedStyle(other).backgroundColor,
        marker:getComputedStyle(selected,'::after').content, focused:document.activeElement===selected};
    })()`)
    // locale-settings.css uses the shared 14.5px readable control size.
    record('language options styled and unclipped ' + size[0], dropdown.fits && dropdown.font==='14.5px' &&
      dropdown.selected!==dropdown.other && dropdown.marker.includes('✓') && dropdown.focused, dropdown)
    await screenshot('user-language-menu-' + size[0])
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    await waitFor('!document.querySelector(".profile-menu .select-menu-popover")', 'language dropdown Escape')
    record('language Escape keeps user panel open ' + size[0], await js('!!document.querySelector(".profile-menu") && document.activeElement.matches(".locale-language-select .select-menu-trigger")'))
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    await waitFor('!document.querySelector(".profile-menu")', 'user menu Escape')
    record('user menu restores focus ' + size[0], await js('document.activeElement === document.querySelector(".side-foot")'))
  }
  win.setSize(1440, 900)
  await navigate('usage', '.ugc-filterbar .select-menu-trigger')
  const usageSelect = await selectStyle('.ugc-filterbar .select-menu-trigger')
  record('project group matches usage dropdown typography and height', JSON.stringify(projectSelect)===JSON.stringify(usageSelect), { projectSelect, usageSelect })
  await navigate('insights', '.oi-plugins .list-pager')
  const insightsSelect = await selectStyle('.oi-plugin-sort .select-menu-trigger')
  record('plugin sorting matches usage dropdown typography and height', JSON.stringify(usageSelect) === JSON.stringify(insightsSelect), { usageSelect, insightsSelect })
  const referencePager = await pagerStyle()
  await js(`document.querySelector('.oi-plugins .list-pager button:last-child').click()`)
  await waitFor('document.querySelector(".oi-plugins .list-pager").innerText.includes("2 / 3")', 'plugin second page')
  await js(`document.querySelector('.oi-plugin-sort .select-menu-trigger').click()`)
  await js(`document.querySelectorAll('.oi-plugin-sort [role="option"]')[1].click()`)
  await waitFor('!!document.querySelector(".oi-plugin-sort .filter-clear")', 'sort clear action')
  record('sorting immediately returns to page one', await js('document.querySelector(".oi-plugins .list-pager").innerText.includes("1 / 3")'))
  await js(`document.querySelector('.oi-plugin-sort .filter-clear').click()`)
  record('sort clear restores default', await js('!document.querySelector(".oi-plugin-sort .select-menu.has-clear")'))
  await changeLocale('zh-CN')
  await js(`document.querySelector('.oi-plugin-tools').scrollIntoView({block:'center'});document.querySelector('.oi-plugin-sort .select-menu-trigger').click()`)
  await screenshot('plugin-sort-zh')
  await js(`document.querySelector('.oi-plugin-sort .select-menu-trigger').click()`)
  await changeLocale('en-US')

  await navigate('clients', '.en-panel .list-pager')
  // DeviceFleet starts a 260 ms search debounce on mount; let it settle before
  // testing page navigation independently from search-reset behavior.
  await sleep(300)
  record('device pagination shares plugin styles', JSON.stringify(referencePager) === JSON.stringify(await pagerStyle()))
  await js(`document.querySelector('.en-panel .list-pager button:last-child').click()`)
  await waitFor('document.querySelector(".en-table tbody").innerText.includes("Device 26")', 'device server page two')
  const deviceRows = await js('document.querySelectorAll(".en-table tbody tr").length')
  record('device pagination loads the next server page', deviceRows === 25, { rows: deviceRows })
  await screenshot('devices-pager')
  const choose = async (selector, index) => {
    await js(`document.querySelector(${JSON.stringify(selector + ' .select-menu-trigger')}).click()`)
    await waitFor(`!!document.querySelector(${JSON.stringify(selector + ' [role=option]')})`, 'filter options')
    await js(`document.querySelectorAll(${JSON.stringify(selector + ' [role=option]')})[${index}].click()`)
  }
  const noRefresh = (selector) => js(`![...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.textContent.trim()==='Refresh')`)
  record('device filter typography matches usage', JSON.stringify(await selectStyle('.en-state-filter .select-menu-trigger')) === JSON.stringify(usageSelect))
  await choose('.en-state-filter', 2)
  await waitFor('document.querySelectorAll(".en-table tbody tr").length === 11', 'offline filter resets page two')
  record('device status applies immediately and resets pagination', await js('document.querySelector(".en-table tbody").innerText.includes("Device 51")'))
  await choose('.en-form-filter', 2)
  await waitFor('document.querySelectorAll(".en-table tbody tr").length === 4', 'combined mobile offline filters')
  record('device form and status combine', true)
  await js(`document.querySelector('.en-state-filter .filter-clear').click()`)
  await waitFor('document.querySelectorAll(".en-table tbody tr").length === 20', 'clear status keeps mobile')
  await js(`document.querySelector('.en-form-filter .filter-clear').click()`)
  await waitFor('document.querySelectorAll(".en-table tbody tr").length === 25', 'clear form restores all devices')
  record('device filters clear independently and keep main tabs', await js('document.querySelectorAll(".en-tabs [role=tab]").length === 3 && !document.querySelector(".en-filter-tabs")'))
  record('device refresh button removed', await noRefresh('.en-panel button'))
  for (const size of [[1920,1080], [1280,720], [390,844]]) {
    win.setSize(...size); await sleep(180)
    await choose('.en-state-filter', 0)
    await js(`document.querySelector('.en-state-filter .select-menu-trigger').click()`)
    const menu = await js(`(() => {const r=document.querySelector('.en-state-filter .select-menu-popover').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth}})()`)
    record('device filter dropdown fits ' + size[0], menu.left>=0 && menu.right<=menu.width && menu.top>=0 && menu.bottom<=menu.height && menu.scroll<=menu.width+1, menu)
    await screenshot('device-filters-' + size[0])
    await js(`document.querySelector('.en-state-filter .select-menu-trigger').click()`)
  }
  win.setSize(1440,900); await sleep(180)
  await js(`document.querySelectorAll('.en-tabs [role="tab"]')[1].click()`)
  await waitFor('!!document.querySelector(".rb-card .list-pager")', 'runner pagination')
  record('runner pagination shares plugin styles', JSON.stringify(referencePager) === JSON.stringify(await pagerStyle()))
  await js(`document.querySelector('.rb-card .list-pager button:last-child').click()`)
  await waitFor('document.querySelector(".rb-card tbody").innerText.includes("Runner 16")', 'runner page two')
  await js(`document.querySelector('.rb-card .list-pager button:last-child').click()`)
  await waitFor('document.querySelector(".rb-card .list-pager button:last-child").disabled', 'runner last page')
  record('runner last page has one item and cannot advance', await js('document.querySelectorAll(".rb-card tbody tr").length === 1'))
  await screenshot('runners-pager')
  record('runner filter typography matches usage', JSON.stringify(await selectStyle('.rb-state-filter .select-menu-trigger')) === JSON.stringify(usageSelect))
  for (const [index, count] of [[3,5], [2,5], [4,3]]) {
    await choose('.rb-state-filter', index)
    await waitFor(`document.querySelectorAll('.rb-card tbody tr').length === ${count}`, 'runner status filter ' + index)
    record('runner status applies immediately ' + index, await js('!document.querySelector(".rb-card .list-pager")'))
  }
  await js(`document.querySelector('.rb-state-filter .filter-clear').click()`)
  await waitFor('document.querySelectorAll(".rb-card tbody tr").length === 15', 'runner clear restores first page')
  record('runner clear resets page three to page one', await js('document.querySelector(".rb-card .list-pager button:first-child").disabled && document.querySelector(".rb-machine-name").textContent === "Runner 1"'))
  record('runner refresh button removed', await noRefresh('.rb-card button'))
  await screenshot('runner-status-filter')
  await js(`document.querySelectorAll('.en-tabs [role="tab"]')[2].click()`)
  await waitFor('!!document.querySelector(".cap-actions")', 'access policy loaded')
  // The access policy owns cap-actions; the separate mail panel also uses the
  // shared cap-panel style and intentionally lets an operator refresh history.
  record('access policy retains main tab and save without refresh', await noRefresh('.cap-panel:has(> .cap-actions) button') && await js('document.querySelectorAll(".en-tabs [role=tab]").length === 3 && !!document.querySelector(".cap-actions button")'))
  await waitFor('!!document.querySelector(".mail-history-head button") && !document.querySelector(".mail-history-head button").disabled', 'mail history refresh available')
  record('mail history retains its explicit refresh action', await js('document.querySelector(".mail-history-head button").textContent.trim() === "Refresh"'))
  const historyReads = () => requests.filter(request => request.method === 'GET' && request.path === '/api/v1/admin/mail-deliveries').length
  const beforeHistory = historyReads()
  fixtures['/admin/mail-deliveries'] = { items: [{ id: 'fixture-refreshed-mail', recipient: 'r***@example.com', state: 'sent', purpose: 'test' }] }
  await js('document.querySelector(".mail-history-head button").click()')
  await waitFor('document.querySelector(".mail-history").textContent.includes("r***@example.com")', 'mail history uses the refreshed server result')
  record('mail history refresh reads once and renders the returned delivery', historyReads() === beforeHistory + 1)
  await js(`sessionStorage.removeItem('soduwork-execution-tab')`)

  await navigate('models', '.model-runtime-facts strong')
  for (const locale of ['zh-CN', 'en-US']) {
    await changeLocale(locale)
    for (const size of [[1920,1080], [1280,720], [390,844]]) {
      win.setSize(...size); await sleep(180)
      const g = await js(`(() => {
        const panel = document.querySelector('.model-runtime'), r = panel.getBoundingClientRect();
        return { viewport:[innerWidth,innerHeight], panelHeight:r.height, right:r.right,
          summaryCount:panel.querySelectorAll('.model-catalog-summary-card').length,
          runtimeCount:panel.querySelectorAll('.model-runtime-facts strong').length,
          expanded:panel.querySelector('.model-runtime-services-head').getAttribute('aria-expanded'),
          documentWidth:document.documentElement.scrollWidth };
      })()`)
      record('compact model overview ' + locale + ' ' + size.join('×'), g.summaryCount === 3 && g.runtimeCount === 4 &&
        g.expanded === 'false' && g.documentWidth <= g.viewport[0] + 1 && g.right <= g.viewport[0] + 1 &&
        (size[0] < 1900 || g.panelHeight < 240), g)
      await screenshot('models-compact-' + locale + '-' + size[0])
    }
  }
  win.setSize(1440,900); await sleep(180)
  await js(`document.querySelector('.model-runtime-services-head').click()`)
  await waitFor('document.querySelector(".model-runtime-services-head").getAttribute("aria-expanded") === "true"', 'runtime expanded')
  const runtimeScroll = await js(`(() => { const e=document.querySelector('.model-runtime-table');e.scrollTop=160;return {height:e.clientHeight,total:e.scrollHeight,scroll:e.scrollTop}; })()`)
  record('expanded runtime list scrolls within a bounded panel', runtimeScroll.total > runtimeScroll.height && runtimeScroll.height <= 240 && runtimeScroll.scroll > 0, runtimeScroll)
  await screenshot('models-runtime-expanded')
  await js(`document.querySelector('.model-runtime-services-head').click()`)
  record('runtime can collapse again', await js('document.querySelector(".model-runtime-services-body").hidden'))
}

module.exports = { checkAdminLayout }

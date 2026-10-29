const assert = require('node:assert/strict')

async function checkInsightsUsage({ win, js, waitFor, sleep, screenshot, changeLocale, origin, fixtures, results }) {
  const usageKey = '/admin/usage/overview', insightsKey = '/admin/operations/insights'
  const previousUsage = fixtures[usageKey], previousInsights = fixtures[insightsKey]
  const record = (name, ok, evidence) => {
    results.push({ name, ok, evidence })
    assert.ok(ok, name + ': ' + JSON.stringify(evidence))
  }
  const fieldTypography = async selector => {
    await js(`document.querySelector(${JSON.stringify(selector + ' .select-menu-trigger')}).click()`)
    await waitFor(`!!document.querySelector(${JSON.stringify(selector + ' [role=option]')})`, 'dropdown typography')
    const typography = await js(`(() => {
      const field=document.querySelector(${JSON.stringify(selector)});
      const style=selector=>{const s=getComputedStyle(field.querySelector(selector));return Object.fromEntries(
        ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','color','marginTop','marginBottom'].map(k=>[k,s[k]]))};
      return {label:style(':scope > span'),value:style('.select-menu-trigger > span'),
        selectedOption:style('[role=option][aria-selected=true]'),option:style('[role=option][aria-selected=false]')};
    })()`)
    await js(`document.querySelector(${JSON.stringify(selector + ' .select-menu-trigger')}).click()`)
    return typography
  }
  fixtures[usageKey] = {
    ...previousUsage,
    users: Array.from({ length: 12 }, (_, i) => ({ userId: 'user-' + i, label: 'Member ' + i, sessions: 10, tokens: 10000, costMicrousd: 20000 })),
    byAgent: Array.from({ length: 30 }, (_, i) => ({ key: 'model-' + i, agent: 'pi', model: 'Model ' + i, provider: 'Fixture Provider', tokens: 10000, costMicrousd: 20000 })),
  }
  fixtures[insightsKey] = { plugins: Array.from({ length: 30 }, (_, i) => ({
    pluginId: 'plugin-' + i, key: 'plugin-' + i, name: 'Plugin ' + (i + 1), enabled: true,
    category: i < 18 ? 'dev' : 'office', installs: 2, runs30d: i < 28 ? 30 - i : 0,
    conversationUses30d: 0, successRate: 100,
  })) }
  try {
    win.setSize(1920, 1080)
    await win.loadURL(origin + '/?screen=usage')
    await waitFor('document.querySelectorAll(".ugc-agent-list > button").length === 30', 'populated usage ledgers')
    await changeLocale('zh-CN')
    const referenceTypography = await fieldTypography('.ugc-filterbar > label:first-child')
    for (const size of [[1920,1080], [3840,1919], [1366,768], [1100,900], [390,844]]) {
      win.setSize(...size); await sleep(180)
      const geometry = await js(`(() => {
        const panel=document.querySelector('.ugc-agents'), list=panel.querySelector('.ugc-agent-list');
        const p=panel.getBoundingClientRect(), r=list.getBoundingClientRect(); list.scrollTop=100;
        return {gap:p.bottom-r.bottom,height:r.height,total:list.scrollHeight,scroll:list.scrollTop,
          panelHeight:p.height,viewport:[innerWidth,innerHeight],pageWidth:document.documentElement.scrollWidth};
      })()`)
      record('agent ledger fills its panel and scrolls at ' + size.join('×'), geometry.gap<=2 && geometry.height>150 &&
        geometry.scroll>0 && geometry.total>geometry.height && geometry.pageWidth<=geometry.viewport[0]+1 &&
        (size[0]>1100 || geometry.height<=geometry.viewport[1]*.6), geometry)
      await js(`document.querySelector('.ugc-agent-list').scrollTop=0;document.querySelector('.ugc-agents').scrollIntoView({block:'center'})`)
      await screenshot('usage-agent-ledger-' + size[0])
    }
    // A short member page must resize the adjacent ledger without overflowing it.
    win.setSize(1920,1080); await sleep(180)
    await js(`document.querySelector('.ugc-members .ugc-pager button:last-child').click()`)
    await waitFor('document.querySelectorAll(".ugc-member-table tbody tr").length === 4', 'short member page')
    const lastPage = await js(`(() => {const p=document.querySelector('.ugc-agents'),l=p.querySelector('.ugc-agent-list');return {gap:p.getBoundingClientRect().bottom-l.getBoundingClientRect().bottom,height:l.clientHeight,total:l.scrollHeight}})()`)
    record('agent ledger follows a shorter member page', lastPage.gap<=2 && lastPage.total>lastPage.height, lastPage)

    await win.loadURL(origin + '/?screen=insights')
    await waitFor('!!document.querySelector(".oi-plugins .list-pager")', 'plugin usage')
    await changeLocale('zh-CN')
    for (const selector of ['.oi-plugin-filter', '.oi-plugin-sort']) {
      const typography = await fieldTypography(selector)
      record('plugin dropdown text matches usage reference ' + selector,
        JSON.stringify(typography)===JSON.stringify(referenceTypography), { referenceTypography, typography })
    }
    const choose = async label => {
      await js(`document.querySelector('.oi-plugin-filter .select-menu-trigger').click()`)
      await waitFor('!!document.querySelector(".oi-plugin-filter [role=option]")', 'plugin filter options')
      await js(`[...document.querySelectorAll('.oi-plugin-filter [role=option]')].find(e=>e.textContent.startsWith(${JSON.stringify(label)})).click()`)
    }
    record('plugin tabs replaced with one dropdown', await js('!!document.querySelector(".oi-plugin-filter .select-menu-trigger") && !document.querySelector(".oi-filters")'))
    await js(`document.querySelector('.oi-plugins .list-pager button:last-child').click()`)
    await choose('研发与交付')
    await waitFor('document.querySelector(".oi-plugins .list-pager").innerText.includes("1 / 2")', 'category returns to first page')
    record('category immediately filters plugin rows', await js(`[...document.querySelectorAll('.oi-plugins tbody .cat')].every(e=>e.textContent==='研发与交付')`))
    await choose('已安装未使用')
    await waitFor('document.querySelectorAll(".oi-plugins tbody tr").length === 2', 'unused plugins')
    record('unused filter replaces category condition', await js(`[...document.querySelectorAll('.oi-plugins tbody .cat')].every(e=>e.textContent==='办公文稿')`))
    await choose('办公文稿')
    await waitFor('document.querySelectorAll(".oi-plugins tbody tr").length === 12', 'category clears unused condition')
    await js(`document.querySelector('.oi-plugin-filter .filter-clear').click()`)
    await waitFor('document.querySelector(".oi-plugins .list-pager").innerText.includes("1 / 3")', 'clear restores all plugins')
    record('plugin dropdown clear restores all categories', await js('!document.querySelector(".oi-plugin-filter .has-clear")'))
    for (const size of [[1920,1080], [1280,720], [390,844]]) {
      win.setSize(...size); await sleep(180)
      await js(`document.querySelector('.oi-plugin-filter').scrollIntoView({block:'center'});document.querySelector('.oi-plugin-filter .select-menu-trigger').click()`)
      const menu = await js(`(() => {const e=document.querySelector('.oi-plugin-filter .select-menu-popover'),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,options:e.querySelectorAll('[role=option]').length,controlTops:[...document.querySelector('.oi-plugin-tools').children].map(e=>e.getBoundingClientRect().top)}})()`)
      record('plugin filter dropdown fits viewport at ' + size[0], menu.options===4 && menu.left>=0 && menu.right<=menu.width && menu.top>=0 && menu.bottom<=menu.height, menu)
      if (size[0]>=1280) record('plugin search and dropdowns align at ' + size[0], Math.max(...menu.controlTops)-Math.min(...menu.controlTops)<=1, menu.controlTops)
      await screenshot('plugin-filter-dropdown-' + size[0])
      await js(`document.querySelector('.oi-plugin-filter .select-menu-trigger').click()`)
    }
    await changeLocale('en-US')
  } finally {
    fixtures[usageKey] = previousUsage
    fixtures[insightsKey] = previousInsights
  }
}

module.exports = { checkInsightsUsage }

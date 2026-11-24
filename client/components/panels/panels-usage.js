/* Personal usage from account-scoped Hub and device receipts. */
(function (global) {
  'use strict';

  const sourceNames = { all: '全部', hub: 'Hub 模型', local: '本机配置' };
  const otherLabels = {direct: '应用直接调用模型', unidentified: '底座未识别'};
  const qualityLabels = { reported: '已上报', reconciled: '已核对', estimated: '估算', unknown: '未知' };
  const byId = id => document.getElementById(id);
  const tr = text => global.SoduWorkI18n?.translateText?.(String(text)) ?? String(text);
  const locale = () => global.SoduWorkI18n?.getLocale?.() || 'zh-CN';
  const missing = '—';
  const pageSize = 5;
  let days = 30, data = null, seq = 0, refreshTimer;
  let source = 'all', dimension = 'agent', scene = '', other = '', page = 0;
  let visibleRecords = [], selectedDay = '';

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }
  const t = key => esc(tr(key));
  const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function sum(items, pick) {
    const values = items.map(pick);
    if (!values.length || values.some(value => !known(value))) return null;
    return values.reduce((a, b) => a + b, 0);
  }

  function count(value) {
    return Math.round(value).toLocaleString(globalThis.SoduWorkI18n?.getLocale() || 'zh-CN');
  }
  function compact(value) {
    const n = Number(value);
    if (n < 10000) return count(n);
    const locale = globalThis.SoduWorkI18n?.getLocale() || 'zh-CN';
    if (/^zh/i.test(locale)) {
      const trim = x => x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
      if (n < 1e8) return trim(n / 1e4) + ' 万';
      if (n < 1e12) return trim(n / 1e8) + ' 亿';
      return trim(n / 1e12) + ' 万亿';
    }
    return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }
  function number(value, short = false) {
    return known(value) ? (short ? compact(value) : count(value)) : missing;
  }
  function tokenValue(value) {
    return `<b title="${number(value)} Tokens">${number(value, true)}</b>`;
  }
  function duration(ms) {
    if (!known(ms)) return missing;
    const minutes = ms / 60000;
    const [unit, value] = minutes < 1 ? ['second', ms / 1000] : minutes < 60 ? ['minute', minutes] : ['hour', minutes / 60];
    return new Intl.NumberFormat(locale(), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(value);
  }
  function money(micro) {
    if (!known(micro)) return missing;
    const formatted = new Intl.NumberFormat(locale(), {style: 'currency', currency: 'USD'}).format(Math.max(micro, micro > 0 ? 10000 : 0) / 1e6);
    return micro > 0 && micro < 10000 ? '< ' + formatted : formatted;
  }
  function dateTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return missing;
    return new Date(value).toLocaleString(locale(), {
      timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function resetFilters() {
    source = 'all'; dimension = 'agent'; scene = ''; other = ''; page = 0; selectedDay = '';
    visibleRecords = [];
  }
  function discard() {
    ++seq;
    data = null;
    resetFilters();
    byId('usageDialog')?.close();
    byId('usageDialogTitle')?.replaceChildren();
    byId('usageDialogBody')?.replaceChildren();
    if (byId('usageBody')) byId('usageBody').replaceChildren();
    if (byId('usagePeriod')) byId('usagePeriod').textContent = '';
    byId('usageSync')?.replaceChildren();
  }
  function openUsagePanel(options) {
    if (options?.days && days !== Number(options.days)) {
      discard();
      days = Math.max(1, Math.min(365, Math.round(Number(options.days)) || 30));
    }
    const panel = mount();
    panel.classList.add('show');
    if (typeof expandForOverlay === 'function') expandForOverlay();
    syncRange();
    loadUsage();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (panel.classList.contains('show') && !byId('usageDialog').open) loadUsage(); }, 60000);
  }
  function closeUsagePanel() {
    byId('usageDialog')?.close();
    byId('usagePanel')?.classList.remove('show');
    clearInterval(refreshTimer);
    if (typeof shrinkFromOverlay === 'function') shrinkFromOverlay();
  }
  function mount() {
    let panel = byId('usagePanel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'usagePanel';
    panel.className = 'sch-panel usage-panel';
    panel.innerHTML = `<div class="sch-head usage-head ws-page-head">
      <div class="sch-h-txt"><h1 class="sch-h-title">${t('我的用量')}</h1><span class="sch-h-sub" id="usagePeriod"></span></div>
      <div class="sch-h-acts"><nav class="usage-range" aria-label="${t('统计周期')}">${[7,30,90].map(n => `<button data-days="${n}">${t(n + ' 天')}</button>`).join('')}</nav>
      <div class="usage-refresh-box"><button class="usage-refresh" id="usageRefresh" aria-label="${t('刷新用量')}" title="${t('刷新用量')}">↻</button><small id="usageSync" role="status"></small></div>
      <button class="np-close" id="usageClose" aria-label="${t('关闭')}">✕</button></div></div>
      <div class="usage-body" id="usageBody"></div>
      <dialog id="usageDialog" aria-labelledby="usageDialogTitle"><div class="usage-line"><h2 id="usageDialogTitle"></h2>
      <button class="usage-link" id="usageDialogClose">${t('关闭')}</button></div><div id="usageDialogBody"></div></dialog>`;
    document.body.appendChild(panel);
    byId('usageClose').onclick = closeUsagePanel;
    byId('usageDialogClose').onclick = () => byId('usageDialog').close();
    byId('usageRefresh').onclick = loadUsage;
    byId('usageBody').addEventListener('focusin', event => readDay(event.target));
    panel.querySelectorAll('[data-days]').forEach(button => {
      button.onclick = () => {
        if (+button.dataset.days === days) return;
        discard(); days = +button.dataset.days; syncRange(); loadUsage();
      };
    });
    if (typeof makeDraggable === 'function') makeDraggable(panel, panel.querySelector('.sch-head'));
    return panel;
  }
  function syncRange() {
    byId('usagePanel').querySelectorAll('[data-days]').forEach(button => {
      button.setAttribute('aria-pressed', String(+button.dataset.days === days));
    });
  }
  async function loadUsage() {
    const current = ++seq;
    const box = byId('usageBody'), refresh = byId('usageRefresh');
    if (!data) box.innerHTML = `<p role="status">${t('正在加载')}</p>`;
    refresh.setAttribute('aria-busy', 'true');
    try {
      const result = await global.SoduWorkAPI.myUsage(days);
      if (current !== seq) return;
      const payload = result?.summary ? {hub:result, local:null, quota:null} : result;
      if (!payload || !(payload.hub || payload.local || payload.quota)) throw new Error();
      data = payload;
      refresh.title = tr('刷新用量');
      refresh.classList.remove('has-error');
      render();
      byId('usageSync').textContent = new Date().toLocaleTimeString(locale(), {hour:'2-digit', minute:'2-digit'});
    } catch {
      if (current !== seq) return;
      if (data) {
        refresh.title = tr('刷新失败，已保留上次数据');
        refresh.classList.add('has-error');
        byId('usageSync').textContent = refresh.title;
      } else {
        box.innerHTML = `<div class="usage-card usage-empty" role="status"><h2>${t('暂时拿不到用量')}</h2><button id="usageRetry">${t('重新加载')}</button></div>`;
        byId('usageRetry').onclick = loadUsage;
      }
    } finally {
      if (current === seq) refresh.removeAttribute('aria-busy');
    }
  }
  function entries(selected = 'all') {
    return ['hub', 'local'].filter(key => data[key] && (selected === 'all' || selected === key))
      .map(key => [key, data[key]]);
  }
  function sceneLabel(row) {
    return row.sourceType === 'chat' ? '对话' : row.sourceLabel || row.sourceType || '未知';
  }
  function workTitle(row) {
    if (row.sourceType === 'chat' || !row.title || row.title === sceneLabel(row)) return tr(sceneLabel(row));
    return row.title;
  }
  function agentName(row, overview) {
    const kind = global.SoduWorkUsageMetrics.agentKind(row, overview);
    return kind === 'runtime' ? global.SoduWorkUsageMetrics.runtimeName(row, overview) : tr(otherLabels[kind]);
  }
  function legend(key) {
    return `<span><i class="usage-dot ${key}"></i>${t(sourceNames[key])}</span>`;
  }
  function periods() { return global.SoduWorkUsageMetrics.quotaPeriods(data.quota); }
  function quotaCard() {
    const quota = periods();
    const row = quota[0];
    const expired = data.quota?.reason === 'trial_expired';
    const balance = expired ? t('试用已结束') : row && row.limit === null ? t('不限额') : number(row?.remaining, true);
    const usedPct = row?.limit > 0 && known(row.used) ? Math.min(100, row.used / row.limit * 100) : 0;
    const hasLimit = !expired && row?.limit > 0 && known(row.used);
    return `<article class="usage-card usage-quota"><div class="usage-line"><h2>${t('Hub 剩余额度')}</h2>
      ${quota.length ? `<button class="usage-link" id="usageQuotaDetails">${t('额度详情')} ↗</button>` : ''}</div>
      <div class="usage-balance${expired || row?.limit === null ? ' usage-status' : ''}" title="${number(row?.remaining)}">${balance} ${!expired && known(row?.remaining) ? '<small>Tokens</small>' : ''}</div>
      <div class="usage-track" ${hasLimit ? '' : 'hidden'}><i style="width:${usedPct}%"></i></div><small>${row ? `${t(row.label)} · ${t('已用')} ${number(row.used)}${known(row.limit) ? ' / ' + number(row.limit) : ''}` : t('暂无额度数据')}</small>
      ${row?.resetAt ? `<small class="usage-reset">${t('下次重置')} · ${esc(dateTime(row.resetAt))}</small>` : ''}
      ${row?.expiresAt ? `<small class="usage-reset">${t('到期时间')} · ${esc(dateTime(row.expiresAt))}</small>` : ''}</article>`;
  }
  function hero(sets) {
    const total = sum(sets, o => o.summary?.tokens);
    const split = ['hub','local'].map(key => `<span>${legend(key)} ${tokenValue(data[key]?.summary?.tokens)}</span>`).join('');
    const share = sets.length === 2 && total > 0 ? Math.min(100,100 * data.hub.summary.tokens / total) : null;
    const ring = share === null ? '' : `<div class="usage-ring" aria-hidden="true" style="--hub-share:${share}%"><span><b>${number(share)}%</b>Hub</span></div>`;
    return `<div class="usage-grid"><article class="usage-card usage-primary"><div><h2>${t('累计 Token 用量')}</h2>
      <div class="usage-big">${tokenValue(total)} <small>Tokens</small></div>
      <div class="usage-split">${split}</div>${sets.length === 1 ? `<small>${t('仅显示可用来源')}</small>` : ''}</div>${ring}</article>${quotaCard()}</div>`;
  }
  function chart(sources) {
    const maps = sources.filter(([,o]) => Array.isArray(o.trend)).map(([key,o]) => [key,new Map(o.trend.map(row => [row.key,row.tokens]))]);
    const dates = [...new Set(maps.flatMap(([,m]) => [...m.keys()]))].sort();
    const points = dates.map(date => maps.map(([key,m]) => [key,m.get(date)]));
    const high = Math.max(1,...points.map(parts => parts.reduce((n,[,v]) => n+(known(v) ? v : 0),0)));
    const ticks = dates.length > 2 ? [dates[0], dates[Math.floor((dates.length-1)/2)], dates.at(-1)] : dates;
    const labels = ticks.map(date => {
      const center = 100 * (dates.indexOf(date) + 0.5) / dates.length;
      return `<span style="--center:${center}%">${esc(date.slice(5))}</span>`;
    }).join('');
    if (!dates.includes(selectedDay)) selectedDay = dates.at(-1) || '';
    let readout = '';
    const bars = points.map((parts,i) => {
      const date = dates[i], title = date + ' · ' + parts.map(([k,v]) => tr(sourceNames[k]) + ' ' + number(v)).join(' / ') + ' Tokens';
      if (date === selectedDay) readout = title;
      return `<button class="usage-bar" data-day="${esc(date)}" aria-label="${esc(title)}" title="${esc(title)}" tabindex="${date === selectedDay ? 0 : -1}">
        ${parts.filter(([,v])=>known(v)).map(([k,v])=>`<i class="${k}" style="height:${100*v/high}%"></i>`).join('')}</button>`;
    }).join('');
    return `<article class="usage-card"><div class="usage-line"><h3>${t('每日用量')}</h3><div class="usage-legend">${sources.map(([k])=>legend(k)).join('')}</div></div>
      ${dates.length ? `<small>Tokens</small><div class="usage-chart"><div class="usage-axis"><span>${number(high,true)}</span><span>${number(high/2,true)}</span><span>0</span></div>
      <div class="usage-plot" role="group" aria-label="${t('每日用量，方向键查看相邻日期')}">${bars}</div><div class="usage-xaxis">${labels}</div></div>
      <div class="usage-readout" id="usageDayRead" aria-live="polite">${esc(readout)}</div>` : `<p>${t('暂无趋势数据')}</p>`}</article>`;
  }
  function ranking(sets) {
    const ranks = global.SoduWorkUsageMetrics.rank(sets, dimension);
    const total = dimension === 'agent' ? sum(ranks, row => row.tokens) : sum(sets, o=>o.summary?.tokens);
    const extra = dimension === 'agent' ? global.SoduWorkUsageMetrics.otherAgentTokens(sets) : {};
    const supplemental = Object.entries(extra).filter(([,tokens]) => tokens > 0);
    const options = [['agent','按底座'],['model','按模型'],['scene','按工作场景']];
    return `<article class="usage-card usage-ranking" data-ranking-source="${esc(source)}"><div class="usage-line"><h3>${t('用量排行')}</h3><select id="usageGroup" aria-label="${t('排行维度')}">
      ${options.map(([k,v])=>`<option value="${k}" ${k === dimension ? 'selected' : ''}>${t(v)}</option>`).join('')}</select></div>
      ${dimension === 'agent' && ranks.length ? `<small class="usage-denominator">${t('占已识别底座用量')} · ${number(total)} Tokens</small>` : ''}
      <div class="usage-rank-scroll" tabindex="0" role="region" aria-label="${t('用量排行列表')}">${ranks.map(row => {
        const pct = total ? Math.min(100, 100*row.tokens/total) : 0;
        return `<div class="usage-rank"><div class="usage-line"><span>${dimension === 'scene' ? `<button class="usage-link" data-scene="${esc(row.key)}">${t(row.label)} ›</button>` : t(row.label)}
          <small>${known(row.sessions) ? t('AI 工作')+' · '+number(row.sessions) : ''}</small></span><span>${tokenValue(row.tokens)}<small>${total === null ? missing : pct.toFixed(1)+'%'}</small></span></div>
          <div class="usage-track"><i style="width:${pct}%"></i></div></div>`;
      }).join('') || `<p>${t('还没有分布数据')}</p>`}</div>
      ${supplemental.length ? `<div class="usage-attribution"><small>${t('另计入总用量')}</small>
        ${supplemental.map(([kind,tokens]) => `<button class="usage-link usage-extra-row" data-other="${kind}"><span>${t(otherLabels[kind])}</span><span>${number(tokens)} Tokens ›</span></button>`).join('')}</div>` : ''}</article>`;
  }
  function recordTable(sources) {
    const rows = sources.flatMap(([key,o]) => (o.recent || []).filter(row => (!scene || row.sourceType === scene) &&
      (!other || global.SoduWorkUsageMetrics.agentKind(row, o) === other))
      .map(row => ({row, key, overview:o}))).sort((a,b) => (Date.parse(b.row.occurredAt)||0) - (Date.parse(a.row.occurredAt)||0));
    const pages = Math.max(1,Math.ceil(rows.length/pageSize));
    page = Math.max(0,Math.min(page,pages-1));
    visibleRecords = rows.slice(page*pageSize,(page+1)*pageSize);
    const chosen = sources.flatMap(([,o])=>o.bySource || []).find(row => row.key === scene);
    return `<section class="usage-card usage-records"><div class="usage-line"><h2 id="usageRecordsTitle" tabindex="-1">${t('最近的 AI 工作')}</h2>
      <div>${scene || other ? `<button class="usage-link" id="usageClearScene" aria-label="${t(other ? '清除筛选' : '清除工作场景筛选')}">${t(otherLabels[other] || chosen?.label || scene)} ×</button>` : ''} <small>${t('记录数')} · ${number(sources.length ? rows.length : null)}</small></div></div>
      <table><thead><tr>${['工作内容','底座 / 模型','模型来源','日期','Tokens'].map((v,i) => `<th class="${i===1 || i===3 ? 'usage-extra' : ''}" scope="col">${t(v)}</th>`).join('')}</tr></thead><tbody>${visibleRecords.map(({row,key,overview},i) => {
        const name = esc(agentName(row,overview)), date = esc(dateTime(row.occurredAt));
        const title = workTitle(row), label = tr(sceneLabel(row));
        return `<tr><td><button class="usage-work" data-record="${i}" data-user-content>${esc(title)}</button>${title === label ? '' : `<small>${esc(label)}</small>`}<small class="usage-mobile">${name} · ${date}</small></td>
          <td class="usage-extra">${name}<small data-user-content>${t(row.model || missing)}</small></td><td><span class="usage-badge ${key}">${t(sourceNames[key])}</span></td>
          <td class="usage-extra">${date}</td><td>${hasUnknownTokens(row) ? t('用量未知') : tokenValue(row.tokens)}</td></tr>`;
      }).join('') || `<tr><td colspan="5">${t(sources.length ? '最近还没有 AI 工作记录' : '暂无用量数据')}</td></tr>`}</tbody></table>
      <div class="usage-line usage-foot"><div><button id="usagePrev" ${page===0?'disabled':''}>${t('上一页')}</button> <small>${page+1} / ${pages}</small> <button id="usageNext" ${page===pages-1?'disabled':''}>${t('下一页')}</button></div></div></section>`;
  }
  function quality(sources) {
    const rows = [];
    for (const [key,overview] of sources) {
      const q = overview.quality || {};
      if (key === 'local') rows.push(['本机回执',sum([q.reported,q.reconciled],n=>n)]);
      else rows.push(['已上报',q.reported],['已核对',q.reconciled]);
    }
    rows.push(['估算',sum(sources,([,o])=>o.quality?.estimated)],['用量状态未知',sum(sources,([,o])=>o.quality?.unknown)]);
    const records = sum(rows, row => row[1]);
    return `<section class="usage-card usage-quality"><div class="usage-line"><h2>${t('数据说明')}</h2><strong>${t('已记录')} · ${number(records)}</strong></div>
      <div class="usage-split">${rows.filter(([,v])=>v > 0).map(([k,v])=>`<span>${t(k)} <b>${number(v)}</b></span>`).join('')}</div>
      <small>${t('仅统计可归属当前账号的记录。缺少 Token 数的调用不会增加总用量。')}</small></section>`;
  }
  function hasUnknownTokens(row) {
    return !known(row.tokens) || (row.quality === 'unknown' && row.tokens === 0);
  }
  function details(title, pairs, taskId) {
    byId('usageDialogTitle').textContent = title;
    byId('usageDialogTitle').setAttribute('data-user-content','');
    byId('usageDialogBody').innerHTML = `<dl>${pairs.map(([k,v])=>`<div><dt>${t(k)}</dt><dd data-user-content>${esc(v)}</dd></div>`).join('')}</dl>` +
      (taskId ? `<button class="usage-link" data-task="${esc(taskId)}">${t('查看任务执行链路')} →</button>` : '');
    const task = byId('usageDialogBody').querySelector('[data-task]');
    if (task) task.onclick = () => {
      byId('usageDialog').close();
      if (typeof global.openDetailEntry === 'function') global.openDetailEntry(taskId);
      else global.WorkspaceHost?.open('detail', {taskId});
    };
    byId('usageDialog').showModal();
  }
  function recordDetails(index) {
    const {row,key,overview} = visibleRecords[index];
    const pairs = [['工作场景',tr(sceneLabel(row))],['模型来源',tr(sourceNames[key])],['底座',agentName(row,overview)],['模型',tr(row.model || missing)]];
    for (const [field,label] of [['input','输入 Tokens'],['output','输出 Tokens'],['cacheRead','缓存读取 Tokens'],
      ['cacheWrite','缓存写入 Tokens'],['reasoning','推理 Tokens'],['tokens','合计 Tokens'],['requests','模型请求']]) {
      if (hasUnknownTokens(row) && field !== 'requests') {
        if (field === 'tokens') pairs.push([label,tr('用量未知')]);
        continue;
      }
      if (known(row[field])) pairs.push([label,number(row[field])]);
    }
    if (known(row.durationMs)) pairs.push(['活跃时长',duration(row.durationMs)]);
    const status = key === 'local' && row.quality === 'reported' ? '本机回执' : qualityLabels[row.quality] || '未知';
    pairs.push(['数据状态',tr(status)],['模型成本',row.costKnown && (!row.currency || row.currency === 'USD') ? money(row.costMicrousd) : tr('待对账')],['北京时间',dateTime(row.occurredAt)]);
    details(workTitle(row),pairs,row.taskId);
  }
  function quotaDetails() {
    const pairs = [];
    for (const row of periods()) {
      pairs.push([row.label,row.period === 'trial' ? tr('试用') : row.period || missing],['总额度',row.limit === null ? tr('不限额') : number(row.limit)],
        ['周期内已用',number(row.used)],['当前剩余',row.limit === null ? tr('不限额') : number(row.remaining)]);
      if (row.resetAt) pairs.push(['下次重置',dateTime(row.resetAt)]);
      if (row.expiresAt) pairs.push(['到期时间',dateTime(row.expiresAt)]);
    }
    details(tr('Hub 额度详情'),pairs);
  }
  function render() {
    const all = entries(), selected = entries(source), sets = selected.map(([,o])=>o);
    const dates = all.flatMap(([,o])=>(o.trend || []).map(row=>row.key)).sort();
    byId('usagePeriod').textContent = dates.length ? dates[0]+' — '+dates.at(-1) : '';
    const box = byId('usageBody');
    const focused = box.contains(document.activeElement) ? document.activeElement : null;
    const rankScroll = box.querySelector('.usage-rank-scroll')?.scrollTop || 0;
    box.innerHTML = hero(all.map(([,o])=>o)) +
      `<div class="usage-line usage-toolbar"><h2>${t('用量分析')}</h2><div class="usage-range" role="group" aria-label="${t('分析来源')}">${Object.entries(sourceNames).map(([k,v])=>`<button data-source="${k}" aria-pressed="${k === source}">${t(v)}</button>`).join('')}</div></div>
      ${all.length<2 ? `<p class="usage-note" role="status">${all.length === 1 ? [sourceNames[data.hub ? 'local' : 'hub'],'暂无用量数据','仅显示可用来源'].map(t).join(' · ') : t('暂无用量数据')}</p>` : ''}
      <div class="usage-grid usage-analysis">${chart(selected)}${ranking(sets)}</div>${recordTable(selected)}${quality(selected)}`;
    const scroll = box.querySelector('.usage-rank-scroll');
    scroll.scrollTop = rankScroll;
    if (focused?.id) byId(focused.id)?.focus({preventScroll:true});
    else if (focused?.dataset.source) box.querySelector(`[data-source="${focused.dataset.source}"]`)?.focus({preventScroll:true});
    else if (focused?.dataset.day) box.querySelector('.usage-bar[tabindex="0"]')?.focus({preventScroll:true});
    box.onclick = handleClick;
    byId('usageGroup').onchange = e => { dimension=e.target.value; scroll.scrollTop=0; render(); };
    box.onmouseover = e => { if (!document.activeElement?.matches('.usage-bar')) readDay(e.target.closest('.usage-bar')); };
    box.onkeydown = e => {
      if (!e.target.matches('.usage-bar')) return;
      const next = e.key === 'ArrowLeft' ? e.target.previousElementSibling : e.key === 'ArrowRight' ? e.target.nextElementSibling : null;
      if (next) { e.preventDefault(); next.focus(); }
    };
  }
  function readDay(button) {
    if (!button?.classList.contains('usage-bar')) return;
    byId('usageBody').querySelector('.usage-bar[tabindex="0"]')?.setAttribute('tabindex','-1');
    button.tabIndex = 0;
    selectedDay = button.dataset.day;
    byId('usageDayRead').textContent = button.title;
  }
  function handleClick(e) {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.source) {
      source=button.dataset.source; scene=''; other=''; page=0; render();
    } else if (button.dataset.scene || button.dataset.other || button.id === 'usageClearScene') {
      scene=button.dataset.scene || ''; other=button.dataset.other || ''; page=0; render(); byId('usageRecordsTitle').focus();
    } else if (button.id === 'usageNext' || button.id === 'usagePrev') {
      page += button.id === 'usageNext' ? 1 : -1; render(); byId('usageRecordsTitle').focus();
    } else if (button.hasAttribute('data-record')) recordDetails(Number(button.dataset.record));
    else if (button.id === 'usageQuotaDetails') quotaDetails();
  }
  global.addEventListener?.('soduwork-data-scope-changed', () => {
    discard();
    if (byId('usagePanel')?.classList.contains('show')) loadUsage();
  });
  global.openUsagePanel = openUsagePanel;
  global.closeUsagePanel = closeUsagePanel;
})(window);

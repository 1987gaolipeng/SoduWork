/* Shared display and input contract for schedule instants. Hub owns dispatch.
   datetime-local values are interpreted in the schedule's zone, not the OS zone. */
(function (global) {
  'use strict';
  const every = [['daily','每天'],['weekly','每周'],['hourly','每小时'],['once','指定日期时间 · 仅一次']];
  const pad = value => String(value).padStart(2, '0');
  const instant = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
  function localInput(value, zone) {
    if (!instant(value)) return '';
    try {
      const date = new Date(value), parts = {};
      new Intl.DateTimeFormat('en-CA', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'})
        .formatToParts(date).forEach(part => {parts[part.type] = part.value;});
      const base = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
      const fraction = date.getUTCMilliseconds();
      return base + (parts.second !== '00' || fraction ? ':' + parts.second : '') +
        (fraction ? '.' + String(fraction).padStart(3,'0') : '');
    } catch (_) { return ''; }
  }
  function fromLocalInput(value, zone) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (!match || Number(match[1]) < 100) return '';
    const ms = Number((match[7] || '').padEnd(3,'0'));
    const nominal = Date.UTC(+match[1],+match[2]-1,+match[3],+match[4],+match[5],+(match[6] || 0),ms);
    const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}` +
      (Number(match[6]) || ms ? ':' + (match[6] || '00') : '') + (ms ? '.' + String(ms).padStart(3,'0') : '');
    // Check both sides of an offset transition. A repeated/missing wall time must
    // be corrected explicitly, rather than quietly selecting a different instant.
    const offsets = new Set(), matches = new Set();
    for (const hours of [-36,0,36]) {
      const sample = nominal + hours * 3600000;
      const local = localInput(new Date(sample).toISOString(),zone);
      if (!local) return '';
      offsets.add(Date.parse(local + 'Z') - sample);
    }
    for (const offset of offsets) {
      const candidate = new Date(nominal-offset).toISOString();
      if (localInput(candidate,zone) === canonical) matches.add(candidate);
    }
    return matches.size === 1 ? [...matches][0] : '';
  }
  function clockNumber(value) {
    return value == null || String(value).trim() === '' ? NaN : Number(value);
  }
  function clockOptions(limit, value) {
    const selected = clockNumber(value);
    const valid = Number.isInteger(selected) && selected >= 0 && selected < limit;
    return (valid ? '' : '<option value="" selected disabled>--</option>') +
      Array.from({length:limit}, (_, number) => '<option value="' + number + '"' +
        (number === selected ? ' selected' : '') + '>' + pad(number) + '</option>').join('');
  }
  function validate(value, existing, now = Date.now()) {
    if (!every.some(item => item[0] === value.every)) return '请选择支持的执行方式';
    if (value.every !== 'once') {
      const hour = clockNumber(value.atHour), minute = clockNumber(value.atMinute);
      if (value.every !== 'hourly' && (!Number.isInteger(hour) || hour < 0 || hour > 23))
        return '请选择小时（00–23）';
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return '请选择分钟（00–59）';
      return '';
    }
    if (!instant(value.runAt)) return '请选择有效的执行日期和时间；夏令时跳过或重复的时刻请调整后重试';
    const unchanged = existing?.id && existing.every === 'once' && value.runAt === existing.runAt;
    if (!unchanged && Date.parse(value.runAt) <= now) return '执行时间已过去，请选择将来的日期和时间';
    return '';
  }
  function summary(value) {
    const formatted = localInput(value.runAt,value.timeZone);
    return formatted ? formatted.replace('T',' ') + ' · 仅一次' : '指定日期时间 · 待设置';
  }
  function cnNumber(raw) {
    if (/^\d{1,2}$/.test(raw)) return Number(raw);
    const digits = {'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
    const parts = String(raw).split('十');
    return parts.length === 2 ? (parts[0] ? digits[parts[0]] : 1)*10 + (parts[1] ? digits[parts[1]] : 0) : digits[raw];
  }
  function clock(text) {
    const found = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*([\d零一二两三四五六七八九十]{1,3})\s*([:：点时])\s*(半|一刻|三刻|整|[\d零一二两三四五六七八九十]{1,3})?\s*分?/);
    if (!found) return null;
    let hour = cnNumber(found[2]);
    const token = found[4] || '0', minute = ({半:30,一刻:15,三刻:45,整:0})[token] ?? cnNumber(token);
    if (/下午|傍晚|晚上/.test(found[1]) && hour < 12) hour += 12;
    if (/凌晨|早上|上午/.test(found[1]) && hour === 12) hour = 0;
    if (found[1] === '中午' && hour < 11) hour += 12;
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? {atHour:hour,atMinute:minute} : {invalid:true};
  }
  function infer(text, previous, now = Date.now()) {
    text = String(text || '').split(/[，,。；;\n]/).map(clause => {
      const first = clause.search(/\d{4}[-/年]|\d{1,2}月|今天|明天|后天|今晚|明晚|[本这下]周|每[天日周小]|(?:仅|只|执行|运行)一次|一次性|单次|[零一二两三四五六七八九十\d]+[:：点时]|\btoday\b|\btomorrow\b|\bonce\b/i);
      const before = first < 0 ? clause : clause.slice(0,first);
      if (/(?:不要|不用|不在|不需要|不是|取消|如果|假如|比如|例如|是否|能否|\bif\b|\bdo not\b|\bdon't\b)/i.test(before)) return '';
      // Only the text before the leading appointment determines whether it is
      // source material. "Tomorrow at noon, summarize today's data" remains once.
      if (/(?:分析|统计|查看|处理|读取|汇总|对比|报告中|日志中)/.test(before) &&
          !/(?:执行时间|触发时间|运行时间|定于|改为|改到|安排在|计划在)/.test(before)) return '';
      const work = first < 0 ? -1 : clause.slice(first).search(/分析|统计|查看|处理|读取|汇总|对比|生成|输出|检查|发送|开发|制作/);
      return work < 0 ? clause : clause.slice(0,first+work);
    }).join('，');
    const prior = previous || {}, next = {...{every:'daily',atHour:18,atMinute:0,weekday:1},...prior};
    const zone = /北京时间/.test(text) ? 'Asia/Shanghai' : /\bUTC\b/.test(text) ? 'UTC' :
      prior.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
    next.timeZone = zone;
    const recurring = /每(?:隔)?(?:一|1)?小时|每小时|每周|每天|每日|天天/.test(text);
    const explicit = text.match(/(?:\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号])/);
    const relative = text.match(/大后天|后天|明天|明晚|今天|今晚|\btoday\b|\btomorrow\b/i);
    const week = text.match(/(本周|这周|下周)([一二三四五六日天])/);
    const oneTime = !recurring && Boolean(explicit || relative || week || /(?:仅|只)(?:执行|运行)?一次|执行一次|运行一次|一次性|单次|\bonce\b/i.test(text));
    if (/每(?:隔)?(?:一|1)?小时|每小时/.test(text)) next.every = 'hourly';
    else if (/每周/.test(text)) next.every = 'weekly';
    else if (/每天|每日|天天/.test(text)) next.every = 'daily';
    if (oneTime) next.every = 'once';
    const weekday = text.match(/(?:每周|周)([一二三四五六日天])/);
    if (weekday && !oneTime && prior.every !== 'once') next.every = 'weekly';
    if (weekday) next.weekday = Math.min(7,'一二三四五六日天'.indexOf(weekday[1])+1);
    const time = clock(text);
    if (time && !time.invalid) Object.assign(next,time);
    else if (next.every === 'hourly') {
      const minute = text.match(/(?:第|每小时)?\s*([0-5]?\d)\s*分/);
      if (minute) next.atMinute = Number(minute[1]);
    }
    if (next.every !== 'once') { next.runAt = null; return next; }
    if (!explicit && !relative && !week && !time && prior.every === 'once') return next;
    const old = localInput(prior.runAt,zone);
    let date = prior.every === 'once' && old ? old.slice(0,10) : '';
    const today = localInput(new Date(now).toISOString(),zone).slice(0,10);
    const firstDate = [explicit,relative,week].filter(Boolean).sort((a,b) => a.index-b.index)[0];
    if (firstDate && firstDate === explicit) date = `${explicit[1] || explicit[4] || today.slice(0,4)}-${pad(explicit[2] || explicit[5])}-${pad(explicit[3] || explicit[6])}`;
    else if (firstDate) {
      const day = new Date(today + 'T12:00:00Z');
      const offset = firstDate === relative ? /大后天/.test(relative[0]) ? 3 : /后天/.test(relative[0]) ? 2 : /明|tomorrow/i.test(relative[0]) ? 1 : 0 :
        (week[1] === '下周' ? 7 : 0) + Math.min(6,'一二三四五六日天'.indexOf(week[2])) - ((day.getUTCDay()+6)%7);
      day.setUTCDate(day.getUTCDate()+offset); date = day.toISOString().slice(0,10);
    }
    // A newly requested one-off without an explicit clock stays incomplete.
    const when = time && !time.invalid ? pad(time.atHour)+':'+pad(time.atMinute) : old ? old.slice(11) : '';
    next.runAt = date && when && !time?.invalid ? fromLocalInput(date+'T'+when,zone) : '';
    return next;
  }
  global.ScheduleTiming = {every,localInput,fromLocalInput,validate,summary,infer,clock,clockNumber,clockOptions};
})(window);

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const panels = path.join(__dirname, '../components/panels');
const now = Date.parse('2026-10-15T01:00:00Z');

test('relative month windows use the message date in the schedule zone and retain their inclusive bounds', () => {
  const {timing} = runtime();
  const sent = Date.parse('2026-12-31T16:20:00Z');
  const original = '这个月25号到30号每天下午给我发一个写日报的提醒';
  const draft = timing.infer(original, {timeZone:'Asia/Shanghai'}, sent);
  assert.deepEqual([draft.every,draft.startDate,draft.endDate,draft.atHour,draft.atMinute],
    ['daily','2027-01-25','2027-01-30',null,null]);
  assert.match(timing.validate(draft), /请补充下午/);
  for (const [reply,hour] of [['三点',15],['下午四点',16],['上午九点',9],['09:00',9]]) {
    const next = timing.infer(reply,draft,sent);
    assert.deepEqual([next.startDate,next.endDate,next.atHour,next.atMinute],
      [draft.startDate,draft.endDate,hour,0]);
    assert.equal(timing.validate(next),'');
  }
  const utc = timing.infer('本月二十五日至下月二日，每日下午三点提醒我', {timeZone:'UTC'}, sent);
  assert.deepEqual([utc.startDate,utc.endDate,utc.atHour], ['2026-12-25','2027-01-02',15]);
  const invalid = timing.infer('这个月28号到31号每天九点提醒我', {timeZone:'UTC'}, Date.parse('2028-02-01T00:00Z'));
  assert.match(timing.validate(invalid), /结束日期无效/);
  const reversed = timing.infer('本月30号到25号每天九点提醒我', {timeZone:'UTC'}, sent);
  assert.match(timing.validate(reversed), /开始日期不能晚于结束日期/);
  const content = timing.infer('每天九点汇总这个月25号到30号的销售数据', {timeZone:'UTC'}, sent);
  assert.equal(content.startDate, undefined);
});

test('relative delays create one-off instants from the message time, including midnight and Chinese numbers', () => {
  const {timing} = runtime(), sentAt = Date.parse('2026-11-16T08:00:00Z');
  for (const [text, minutes] of [['五分钟后帮我生成日报',5], ['5分钟后生成日报',5], ['半小时后生成日报',30],
    ['两小时后生成日报',120], ['一刻钟后生成日报',15], ['120分钟后生成日报',120],
    ['10分钟以后生成日报',10], ['一刻钟过后生成日报',15]]) {
    const draft = timing.infer(text, {timeZone:'Asia/Shanghai'}, sentAt);
    assert.equal(draft.every, 'once', text);
    assert.equal(draft.runAt, new Date(sentAt + minutes * 60000).toISOString(), text);
    assert.equal(timing.validate(draft, null, sentAt), '', text);
  }
  const crossing = timing.infer('五分钟后生成日报', {timeZone:'Asia/Shanghai'}, Date.parse('2026-11-16T15:58:00Z'));
  assert.equal(timing.localInput(crossing.runAt, crossing.timeZone), '2026-11-17T00:03');
});

test('incomplete, invalid and ambiguous timing cannot pass as daily 18:00', () => {
  const {timing} = runtime();
  for (const text of ['【自动化】：五分钟红帮我做个任务。', '每天提醒我喝水', '每天25:00生成日报',
    '零分钟后生成日报', '五分钟后或十分钟后生成日报', '生成日报']) {
    const value = timing.infer(text, {timeZone:'Asia/Shanghai'}, now);
    assert.ok(timing.validate(value, null, now), text);
    assert.notEqual(value.atHour, 18, text);
  }
  const prior = {every:'daily',atHour:9,atMinute:0,timeZone:'Asia/Shanghai'};
  assert.ok(timing.validate(timing.infer('改为五分钟红', prior, now)));
  assert.equal(timing.infer('每天汇总日报并在上午9点发送', {}, now).atHour, 9);
});

test('supplementing work preserves the original delay; a new delay uses its own message time', () => {
  const {timing} = runtime(), sentAt = Date.parse('2026-11-16T08:00:00Z');
  const initial = timing.infer('五分钟后生成日报', {timeZone:'Asia/Shanghai'}, sentAt);
  assert.equal(timing.infer('增加来源链接', initial, sentAt + 60000).runAt, initial.runAt);
  assert.equal(timing.infer('改为十分钟后', initial, sentAt + 60000).runAt, '2026-11-16T08:11:00.000Z');
  assert.equal(timing.infer('改为十分钟后生成日报', initial, sentAt + 60000).runAt, '2026-11-16T08:11:00.000Z');
  for (const text of ['不要五分钟后执行', '如果五分钟后执行会怎样', '分析五分钟后的日志'])
    assert.equal(timing.infer(text, initial, sentAt + 60000).runAt, initial.runAt, text);
});

test('a generic task stays incomplete until the user supplies concrete work', () => {
  const {proposalOf} = runtime();
  const initial = proposalOf({title:'待明确的任务',note:'帮我做个任务'}, '五分钟后帮我做个任务');
  assert.equal(initial.needsTask, true);
  const timingOnly = proposalOf({title:initial.title,note:initial.note}, '改为十分钟后', initial);
  assert.equal(timingOnly.needsTask, true);
  const clarified = proposalOf({title:initial.title,note:initial.note}, '就是五分钟后', initial);
  assert.equal(clarified.needsTask, true, 'clarifying the time does not supply the missing task');
  const completed = proposalOf({title:'日报',note:'生成当天日报'}, '帮我生成当天日报', timingOnly);
  assert.equal(completed.needsTask, false);
  assert.equal(completed.runAt, timingOnly.runAt);
});
function runtime() {
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = {Date:Clock, Intl, setTimeout, clearTimeout}; context.window = context;
  for (const file of ['schedule-timing.js','work-automation-bindings.js','work-automation-card-state.js']) {
    const target = path.join(panels,file);
    if (fs.existsSync(target)) vm.runInNewContext(fs.readFileSync(target,'utf8'),context);
  }
  vm.runInNewContext(fs.readFileSync(path.join(panels,'work-automation-sheet.js'),'utf8').replace(
    '  global.WorkAutomationSheet = { open, active, refine, close };',
    '  global.probe = {state,proposalOf,bodyOf,validate};'),context);
  context.probe.state.agents = [{id:'local:pi',name:'Pi',available:true}];
  return {...context.probe, timing:context.ScheduleTiming};
}
test('only unambiguous time-only instructions bypass task extraction', () => {
  const {timing} = runtime();
  const prior = {every:'once',runAt:'2026-10-15T08:05:00.000Z',timeZone:'Asia/Shanghai'};
  for (const text of ['修改为10分钟之后','修改为10分钟以后','修改为10分钟过后','再改为十五分钟后','请把执行时间调整为半小时后执行']) {
    assert.equal(timing.relativeEdit(text,prior,now).every,'once',text);
  }
  for (const text of ['不要改为10分钟之后','如果改为10分钟之后会怎样','把标题改为“10分钟后”',
    '10分钟后生成新的日报','分析10分钟后采集的日志','修改为10分钟后或20分钟后']) {
    assert.equal(timing.relativeEdit(text,prior,now),null,text);
  }
  const invalid = timing.relativeEdit('修改为0分钟后',prior,now);
  assert.ok(timing.validate(invalid, null, now)); assert.equal(invalid.runAt,'');
});
test('today at noon is a one-time UTC reservation, not a daily fallback', () => {
  const {proposalOf,bodyOf,validate} = runtime();
  const draft=proposalOf({},'在今天中午12点执行一次，生成报告',{timeZone:'Asia/Shanghai'});
  assert.equal(draft.every,'once');
  assert.equal(draft.runAt,'2026-10-15T04:00:00.000Z');
  assert.equal(validate(draft),'');
  assert.equal(bodyOf(draft).runAt,'2026-10-15T04:00:00.000Z');
});
test('absolute date, relative day and Chinese clock stay faithful to the given date', () => {
  const {proposalOf}=runtime();
  for (const [text,want] of [
    ['2026年10月20日下午两点半运行一次','2026-10-20T06:30:00.000Z'],
    ['2026-10-20 14:30执行报告','2026-10-20T06:30:00.000Z'],
    ['明天晚上8点执行','2026-10-16T12:00:00.000Z'],
    ['后天上午九点运行','2026-10-17T01:00:00.000Z'],
  ]) assert.equal(proposalOf({},text,{timeZone:'Asia/Shanghai'}).runAt,want,text);
});
test('missing date, missing clock, invalid and elapsed dates are blocked rather than guessed', () => {
  const {proposalOf,validate}=runtime();
  for (const text of ['仅执行一次生成报告','明天生成报告','2026年2月30日12点执行','今天早上8点执行']) {
    const draft=proposalOf({},text,{timeZone:'Asia/Shanghai'});
    assert.equal(draft.every,'once');
    assert.ok(validate(draft),text);
  }
});
test('refinement preserves one-time selection unless it explicitly changes the rhythm', () => {
  const {proposalOf,bodyOf}=runtime();
  const prior={every:'once',runAt:'2026-10-20T04:00:00Z',timeZone:'Asia/Shanghai'};
  assert.equal(proposalOf({},'完成标准增加截图',prior).runAt,prior.runAt);
  assert.equal(proposalOf({},'改为下午两点执行',prior).runAt,'2026-10-20T06:00:00.000Z');
  const daily=proposalOf({},'改为每天上午九点',prior);
  assert.equal(daily.every,'daily'); assert.equal(bodyOf(daily).runAt,null);
  assert.equal(proposalOf({},'把标题改为“明天12点执行一次”',prior).runAt,prior.runAt);
});
test('dates in material, negation and hypothetical wording cannot change the reservation', () => {
  const {proposalOf}=runtime();
  const prior={every:'once',runAt:'2026-10-20T04:00:00Z',timeZone:'Asia/Shanghai'};
  for (const text of ['分析2026年10月18日12点的日志','不要今天12点执行','如果明天12点执行会怎样']) {
    assert.equal(proposalOf({},text,prior).runAt,prior.runAt,text);
  }
  assert.equal(proposalOf({},'不要今天12点执行，改为明天12点执行',prior).runAt,'2026-10-16T04:00:00.000Z');
});
test('a leading appointment survives source dates and a negative reminder in its task body', () => {
  const {proposalOf}=runtime();
  for (const text of ['明天12点汇总今天的数据','明天12点分析2026年10月14日的日志',
    '不是每天，是明天12点执行一次','明天12点不要忘记执行一次','明天12点汇总每天的指标']) {
    const result=proposalOf({},text,{timeZone:'Asia/Shanghai'});
    assert.equal(result.every,'once',text);
    assert.equal(result.runAt,'2026-10-16T04:00:00.000Z',text);
  }
});
test('restating once does not rewrite an existing appointment precision', () => {
  const {proposalOf}=runtime();
  const prior={every:'once',runAt:'2026-10-14T04:30:15.123456+00:00',timeZone:'Asia/Shanghai'};
  assert.equal(proposalOf({},'只执行一次，标题改为日报',prior).runAt,prior.runAt);
  assert.equal(proposalOf({},'执行一次生成报告',{timeZone:'Asia/Shanghai'}).every,'once');
});
test('the time zone controls conversion even on a device in a different zone', () => {
  const {timing}=runtime();
  assert.equal(timing.fromLocalInput('2026-10-20T12:30','Asia/Shanghai'),'2026-10-20T04:30:00.000Z');
  assert.equal(timing.localInput('2026-10-20T04:30:00Z','America/New_York'),'2026-10-20T00:30');
  assert.equal(timing.fromLocalInput('2026-10-20T00:30','America/New_York'),'2026-10-20T04:30:00.000Z');
  assert.equal(timing.fromLocalInput('2026-02-30T12:00','Asia/Shanghai'),'');
  assert.equal(timing.fromLocalInput('2026-10-20T12:00','invalid'),'');
});
test('DST missing and repeated local times do not silently move an appointment', () => {
  const {timing}=runtime();
  assert.equal(timing.fromLocalInput('2026-03-08T02:30','America/New_York'),'');
  assert.equal(timing.fromLocalInput('2026-11-01T01:30','America/New_York'),'');
  assert.equal(timing.fromLocalInput('2026-11-01T03:30','America/New_York'),'2026-11-01T08:30:00.000Z');
});
test('editing an unchanged past reservation is allowed but a new past date is rejected', () => {
  const {timing}=runtime();
  const value={every:'once',runAt:'2026-10-14T04:00:00Z'};
  assert.ok(timing.validate(value));
  assert.equal(timing.validate(value,{...value,id:'existing'}),'');
  assert.ok(timing.validate(value,{...value,id:'existing',runAt:'2026-10-13T04:00:00Z'}));
});

test('recurring inference keeps multi-select weekdays, month days, and date bounds', () => {
  const { timing } = runtime();
  const weekly = timing.infer('每周一、三、五上午9点');
  assert.equal(weekly.every, 'weekly');
  assert.deepEqual([...weekly.weekdays], [1, 3, 5]);
  assert.equal(weekly.atHour, 9);
  const monthly = timing.infer('每月30、31号早上9点');
  assert.equal(monthly.every, 'monthly');
  assert.deepEqual([...monthly.monthDays], [30, 31]);
  for (const phrase of ['每月30,31号早上9点', '每月30号，31号早上9点', '每月30,31号汇总报告']) {
    assert.deepEqual([...timing.infer(phrase).monthDays], [30, 31], phrase);
  }
  assert.deepEqual([...timing.infer('每周一、周三、周五上午9点').weekdays], [1, 3, 5]);
  assert.deepEqual([...timing.infer('每周一，周三，周五汇总报告').weekdays], [1, 3, 5]);
  assert.equal(timing.infer('每月5号汇总报告').every, 'monthly');
  const lastDay = timing.infer('每月最后一天早上9点');
  assert.deepEqual([...lastDay.monthDays], [31]);
  assert.equal(lastDay.monthDayPolicy, 'last_day');
  assert.equal(timing.validate({ ...monthly, startDate: '2026-11-01', endDate: '2026-12-31' }), '');
  assert.match(timing.validate({ ...monthly, startDate: '2026-12-31', endDate: '2026-11-01' }), /开始日期/);
  assert.match(timing.validate({ every: 'weekly', weekdays: [], weekday: null, atHour: 9, atMinute: 0 }), /至少一个星期/);
});

test('a leading duration and action schedule the same one-off with or without an explicit delay marker', () => {
  const {proposalOf, bodyOf, validate} = runtime();
  const prior = {timeZone:'Asia/Shanghai'};
  for (const [phrase, minutes] of [
    ['5分钟发一首关于秋天的诗', 5], ['5分钟后发秋天的诗', 5], ['五分钟后发送一句夏天的诗', 5],
    ['【自动化】：请半小时提醒我喝水', 30], ['一刻钟帮我生成日报', 15],
  ]) {
    const draft = proposalOf({}, phrase, prior);
    assert.equal(validate(draft), '', phrase);
    assert.equal(draft.every, 'once', phrase);
    assert.equal(bodyOf(draft).runAt, new Date(now + minutes * 60000).toISOString(), phrase);
  }
  for (const phrase of ['每5分钟发一首诗', '5分钟发一次提醒', '5分钟内发一首诗', '用5分钟写一首诗',
    '分析5分钟发言稿', '如果5分钟发一首诗会怎样']) {
    const draft = proposalOf({}, phrase, prior);
    assert.ok(validate(draft), phrase);
    assert.ok(!draft.runAt, phrase);
  }
});

test('implicit one-offs preserve intervals explicitly present in source material and unrelated durations', () => {
  const {proposalOf} = runtime();
  const text = '5分钟发送提醒，正文写“每5分钟采样”';
  const fields = {title:'采样提醒', note:'引用：每5分钟采样', checklist:['检查每10分钟采集的数据']};
  const draft = proposalOf(fields, text, {timeZone:'Asia/Shanghai'});
  assert.equal(draft.every, 'once');
  assert.equal(draft.note, fields.note);
  assert.deepEqual([...draft.acceptance], fields.checklist);
  const other = proposalOf(fields, '5分钟发一条提醒', {timeZone:'Asia/Shanghai'});
  assert.deepEqual([...other.acceptance], fields.checklist);
});

test('spoken calendar schedules retain the same selections in the draft and create request', () => {
  const {proposalOf, bodyOf, validate} = runtime();
  for (const [phrase, fields] of [
    ['每晚八点发一首诗', {every:'daily', atHour:20, atMinute:0}],
    ['每早七点半提醒喝水', {every:'daily', atHour:7, atMinute:30}],
    ['每日下午三点一刻生成日报', {every:'daily', atHour:15, atMinute:15}],
    ['每个工作日上午九点发送日报', {every:'weekly', weekdays:[1,2,3,4,5], atHour:9}],
    ['每星期二至星期四下午三点生成报告', {every:'weekly', weekdays:[2,3,4], atHour:15}],
    ['每周一，三点生成报告', {every:'weekly', weekdays:[1], atHour:3}],
    ['每个周末中午十二点提醒浇水', {every:'weekly', weekdays:[6,7], atHour:12}],
    ['每个月十五号下午三点生成报告', {every:'monthly', monthDays:[15], atHour:15}],
    ['每月一号，十五号上午九点发送报告', {every:'monthly', monthDays:[1,15], atHour:9}],
    ['每月二十八号到三十号晚间20:15生成报告', {every:'monthly', monthDays:[28,29,30], atHour:20, atMinute:15}],
    ['每个月底上午九点生成报告', {every:'monthly', monthDays:[31], monthDayPolicy:'last_day'}],
    ['每个小时第十五分钟检查日志', {every:'hourly', atMinute:15}],
    ['每小时第0分钟检查日志', {every:'hourly', atMinute:0}],
    ['每小时整点提醒喝水', {every:'hourly', atMinute:0}],
    ['今晚八点发诗', {every:'once', runAt:'2026-10-15T12:00:00.000Z'}],
    ['明晚八点半发诗', {every:'once', runAt:'2026-10-16T12:30:00.000Z'}],
  ]) {
    const draft = proposalOf({}, phrase, {timeZone:'Asia/Shanghai'});
    assert.equal(validate(draft), '', phrase);
    for (const value of [draft, bodyOf(draft)]) {
      for (const [key, expected] of Object.entries(fields)) {
        assert.deepEqual(Array.isArray(value[key]) ? [...value[key]] : value[key], expected, phrase);
      }
    }
  }
});

test('evening midnight reserves the next day at 00:00 instead of noon', () => {
  const {proposalOf, bodyOf, validate} = runtime();
  for (const [phrase, runAt] of [
    ['今晚12点提醒我交报告', '2026-10-15T16:00:00.000Z'],
    ['明晚12点生成日报', '2026-10-16T16:00:00.000Z'],
    ['2026年10月20日晚上12点执行一次', '2026-10-20T16:00:00.000Z'],
    ['后天午夜12点生成日报', '2026-10-17T16:00:00.000Z'],
  ]) {
    const draft = proposalOf({}, phrase, {timeZone:'Asia/Shanghai'});
    assert.equal(draft.every, 'once', phrase);
    assert.equal(validate(draft), '', phrase);
    assert.equal(bodyOf(draft).runAt, runAt, phrase);
  }
  for (const phrase of ['每天晚上12点生成日报', '每天半夜12点生成日报', '每周日晚上12点生成日报']) {
    const draft = proposalOf({}, phrase, {timeZone:'Asia/Shanghai'});
    assert.equal(draft.atHour, 0, phrase);
    assert.equal(validate(draft), '', phrase);
  }
  for (const [phrase, runAt] of [
    ['今天中午12点执行一次', '2026-10-15T04:00:00.000Z'],
    ['今天下午12点执行一次', '2026-10-15T04:00:00.000Z'],
  ]) assert.equal(bodyOf(proposalOf({}, phrase, {timeZone:'Asia/Shanghai'})).runAt, runAt, phrase);
});

test('invalid selections require clarification and refinements replace the old calendar settings', () => {
  const {proposalOf, validate} = runtime();
  const daily = proposalOf({}, '每天九点半生成报告');
  for (const phrase of ['改为每周上午九点', '改为每个月九点', '改为每小时第六十分',
    '改为每月一号和三十二号上午九点', '改为每月第一个周五上午九点']) {
    assert.ok(validate(proposalOf({}, phrase, daily)), phrase);
  }
  const lastDay = proposalOf({}, '每个月最后一天九点生成报告');
  const regular = proposalOf({}, '改为每月三十号', lastDay);
  assert.deepEqual([...regular.monthDays], [30]);
  assert.equal(regular.monthDayPolicy, 'skip');
  const hourly = proposalOf({}, '改为每小时第十五分钟', daily);
  assert.equal(proposalOf({}, '改为每小时整点', hourly).atMinute, 0);
  assert.equal(proposalOf({}, '改为每小时检查日志', daily).atMinute, 0);
  assert.equal(proposalOf({}, '汇总每个工作日的记录', daily).every, 'daily');
});

test('custom recurrence rules preserve text and use the shared create contract', () => {
  const { proposalOf, bodyOf, validate, timing } = runtime();
  const rule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=8';
  const draft = proposalOf({}, 'Task: Generate a report\n' + rule, {timeZone:'Asia/Shanghai'});
  assert.equal(draft.every, 'custom');
  assert.equal(draft.customRule, rule);
  assert.equal(validate(draft), '');
  const body = bodyOf({...draft, startDate:'2000-01-01', endDate:'2000-01-02'});
  assert.equal(body.customRule, rule);
  assert.equal(body.startDate, null);
  assert.equal(body.endDate, null);
  const refined = proposalOf({}, 'Keep the report concise', draft);
  assert.equal(refined.every, 'custom');
  assert.equal(refined.customRule, rule);
  assert.equal(timing.summary(draft), '自定义规则');
});

test('custom inference retains unsupported calendar properties for validation', () => {
  const { proposalOf, validate } = runtime();
  assert.equal(proposalOf({}, 'BEGIN: task notes\n每天9点生成报告', {}).every, 'daily');
  const rule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=DAILY';
  const folded = proposalOf({}, rule + ';COUNT=1\n 0', {timeZone:'Asia/Shanghai'});
  assert.equal(folded.customRule, rule + ';COUNT=1\n0');
  assert.ok(validate(folded), 'Unsupported folding must not turn COUNT=10 into COUNT=1');
  for (const property of ['EXDATE:20990102T105100', 'exdate:20990102T105100',
    'RDATE:20990102T105100', 'DTEND:20990102T105100', 'X-HOLIDAY:skip', 'UNSUPPORTED:date']) {
    for (const text of [rule + '\n' + property, property + '\n' + rule]) {
      const draft = proposalOf({}, 'Task: Generate a report\n' + text, {timeZone:'Asia/Shanghai'});
      assert.equal(draft.every, 'custom');
      assert.ok(draft.customRule.includes(property), property);
      assert.ok(validate(draft), property);
    }
  }
});

test('custom validation rejects malformed dates, unknown rules and duplicates', () => {
  const { timing } = runtime();
  const rule = 'DTSTART;TZID=Asia/Shanghai:20990101T105100\nRRULE:FREQ=DAILY';
  for (const invalid of ['', rule.replace('20990101', '20990230'), rule.replace('105100', '246100'),
    rule.replace('Asia/Shanghai', 'Invalid/Zone'), rule + ';FREQ=WEEKLY', rule + ';BYHOUR=9',
    rule + ';INTERVAL=0', rule + ';COUNT=1000001', rule + ';BYDAY=MO',
    rule + ';BYMONTHDAY=1', rule + ';UNTIL=20990230T120000', rule + '\nRRULE:FREQ=MONTHLY',
    rule + ';COUNT=5;UNTIL=20991231T000000Z', rule + ';UNTIL=20900101T000000',
    rule.replace('105100', '105101'), rule.replace('105100', '105100+08:00'), rule.replace('105100', '105100Z'),
    rule + '\nEXDATE:20990101T105100', rule + ';' + 'X'.repeat(4096)]) {
    assert.ok(timing.validate({every:'custom',customRule:invalid}), invalid);
  }
  for (const valid of [rule, rule.replace('105100', '1051'), rule.replace(';TZID=Asia/Shanghai', '').replace('105100', '105100Z'),
    rule + ';UNTIL=20991231T120000Z',
    rule.replace('FREQ=DAILY', 'FREQ=MONTHLY;BYMONTHDAY=30,31'),
    rule.replace('FREQ=DAILY', 'FREQ=HOURLY;INTERVAL=100000')]) {
    assert.equal(timing.validate({every:'custom',customRule:valid}), '', valid);
  }
  assert.ok(timing.validateCustomRule('DTSTART:00990101T090000Z\nRRULE:FREQ=DAILY'));
  assert.equal(timing.validateCustomRule('DTSTART:20990101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20990101T100000', 'Asia/Shanghai'), '');
});

test('custom example is future minute precision and preview uses server occurrence', () => {
  const { timing } = runtime();
  assert.equal(timing.customExample('Asia/Shanghai', now),
    'DTSTART;TZID=Asia/Shanghai:20261015T100000\nRRULE:FREQ=DAILY;COUNT=1');
  assert.equal(timing.customPreview({nextRunAt:'2099-01-01T02:51:00Z',timeZone:'Asia/Shanghai'}),
    '下一次：2099-01-01 10:51');
  assert.equal(timing.customPreview({nextRunAt:null}), '自定义规则已无后续执行时间');
  assert.equal(timing.customPreview({}), '保存后由服务端计算下一次执行时间');
});

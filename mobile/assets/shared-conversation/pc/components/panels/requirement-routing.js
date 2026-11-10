/* Requirement routing consumes verified direct-instruction metadata, never
   model suggestions or conversation material as authority to change a choice. */
(function (global) {
  'use strict';
  const text = value => String(value == null ? '' : value).trim();
  const norm = value => text(value).replace(/[\s「」『』“”"'《》【】]/g, '').toLowerCase();
  function instruction(options, fallback) {
    if (options && Object.prototype.hasOwnProperty.call(options, 'instruction')) return String(options.instruction ?? '');
    return options?.conversationContext?.text ? '' : String(fallback ?? '');
  }
  function person(name, mates, failed) {
    const requested = text(name), exact = (mates || []).filter(row => norm(row.name) === norm(requested));
    const matches = exact.length ? exact : (mates || []).filter(row => norm(row.name).includes(norm(requested)));
    let hint = '';
    if (failed) hint = '同事名单暂时无法加载，请重试后确认「' + requested + '」。';
    else if (!matches.length) hint = '没有找到「' + requested + '」，请选择实际负责人。';
    else if (matches.length > 1) hint = '「' + requested + '」对应多位同事，请选择具体的人。';
    else if (!matches[0].hasBox) hint = '「' + matches[0].name + '」暂时无法接收需求，请确认负责人。';
    return hint ? { kind: 'pending', requested, hint }
      : { kind: 'mate', id: matches[0].id, name: matches[0].name, requested };
  }
  function who(value, context) {
    const name = text(value);
    if (name === 'me') return { kind: 'me' };
    if (name === 'ai') return context.agent ? { kind: 'agent', id: context.agent.id } : {
      kind: 'pending', requested: 'AI', hint: '当前没有可用 AI，请选择执行人或稍后重试。' };
    if (!name) return context.agent ? { kind: 'agent', id: context.agent.id } : { kind: 'me' };
    return person(name, context.mates, context.failed);
  }
  // Compatibility with older Hubs: recognize only simple current-turn handoff
  // clauses. Never use the model's name to guess an unknown recipient.
  function legacyAssignee(direct, proposed) {
    const selected = [];
    for (const clause of direct.split(/[，,。；;\n]/)) {
      if (/[“”「」『』"']|如果|假如|例如|比如|是否|能否|不要|不用|不需要|别|禁止|取消|标题|正文|备注|描述/.test(clause)) continue;
      if (/(?:我自己|我来)(?:负责|处理|修复|做|执行)?|由我(?:负责|处理|修复|做|执行)/.test(clause)) { selected.push('me'); continue; }
      let match = /(?:转交给|转给|交给|指派给|分配给)\s*([^\s，,。；;：:]{1,30}?)(?=\s|负责|处理|修复|完成|跟进|执行|接手|来做|来处理|开发|测试|$)/.exec(clause);
      if (!match) {
        const weak = /(?:让|由(?!于))\s*([^\s，,。；;：:]{1,30}?)(?=\s|负责|处理|修复|完成|跟进|执行|接手|来做|来处理|开发|测试|$)/.exec(clause);
        if (weak && norm(weak[1]) === norm(proposed)) match = weak;
      }
      if (match) selected.push(/^(?:ai|人工智能)$/i.test(match[1]) ? 'ai' : match[1]);
    }
    return [...new Set(selected)].join('、');
  }
  function parsed(draft, fields, context, initial) {
    const f = fields || {}, c = context || {}, direct = text(c.instruction);
    // The backend derives this flag from the separately supplied direct text.
    const legacy = Object.prototype.hasOwnProperty.call(f, 'assigneeExplicit') ? '' : legacyAssignee(direct, f.assignee);
    const explicitPerson = Boolean((f.assigneeExplicit === true || legacy) && direct);
    if (explicitPerson) {
      draft.who = f.assigneeProblem ? { kind: 'pending', problem: f.assigneeProblem,
        requested: text(f.assigneeRequested) || '负责人', hint: '本次指令指定了多位负责人，请明确选择一位。' }
        : who(legacy || f.assignee, c);
      draft.whoSource = 'instruction';
      draft.flow = ''; draft.flowProblem = ''; draft.flowExplicit = false;
    } else if (initial && !draft.who) {
      draft.who = who('', c); draft.whoSource = 'default';
    }
    const requested = text(f.flowRequested);
    const references = (Array.isArray(f.flowReferences) ? f.flowReferences : requested.split('、')).map(text).filter(Boolean);
    const verifiedReference = references.length > 0 && references.every(value => norm(direct).includes(norm(value)));
    const selected = text(c.userSelection?.flow);
    const currentFlow = (c.flows || []).find(row => row.bindingId === draft.flow);
    const clear = Boolean(direct && f.flowExplicit === true && f.flowCleared === true &&
      (!requested || (verifiedReference && currentFlow &&
        references.some(reference => [currentFlow.bindingId, currentFlow.key, currentFlow.name]
          .some(value => norm(value) === norm(reference))))));
    draft.recommendedFlow = text(f.recommendedFlow || (!f.flowExplicit ? f.flow : '') || draft.recommendedFlow);
    // A named human, oneself or an unresolved person remains the assignee;
    // even an explicitly mentioned method does not authorize replacing them.
    const human = draft.who?.kind === 'mate' ||
      (draft.who?.kind === 'pending' && draft.who.requested !== 'AI') ||
      (draft.who?.kind === 'me' && ['instruction', 'manual', 'proposal'].includes(draft.whoSource));
    if (human && (verifiedReference || selected)) {
      draft.routeHint = '已保留指定负责人，工作流「' + (requested || selected) + '」交由负责人确认。';
    } else if (explicitPerson || clear || selected || verifiedReference) draft.routeHint = '';
    if (!human && (selected || verifiedReference || clear)) {
      if (clear) {
        draft.flow = ''; draft.flowProblem = ''; draft.flowExplicit = true;
        if (draft.who?.kind === 'workflow') draft.who = who('ai', c);
      } else if (!f.flowCleared && (selected || f.flowExplicit === true || f.flowProblem)) {
        const reference = selected || requested;
        const matches = (c.flows || []).filter(row => row.runnable !== false &&
          [row.bindingId, row.key, row.name].some(value => norm(value) === norm(reference)));
        if (matches.length !== 1 || f.flowProblem) {
          draft.flow = ''; draft.flowProblem = '工作流「' + reference + '」' +
            (matches.length > 1 || f.flowProblem === 'ambiguous' ? '有多个匹配，请明确选择。' : '当前不可用，请重新选择。');
        } else {
          draft.flow = matches[0].bindingId; draft.flowProblem = ''; draft.flowExplicit = true;
          if (c.managed(matches[0])) draft.who = { kind: 'workflow' };
          else if (draft.who?.kind !== 'agent') draft.who = who('ai', c);
        }
      }
    }
    // Parser prose can describe a rejected suggestion. The UI already describes
    // the current human/direct/workflow choice from actual selected records.
    draft.reason = '';
    return draft;
  }
  // Deduplicate people across devices and distinguish eligible recipients from inactive accounts.
  function _boolValue(value) {
    const normalized = String(value == null ? '' : value).trim().toLowerCase();
    return value === true || value === 1 || normalized === '1' ||
      normalized === 'true' || normalized === 'yes';
  }

  function normalizeMates(raw) {
    const byId = new Map();
    (Array.isArray(raw) ? raw : []).forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const id = String(item.id || item.userId || item.uid || '').trim();
      if (!id) return;
      const name = String(item.name || item.displayName || item.username || '未命名同事').trim();
      const org = String(item.org || item.orgName || item.department || '未分组').trim();
      const hasBox = Object.prototype.hasOwnProperty.call(item, 'canReceive')
        ? _boolValue(item.canReceive)
        : Object.prototype.hasOwnProperty.call(item, 'hasBox')
          ? _boolValue(item.hasBox)
          : _boolValue(item.available) || _boolValue(item.soduWorkEnabled);
      const deviceCount = Array.isArray(item.devices)
        ? item.devices.length
        : Math.max(0, Number(item.deviceCount || item.devices || 0) || 0);
      const key = id.toLowerCase();
      const old = byId.get(key);
      if (!old) {
        byId.set(key, { id, name: name || '未命名同事', org: org || '未分组',
          hasBox, deviceCount });
        return;
      }
      old.hasBox = old.hasBox || hasBox;
      old.deviceCount = Math.max(old.deviceCount, deviceCount);
      if (old.name === '未命名同事' && name) old.name = name;
      if (old.org === '未分组' && org) old.org = org;
    });
    return Array.from(byId.values()).sort((a, b) =>
      Number(b.hasBox) - Number(a.hasBox) ||
      a.org.localeCompare(b.org, 'zh-CN') ||
      a.name.localeCompare(b.name, 'zh-CN') ||
      a.id.localeCompare(b.id));
  }

  global.RequirementRouting = { instruction, person, who, parsed, normalizeMates };
})(window);

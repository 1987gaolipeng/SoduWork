export async function briefsJourney(ctx) {
  const { journey, navigate, assert, requirementTitle, findTaskOnServer, cleanupNamedTask } = ctx;
  await journey('UJ-08', '简报菜单隐藏，现有日报与周报仍可读取', async () => {
    await ctx.main.run(() => {
      const button = document.querySelector('#wsMine');
      if (!button) return false;
      button.click();
      return true;
    });
    await ctx.main.waitFor(() => document.querySelector('[data-rail-menu="more"]'), null, 3000);
    const hidden = await ctx.main.run(() => {
      document.querySelector('[data-rail-menu="more"]').click();
      return !document.querySelector('#wsRailMoreMenu [data-rail-view="briefs"]');
    });
    assert(hidden, '简报入口应暂时隐藏');
    // Exercise the retained panel explicitly rather than inventing a visible menu.
    await ctx.main.run(() => {
      document.querySelector('[data-rail-menu="more"]').click();
      WorkspaceHost.open('briefs');
      return true;
    });
    await ctx.main.waitFor(() => WorkspaceHost.view === 'briefs', null, 3000);
    await ctx.main.run(() => {
      document.querySelector('[data-period="daily"]').click();
      document.querySelector('[data-scope="mine"]').click();
      return true;
    });
    const daily = await ctx.main.waitFor(() => {
      const panel = document.querySelector('#briefPanel');
      const body = document.querySelector('#briefBody');
      if (!panel || !panel.classList.contains('show') || !body ||
          body.querySelector('.br-skeleton')) return false;
      return {
        daily: document.querySelector('[data-period="daily"]').classList.contains('is-active'),
        mine: document.querySelector('[data-scope="mine"]').classList.contains('is-active'),
        label: document.querySelector('[data-current]').textContent.trim(),
        error: body.textContent.includes('简报没有加载出来') ||
          body.textContent.includes('需要有效的 SoduWork 设备会话'),
        sourceVisible: !!body.querySelector('.br-source, .br-source-empty, .br-state'),
      };
    }, null, 5000);
    assert(daily.daily && daily.mine, '日报/我的默认选择不正确', daily);
    assert(!daily.error && daily.sourceVisible, '日报没有给出可读事实或空态', daily);

    await ctx.main.run(() => {
      document.querySelector('[data-period="weekly"]').click();
      return true;
    });
    const weekly = await ctx.main.waitFor(() => {
      const body = document.querySelector('#briefBody');
      const button = document.querySelector('[data-period="weekly"]');
      if (!body || body.querySelector('.br-skeleton') || !button.classList.contains('is-active')) return false;
      return {
        label: document.querySelector('[data-current]').textContent.trim(),
        title: body.textContent,
        error: body.textContent.includes('简报没有加载出来'),
      };
    }, null, 5000);
    assert(!weekly.error, '周报加载失败', weekly);
    assert(weekly.label.includes('周') || weekly.label.includes('—'),
      '周报周期标签不符合用户认知', weekly.label);

    const teamAvailable = await ctx.main.run(() => {
      const button = document.querySelector('[data-scope="team"]');
      return button && !button.hidden;
    });
    if (teamAvailable) {
      await ctx.main.run(() => {
        document.querySelector('[data-scope="team"]').click();
        return true;
      });
      const team = await ctx.main.waitFor(() => {
        const body = document.querySelector('#briefBody');
        const button = document.querySelector('[data-scope="team"]');
        if (!body || body.querySelector('.br-skeleton') || !button.classList.contains('is-active')) return false;
        return {
          text: body.textContent,
          error: body.textContent.includes('简报没有加载出来') ||
            body.textContent.includes('需要有效的 SoduWork 设备会话'),
        };
      }, null, 6000);
      assert(!team.error, '团队周报加载失败', team);
      assert(team.text.includes('团队') || team.text.includes('成员'),
        '团队概况没有让负责人看懂当前范围', team.text.slice(0, 200));
    }
  });
}

export async function requirementsJourney(ctx) {
  const { journey, navigate, assert, requirementTitle } = ctx;
  await journey('UJ-10', '单一需求创建、完成标准、详情和阶段维护', async () => {
    await navigate('history');
    await ctx.main.waitFor(() => document.querySelector('.requirements-board'), null, 6000);
    try {
      await ctx.main.run(() => document.querySelector('#hbAdd').click());
      await ctx.main.waitFor(() => document.querySelector('#workEntryLayer #cpTitle'), null, 6000);
      await ctx.main.run(title => {
        const set = (selector, value) => {
          const field = document.querySelector(selector); field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('#cpTitle', title);
        set('#cpNote', 'Verify a requirement keeps its business context without a second execution entry.');
        while (document.querySelectorAll('#cpCheck .cp-ck-t').length < 2) document.querySelector('#cpCkAdd').click();
        ['Requirement remains visible', 'Task keeps acceptance criteria'].forEach((value, index) => {
          const field = document.querySelectorAll('#cpCheck .cp-ck-t')[index]; field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        document.querySelector('[data-selbtn="who"]').click();
        document.querySelector('[data-selv="who|me"]').click();
        document.querySelector('#cpCreate').click();
      }, requirementTitle);
      await ctx.main.waitFor(() => document.querySelector('#workEntryLayer .cp-ok'), null, 15000);
      const saved = await ctx.main.run(async title => (await SoduWorkAPI.getTasks()).filter(t => t.title === title), requirementTitle);
      assert(saved.length === 1 && saved[0].status === 'todo' && saved[0].triageStage === 'ready' &&
        saved[0].note.includes('business context') && saved[0].acceptanceCriteria.length === 2,
        '需求字段没有写入同一 Task，或产生了重复执行入口', saved);
      ctx.requirementId = saved[0].id;
      await ctx.main.run(async () => { WorkEntrySheet.close(true, true); await RequirementsBoard.refresh(); });
      await ctx.main.run(id => document.querySelector('[data-rq-open="' + id + '"]').click(), ctx.requirementId);
      await ctx.main.waitFor(() => document.querySelector('#rqEditForm'), null, 7000);
      const detail = await ctx.main.run(() => ({
        title: document.querySelector('#rqEditForm [name="title"]').value,
        note: document.querySelector('#rqEditForm [name="note"]').value,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
      }));
      assert(detail.title === requirementTitle && detail.note.includes('business context') && !detail.overflow,
        '需求详情未保留原文或页面发生溢出', detail);
      await ctx.main.run(() => {
        const form = document.querySelector('#rqEditForm'); form.elements.triageStage.value = 'clarifying';
        form.requestSubmit();
      });
      const updated = await ctx.main.waitFor(async id => {
        const task = await SoduWorkAPI.getTask(id); return task.triageStage === 'clarifying' ? task : false;
      }, ctx.requirementId, 7000);
      assert(updated.status === 'todo' && updated.requirementStage === 'clarifying',
        '需求阶段变更不应伪造执行状态', updated);
      const same = await ctx.main.run(async title => (await SoduWorkAPI.getTasks()).filter(t => t.title === title), requirementTitle);
      assert(same.length === 1 && same[0].id === ctx.requirementId, '维护需求不能创建第二个 Task', same);
    } finally {
      await ctx.main.run(() => { WorkEntrySheet.close(true, true); RequirementsDetail.close(); }).catch(() => {});
    }
  });
}

export async function catalogJourney(ctx) {
  const { journey, navigate, assert, requirementTitle, findTaskOnServer, cleanupNamedTask } = ctx;
  await journey('UJ-11', '插件中心真实入口、详情与能力页签', async () => {
    await navigate('skills');
    const center = await ctx.main.waitFor(() => {
      const panel = document.querySelector('#capPanel');
      const shell = panel?.querySelector('.cap-shell');
      const cards = panel?.querySelectorAll('.cap-plugin-card') || [];
      if (!panel || !panel.classList.contains('show') || !shell || !cards.length) return false;
      return {
        tabs: Array.from(panel.querySelectorAll('[data-cap-tab]')).map((node) => node.dataset.capTab),
        cards: cards.length,
        error: panel.textContent.includes('插件目录没有加载成功'),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    }, null, 10000, 160);
    assert(center.tabs.includes('plugins') && center.tabs.includes('skills') && center.tabs.includes('mcp') &&
      center.tabs.includes('market') && center.cards > 0 && !center.error && !center.overflow,
    '插件中心没有完整加载插件、Skill、MCP 和市场入口', center);
    await ctx.main.run(() => {
      document.querySelector('#capPanel .cap-plugin-card [data-plugin]')?.click();
      return true;
    });
    const detail = await ctx.main.waitFor(() => {
      const modal = document.querySelector('#capModalLayer');
      const body = document.querySelector('#capModalBody');
      if (!modal || modal.hidden || !body || !body.textContent.trim()) return false;
      const box = modal.querySelector('.cap-modal');
      return {
        title: document.querySelector('#capModalTitle')?.textContent.trim() || '',
        body: body.textContent,
        action: document.querySelector('#capModalFoot button, #capModalFoot [role="button"]')?.textContent.trim() || '',
        overflow: !!box && box.scrollWidth > box.clientWidth + 1,
      };
    }, null, 6000);
    assert(detail.title && detail.body.includes('当前状态') && detail.body.includes('权限与风险') &&
      detail.action && !detail.overflow, '插件详情没有呈现可用状态、风险与下一步动作', detail);
    await ctx.main.run(() => { document.querySelector('#capModalClose')?.click(); return true; });
    await ctx.main.run(() => { document.querySelector('#capPanel [data-cap-tab="skills"]')?.click(); return true; });
    const skills = await ctx.main.waitFor(() => {
      const panel = document.querySelector('#capPanel');
      const shell = panel?.querySelector('.cap-shell.cap-tab-skills');
      if (!shell) return false;
      return {
        text: panel.textContent,
        saveState: !!panel.querySelector('#capSkillSaveState'),
        hasSkillRows: panel.querySelectorAll('[data-skill], .skill-row, .cap-skill').length,
      };
    }, null, 8000, 160);
    assert(skills.saveState && !skills.text.includes('能力目录没有加载成功'),
      'Skill 页签没有完成加载或自动保存状态不可见', skills);
    await ctx.main.run(() => { document.querySelector('#capPanel [data-cap-tab="market"]')?.click(); return true; });
    const market = await ctx.main.waitFor(() => {
      const panel = document.querySelector('#capPanel');
      const shell = panel?.querySelector('.cap-shell.cap-tab-market');
      return shell && {
        cards: panel.querySelectorAll('.cap-market-row').length,
        text: panel.textContent,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    }, null, 8000, 160);
    assert(market.cards > 0 && !market.text.includes('插件目录没有加载成功') && !market.overflow,
      '插件市场入口没有呈现可用目录或出现页面溢出', market);
    await ctx.main.run(() => { document.querySelector('#capClose')?.click(); return true; });
  });
}

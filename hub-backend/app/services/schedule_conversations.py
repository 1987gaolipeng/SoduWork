"""Device-native automation: immutable run envelope, ordinary conversation, no Task.

Only upgraded owner devices opt in. Explicit remote assignments, code delivery
and enterprise workflow bindings retain their existing execution contracts.
"""
import json
from datetime import datetime, timezone
from sqlalchemy import select
from fastapi import HTTPException
from .. import models
from . import schedule_access

PROTOCOL = 'soduwork.automation-conversation/v1'
ADAPTERS = {'pi': 'pi', 'codex': 'codex-harness', 'codex-harness': 'codex-harness',
            'opencode': 'opencode', 'claude': 'claude'}


def adapter_for(schedule, client):
    if not dict(getattr(client, 'config', None) or {}).get('automationConversationV1'):
        return ''
    if getattr(schedule, 'plugin_binding_id', '') or getattr(schedule, 'flow', False):
        return ''
    aid = str(schedule.assignee_id or '')
    if aid.startswith('runner:'):
        from . import runner_hub
        parts = aid.split(':', 2)
        if len(parts) != 3:
            return ''
        _, runner_id, cli = parts
        runner = runner_hub.get(runner_id)
        if runner is None or runner.client_id != client.id:
            return ''
    elif aid.startswith('local:'):
        cli = aid.split(':', 1)[1]
    else:
        return ''
    return ADAPTERS.get(cli, '')


async def prepare(session, schedule, client, repo, run_id, adapter, personal):
    from . import schedules, workdirs
    run = await session.get(models.AiScheduleRun, run_id)
    if run is None:
        raise ValueError('自动化运行记录尚未建立')
    existing = dict(run.receipt or {})
    if existing.get('executionMode') == PROTOCOL:
        return {'ok': True, 'executionMode': PROTOCOL, 'conversationId': existing.get('conversationId', ''),
                'conversationTitle': existing.get('conversationTitle', ''), 'waitingForDevice': True}
    cwd = ''
    if repo:
        cwd, _ = workdirs.auto_dir(client, repo)
        if not cwd:
            raise ValueError('工程尚未配置工作目录，请先选择本机已有的工程文件夹')
    title = str(schedule.title or '自动化')
    instruction = title + '\n\n' + str(schedule.note or '')
    inputs = dict(schedule.plugin_inputs or {})
    if inputs:
        instruction += '\n\n本次输入参数：\n' + json.dumps(inputs, ensure_ascii=False, indent=2)
    if repo:
        instruction += '\n\n工程：' + str(repo.name or '')
    instruction += '\n\n自动化触发时间：' + schedules._now_local(schedule).isoformat()
    capabilities = schedules.clean_required_capabilities(schedule.required_capabilities)
    envelope = {'runId': run.id, 'title': title, 'text': instruction, 'attachments': [],
                'adapterId': adapter, 'cwd': cwd, 'projectId': str(getattr(repo, 'project_id', '') or ''),
                'capabilities': capabilities, 'skills': schedules.required_skill_names(capabilities),
                'modelName': str(dict(client.agent_models or {}).get(adapter) or
                                 dict(client.agent_models or {}).get(adapter.removesuffix('-harness')) or ''),
                'personalPlugin': dict(personal)}
    run.receipt = {**existing, 'executionMode': PROTOCOL, 'conversationTitle': title,
                   'conversationInput': envelope, 'phase': 'device'}
    await session.flush()
    return {'ok': True, 'executionMode': PROTOCOL, 'conversationTitle': title, 'waitingForDevice': True}


async def inbox(session, client):
    # Capability registration is authenticated and confined to this device.
    config = dict(client.config or {})
    if config.get('automationConversationV1') != 1:
        client.config = {**config, 'automationConversationV1': 1}
    rows = (await session.execute(select(models.AiScheduleRun).where(
        schedule_access.owner_clause(client, models.AiScheduleRun),
        models.AiScheduleRun.receipt['executionMode'].as_string() == PROTOCOL,
        models.AiScheduleRun.state.in_(['starting', 'running', 'waiting'])
    ).order_by(models.AiScheduleRun.started_at).limit(200))).scalars().all()
    items = [{'id': row.id, 'state': row.state} for row in rows
            if dict(row.receipt or {}).get('executionMode') == PROTOCOL]
    await session.commit()
    return items


async def locked_run(session, client, run_id):
    run = (await session.execute(select(models.AiScheduleRun).where(
        models.AiScheduleRun.id == run_id, schedule_access.owner_clause(client, models.AiScheduleRun)
    ).with_for_update().execution_options(populate_existing=True))).scalar_one_or_none()
    if run is None or dict(run.receipt or {}).get('executionMode') != PROTOCOL:
        raise HTTPException(404, '这条自动化会话不属于当前设备')
    return run


async def claim(session, client, run_id, instance):
    if not instance or len(instance) > 80:
        raise HTTPException(400, '缺少有效的执行端标识')
    run = await locked_run(session, client, run_id)
    receipt = dict(run.receipt or {})
    if run.state in ('succeeded', 'failed', 'cancelled'):
        return {'ok': True, 'terminal': True, 'state': run.state}
    now = datetime.now(timezone.utc).timestamp()
    if receipt.get('worker') != instance and float(receipt.get('leaseUntil') or 0) > now:
        return {'ok': False, 'busy': True}
    receipt.update(worker=instance, leaseUntil=now + 300)
    run.receipt = receipt
    await session.commit()
    return {'ok': True, 'input': dict(receipt.get('conversationInput') or {}),
            'trigger': run.trigger,
            'conversationId': receipt.get('conversationId', '')}


async def acknowledge(session, client, run_id, body):
    run = await locked_run(session, client, run_id)
    receipt = dict(run.receipt or {})
    if receipt.get('worker') != str(body.get('instanceId') or ''):
        raise HTTPException(409, '本次执行已由另一个客户端接管')
    state = str(body.get('state') or '')
    if state not in ('running', 'waiting', 'succeeded', 'failed', 'cancelled'):
        raise HTTPException(400, '执行状态无效')
    cid = str(body.get('conversationId') or '')[:120]
    if receipt.get('conversationId') and cid != receipt['conversationId']:
        raise HTTPException(409, '同一次自动化不能替换为另一条对话')
    if run.state in ('succeeded', 'failed', 'cancelled'):
        return {'ok': True, 'state': run.state}
    if state in ('running', 'waiting', 'succeeded') and not cid:
        raise HTTPException(400, '缺少普通会话标识')
    receipt.update(conversationId=cid, leaseUntil=datetime.now(timezone.utc).timestamp() + 300)
    receipt.pop('phase', None)
    run.receipt = receipt
    run.state = state
    run.error = str(body.get('error') or '')[:1200] if state == 'failed' else ''
    run.finished_at = datetime.now(timezone.utc) if state in ('succeeded', 'failed', 'cancelled') else None
    # Only the latest occurrence controls the compact schedule card. Older
    # completions must not overwrite the state of a newer invocation.
    latest = await session.scalar(select(models.AiScheduleRun.id).where(
        models.AiScheduleRun.schedule_id == run.schedule_id
    ).order_by(models.AiScheduleRun.started_at.desc()).limit(1))
    if latest == run.id:
        from . import schedule_timing
        schedule = await schedule_timing.locked_schedule(session, run.schedule_id)
        if schedule is not None and schedule_timing.matches(schedule, run):
            schedule.last_error = run.error[:400]
    await session.commit()
    return {'ok': True, 'state': state}

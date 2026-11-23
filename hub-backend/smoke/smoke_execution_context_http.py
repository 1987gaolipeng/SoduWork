# -*- coding: utf-8 -*-
'''HTTP regression for dispatch -> durable execution context -> session recovery.

The request path is real FastAPI HTTP, while the provider boundary is replaced by
an in-process deterministic adapter. This keeps the test isolated and fast without
starting a real CLI or sending work to a Runner.
'''
from __future__ import annotations

import asyncio
import os
import tempfile
from unittest.mock import AsyncMock, call

_root = tempfile.TemporaryDirectory(prefix='soduwork-smoke-execution-context-http-')
os.environ['DATABASE_URL'] = (
    'sqlite+aiosqlite:///' + os.path.join(
        _root.name, 'context.db').replace('\\', '/'))
os.environ['SODUWORK_DATA_ROOT'] = os.path.join(_root.name, 'data')
os.environ['DB_MIGRATION_MODE'] = 'auto'
os.environ['REPORT_AUTO'] = 'false'
os.environ['POLL_INTERVAL_SECONDS'] = '0'

import httpx  # noqa: E402

from app import models  # noqa: E402
from app.api import tasks as tasks_api  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.services import ai_exec, device_auth, zero_work_route  # noqa: E402


USER = 'u-smoke-execution-context-http'
CLIENT = 'c-smoke-execution-context-http'
TASK = ''
SECRET = 'execution-context-http-secret'
TOKEN = ''
passed = failed = 0


def check(name: str, condition: bool, detail='') -> None:
    global passed, failed
    if condition:
        passed += 1
        print('  PASS  ' + name)
    else:
        failed += 1
        print('  FAIL  ' + name + ('  << ' + str(detail)[:500] if detail else ''))


def headers() -> dict[str, str]:
    return {'Authorization': 'Device ' + TOKEN}


class FakeLocalProvider:
    PREFIX = ''

    def __init__(self):
        self.calls = []

    def dispatch_sync(self, _cfg, _task, _files=None, assignee=None, _extra=None):
        self.calls.append({'cfg': _cfg, 'extra': _extra, 'assignee': assignee})
        cli = str((assignee or {}).get('id') or '').rsplit(':', 1)[-1]
        selected = dict((_extra or {}).get('agentExecution') or {}).get('model')
        return {
            'ok': True,
            'issueId': 'local-http-context-ref-' + str(len(self.calls)),
            'identifier': 'HTTP-CONTEXT-1',
            'provider': 'local',
            'assigneeId': (assignee or {}).get('id', 'local:pi'),
            'assigneeType': 'agent',
            'assigneeName': '本机 Pi',
            'assigneeCli': cli,
            'model': selected or dict((_cfg or {}).get('llm') or {}).get('model') or 'smoke-model',
            'host': 'SMOKE-DESKTOP',
            'files': 0,
        }


async def seed() -> None:
    global TOKEN
    async with SessionLocal() as session:
        user = models.User(
            id=USER, username='smoke-execution-context',
            display_name='执行上下文 HTTP 冒烟', is_active=True)
        client = models.Client(
            id=CLIENT, name='执行上下文冒烟 SoduWork',
            secret_hash=device_auth.hash_secret(SECRET))
        device_auth.activate(client, user)
        session.add_all([
            user, client,
            models.ModelProvider(id='context-fixture', base_url='https://fixture.invalid/v1',
                                 api_key='fixture-key', enabled=True),
            models.ModelDef(id='context-fixture:smoke-model', provider_id='context-fixture',
                            name='smoke-model', enabled=True),
        ])
        await session.commit()
        TOKEN = device_auth.issue_session(client)[0]


async def async_none():
    return None


async def main() -> None:
    global TASK
    await init_db()
    await seed()

    provider = FakeLocalProvider()
    old = {
        'load': ai_exec.load,
        'resolve_requested_sync': ai_exec.resolve_requested_sync,
        'with_task_git': ai_exec.with_task_git,
        'by_assignee': ai_exec._by_assignee,
        'zero_route': zero_work_route.try_route,
        'settle_work_dir': tasks_api._settle_work_dir,
        'attach_skills': tasks_api._attach_skills,
        'read_session': ai_exec.read_session,
    }

    async def fake_load(_session, force=False):
        return {'name': 'local', 'cfg': {}, 'localCfg': {}}

    def fake_resolve(_ctx, aid, _atype='', *_args):
        return {
            'id': aid or 'local:pi', 'type': 'agent', 'name': '本机 Pi',
            'cli': str(aid).rsplit(':', 1)[-1], 'clientId': CLIENT, 'runnerId': 'backend-local',
        }

    async def fake_with_task_git(_session, ctx, _task, **_kwargs):
        return ctx

    async def fake_settle(_session, _client, _repo, _repo_ctx, _task_id,
                          remote=False):
        return {'ok': True, 'dir': '', 'workRoot': _root.name,
                'remote': remote}

    try:
        ai_exec.load = fake_load
        ai_exec.resolve_requested_sync = fake_resolve
        ai_exec.with_task_git = fake_with_task_git
        ai_exec._by_assignee = lambda _aid: provider
        zero_work_route.try_route = lambda *args, **kwargs: async_none()
        tasks_api._settle_work_dir = fake_settle
        tasks_api._attach_skills = lambda *args, **kwargs: async_none()
        read_session = AsyncMock(return_value={
            'ok': False, 'error': 'smoke runner unavailable'})
        ai_exec.read_session = read_session

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url='http://soduwork.test') as client:
            created = await client.post(
                '/api/v1/tasks', headers=headers(),
                json={'title': 'HTTP 执行上下文恢复验证', 'note': '请求级冒烟'})
            body = created.json() if created.status_code == 200 else {}
            TASK = str(body.get('id') or '')
            check('HTTP 创建任务成功',
                  created.status_code == 200 and bool(TASK), created.text)

            dispatched = await client.post(
                '/api/v1/tasks/%s/ai-dispatch' % TASK,
                headers=headers(),
                json={'assigneeId': 'local:pi', 'assigneeType': 'agent'})
            dispatch_body = dispatched.json() if dispatched.status_code == 200 else {}
            execution = dispatch_body.get('executionContext') or {}
            check(
                'HTTP 派活回执带稳定执行上下文',
                dispatched.status_code == 200
                and execution.get('schemaVersion') == 1
                and execution.get('strategy') == 'direct'
                and (execution.get('agent') or {}).get('cli') == 'pi'
                and execution.get('location', {}).get('mode') == 'local'
                and execution.get('model') == 'smoke-model',
                dispatched.text)
            check(
                'HTTP 回执不暴露工作目录或运行时字段',
                'workDir' not in execution
                and 'secret' not in str(execution)
                and 'local-http-context-ref' not in str(execution),
                execution)

            recovered = await client.get(
                '/api/v1/tasks/%s/ai-session' % TASK, headers=headers(),
                params={'since': 7, 'limit': 25})
            recovered_body = recovered.json() if recovered.status_code == 200 else {}
            recovered_context = recovered_body.get('executionContext') or {}
            check(
                'HTTP 会话恢复定向已鉴权执行端并保留读取游标',
                read_session.await_args_list == [call(
                    {'name': 'local', 'cfg': {}, 'localCfg': {}},
                    'local-http-context-ref-1', 7, runner_id='backend-local', limit=25)],
                read_session.await_args_list)
            check(
                '执行会话离线恢复仍带执行上下文',
                recovered.status_code == 200
                and recovered_context.get('schemaVersion') == 1
                and recovered_context.get('location', {}).get('mode') == 'local'
                and (recovered_context.get('agent') or {}).get('name') == '本机 Pi'
                and recovered_body.get('liveError') == 'smoke runner unavailable',
                recovered.text)

            async with SessionLocal() as session:
                task = await session.get(models.Task, TASK)
                check('派活后任务进入进行中',
                      getattr(task, 'status', '') == 'doing',
                      getattr(task, 'status', ''))

            # Exercise the real authenticated request, catalog and durable task with a synthetic Agent.
            async def dispatch_case(cli, model, **extra):
                created = await client.post('/api/v1/tasks', headers=headers(),
                    json={'title': 'Model route ' + cli})
                task_id = created.json()['id']
                response = await client.post('/api/v1/tasks/' + task_id + '/ai-dispatch',
                    headers=headers(), json={'assigneeId': 'local:' + cli,
                        'assigneeType': 'agent', 'model': model,
                        'executionContext': {'strategy': 'direct'}, **extra})
                return response, task_id

            async with SessionLocal() as session:
                selected = await session.get(models.ModelDef, 'context-fixture:smoke-model')
                selected.enabled = False
                await session.commit()
            count = len(provider.calls)
            response, _ = await dispatch_case('pi', '')
            check('HTTP missing default catalog model refuses dispatch without fallback',
                  response.status_code == 409 and len(provider.calls) == count
                  and response.json().get('detail', {}).get('phase') == 'configuration', response.text)
            async with SessionLocal() as session:
                selected = await session.get(models.ModelDef, 'context-fixture:smoke-model')
                selected.enabled = True
                await session.commit()

            async with SessionLocal() as session:
                session.add_all([
                    models.ModelDef(id='context-fixture:chosen-model', provider_id='context-fixture',
                                    name='chosen-model', enabled=True),
                    models.ModelProvider(id='other-fixture', base_url='https://fixture.invalid/v1',
                                         api_key='second-fixture-key', enabled=True),
                    models.ModelDef(id='other-fixture:chosen-model', provider_id='other-fixture',
                                    name='chosen-model', enabled=True),
                ])
                await session.commit()

            for cli in ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh']:
                saved = await client.put('/api/v1/agent-setup/model', headers=headers(), json={
                    'key': cli, 'model': 'chosen-model', 'providerId': 'other-fixture'})
                # Exercise both inheritance and an explicitly repeated wire model name.
                response, _ = await dispatch_case(cli, '' if cli == 'pi' else 'chosen-model')
                wire = provider.calls[-1]
                llm = wire['cfg'].get('llm') or {}
                check('HTTP ' + cli + ' receives selected model and full provider',
                      saved.status_code == 200 and response.status_code == 200
                      and llm.get('model') == 'chosen-model' and llm.get('key') == 'second-fixture-key'
                      and llm.get('base') == 'https://fixture.invalid/v1'
                      and wire['extra'].get('agentExecution', {}).get('kind') == 'local:' + cli,
                      (saved.status_code, response.status_code))

            async with SessionLocal() as session:
                (await session.get(models.ModelProvider, 'other-fixture')).enabled = False
                await session.commit()
            count = len(provider.calls)
            response, _ = await dispatch_case('pi', '')
            check('HTTP unavailable pinned provider does not dispatch to a same-name model',
                  response.status_code == 409 and len(provider.calls) == count, response.status_code)
            response, _ = await dispatch_case('codex', 'gpt-5-codex', reasoningEffort='high')
            wire = provider.calls[-1]
            check('HTTP native Codex receives native options without shared model service',
                  response.status_code == 200 and 'llm' not in wire['cfg']
                  and wire['extra'].get('agentExecution') == {
                      'kind': 'local:codex', 'model': 'gpt-5-codex', 'reasoningEffort': 'high'},
                  response.status_code)
            count = len(provider.calls)
            response, task_id = await dispatch_case('qwen', 'removed-model')
            check('HTTP missing explicit model refuses dispatch without fallback',
                  response.status_code == 409 and len(provider.calls) == count
                  and response.json().get('detail', {}).get('phase') == 'configuration', response.text)
            async with SessionLocal() as session:
                rejected = await session.get(models.Task, task_id)
                check('Rejected model leaves the task available for corrected dispatch',
                      rejected.status == 'todo', rejected.status)

    finally:
        ai_exec.load = old['load']
        ai_exec.resolve_requested_sync = old['resolve_requested_sync']
        ai_exec.with_task_git = old['with_task_git']
        ai_exec._by_assignee = old['by_assignee']
        zero_work_route.try_route = old['zero_route']
        tasks_api._settle_work_dir = old['settle_work_dir']
        tasks_api._attach_skills = old['attach_skills']
        ai_exec.read_session = old['read_session']
        await engine.dispose()


asyncio.run(main())
print('PASS=%d FAIL=%d' % (passed, failed))
raise SystemExit(1 if failed else 0)

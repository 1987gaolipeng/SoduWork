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
from unittest.mock import patch

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
from app.services import ai_exec, device_auth, model_catalog, zero_work_route  # noqa: E402


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
        session.add_all([user, client])
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
        'session_sync': ai_exec.session_sync,
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
        ai_exec.session_sync = lambda *args, **kwargs: {
            'ok': False, 'error': 'smoke runner unavailable'}

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
                '/api/v1/tasks/%s/ai-session' % TASK, headers=headers())
            recovered_body = recovered.json() if recovered.status_code == 200 else {}
            recovered_context = recovered_body.get('executionContext') or {}
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

            # Use the real authenticated request, durable task and dispatch code;
            # replace only the shared model catalog and external Agent boundary.
            async def dispatch_case(cli, model, **extra):
                created = await client.post('/api/v1/tasks', headers=headers(),
                    json={'title': 'Model route ' + cli})
                task_id = created.json()['id']
                response = await client.post('/api/v1/tasks/' + task_id + '/ai-dispatch',
                    headers=headers(), json={'assigneeId': 'local:' + cli,
                        'assigneeType': 'agent', 'model': model,
                        'executionContext': {'strategy': 'direct'}, **extra})
                return response, task_id

            async def catalog(_session, _client, wanted=''):
                if wanted == 'removed-model':
                    return {}
                return {'model': wanted or 'fixture-default',
                        'base': 'https://fixture.invalid/v1', 'key': 'fixture-key'}

            with patch.object(model_catalog, 'resolve', new=catalog):
                for cli in ['pi', 'opencode', 'qwen', 'codex-harness', 'dsh']:
                    response, _ = await dispatch_case(cli, 'chosen-model')
                    wire = provider.calls[-1]
                    check('HTTP ' + cli + ' receives selected model and full provider',
                          response.status_code == 200
                          and wire['cfg'].get('llm', {}).get('model') == 'chosen-model'
                          and wire['cfg'].get('llm', {}).get('base') == 'https://fixture.invalid/v1'
                          and wire['extra'].get('agentExecution', {}).get('kind') == 'local:' + cli,
                          response.status_code)
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
        ai_exec.session_sync = old['session_sync']
        await engine.dispose()


asyncio.run(main())
print('PASS=%d FAIL=%d' % (passed, failed))
raise SystemExit(1 if failed else 0)

'''Build a safe, provider-neutral execution context for task details.'''
from __future__ import annotations


SCHEMA_VERSION = 1
_STRATEGIES = {'direct', 'workflow', 'plugin', 'forward', 'plan', 'batch', 'milestone'}


def _text(value, limit: int = 160) -> str:
    return str(value or '').strip()[:limit]


def _agent_cli(assignee: dict, dispatch: dict) -> str:
    value = _text(
        dispatch.get('agentCli') or dispatch.get('assigneeCli')
        or assignee.get('cli') or assignee.get('cliName'))
    if value:
        return value
    aid = _text(dispatch.get('assigneeId') or assignee.get('id'), 180)
    if aid.startswith('runner:'):
        return aid.rsplit(':', 1)[-1]
    if aid.startswith('local:'):
        return aid.split(':', 1)[1]
    return ''


def _runner(assignee: dict, dispatch: dict, provider: str) -> tuple[bool, dict]:
    aid = _text(dispatch.get('assigneeId') or assignee.get('id'), 180)
    runner_id = _text(dispatch.get('runnerId') or assignee.get('runnerId'), 80)
    # backend-local is the durable placeholder used for a Hub-local
    # execution session. It must not turn a local adapter receipt into a
    # remote Runner route in the public task detail.
    backend_local = runner_id == 'backend-local'
    remote = provider == 'runner' or (
        bool(runner_id) and not backend_local) or aid.startswith('runner:')
    if backend_local:
        runner_id = ''
    if not remote:
        return False, {'mode': 'local'}
    return True, {
        'mode': 'remote',
        'id': runner_id,
        'runnerId': runner_id,
        'clientId': _text(
            dispatch.get('runnerClientId') or assignee.get('clientId'), 64),
        'host': _text(dispatch.get('host') or assignee.get('host'), 100),
        'version': _text(
            dispatch.get('runnerVersion') or assignee.get('runnerVersion')
            or assignee.get('version'), 40),
    }


def _repo(ctx: dict, task=None) -> dict | None:
    raw = dict(ctx.get('repo') or {})
    repo_id = _text(raw.get('id') or getattr(task, 'repo_id', ''), 64)
    project_id = _text(raw.get('projectId') or getattr(task, 'project_id', ''), 64)
    if not any((repo_id, project_id, raw.get('name'), raw.get('branch'))):
        return None
    out = {
        'id': repo_id,
        'projectId': project_id,
        'name': _text(raw.get('name'), 120),
        'branch': _text(raw.get('branch'), 120),
        'kind': _text(raw.get('kind'), 16),
    }
    scm = _text(raw.get('scm'), 16).lower()
    if scm:
        out['scm'] = scm
    return out


def _plugin(ctx: dict) -> dict | None:
    personal = dict(ctx.get('personalPlugin') or {})
    key = _text(personal.get('key') or ctx.get('pluginKey'), 120)
    run_id = _text(ctx.get('pluginRunId'), 36)
    node = _text(ctx.get('pluginNode'), 120)
    binding_id = _text(ctx.get('bindingId'), 36)
    version = _text(personal.get('version'), 80)
    if not any((key, run_id, node, binding_id, version)):
        return None
    out = {'key': key, 'version': version, 'bindingId': binding_id,
           'runId': run_id, 'node': node}
    return {k: v for k, v in out.items() if v}


def build(ctx: dict | None = None, *, assignee: dict | None = None,
          dispatch: dict | None = None, task=None) -> dict:
    '''Project resolved dispatch facts into a stable UI/audit contract.'''
    context = dict(ctx or {})
    selected = dict(assignee or {})
    receipt = dict(dispatch or {})
    provider = _text(receipt.get('provider'), 24).lower()
    cli = _agent_cli(selected, receipt)
    remote, runner = _runner(selected, receipt, provider)
    model = _text(receipt.get('model') or context.get('model'), 160)
    if not model:
        for cfg_key in ('cfg', 'localCfg'):
            llm = dict((context.get(cfg_key) or {}).get('llm') or {})
            model = _text(llm.get('model'), 160)
            if model:
                break
    aid = _text(receipt.get('assigneeId') or selected.get('id'), 180)
    name = _text(receipt.get('assigneeName') or receipt.get('agentCliName')
                 or selected.get('name') or selected.get('cliName') or cli, 120)
    strategy = _text(context.get('executionStrategy'), 24).lower()
    if strategy not in _STRATEGIES:
        strategy = 'plugin' if context.get('personalPlugin') else (
            'workflow' if context.get('pluginRunId') else 'direct')
    agent = {k: v for k, v in {'id': aid, 'cli': cli, 'name': name}.items() if v}
    location = {
        'mode': 'remote' if remote else 'local',
        'label': ('远程 Runner' if remote else '本机')
        + ((' · ' + runner['host']) if runner.get('host') else ''),
    }
    execution = {'agentKind': 'local:' + cli if cli else ('hosted' if not aid else aid),
                 'model': model}
    execution = {k: v for k, v in execution.items() if v}
    return {'schemaVersion': SCHEMA_VERSION, 'strategy': strategy,
            'agent': agent or None, 'model': model, 'location': location,
            'runner': runner, 'repo': _repo(context, task),
            'plugin': _plugin(context), 'execution': execution}


def public(value: dict | None) -> dict:
    '''Return only the public execution contract; never echo runtime payloads.'''
    raw = value if isinstance(value, dict) else {}
    agent_raw = raw.get('agent') if isinstance(raw.get('agent'), dict) else {}
    location_raw = raw.get('location') if isinstance(raw.get('location'), dict) else {}
    runner_raw = raw.get('runner') if isinstance(raw.get('runner'), dict) else {}
    repo_raw = raw.get('repo') if isinstance(raw.get('repo'), dict) else {}
    plugin_raw = raw.get('plugin') if isinstance(raw.get('plugin'), dict) else {}
    execution_raw = raw.get('execution') if isinstance(raw.get('execution'), dict) else {}
    mode = _text(location_raw.get('mode'), 12).lower()
    if mode not in {'local', 'remote'}:
        mode = 'local'
    runner_mode = _text(runner_raw.get('mode'), 12).lower()
    if runner_mode not in {'local', 'remote'}:
        runner_mode = 'remote' if mode == 'remote' else 'local'
    strategy = _text(raw.get('strategy'), 24).lower()
    if strategy not in _STRATEGIES:
        strategy = 'direct'
    agent = {key: _text(agent_raw.get(key), limit) for key, limit in (
        ('id', 180), ('cli', 48), ('name', 120))}
    agent = {key: item for key, item in agent.items() if item}
    runner = {'mode': runner_mode}
    for key, limit in (('id', 80), ('runnerId', 80), ('clientId', 64),
                       ('host', 100), ('version', 40)):
        item = _text(runner_raw.get(key), limit)
        if item:
            runner[key] = item
    repo = {key: _text(repo_raw.get(key), limit) for key, limit in (
        ('id', 64), ('projectId', 64), ('name', 120), ('branch', 120),
        ('kind', 16), ('scm', 16))}
    repo = {key: item for key, item in repo.items() if item}
    plugin = {key: _text(plugin_raw.get(key), limit) for key, limit in (
        ('key', 120), ('version', 80), ('bindingId', 36), ('runId', 36),
        ('node', 120))}
    plugin = {key: item for key, item in plugin.items() if item}
    execution = {key: _text(execution_raw.get(key), 160) for key in (
        'agentKind', 'model')}
    execution = {key: item for key, item in execution.items() if item}
    return {
        'schemaVersion': SCHEMA_VERSION,
        'strategy': strategy,
        'agent': agent or None,
        'model': _text(raw.get('model'), 160),
        'location': {
            'mode': mode,
            'label': _text(location_raw.get('label'), 180),
        },
        'runner': runner,
        'repo': repo or None,
        'plugin': plugin or None,
        'execution': execution,
    }


__all__ = ['SCHEMA_VERSION', 'build', 'public']

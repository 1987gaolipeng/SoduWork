'''Regression checks for the provider-neutral execution context contract.'''
from types import SimpleNamespace

from app.services import execution_context


def test_remote_context_uses_resolved_receipt_and_drops_runtime_payload():
    task = SimpleNamespace(project_id='project-1', repo_id='repo-1')
    ctx = {
        'repo': {
            'id': 'repo-1', 'projectId': 'project-1', 'name': 'Demo',
            'branch': 'main', 'path': r'C:\private\worktree',
            'gitUrl': 'https://git.example/repo.git',
        },
        'personalPlugin': {
            'key': 'daily-report', 'version': '1.2.0',
            'inputs': {'TOKEN': 'secret-value'},
        },
        'pluginRunId': 'run-1', 'pluginNode': 'node-a', 'bindingId': 'binding-1',
        'runtimeSecrets': {'TOKEN': 'GITLAB_TOKEN'},
    }
    result = execution_context.build(
        ctx,
        assignee={
            'id': 'runner:runner-1:codex', 'cli': 'codex', 'name': 'Codex',
            'runnerId': 'runner-1', 'clientId': 'client-1',
        },
        dispatch={
            'provider': 'runner', 'assigneeId': 'runner:runner-1:codex',
            'agentCli': 'codex', 'agentCliName': 'Codex',
            'runnerId': 'runner-1', 'runnerClientId': 'client-1',
            'host': 'BUILD-PC', 'runnerVersion': '2.0.0',
            'model': 'gpt-5.6-sol',
        },
        task=task,
    )
    assert result['location']['mode'] == 'remote'
    assert result['runner']['runnerId'] == 'runner-1'
    assert result['execution'] == {
        'agentKind': 'local:codex', 'model': 'gpt-5.6-sol'}
    assert result['repo'] == {
        'id': 'repo-1', 'projectId': 'project-1', 'name': 'Demo',
        'branch': 'main', 'kind': ''}
    assert result['plugin'] == {
        'key': 'daily-report', 'version': '1.2.0',
        'bindingId': 'binding-1', 'runId': 'run-1', 'node': 'node-a'}
    serialized = repr(result)
    assert 'private' not in serialized
    assert 'git.example' not in serialized
    assert 'secret-value' not in serialized
    assert 'GITLAB_TOKEN' not in serialized


def test_local_context_is_explicit_and_does_not_trust_client_route():
    result = execution_context.build(
        {
            'executionContext': {
                'runner': {'id': 'attacker-runner'},
                'model': 'untrusted-model',
            },
            'localCfg': {'llm': {'model': 'configured-model'}},
        },
        assignee={'id': 'local:pi', 'cli': 'pi', 'name': 'Pi'},
        dispatch={'provider': 'local', 'assigneeId': 'local:pi',
                  'agentCli': 'pi'},
    )
    assert result['location']['mode'] == 'local'
    assert result['runner'] == {'mode': 'local'}
    assert result['execution'] == {
        'agentKind': 'local:pi', 'model': 'configured-model'}
    assert 'attacker-runner' not in repr(result)
    assert 'untrusted-model' not in repr(result)


def test_public_context_is_a_strict_whitelist():
    result = execution_context.public({
        'schemaVersion': 99,
        'strategy': 'not-a-strategy',
        'location': {'mode': 'remote', 'label': 'BUILD-PC', 'secret': 'drop'},
        'runner': {'mode': 'remote', 'runnerId': 'runner-1',
                   'workDir': r'C:\private', 'token': 'drop'},
        'repo': {'name': 'Demo', 'path': r'C:\private', 'gitUrl': 'drop'},
        'execution': {'agentKind': 'local:codex', 'model': 'gpt-5.6-sol',
                      'prompt': 'drop'},
    })
    assert result['schemaVersion'] == 1
    assert result['strategy'] == 'direct'
    assert result['runner'] == {'mode': 'remote', 'runnerId': 'runner-1'}
    assert result['repo'] == {'name': 'Demo'}
    assert result['execution'] == {
        'agentKind': 'local:codex', 'model': 'gpt-5.6-sol'}
    assert 'private' not in repr(result)
    assert 'drop' not in repr(result)


if __name__ == '__main__':
    test_remote_context_uses_resolved_receipt_and_drops_runtime_payload()
    test_local_context_is_explicit_and_does_not_trust_client_route()
    test_public_context_is_a_strict_whitelist()
    print('execution context smoke tests passed')

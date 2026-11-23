"""Verify installed DSH task recovery against an isolated loopback model.

Uses the production bridge, native session/tools, stream settlement and goal
controller. Model responses and the process scheduling callback are fixtures;
every scheduled turn still launches the real bridge and installed DSH adapter.
No paid provider, desktop UI or installed configuration is used or changed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import e2e_dsh_subagent_settlement as fixture_module
from app.services import ai_local, local_base as base, local_stream as stream, local_task_goal as goal

original_popen = subprocess.Popen
captured = {}


def popen(argv, *args, **kwargs):
    if isinstance(argv, list) and any(Path(str(item)).name == 'acp_bridge.py' for item in argv):
        captured['argv'], captured['env'] = list(argv), dict(kwargs['env'])
    return original_popen(argv, *args, **kwargs)

original_env = fixture_module.dsh_runtime.apply_env


def apply_env(env, root):
    result = original_env(env, root)
    env['SODUWORK_TASK_OUTPUT_RECOVERY_OWNED'] = '1'
    return result


def model_response(self, body):
    assert body['model'] == fixture_module.MODEL
    if not body.get('tools'):
        return {'role': 'assistant', 'content': 'Synthetic task goal'}, 'stop', None
    with self.lock:
        stage = self.calls['parent']
        self.calls['parent'] += 1
    names = {tool['function']['name'] for tool in body['tools']}
    self.observe('model_request', stage=stage)
    if stage in (0, 1, 3):
        tool = 'read' if stage == 3 else 'write'
        assert tool in names, str(names)
        arguments = ('{"file_path":"truncated.txt","content":"UNFINISHED' if stage == 0 else
                     json.dumps({'file_path': 'finished.txt', 'content': 'Completed exactly once.\n'}) if stage == 1 else
                     json.dumps({'file_path': 'finished.txt'}))
        return {'role': 'assistant', 'content': None, 'tool_calls': [{
            'id': 'goal_fixture_' + str(stage), 'type': 'function',
            'function': {'name': tool, 'arguments': arguments}}]}, ('length' if stage == 0 else 'tool_calls'), None
    if stage == 2:
        return {'role': 'assistant', 'content': 'The remaining file has been written.'}, 'stop', None
    if stage == 4:
        users = [m.get('content') for m in body['messages'] if m.get('role') == 'user']
        tokens = re.findall(r'"nonce"\s*:\s*"([a-f0-9]{48})"', json.dumps(users, ensure_ascii=False).replace('\\"', '"'))
        assert tokens, 'Missing production review nonce'
        return {'role': 'assistant', 'content': json.dumps({'schemaVersion': 1, 'nonce': tokens[-1],
                'result': 'pass', 'summary': 'Read finished.txt and verified retained work.', 'gaps': []})}, 'stop', None
    raise AssertionError('Unexpected model retry ' + str(stage))


def controller_case(args, root, proc, fixture, incoming, updates, report, reader):
    work = root / 'work'
    seeds = {'RUN_ID.txt': 'synthetic-retained-run-identity\n', 'existing.txt': 'Keep prior work\n'}
    for name, value in seeds.items():
        (work / name).write_text(value, encoding='utf-8')
    before = {name: ((work / name).read_bytes(), (work / name).stat().st_mtime_ns) for name in seeds}
    ref = 'task-goal-native-fixture'
    provider = json.loads(captured['env'][fixture_module.dsh_gateway.PROFILE_ENV])['soduwork']
    cfg = {'llm': {'base': provider['baseURL'], 'model': fixture_module.MODEL,
                   'key': fixture_module.KEY, 'localOnly': True}}
    run = dict(cli='dsh', cliSid='', ws=str(work), state='running', mode='work', seq=0, lines=[], queue=[],
               segment=1, round=1, turnStartSeq=0, cfg=cfg, artifactMode='files', conversationMode='goal',
               expectedOutputPaths=['finished.txt'], expectedOutputBaseline={}, admissionKey='native-admission')
    base._RUNS[ref] = run
    goal.initialize(run, {'schemaVersion': 1, 'objective': 'Preserve RUN_ID.txt and existing.txt; finish and verify finished.txt.',
                         'acceptance': 'finished.txt contains Completed exactly once.', 'budgetMinutes': 5, 'maxSteps': 20})
    queued = []

    def enqueue(exe, argv, prompt, ws, ref, cfg, prof):
        run['turnStartSeq'] = run['seq']
        goal.begin_turn(run)
        queued.append((argv[0], prompt))

    prof = dict(base._PROFILES['dsh'], bin=lambda: 'fixture-launcher', compact=None,
                resume=lambda sid, mode, ws, cfg: [sid], start=lambda sid, mode, ws, cfg: [sid])
    prompt = goal.work_prompt(run, 'FIXTURE:parent: Continue the synthetic file task.')
    codes, native_ids, boundaries = [], [], []
    with patch.object(base, '_STORE', str(root / 'archive')), patch.object(stream, '_STORE', str(root / 'archive')), \
            patch.object(ai_local, '_STORE', str(root / 'archive')), patch.object(stream, '_spawn', side_effect=enqueue), \
            patch.dict(base._PROFILES, {'dsh': prof}):
        current = proc
        for attempt in range(5):
            if attempt == 0:
                current.stdin.write(prompt)
                current.stdin.close()
                current.wait(timeout=30)
                reader.join(timeout=3)
                assert not reader.is_alive(), 'First bridge stream did not close'
                events = []
                while not incoming.empty():
                    events.append(incoming.get_nowait())
            else:
                native, prompt = queued.pop(0)
                command = list(captured['argv'])
                index = command.index('--')
                command[index:index] = ['--session', native]
                flags = ({'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0)}
                         if os.name == 'nt' else {'start_new_session': True})
                current = original_popen(command, cwd=work, env=captured['env'], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', **flags)
                try:
                    stdout, stderr = current.communicate(prompt, timeout=30)
                    events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
                    assert not stderr or current.returncode in (0, 2), stderr[-1500:]
                finally:
                    ownership = fixture_module.OwnedProcessGroup(current.pid) if os.name != 'nt' else None
                    fixture_module.close_process(current, [], ownership)
            codes.append(current.returncode)
            updates.extend(events)
            terminal = {}
            for event in events:
                if event.get('fixtureEOF'):
                    continue
                assert not event.get('error'), event
                stream._on_line(ref, json.dumps(event), terminal)
                if event.get('type') == 'session':
                    native_ids.append(event['sessionID'])
            stream._finish(ref, current.returncode, terminal, '')
            boundaries.append({'attempt': attempt, 'code': current.returncode, 'state': run['state'],
                               'goal': goal.snapshot(run), 'modelCalls': fixture.calls['parent']})
            if not queued:
                break
        report.update(productionPythonBridge=True, productionTaskController=True,
                      substitutedBoundaries=['loopback model responses', 'process scheduling callback'],
                      processCodes=codes, nativeSessionIds=native_ids, taskBoundaries=boundaries,
                      taskGoal=goal.snapshot(run), outputRecoveries=run['goalState']['outputRecoveries'])
        assert codes == [2, 0, 0], codes
        assert boundaries[0]['modelCalls'] == 1, 'Bridge multiplied the task recovery budget'
        assert len(set(native_ids)) == 1 and len(native_ids) == 3, native_ids
        assert run['state'] == 'done' and run['goalState']['status'] == 'completed', report
        assert run['goalState']['outputRecoveries'] == 1
        assert (work / 'finished.txt').read_text() == 'Completed exactly once.\n'
        assert not (work / 'truncated.txt').exists()
        report['existingFilesPreserved'] = all(((work/name).read_bytes(), (work/name).stat().st_mtime_ns) == value for name,value in before.items())
        assert report['existingFilesPreserved']
        sessions = fixture_module.native_session_summary(args.node, root)
        report['nativeSessions'] = sessions
        assert len(sessions) == 1
        assert [call['name'] for call in sessions[0]['toolCalls']] == ['write', 'read'], sessions
    base._RUNS.pop(ref, None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adapter-entry', type=Path, required=True)
    parser.add_argument('--runtime-root', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.expect_bug = False
    for name in ('adapter_entry', 'runtime_root', 'node'):
        setattr(args, name, getattr(args, name).resolve(strict=True))
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    files = [args.adapter_entry.parent.parent / 'package.json', *args.adapter_entry.parent.glob('*.js')]
    files += [args.runtime_root / 'node_modules/@deepseek-ai' / package / name
              for package, name in [('dsh', 'package.json'), ('dsh-agent', 'lib/index.js'),
                                    ('dsh-subagent', 'lib/index.js'), ('dsh-acp', 'lib/index.js')]]
    before = fixture_module.fingerprint(files)
    with tempfile.TemporaryDirectory(prefix='soduwork-task-goal-native-') as folder:
        temporary = Path(folder).resolve()
        installation = temporary / 'installation'
        link = installation / 'agent-runtimes/dsh-host'
        link.parent.mkdir(parents=True)
        if os.name == 'nt':
            shutil.copytree(args.runtime_root, link)
        else:
            link.symlink_to(args.runtime_root, target_is_directory=True)
        with patch.object(fixture_module.Fixture, 'response', model_response), \
                patch.object(fixture_module, 'run_truncated_tool_case', controller_case), \
                patch.object(fixture_module.dsh_runtime, 'apply_env', apply_env), \
                patch.object(subprocess, 'Popen', popen):
            report = fixture_module.run_case(args, 'bridge-truncated-tool', temporary / 'case', output, installation)
    report['installedInputsUnchanged'] = before == fixture_module.fingerprint(files)
    report['node'] = subprocess.check_output([str(args.node), '--version'], text=True).strip()
    report['platform'] = sys.platform
    report['adapter'] = json.loads((args.adapter_entry.parent.parent / 'package.json').read_text())['version']
    (output / 'summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: report.get(key) for key in ('ok', 'error', 'processCodes', 'taskGoal',
                                                    'outputRecoveries', 'installedInputsUnchanged', 'calls')}))
    return 0 if report.get('ok') and report['installedInputsUnchanged'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

"""Isolated ACP executable used to prove declaration-only Runner expansion."""
import json
import os
from pathlib import Path
import sys


def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8')
    assert os.environ['FIXTURE_MODEL'] == 'fixture-model'
    assert os.environ['FIXTURE_KEY'] == 'fixture-secret'
    assert Path(os.environ['FIXTURE_HOME']).is_dir()
    cwd, resumed = '', False
    for raw in sys.stdin:
        message = json.loads(raw)
        method, params = message.get('method'), message.get('params') or {}
        if method == 'initialize':
            result = {'protocolVersion': 1, 'agentCapabilities': {
                'loadSession': True, 'sessionCapabilities': {'resume': {}}},
                'agentInfo': {'name': 'catalog-fixture', 'version': '1'}}
        elif method == 'session/new':
            cwd = params['cwd']
            result = {'sessionId': 'catalog-fixture-session'}
        elif method in {'session/resume', 'session/load'}:
            assert params['sessionId'] == 'catalog-fixture-session'
            cwd = params['cwd']
            assert (Path(cwd) / 'catalog-result.md').is_file()
            resumed = True
            result = {}
        elif method == 'session/prompt':
            content = '# Catalog result\n' + ('Resumed successfully\n' if resumed else 'First turn delivered\n')
            send({'jsonrpc': '2.0', 'id': 900, 'method': 'fs/write_text_file',
                  'params': {'sessionId': 'catalog-fixture-session',
                             'path': str(Path(cwd) / 'catalog-result.md'), 'content': content}})
            response = json.loads(sys.stdin.readline())
            assert response.get('id') == 900 and 'error' not in response, response
            send({'jsonrpc': '2.0', 'method': 'session/update', 'params': {
                'sessionId': 'catalog-fixture-session', 'update': {
                    'sessionUpdate': 'agent_message_chunk',
                    'content': {'type': 'text', 'text': '已完成，成果保存在 catalog-result.md。'}}}})
            result = {'stopReason': 'end_turn'}
        else:
            raise AssertionError('Unexpected ACP method: ' + str(method))
        send({'jsonrpc': '2.0', 'id': message['id'], 'result': result})


if __name__ == '__main__':
    main()

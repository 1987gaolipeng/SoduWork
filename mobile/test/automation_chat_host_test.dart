import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/automation_chat_host.dart';
import 'package:soduwork_mobile/core/automation_execution_directory.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'memory_device_auth.dart';

void main() {
  test('new plans prefer an authorized online personal runner over cloud and offline seats', () {
    final result = mergeAutomationExecutionDirectory({}, {'targets': [
      {'id': 'runner:cloud:pi', 'agentId': 'pi', 'runnerId': 'cloud', 'runnerKind': 'cloud', 'online': true},
      {'id': 'runner:offline:pi', 'agentId': 'pi', 'runnerId': 'offline', 'runnerKind': 'work-computer', 'online': false},
      {'id': 'runner:mine:pi', 'agentId': 'pi', 'runnerId': 'mine', 'runnerKind': 'work-computer', 'online': true},
    ]});
    final rows = result['substrates'] as List;
    expect(rows.map((row) => row['key']), ['runner:mine:pi', 'runner:cloud:pi']);
  });

  test(
    'remote directory uses only authorized online runner target identifiers',
    () {
      final merged = mergeAutomationExecutionDirectory(
        {
          'substrates': [
            {'key': 'local:pi', 'name': 'Pi', 'available': false},
          ],
          'availability': {'agentReason': '本机 Agent 尚未在线'},
        },
        {
          'targets': [
            {
              'id': 'runner:mine:pi',
              'agentId': 'pi',
              'type': 'agent',
              'remote': true,
              'online': true,
              'name': '测试电脑 · Pi',
            },
            {
              'id': 'runner:offline:pi',
              'agentId': 'pi',
              'type': 'agent',
              'remote': true,
              'online': false,
            },
            {
              'id': 'local:forged',
              'agentId': 'pi',
              'type': 'agent',
              'remote': true,
              'online': true,
            },
            {
              'id': 'runner:mine:pi',
              'agentId': 'pi',
              'type': 'agent',
              'remote': true,
              'online': true,
            },
          ],
        },
      );
      expect((merged['substrates'] as List).map((row) => row['key']), [
        'local:pi',
        'runner:mine:pi',
      ]);
      expect(merged['availability']['agentReason'], '');
    },
  );

  test(
    'parse uses the desktop automation contract without creating a schedule',
    () async {
      final calls = <String>[];
      final api = _api((request) async {
        calls.add(request.url.path);
        final body = jsonDecode(request.body);
        expect(body['kind'], 'automation');
        expect(body['instruction'], '改为每周五');
        expect(body['model'], 'allowed-model');
        expect(body['candidates']['agents'][0]['id'], 'runner:mine:pi');
        return _json({
          'ok': true,
          'fields': {'title': '周报', 'note': '整理进展'},
        });
      });
      final host = _host(api);
      expect(
        await host.handle('parse', {
          'text': '已有草稿；改为每周五',
          'instruction': '改为每周五',
          'model': 'allowed-model',
          'candidates': {
            'agents': [
              {'id': 'runner:mine:pi', 'name': 'Pi'},
            ],
          },
        }),
        {'title': '周报', 'note': '整理进展'},
      );
      expect(calls, ['/api/v1/tasks/parse']);
    },
  );

  test(
    'creation preflights the real seat, strips owner injection and always saves paused',
    () async {
      final calls = <String>[];
      final api = _api((request) async {
        calls.add(request.url.path);
        final body = jsonDecode(request.body);
        expect(body['enabled'], false);
        expect(body['assigneeId'], 'runner:mine:pi');
        expect(body['modelName'], 'allowed-model');
        expect(body.containsKey('ownerClientId'), false);
        expect(body.containsKey('scheduleId'), false);
        if (request.url.path.endsWith('preflight')) {
          return _json({'state': 'ready'});
        }
        return _json({'id': 'new', 'title': '计划', ...body});
      });
      final host = _host(api);
      final result = await host.handle('create', {
        'title': '计划',
        'note': '汇总',
        'every': 'daily',
        'assigneeId': 'runner:mine:pi',
        'modelName': 'allowed-model',
        'enabled': true,
        'ownerClientId': 'another',
        'scheduleId': 'other',
      });
      expect((result as Map)['id'], 'new');
      expect(calls, ['/api/v1/schedules/preflight', '/api/v1/schedules']);
      await expectLater(host.handle('create', {}), throwsA(isA<ApiFailure>()));
      expect(calls.length, 2);
    },
  );

  test('unknown preflight and stale identity never create', () async {
    var writes = 0;
    final api = _api((request) async {
      if (request.url.path.endsWith('preflight')) {
        return _json({'state': 'blocked', 'message': '无权限'});
      }
      writes++;
      return _json({});
    });
    await expectLater(
      _host(api).handle('create', {'title': 'test'}),
      throwsA(isA<ApiFailure>()),
    );
    expect(writes, 0);
    final response = Completer<http.Response>();
    var active = true;
    final lateHost = AutomationChatHost(
      api: _api((_) => response.future),
      identity: 'owner',
      dark: false,
      checkCurrent: () {
        if (!active) throw const ApiFailure('账号变更');
      },
      onClose: () {},
    );
    final pending = lateHost.handle('models', {});
    active = false;
    response.complete(_json({'usable': []}));
    await expectLater(pending, throwsA(isA<ApiFailure>()));
  });

  test('uncertain creation blocks repeat writes', () async {
    var count = 0;
    final api = _api((request) async {
      if (request.url.path.endsWith('preflight')) {
        return _json({'state': 'ready'});
      }
      count++;
      throw http.ClientException('connection closed');
    });
    final host = _host(api);
    await expectLater(
      host.handle('create', {'title': 'test'}),
      throwsA(isA<ApiFailure>()),
    );
    await expectLater(
      host.handle('create', {'title': 'test'}),
      throwsA(isA<ApiFailure>()),
    );
    expect(count, 1);
  });

  test('host exposes no device or model credentials', () async {
    final host = _host(
      _api(
        (_) async => _json({
          'usable': [
            {
              'name': 'one',
              'label': '模型',
              'config': {'apiKey': 'secret'},
              'key': 'secret',
            },
          ],
        }),
      ),
    );
    final result = await host.handle('models', {});
    expect(result, {
      'usable': [
        {'name': 'one', 'label': '模型'},
      ],
    });
    await expectLater(host.handle('admin', {}), throwsA(isA<ApiFailure>()));
  });
}

AutomationChatHost _host(SoduWorkApi api) => AutomationChatHost(
  api: api,
  identity: 'owner:device',
  dark: false,
  checkCurrent: () {},
  onClose: () {},
);
SoduWorkApi _api(Future<http.Response> Function(http.Request) handler) => SoduWorkApi(
  store: _Store(),
  endpoint: const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'https://hub.test',
  ),
  client: MockClient(handler),
);
http.Response _json(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json'},
);

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'session';
}

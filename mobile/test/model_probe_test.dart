import 'memory_device_auth.dart';
import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/model_probe.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

void main() {
  test(
    'explicit probe uses isolated ticket, fixed endpoint, bounded request',
    () async {
      final requests = <http.Request>[];
      final api = _api(
        MockClient((request) async {
          requests.add(request);
          if (request.method == 'GET') {
            return _json({
              'ok': true,
              'key': 'fixture-short-ticket',
              'model': 'chat-model',
              'path': 'https://untrusted.example/collect',
              'mcpKey': 'fixture-mcp-ticket',
            });
          }
          return _json({
            'choices': [
              {
                'message': {'content': '连接正常'},
              },
            ],
          });
        }),
      );
      final result = await ModelProbe(
        api,
      ).run('chat-model', isCurrent: () => true);
      expect(result.model, 'chat-model');
      expect(requests, hasLength(2));
      expect(
        requests.first.headers['Authorization'],
        'Device fixture-device-session',
      );
      expect(requests.first.url.queryParameters, {
        'model': 'chat-model',
        'agent': 'pi',
      });
      expect(
        requests.last.url.toString(),
        'https://hub.test/api/v1/ai-proxy/v1/chat/completions',
      );
      expect(
        requests.last.headers['Authorization'],
        'Bearer fixture-short-ticket',
      );
      expect(requests.last.followRedirects, isFalse);
      final body = jsonDecode(requests.last.body) as Map;
      expect(body['stream'], isFalse);
      expect(body['max_tokens'], 1024);
      expect(body.containsKey('tools'), isFalse);
      expect(body['messages'], hasLength(1));
    },
  );

  test('unavailable config does not invoke a paid model request', () async {
    var count = 0;
    final api = _api(
      MockClient((_) async {
        count++;
        return _json({'ok': false, 'reason': '此模型尚未授权'});
      }),
    );
    await expectLater(
      ModelProbe(api).run('chat-model', isCurrent: () => true),
      throwsA(isA<ApiFailure>().having((e) => e.message, 'reason', '此模型尚未授权')),
    );
    expect(count, 1);
  });

  test(
    'identity change after configuration prevents model invocation',
    () async {
      var current = true;
      var count = 0;
      final api = _api(
        MockClient((_) async {
          count++;
          current = false;
          return _json({'ok': true, 'key': 'fixture', 'model': 'chat-model'});
        }),
      );
      await expectLater(
        ModelProbe(api).run('chat-model', isCurrent: () => current),
        throwsA(
          isA<ApiFailure>().having((e) => e.status, 'scope conflict', 409),
        ),
      );
      expect(count, 1);
    },
  );

  test('late completion after identity change is discarded', () async {
    var current = true;
    final pending = Completer<http.Response>();
    final sent = Completer<void>();
    final api = _api(
      MockClient((request) async {
        if (request.method == 'GET') {
          return _json({'ok': true, 'key': 'fixture', 'model': 'chat-model'});
        }
        sent.complete();
        return pending.future;
      }),
    );
    final operation = ModelProbe(
      api,
    ).run('chat-model', isCurrent: () => current);
    final rejected = expectLater(
      operation,
      throwsA(isA<ApiFailure>().having((e) => e.status, 'scope conflict', 409)),
    );
    await sent.future;
    current = false;
    pending.complete(
      _json({
        'choices': [
          {
            'message': {'content': 'old account'},
          },
        ],
      }),
    );
    await rejected;
  });

  test(
    'provider error is actionable and suppresses ticket and bearer strings',
    () async {
      final api = _api(
        MockClient((request) async {
          if (request.method == 'GET') {
            return _json({
              'ok': true,
              'key': 'fixture-ticket',
              'model': 'chat-model',
            });
          }
          return _json({
            'error': {
              'message': '额度不足 fixture-ticket Bearer fixture-other sk-fixture',
            },
          }, 429);
        }),
      );
      await expectLater(
        ModelProbe(api).run('chat-model', isCurrent: () => true),
        throwsA(
          isA<ApiFailure>()
              .having((e) => e.status, 'status', 429)
              .having((e) => e.message, 'reason', contains('额度不足'))
              .having(
                (e) => e.message,
                'credential removed',
                isNot(contains('fixture')),
              ),
        ),
      );
    },
  );

  test('empty model replies do not claim successful connectivity', () async {
    final api = _api(
      MockClient(
        (request) async => request.method == 'GET'
            ? _json({'ok': true, 'key': 'fixture', 'model': 'chat-model'})
            : _json({
                'choices': [
                  {
                    'message': {'content': ''},
                  },
                ],
              }),
      ),
    );
    await expectLater(
      ModelProbe(api).run('chat-model', isCurrent: () => true),
      throwsA(
        isA<ApiFailure>().having(
          (e) => e.message,
          'empty reply',
          contains('空回复'),
        ),
      ),
    );
  });

  test(
    'changed resolved model does not silently charge a different selection',
    () async {
      var count = 0;
      final api = _api(
        MockClient((_) async {
          count++;
          return _json({'ok': true, 'key': 'fixture', 'model': 'other-model'});
        }),
      );
      await expectLater(
        ModelProbe(api).run('chat-model', isCurrent: () => true),
        throwsA(isA<ApiFailure>()),
      );
      expect(count, 1);
    },
  );
}

SoduWorkApi _api(http.Client client) => SoduWorkApi(
  store: _Store(),
  endpoint: const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'https://hub.test',
  ),
  client: client,
);

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async =>
      'fixture-device-session';
}

http.Response _json(Object data, [int status = 200]) => http.Response(
  jsonEncode(data),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

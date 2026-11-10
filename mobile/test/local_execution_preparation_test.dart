import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'memory_device_auth.dart';

class TestStore extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
  @override
  Future<DeviceCredentials> credentials(String endpoint) async =>
      const DeviceCredentials(
        id: 'mobile-fixture',
        secret: 'unit-test-device-secret-000000000000',
        name: 'fixture',
        platform: 'Web',
      );
}

SoduWorkApi apiFor(
  http.Client client, {
  String name = 'SoduWork Web 联调',
  String endpoint = 'http://10.1.2.3:18893',
}) => SoduWorkApi(
  store: TestStore(),
  client: client,
  deviceDisplayName: name,
  endpoint: EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: endpoint,
  ),
);

void main() {
  test('ready cloud requirement options skip device preparation', () async {
    for (final locations in [
      [
        {'mode': 'local', 'runnerId': 'device-runner'},
        {'mode': 'remote', 'runnerId': 'cloud-runner'},
      ],
      <Map<String, String>>[],
    ]) {
      final calls = <String>[];
      final api = apiFor(
        MockClient((request) async {
          calls.add(request.url.path);
          expect(request.url.path, '/api/v1/task-execution-options');
          expect(request.headers['Authorization'], 'Device fixture-session');
          expect(jsonDecode(request.body), {'taskId': 'r3', 'repoId': ''});
          return http.Response(
            jsonEncode({
              'substrates': [
                {
                  'key': 'local:pi',
                  'available': true,
                  'locationMode': 'remote',
                  'locations': locations,
                },
              ],
            }),
            200,
          );
        }),
        endpoint: 'http://127.0.0.1:18899',
      );
      final result = await api.taskExecutionOptions({
        'taskId': 'r3',
        'repoId': '',
      });
      expect((result['substrates'] as List).single['locations'], locations);
      expect(calls, ['/api/v1/task-execution-options']);
      expect(api.localExecutionRunnerId, isNull);
    }
  });

  test(
    'local-only requirements retain verified device preparation and refetch',
    () async {
      final calls = <String>[];
      final api = apiFor(
        MockClient((request) async {
          calls.add(request.url.path);
          if (request.url.path.endsWith('/preview-version')) {
            return http.Response(
              '{}',
              200,
              headers: {'x-soduwork-local-only': 'true'},
            );
          }
          if (request.url.path.endsWith('/execution')) {
            return http.Response(
              '{"ready":true,"runnerId":"device-runner"}',
              200,
            );
          }
          expect(jsonDecode(request.body), {'taskId': 'local-task'});
          return http.Response(
            '{"substrates":[{"available":true,"locations":[{"mode":"local"}]}]}',
            200,
          );
        }),
      );
      await api.taskExecutionOptions({'taskId': 'local-task'});
      expect(calls, [
        '/api/v1/task-execution-options',
        '/__mobile_local__/preview-version',
        '/api/v1/mobile-local/execution',
        '/api/v1/task-execution-options',
      ]);
      expect(api.localExecutionRunnerId, 'device-runner');
    },
  );

  test(
    'cloud requirements do not join an already pending device preparation',
    () async {
      final marker = Completer<http.Response>();
      final started = Completer<void>();
      var deviceCalls = 0;
      final api = apiFor(
        MockClient((request) async {
          if (request.url.path.endsWith('/preview-version')) {
            started.complete();
            return marker.future;
          }
          if (request.url.path.endsWith('/execution')) deviceCalls++;
          expect(request.url.path, '/api/v1/task-execution-options');
          return http.Response(
            '{"substrates":[{"available":true,"locations":[{"mode":"remote","runnerId":"cloud"}]}]}',
            200,
          );
        }),
      );
      final preparing = api.prepareLocalExecution();
      final cancelled = expectLater(preparing, throwsA(isA<ApiFailure>()));
      await started.future;
      try {
        final options = await api
            .taskExecutionOptions({'taskId': 'r3'})
            .timeout(const Duration(seconds: 2));
        expect(options['substrates'], isNotEmpty);
        expect(deviceCalls, 0);
      } finally {
        api.invalidateAuthentication();
        marker.complete(
          http.Response('{}', 200, headers: {'x-soduwork-local-only': 'true'}),
        );
        await cancelled;
      }
      expect(deviceCalls, 0);
    },
  );

  test(
    'ready authorized personal Runner never waits for device preparation',
    () async {
      final calls = <String>[];
      final api = apiFor(
        MockClient((request) async {
          calls.add(request.url.path);
          expect(request.headers['Authorization'], 'Device fixture-session');
          expect(request.url.path, '/api/v1/conversation-handoffs/targets');
          return http.Response(
            jsonEncode({
              'targets': [
                {
                  'type': 'agent',
                  'remote': true,
                  'online': true,
                  'agentId': 'pi',
                  'runnerId': 'authorized-personal-runner',
                },
              ],
            }),
            200,
          );
        }),
      );
      final result = await api.cloudConversationTargets();
      expect(
        (result['targets'] as List).single['runnerId'],
        'authorized-personal-runner',
      );
      expect(calls, ['/api/v1/conversation-handoffs/targets']);
      // Reading the personal catalog cannot mark a device/automation helper ready.
      expect(api.localExecutionRunnerId, isNull);
    },
  );

  test('offline and malformed targets cannot skip device readiness', () async {
    for (final target in [
      {'type': 'agent', 'remote': true, 'online': false, 'agentId': 'pi'},
      {'type': 'agent', 'remote': false, 'online': true, 'agentId': 'pi'},
      {'type': 'agent', 'remote': true, 'online': true, 'agentId': ''},
    ]) {
      var reads = 0, prepared = false;
      final api = apiFor(
        MockClient((request) async {
          if (request.url.path.endsWith('/preview-version')) {
            return http.Response(
              '{}',
              200,
              headers: {'x-soduwork-local-only': 'true'},
            );
          }
          if (request.url.path.endsWith('/execution')) {
            prepared = true;
            return http.Response('{"ready":true}', 200);
          }
          reads++;
          return http.Response(
            jsonEncode({
              'targets': reads == 1 ? [target] : [],
            }),
            200,
          );
        }),
      );
      final result = await api.cloudConversationTargets();
      expect(prepared, isTrue);
      expect(reads, 2);
      expect(result['targets'], isEmpty);
    }
  });

  test(
    'empty directory prepares only own device after verifying gateway',
    () async {
      final calls = <String>[];
      final api = apiFor(
        MockClient((request) async {
          calls.add(request.url.path);
          if (request.url.path.endsWith('/preview-version')) {
            expect(request.headers.containsKey('Authorization'), false);
            return http.Response(
              '{}',
              200,
              headers: {'x-soduwork-local-only': 'true'},
            );
          }
          expect(request.headers['Authorization'], 'Device fixture-session');
          if (request.url.path.endsWith('/execution')) {
            expect(jsonDecode(request.body), {
              'device': 'mobile-fixture',
              'secret': 'unit-test-device-secret-000000000000',
            });
            return http.Response('{"ready":true}', 200);
          }
          return http.Response('{"targets":[]}', 200);
        }),
      );
      await Future.wait([
        api.cloudConversationTargets(),
        api.automationExecutionOptions(),
      ]);
      expect(calls.where((p) => p.endsWith('/execution')).length, 1);
      expect(
        calls.indexOf('/__mobile_local__/preview-version'),
        lessThan(calls.indexOf('/api/v1/mobile-local/execution')),
      );
      await api.cloudConversationTargets();
      expect(calls.where((p) => p.endsWith('/execution')).length, 1);
    },
  );
  test(
    'ordinary and production clients never register device secrets',
    () async {
      for (final pair in [
        ('SoduWork Mobile', 'http://10.1.2.3:18893'),
        ('SoduWork Web 联调', 'https://work.example.com'),
      ]) {
        final api = apiFor(
          MockClient((request) async {
            expect(request.url.path, '/api/v1/conversation-handoffs/targets');
            return http.Response('{"targets":[]}', 200);
          }),
          name: pair.$1,
          endpoint: pair.$2,
        );
        await api.cloudConversationTargets();
      }
    },
  );
  test('unverified gateway cannot receive registration secrets', () async {
    var count = 0;
    final api = apiFor(
      MockClient((request) async {
        count++;
        expect(request.method, 'GET');
        return http.Response(
          request.url.path == '/api/v1/conversation-handoffs/targets'
              ? '{"targets":[]}'
              : '{}',
          200,
        );
      }),
    );
    await expectLater(
      api.cloudConversationTargets(),
      throwsA(isA<ApiFailure>()),
    );
    expect(count, 2); // Read-only directory, then rejected gateway marker.
  });
  test(
    'identity switch invalidates preparation before credentials can be sent',
    () async {
      final pending = Completer<http.Response>();
      final started = Completer<void>();
      var count = 0;
      final api = apiFor(
        MockClient((request) {
          count++;
          started.complete();
          return pending.future;
        }),
      );
      final operation = api.cloudConversationTargets();
      final expectation = expectLater(operation, throwsA(isA<ApiFailure>()));
      await started.future;
      api.invalidateAuthentication();
      pending.complete(
        http.Response('{}', 200, headers: {'x-soduwork-local-only': 'true'}),
      );
      await expectation;
      expect(count, 1);
    },
  );
  testWidgets(
    'preparation has one deadline, ignores late readiness and permits retry',
    (tester) async {
      var executionCalls = 0;
      final late = Completer<http.Response>();
      final api = apiFor(
        MockClient((request) async {
          if (request.url.path.endsWith('/preview-version')) {
            return http.Response(
              '{}',
              200,
              headers: {'x-soduwork-local-only': 'true'},
            );
          }
          if (request.url.path.endsWith('/execution')) {
            executionCalls++;
            if (executionCalls == 1) {
              await Future<void>.delayed(const Duration(seconds: 15));
              return http.Response('{"ready":false}', 200);
            }
            if (executionCalls == 2) return late.future;
            return http.Response('{"ready":true,"runnerId":"verified"}', 200);
          }
          return http.Response('{"targets":[]}', 200);
        }),
      );
      final operation = api.prepareLocalExecution();
      final expectation = expectLater(
        operation,
        throwsA(
          isA<ApiFailure>().having(
            (e) => e.message,
            'message',
            contains('准备已超时'),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 15));
      await tester.pump(const Duration(seconds: 1));
      expect(executionCalls, 2);
      await tester.pump(const Duration(seconds: 14));
      await expectation;
      late.complete(http.Response('{"ready":true,"runnerId":"late"}', 200));
      await tester.pump();
      await api.prepareLocalExecution();
      expect(executionCalls, 3);
    },
  );

  test(
    'automation parsing uses existing explicit kind and refuses empty draft',
    () async {
      final api = apiFor(
        MockClient((request) async {
          final body = jsonDecode(request.body);
          expect(body['kind'], 'automation');
          expect(body['model'], 'model-a');
          expect(body['instruction'], 'refine');
          expect(body['candidates'], {'agents': []});
          return http.Response('{"ok":false,"fields":{}}', 200);
        }),
        name: 'SoduWork Mobile',
      );
      await expectLater(
        api.parseAutomation(
          'repeat task',
          model: 'model-a',
          instruction: 'refine',
          candidates: {'agents': []},
        ),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
}

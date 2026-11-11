import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'memory_device_auth.dart';

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'test-session';
  @override
  Future<DeviceCredentials> credentials(String endpoint) async =>
      const DeviceCredentials(
        id: 'mobile-device',
        secret: 'unit-test-secret-000000000000000000000',
        name: 'SoduWork Web 联调 · Web',
        platform: 'Web',
      );
}

void main() {
  SoduWorkApi api(http.Client client, {bool local = false}) => SoduWorkApi(
    store: _Store(),
    client: client,
    deviceDisplayName: local ? 'SoduWork Web 联调' : 'SoduWork Mobile',
    endpoint: EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: local ? 'http://127.0.0.1:18893' : 'https://soduwork.test',
    ),
  );

  test(
    'ordinary PC conversation is not guessed into a task or registered as an inbox',
    () async {
      final seen = <String>[];
      final value = api(
        MockClient((request) async {
          seen.add(request.url.path);
          return http.Response('{}', 200);
        }),
      );
      addTearDown(value.client.close);
      expect((await value.automationConsumerStatus())['ready'], false);
      await expectLater(
        value.automationConversationReceipt('pc-native-id'),
        throwsA(isA<ApiFailure>()),
      );
      expect(seen, isEmpty);
    },
  );

  test(
    'mobile automation conversation resolves its real receipt with current authentication',
    () async {
      const run = 'd9cdfc94-d19f-4459-9c9a-8b139a8d4225';
      final value = api(
        MockClient((request) async {
          expect(request.method, 'GET');
          expect(
            request.url.path,
            '/api/v1/conversation-handoffs/automation-$run',
          );
          expect(request.headers['Authorization'], 'Device test-session');
          return http.Response(
            jsonEncode({
              'ok': true,
              'taskId': 'real-task',
              'phase': 'dispatched',
            }),
            200,
          );
        }),
      );
      addTearDown(value.client.close);
      expect(
        (await value.automationConversationReceipt(
          'mobile-automation:$run',
        ))['taskId'],
        'real-task',
      );
    },
  );

  test(
    'local readiness checks helper after normal executor preparation without registering inbox',
    () async {
      final seen = <String>[];
      final value = api(
        MockClient((request) async {
          seen.add(request.url.path);
          if (request.url.path.endsWith('/preview-version')) {
            return http.Response(
              '{}',
              200,
              headers: {'x-soduwork-local-only': 'true'},
            );
          }
          expect(request.headers['Authorization'], 'Device test-session');
          return http.Response(
            jsonEncode({'ready': true, 'state': 'ready'}),
            200,
          );
        }),
        local: true,
      );
      addTearDown(value.client.close);
      expect((await value.automationConsumerStatus())['ready'], true);
      expect(seen, [
        '/__mobile_local__/preview-version',
        '/api/v1/mobile-local/execution',
        '/api/v1/mobile-local/automation-status',
      ]);
    },
  );
}

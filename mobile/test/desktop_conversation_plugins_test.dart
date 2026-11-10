import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/desktop_conversation_plugins.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

class PluginApi extends SoduWorkApi {
  PluginApi()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://fixture.invalid',
        ),
      );
  bool online = true, synced = true;
  final calls = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> desktopCapabilityTargets() async => {
    'items': [
      {'id': 'pc', 'runnerId': 'runner', 'ready': online},
      {'id': 'other-pc', 'runnerId': 'other-runner', 'ready': true},
    ],
  };
  @override
  Future<Map<String, dynamic>> desktopCapabilityRequest(
    String target,
    String operation,
    Map<String, dynamic> args,
    String requestId,
  ) async {
    calls.add({
      'target': target,
      'op': operation,
      'args': args,
      'requestId': requestId,
    });
    if (operation == 'catalog') {
      return {
        'plugins': [
          {
            'pluginId': 'local:test',
            'name': '测试插件',
            'checksum': 'v1',
            'version': '1.0.0',
            'conversationUse': {'available': true},
          },
        ],
      };
    }
    return {
      'ok': true,
      'sourceSessionId': 'session',
      if (synced)
        'conversation': {
          'id': 'conversation',
          'sourceSessionId': 'session',
          'sourceClientId': target,
        },
    };
  }
}

void main() {
  test(
    'composer selection pins desktop and version, and preserves selected model',
    () async {
      final api = PluginApi();
      addTearDown(api.client.close);
      final host = DesktopConversationPlugins(api, () {});
      final row = ((await host.catalog('runner'))['items'] as List).single;
      expect(row['pluginId'], 'desktop:runner:v1:local:test');
      final args = <String, dynamic>{
        'plugins': [
          {'pluginId': row['pluginId']},
        ],
        'agentId': 'pi',
        'targetRunnerId': 'runner',
        'targetRunnerKind': 'work-computer',
        'text': '只回复 OK',
        'model': 'chosen-model',
        'messageId': 'unique-send-id',
      };
      final result = await host.send(args);
      expect(result.sourceClientId, 'pc');
      expect(api.calls.last['args'], {
        'pluginId': 'local:test',
        'expectedChecksum': 'v1',
        'text': '只回复 OK',
        'modelName': 'chosen-model',
      });
      final before = api.calls.length;
      for (final invalid in [
        {...args, 'targetRunnerId': 'other-runner'},
        {...args, 'agentId': 'codex'},
        {
          ...args,
          'files': [
            {'name': 'file.txt'},
          ],
        },
      ]) {
        await expectLater(host.send(invalid), throwsA(isA<ApiFailure>()));
      }
      expect(api.calls.length, before);
      api.online = false;
      await expectLater(host.send(args), throwsA(isA<ApiFailure>()));
      expect(api.calls.length, before);
    },
  );

  test(
    'pending account sync retries the same durable native receipt',
    () async {
      final api = PluginApi();
      addTearDown(api.client.close);
      final host = DesktopConversationPlugins(api, () {});
      final row = ((await host.catalog('runner'))['items'] as List).single;
      final args = <String, dynamic>{
        'plugins': [
          {'pluginId': row['pluginId']},
        ],
        'agentId': 'pi',
        'targetRunnerId': 'runner',
        'targetRunnerKind': 'work-computer',
        'text': 'work',
        'messageId': 'same-send-id',
      };
      api.synced = false;
      await expectLater(
        host.send(args),
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 503)),
      );
      api.synced = true;
      expect((await host.send(args)).id, 'conversation');
      expect(
        api.calls
            .where((c) => c['op'] == 'plugin.use')
            .map((c) => c['requestId'])
            .toList(),
        ['same-send-id', 'same-send-id'],
      );
    },
  );
}

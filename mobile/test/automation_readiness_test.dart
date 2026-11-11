import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/automation_readiness.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/core/device_store.dart';

class _Api extends SoduWorkApi {
  final List<Map<String, dynamic>> states;
  final bool local;
  int calls = 0;
  _Api(this.states, {this.local = true})
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  @override
  bool get isLocalDevelopment => local;
  @override
  Future<Map<String, dynamic>> automationConsumerStatus() async {
    final index = calls++;
    return states[index.clamp(0, states.length - 1)];
  }
}

void main() {
  test(
    'only an authoritative ready cloud preflight skips the local helper',
    () async {
      for (final preflight in <Map<String, dynamic>?>[
        null,
        {'state': 'waiting', 'executionMode': 'soduwork.cloud-automation/v1'},
        {'state': 'ready', 'executionMode': 'soduwork.automation-conversation/v1'},
        {'state': 'ready', 'executionMode': 'soduwork.cloud-automation/v1'},
      ]) {
        final api = _Api([
          {'ready': true},
        ]);
        addTearDown(api.client.close);
        await ensureAutomationExecutionReady(
          api,
          configuration: {'assigneeId': 'runner:cloud:pi'},
          preflight: preflight,
          checkCurrent: () {},
        );
        expect(
          api.calls,
          preflight?['state'] == 'ready' &&
                  preflight?['executionMode'] == 'soduwork.cloud-automation/v1'
              ? 0
              : 1,
        );
      }
    },
  );

  test(
    'chat availability is insufficient until the automation consumer is ready',
    () async {
      final api = _Api([
        {'ready': false, 'state': 'starting'},
        {'ready': false, 'state': 'preparing'},
        {'ready': true, 'state': 'ready'},
      ]);
      addTearDown(api.client.close);
      var waits = 0;
      await ensureAutomationExecutionReady(
        api,
        configuration: {},
        checkCurrent: () {},
        wait: (_) async {
          waits++;
        },
      );
      expect(api.calls, 3);
      expect(waits, 2);
    },
  );

  test(
    'a failed consumer reports its reason without retrying a dispatch',
    () async {
      final api = _Api([
        {'ready': false, 'state': 'failed', 'reason': '持久化不可用'},
      ]);
      addTearDown(api.client.close);
      await expectLater(
        ensureAutomationExecutionReady(
          api,
          configuration: {},
          checkCurrent: () {},
        ),
        throwsA(isA<ApiFailure>().having((e) => e.message, 'reason', '持久化不可用')),
      );
      expect(api.calls, 1);
    },
  );

  test(
    'identity change stops readiness polling before another request',
    () async {
      final api = _Api([
        {'ready': false, 'state': 'starting'},
      ]);
      addTearDown(api.client.close);
      var changed = false;
      await expectLater(
        ensureAutomationExecutionReady(
          api,
          configuration: {},
          checkCurrent: () {
            if (changed) throw const ApiFailure('账号已变化');
          },
          wait: (_) async {
            changed = true;
          },
        ),
        throwsA(isA<ApiFailure>()),
      );
      expect(api.calls, 1);
    },
  );

  test(
    'offline consumer remains bounded and preserves the actionable reason',
    () async {
      final api = _Api([
        {'ready': false, 'state': 'offline', 'reason': '请启动电脑助手'},
      ]);
      addTearDown(api.client.close);
      await expectLater(
        ensureAutomationExecutionReady(
          api,
          configuration: {},
          checkCurrent: () {},
          wait: (_) async {},
        ),
        throwsA(
          isA<ApiFailure>().having((e) => e.message, 'reason', '请启动电脑助手'),
        ),
      );
      expect(api.calls, 20);
    },
  );

  test(
    'enterprise workflows and remote production retain Hub preflight authority',
    () async {
      for (final api in [_Api([], local: false), _Api([])]) {
        addTearDown(api.client.close);
        await ensureAutomationExecutionReady(
          api,
          configuration: api.local
              ? {'pluginBindingId': 'authorized-binding'}
              : {},
          checkCurrent: () {},
        );
        expect(api.calls, 0);
      }
    },
  );
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/automations_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

class _Api extends SoduWorkApi {
  bool ready = false;
  int consumerChecks = 0, preflights = 0, runs = 0, toggles = 0;
  Map<String, dynamic> preflight = {'state': 'ready'};
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  @override
  bool get isLocalDevelopment => true;
  @override
  Future<Map<String, dynamic>> automationConsumerStatus() async {
    consumerChecks++;
    return {
      'ready': ready,
      'state': ready ? 'ready' : 'failed',
      'reason': '电脑自动化助手尚未启动',
    };
  }

  @override
  Future<List<Map<String, dynamic>>> automationTemplates() async => [];
  @override
  Future<List<AutomationSchedule>> automations() async => [
    AutomationSchedule.fromJson({
      'id': 'schedule',
      'title': '周报验收',
      'enabled': false,
      'every': 'weekly',
      'assigneeId': 'local:pi',
    }),
  ];
  @override
  Future<Map<String, dynamic>> preflightAutomation(
    Map<String, dynamic> body,
  ) async {
    preflights++;
    return preflight;
  }

  @override
  Future<Map<String, dynamic>> runAutomation(String id) async {
    runs++;
    return {'ok': true, 'scheduleRunId': 'run', 'waitingForDevice': true};
  }

  @override
  Future<AutomationSchedule> setAutomationEnabled(
    String id,
    bool enabled,
  ) async {
    toggles++;
    return AutomationSchedule.fromJson({
      'id': id,
      'title': '周报验收',
      'enabled': enabled,
    });
  }

  @override
  Future<List<AutomationRun>> automationRuns(
    String id, {
    int limit = 20,
  }) async => [
    AutomationRun.fromJson({
      'id': 'run',
      'scheduleId': id,
      'state': 'succeeded',
      'trigger': 'manual',
    }),
  ];
}

void main() {
  Future<_Api> mount(WidgetTester tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = _Api();
    final state = MobileState()
      ..api = api
      ..phase = MobilePhase.ready;
    addTearDown(state.dispose);
    addTearDown(api.client.close);
    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: const MaterialApp(home: AutomationsScreen()),
      ),
    );
    await tester.pumpAndSettle();
    return api;
  }

  testWidgets(
    'manual run cannot bypass missing consumer and can retry after recovery',
    (tester) async {
      final api = await mount(tester);
      await tester.ensureVisible(find.text('立即运行'));
      await tester.tap(find.text('立即运行'));
      await tester.pumpAndSettle();
      expect(find.text('电脑自动化助手尚未启动'), findsOneWidget);
      expect(api.runs, 0);
      expect(api.preflights, 1);
      api.ready = true;
      await tester.tap(find.text('立即运行'));
      await tester.pumpAndSettle();
      expect(api.consumerChecks, 2);
      expect(api.preflights, 2);
      expect(api.runs, 1);
      expect(find.text('已完成'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('enabling a schedule also requires the persistent consumer', (
    tester,
  ) async {
    final api = await mount(tester);
    await tester.ensureVisible(find.byType(Switch));
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(api.consumerChecks, 1);
    expect(api.toggles, 0);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    expect(find.text('电脑自动化助手尚未启动'), findsOneWidget);
  });

  testWidgets(
    'verified cloud execution does not depend on the local consumer',
    (tester) async {
      final api = await mount(tester);
      api.preflight = {
        'state': 'ready',
        'executionMode': 'soduwork.cloud-automation/v1',
      };
      await tester.ensureVisible(find.text('立即运行'));
      await tester.tap(find.text('立即运行'));
      await tester.pumpAndSettle();
      expect(api.consumerChecks, 0);
      expect(api.preflights, 1);
      expect(api.runs, 1);
      expect(find.text('电脑自动化助手尚未启动'), findsNothing);
    },
  );

  testWidgets('unavailable cloud target cannot launch or enable a plan', (
    tester,
  ) async {
    final api = await mount(tester);
    api.preflight = {'state': 'waiting', 'message': '所选云端执行机未就绪'};
    await tester.ensureVisible(find.text('立即运行'));
    await tester.tap(find.text('立即运行'));
    await tester.pumpAndSettle();
    expect(api.runs, 0);
    expect(api.consumerChecks, 0);
    expect(find.text('所选云端执行机未就绪'), findsOneWidget);
    await tester.ensureVisible(find.byType(Switch));
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(api.toggles, 0);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
  });
}

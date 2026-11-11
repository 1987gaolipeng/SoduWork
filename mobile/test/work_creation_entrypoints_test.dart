import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/automations_screen.dart';
import 'package:soduwork_mobile/screens/work_screen.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/automation_editor.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/task_forms.dart';

class _Api extends SoduWorkApi {
  final List<AutomationSchedule> schedules;
  int executionLoads = 0;
  _Api({this.schedules = const []})
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  @override
  Future<List<AutomationSchedule>> automations() async => schedules;
  @override
  Future<List<Map<String, dynamic>>> automationTemplates() async => [];
  @override
  Future<Map<String, dynamic>> taskExecutionOptions(
    Map<String, dynamic> body,
  ) async {
    executionLoads++;
    return {
      'substrates': [
        {'key': 'local:pi', 'name': 'Pi', 'available': true},
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> automationExecutionOptions() =>
      taskExecutionOptions({});

  @override
  Future<Map<String, dynamic>> cloudConversationTargets() async => {
    'targets': [],
  };
}

class _Navigation extends NavigatorObserver {
  int pushes = 0;
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    pushes++;
    super.didPush(route, previousRoute);
  }
}

Future<void> _show(
  WidgetTester tester,
  MobileState state,
  Widget screen,
  _Navigation navigation,
) async {
  addTearDown(state.dispose);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(const SoduWorkBrandTheme()),
        navigatorObservers: [navigation],
        home: Scaffold(body: screen),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('需求池新建只调用父级对话入口一次，不打开旧表单', (tester) async {
    var created = 0;
    final api = _Api(), navigation = _Navigation();
    final state = MobileState()..api = api;
    await _show(
      tester,
      state,
      WorkScreen(onCreate: () => created++),
      navigation,
    );
    final before = navigation.pushes;
    await tester.tap(find.widgetWithText(FilledButton, '新建需求'));
    await tester.pumpAndSettle();
    expect(created, 1);
    expect(navigation.pushes, before);
    expect(find.byType(CreateTaskSheet), findsNothing);
    expect(find.byType(BottomSheet), findsNothing);
    expect(api.executionLoads, 0);
  });

  testWidgets('自动化新建只调用父级对话入口一次，不打开旧聊天或编辑器', (tester) async {
    var created = 0;
    final api = _Api(), navigation = _Navigation();
    final state = MobileState()..api = api;
    await _show(
      tester,
      state,
      AutomationsScreen(onCreate: () => created++),
      navigation,
    );
    final before = navigation.pushes;
    await tester.tap(find.text('新建自动化'));
    await tester.pumpAndSettle();
    expect(created, 1);
    expect(navigation.pushes, before);
    expect(find.byType(AutomationEditor), findsNothing);
    expect(find.byType(CreateTaskSheet), findsNothing);
    expect(find.byType(BottomSheet), findsNothing);
    expect(api.executionLoads, 0);
  });

  testWidgets('编辑既有自动化保留原编辑器和原计划，不调用新建回调', (tester) async {
    var created = 0;
    final schedule = AutomationSchedule.fromJson({
      'id': 'existing-plan',
      'title': '现有周报',
      'note': '现有工作要求',
      'every': 'daily',
      'enabled': false,
      'timeZone': 'Asia/Shanghai',
      'atHour': 9,
      'atMinute': 5,
      'assigneeId': 'local:pi',
    });
    final api = _Api(schedules: [schedule]), navigation = _Navigation();
    final state = MobileState()..api = api;
    await _show(
      tester,
      state,
      AutomationsScreen(onCreate: () => created++),
      navigation,
    );
    await tester.scrollUntilVisible(
      find.byTooltip('管理自动化'),
      250,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.byTooltip('管理自动化'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('编辑计划'));
    await tester.pumpAndSettle();
    expect(created, 0);
    expect(find.byType(AutomationEditor), findsOneWidget);
    expect(
      tester
          .widget<AutomationEditor>(find.byType(AutomationEditor))
          .schedule
          ?.id,
      'existing-plan',
    );
    expect(
      find.descendant(
        of: find.byType(AutomationEditor),
        matching: find.text('现有周报'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byType(AutomationEditor),
        matching: find.text('现有工作要求'),
      ),
      findsOneWidget,
    );
    expect(api.executionLoads, 1);
  });
}

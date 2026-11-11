import 'memory_device_auth.dart';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/app_shell.dart';
import 'package:soduwork_mobile/screens/automations_screen.dart';
import 'package:soduwork_mobile/screens/approval_detail_screen.dart';
import 'package:soduwork_mobile/screens/conversations_screen.dart';
import 'package:soduwork_mobile/screens/work_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/task_lifecycle.dart';
import 'package:soduwork_mobile/ui/work_widgets.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    TestWidgetsFlutterBinding.instance.platformDispatcher.views.first
      ..physicalSize = const Size(390, 844)
      ..devicePixelRatio = 1;
  });

  tearDown(() {
    TestWidgetsFlutterBinding.instance.platformDispatcher.views.first
      ..resetPhysicalSize()
      ..resetDevicePixelRatio();
  });

  testWidgets('task row stays usable on a phone viewport', (tester) async {
    final task = WorkTask.fromJson({
      'id': 'task-mobile',
      'title':
          '\u4fee\u590d\u5ba2\u6237\u767b\u5f55\u9875\u5e76\u5b8c\u6210\u6d4b\u8bd5\u73af\u5883\u9a8c\u6536',
      'status': 'doing',
      'priority': 'high',
      'due': DateTime(2026, 8, 20).millisecondsSinceEpoch,
      'ai': {'state': 'running', 'name': 'Pi'},
      'progress': [
        {
          'text':
              '\u5df2\u5b8c\u6210\u95ee\u9898\u5b9a\u4f4d\uff0c\u6b63\u5728\u8865\u5145\u56de\u5f52\u6d4b\u8bd5\u3002',
        },
      ],
    });

    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: Padding(
            padding: const EdgeInsets.all(20),
            child: TaskRow(task: task),
          ),
        ),
      ),
    );

    expect(find.text(task.title), findsOneWidget);
    expect(find.text('\u8fdb\u884c\u4e2d'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('execution lifecycle scrolls instead of overflowing', (
    tester,
  ) async {
    final task = WorkTask.fromJson({
      'id': 'task-flow',
      'title': '\u53d1\u5e03\u5b98\u7f51',
      'status': 'doing',
      'handler': 'auto',
      'ai': {'state': 'running', 'name': 'OpenCode'},
    });
    final trace = {
      'runs': [
        {'id': 'run-1'},
      ],
      'phases': List.generate(6, (index) {
        return {
          'name': [
            '\u7406\u89e3\u5de5\u4f5c',
            '\u7ec4\u7ec7\u534f\u4f5c',
            '\u6267\u884c\u5de5\u4f5c',
            '\u786e\u8ba4\u7ed3\u679c',
            '\u4ea4\u4ed8\u53d1\u5e03',
            '\u8bc4\u4ef7\u6c89\u6dc0',
          ][index],
          'status': index < 3 ? 'done' : (index == 3 ? 'running' : 'todo'),
        };
      }),
    };

    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: TaskLifecyclePanel(task: task, trace: trace),
          ),
        ),
      ),
    );

    expect(find.text('\u6267\u884c\u5168\u94fe\u8def'), findsOneWidget);
    expect(find.byType(ListView), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('conversation shell keeps work and profile accessible', (
    tester,
  ) async {
    final state = MobileState();
    state
      ..endpoint = const EndpointSettings(
        environment: SoduWorkEnvironment.production,
        baseUrl: EndpointSettings.productionUrl,
      )
      ..phase = MobilePhase.ready;

    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(theme: SoduWorkTheme.light(), home: const AppShell()),
      ),
    );

    await tester.pumpAndSettle();
    expect(find.text('开始一项工作'), findsOneWidget);
    expect(find.byKey(const Key('workspace-tab-0')), findsNothing);
    expect(find.byKey(const Key('home-composer')), findsOneWidget);

    await tester.tap(find.byKey(const Key('open-sidebar')));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('设置'));
    await tester.pumpAndSettle();
    expect(find.text('账户信息'), findsOneWidget);
    expect(find.text('偏好设置'), findsOneWidget);
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-sidebar')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('需求池'));
    await tester.pumpAndSettle();
    expect(find.text('搜索需求'), findsOneWidget);
    expect(tester.takeException(), isNull);
    state.dispose();
  });
  testWidgets('automation receipts stay usable on a phone viewport', (
    tester,
  ) async {
    final store = _WidgetSessionStore();
    final api = SoduWorkApi(
      store: store,
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'http://soduwork.test',
      ),
      client: MockClient((request) async {
        final body = request.url.path.endsWith('/runs')
            ? {
                'items': [
                  {
                    'id': 'run-mobile',
                    'scheduleId': 'schedule-mobile',
                    'state': 'succeeded',
                    'trigger': 'timer',
                    'taskTitle':
                        '\u751f\u6210\u6bcf\u65e5\u98ce\u9669\u7b80\u62a5',
                    'startedAt': '2026-08-22T10:00:00Z',
                    'durationSeconds': 36,
                    'receipt': {
                      'plugin': {
                        'name': '\u98ce\u9669\u5de1\u68c0',
                        'version': '1.2.0',
                      },
                      'route': {
                        'resolved': {
                          'host': 'DESKTOP-SODUWORK',
                          'agent': 'Pi',
                          'model': 'dev-coding-large-agent-soduwork',
                        },
                      },
                    },
                  },
                ],
              }
            : [
                {
                  'id': 'schedule-mobile',
                  'title': '\u6bcf\u65e5\u98ce\u9669\u5de1\u68c0',
                  'note':
                      '\u6309\u8ba1\u5212\u8fd0\u884c\u5e76\u4fdd\u7559\u56de\u6267',
                  'enabled': true,
                  'timeZone': 'Asia/Shanghai',
                  'nextRunLocal': '2026-08-23 09:00',
                  'executionMode': 'personal',
                  'personalPluginKey': 'risk-inspection',
                  'personalPluginVersionPolicy': 'fixed',
                  'personalPluginVersion': '1.2.0',
                },
              ];
        return http.Response(
          jsonEncode(body),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    final state = MobileState(store: store)
      ..api = api
      ..phase = MobilePhase.ready;
    addTearDown(api.client.close);
    addTearDown(state.dispose);

    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(
          theme: SoduWorkTheme.light(),
          home: const AutomationsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('\u6bcf\u65e5\u98ce\u9669\u5de1\u68c0'), findsOneWidget);
    expect(find.textContaining('\u56fa\u5b9a\u7248\u672c'), findsOneWidget);
    await tester.tap(find.text('\u8fd0\u884c\u8bb0\u5f55'));
    await tester.pumpAndSettle();

    expect(
      find.text('\u751f\u6210\u6bcf\u65e5\u98ce\u9669\u7b80\u62a5'),
      findsOneWidget,
    );
    expect(find.textContaining('DESKTOP-SODUWORK'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('conversations home keeps approvals above the session list', (
    tester,
  ) async {
    final primary = WorkTask.fromJson({
      'id': 'task-gate',
      'title': '等待验收的客户门户',
      'status': 'doing',
      'handler': 'auto',
      'origin': 'cloud-conversation',
      'ai': {'state': 'running', 'name': 'Pi'},
    });
    final other = WorkTask.fromJson({
      'id': 'task-other',
      'title': '整理本周经营简报',
      'status': 'doing',
    });
    final state = MobileState()
      ..phase = MobilePhase.ready
      ..enrollment = const EnrollmentState(
        active: true,
        deviceId: 'mobile-test',
        deviceName: 'SoduWork Mobile',
        authState: 'active',
        ownerUserId: 'user-1',
      )
      ..tasks = [primary, other]
      ..pendingApprovals = [
        ApprovalItem.fromJson({
          'id': 'approval-gate',
          'action': 'uat',
          'status': 'pending',
          'task': {
            'id': primary.id,
            'title': primary.title,
            'status': primary.status,
          },
        }),
      ];
    addTearDown(state.dispose);

    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(
          theme: SoduWorkTheme.light(),
          home: const Scaffold(body: ConversationsScreen()),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('搜索会话'), findsOneWidget);
    expect(find.textContaining('待你确认'), findsOneWidget);
    // The session row shows the work; the banner embeds the title inline.
    expect(find.text(primary.title), findsOneWidget);
    expect(find.text(other.title), findsOneWidget);
    expect(find.text('进行中'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'requirement board keeps requirement stages separate from ordinary conversations',
    (tester) async {
      final primary = WorkTask.fromJson({
        'id': 'task-gate',
        'title': '等待验收的客户门户',
        'status': 'doing',
        'handler': 'auto',
        'origin': 'local',
        'ai': {'state': 'running', 'name': 'Pi'},
      });
      final manual = WorkTask.fromJson({
        'id': 'task-manual',
        'title': '整理本周经营简报',
        'status': 'todo',
      });
      final state = MobileState()
        ..phase = MobilePhase.ready
        ..enrollment = const EnrollmentState(
          active: true,
          deviceId: 'device-x',
          deviceName: 'SoduWork Mobile',
          authState: 'active',
          ownerUserId: 'user-1',
        )
        ..tasks = [
          primary,
          manual,
          WorkTask.fromJson({
            'id': 'ordinary-chat',
            'title': '普通聊天不进入需求池',
            'origin': 'cloud-conversation',
            'status': 'doing',
          }),
        ];
      addTearDown(state.dispose);

      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: const Scaffold(body: WorkScreen()),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('需求池'), findsWidgets);
      expect(find.text('搜索需求'), findsOneWidget);
      expect(find.text('全部 2'), findsOneWidget);
      expect(find.text('普通聊天不进入需求池'), findsNothing);
      expect(find.text('待开始 1'), findsOneWidget);
      expect(find.text('进行中 1'), findsOneWidget);
      expect(find.text('待验收 0'), findsOneWidget);
      expect(find.text('整理本周经营简报'), findsOneWidget);

      await Scrollable.ensureVisible(tester.element(find.text('进行中 1')));
      await tester.pump();
      await tester.tap(find.text('进行中 1'));
      // Running rows carry a perpetual StatusBeacon pulse; settle manually.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('等待验收的客户门户'), findsOneWidget);
      expect(find.text('整理本周经营简报'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('approval detail consumes the enriched gate packet once', (
    tester,
  ) async {
    final requests = <String>[];
    final store = _WidgetSessionStore();
    final api = SoduWorkApi(
      store: store,
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'http://soduwork.test',
      ),
      client: MockClient((request) async {
        requests.add(request.url.path);
        if (request.url.path == '/api/v1/approvals/approval-uat') {
          return http.Response(
            jsonEncode({
              'item': {
                'id': 'approval-uat',
                'action': 'uat',
                'status': 'pending',
                'task': {
                  'id': 'task-uat',
                  'title': '发布客户门户到测试环境',
                  'status': 'doing',
                  'handler': 'auto',
                },
                'artifact': {'id': 'artifact-3'},
                'gate': {
                  'schemaVersion': 'soduwork.gate/1.0',
                  'title': '确认环境验收结果',
                  'subject': {
                    'environmentName': '测试环境',
                    'artifactSeq': 3,
                    'fingerprint': 'abc123def4567890',
                  },
                  'criteria': [
                    {'id': 'criterion-1', 'label': '核心页面能够正常打开'},
                  ],
                  'requirements': [
                    {
                      'id': 'health',
                      'label': '上线后健康检查',
                      'oneOf': ['check'],
                      'satisfied': true,
                      'evidenceRefs': ['check-1'],
                    },
                    {
                      'id': 'screenshot',
                      'label': '环境验收截图',
                      'oneOf': ['image'],
                      'satisfied': false,
                      'evidenceRefs': [],
                    },
                  ],
                  'evidence': [
                    {
                      'id': 'check-1',
                      'kind': 'check',
                      'title': 'HTTP 健康检查',
                      'summary': '200 OK · 版本一致',
                      'verification': {'state': 'passed', 'by': 'runner'},
                    },
                  ],
                  'readiness': {
                    'state': 'blocked',
                    'canApprove': false,
                    'blockers': ['环境验收截图'],
                    'evidenceCount': 1,
                    'kinds': ['check'],
                  },
                },
              },
              'trace': {
                'runs': [
                  {'id': 'run-uat'},
                ],
                'phases': [
                  {'name': '确认结果', 'status': 'running'},
                ],
              },
            }),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }
        return http.Response('not expected', 500);
      }),
    );
    final state = MobileState(store: store)
      ..api = api
      ..phase = MobilePhase.ready
      ..pendingApprovals = [
        ApprovalItem.fromJson({
          'id': 'approval-uat',
          'action': 'uat',
          'status': 'pending',
          'task': {'id': 'task-uat', 'title': '发布客户门户到测试环境'},
        }),
      ];
    addTearDown(api.client.close);
    addTearDown(state.dispose);

    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(
          theme: SoduWorkTheme.light(),
          home: const ApprovalDetailScreen(approvalId: 'approval-uat'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(requests, ['/api/v1/approvals/approval-uat']);
    expect(find.text('还不能通过'), findsOneWidget);
    expect(find.text('测试环境'), findsOneWidget);
    expect(find.text('上线后健康检查'), findsOneWidget);
    expect(find.text('环境验收截图'), findsOneWidget);
    expect(find.text('HTTP 健康检查'), findsOneWidget);
    expect(find.text('200 OK · 版本一致'), findsOneWidget);
    expect(find.text('证据未齐'), findsOneWidget);
    final approve = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, '证据未齐'),
    );
    expect(approve.onPressed, isNull);
    expect(tester.takeException(), isNull);
  });
}

class _WidgetSessionStore extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'mobile-session';

  @override
  Future<void> clearSession(String endpoint) async {}
}

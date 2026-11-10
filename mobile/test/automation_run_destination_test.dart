import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/automation_run_destination.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/automations_screen.dart';
import 'package:soduwork_mobile/screens/cloud_conversation_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'memory_device_auth.dart';

const runId = '8ed47c31-e58b-41ba-bced-16bbf6e607fe';
Map<String, dynamic> mobileRun() => {
  'id': runId,
  'state': 'succeeded',
  'conversationId': 'mobile-automation:$runId',
  'conversationTitle': '真实自动化会话',
  'receipt': {'executionMode': 'soduwork.automation-conversation/v1'},
};
AutomationRun run(Map<String, dynamic> data) => AutomationRun.fromJson(data);
http.Response json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
_Api _makeApi(Future<http.Response> Function(http.Request) respond) =>
    _Api(MockClient(respond));
Future<AutomationRunDestination> resolve(
  SoduWorkApi client,
  AutomationRun item, {
  String owner = 'pc-owner',
  bool Function()? current,
}) => AutomationRunDestination.resolve(
  run: item,
  api: client,
  ownerClientId: owner,
  isCurrent: current ?? () => true,
);
Map<String, dynamic> projection(String id, String owner, int revision) => {
  'id': id,
  'sourceSessionId': 'pc-session',
  'sourceClientId': owner,
  'revision': revision,
  'title': '电脑结果',
};

void main() {
  test(
    'cloud automation validates an account-scoped task created on another device',
    () async {
      final requestId = 'schedule-${List.filled(64, 'a').join()}';
      final paths = <String>[];
      final item = run({
        'id': runId,
        'conversationId': requestId,
        'receipt': {
          'executionMode': 'soduwork.cloud-automation/v1',
          'taskId': runId,
        },
      });
      final dest = await resolve(
        _makeApi((request) async {
          paths.add('${request.method} ${request.url.path}');
          return json({
            'id': runId,
            'origin': 'cloud-conversation',
            'ownerClientId': 'other-pc',
            'canViewExecution': true,
            'workRouting': {
              'cloudConversation': {'sessionId': requestId},
            },
          });
        }),
        item,
      );
      expect(paths, ['GET /api/v1/tasks/$runId']);
      expect(item.conversationMode, isTrue);
      expect(dest.cloud, isTrue);
      expect(dest.taskId, runId);
      expect(dest.ref, isEmpty);
    },
  );
  test(
    'cloud result rejects inaccessible tasks and mismatched session identities',
    () async {
      final requestId = 'schedule-${List.filled(64, 'a').join()}';
      final item = run({
        'conversationId': requestId,
        'receipt': {
          'executionMode': 'soduwork.cloud-automation/v1',
          'taskId': runId,
        },
      });
      for (final response in [
        json({'detail': 'Not allowed'}, 403),
        json({'detail': 'Not found'}, 404),
        json({
          'id': runId,
          'origin': 'cloud-conversation',
          'workRouting': {
            'cloudConversation': {'sessionId': 'different'},
          },
        }),
        json({
          'id': runId,
          'origin': 'task',
          'workRouting': {
            'cloudConversation': {'sessionId': requestId},
          },
        }),
        json({
          'id': runId,
          'origin': 'cloud-conversation',
          'canViewExecution': false,
          'workRouting': {
            'cloudConversation': {'sessionId': requestId},
          },
        }),
      ]) {
        await expectLater(
          resolve(_makeApi((_) async => response), item),
          throwsA(isA<ApiFailure>()),
        );
      }
      var current = true;
      await expectLater(
        resolve(
          _makeApi((_) async {
            current = false;
            return json({
              'id': runId,
              'origin': 'cloud-conversation',
              'workRouting': {
                'cloudConversation': {'sessionId': requestId},
              },
            });
          }),
          item,
          current: () => current,
        ),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'incomplete cloud receipt cannot fall through to account history',
    () async {
      await expectLater(
        resolve(
          _makeApi((_) async => throw StateError('unexpected lookup')),
          run({
            'conversationId': 'pc-session',
            'receipt': {'executionMode': 'soduwork.cloud-automation/v1'},
          }),
        ),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test('retains ordinary conversation receipt without task ID', () {
    final item = run(mobileRun());
    expect(item.taskId, isEmpty);
    expect(item.hasResult, isTrue);
    expect(item.conversationMode, isTrue);
    expect(item.resultTitle, '真实自动化会话');
    final legacy = run({
      'receipt': {'conversationId': 'old', 'conversationTitle': '旧回执'},
    });
    expect(legacy.conversationId, 'old');
    expect(legacy.resultTitle, '旧回执');
  });
  test('workflow task opens unchanged without a conversation lookup', () async {
    final dest = await resolve(
      _makeApi((_) async => throw StateError('unexpected lookup')),
      run({'taskId': 'workflow-task'}),
    );
    expect(dest.taskId, 'workflow-task');
    expect(dest.cloud, isFalse);
  });
  test(
    'mobile conversation resolves actual Hub task ID and ref using read only request',
    () async {
      final paths = <String>[];
      final dest = await resolve(
        _makeApi((request) async {
          paths.add('${request.method} ${request.url.path}');
          return json({
            'ok': true,
            'taskId': 'actual-hub-task',
            'ref': 'ref-42',
          });
        }),
        run(mobileRun()),
      );
      expect(paths, ['GET /api/v1/conversation-handoffs/automation-$runId']);
      expect(dest.taskId, 'actual-hub-task');
      expect(dest.ref, 'ref-42');
      expect(dest.cloud, isTrue);
    },
  );
  test('mismatched mobile run identity never queries another run', () async {
    await expectLater(
      resolve(
        _makeApi((_) async => throw StateError('unexpected lookup')),
        run({...mobileRun(), 'id': 'different-run'}),
      ),
      throwsA(isA<ApiFailure>()),
    );
  });
  test(
    'pending receipt is not mistaken for a task and retry can resolve',
    () async {
      var reads = 0;
      final client = _makeApi(
        (_) async => ++reads == 1
            ? json({'ok': true, 'phase': 'starting'})
            : json({'ok': true, 'taskId': 'ready-task'}),
      );
      await expectLater(
        resolve(client, run(mobileRun())),
        throwsA(isA<ApiFailure>()),
      );
      expect((await resolve(client, run(mobileRun()))).taskId, 'ready-task');
    },
  );
  test('account change rejects late receipt', () async {
    final pending = Completer<http.Response>();
    var current = true;
    final future = resolve(
      _makeApi((_) => pending.future),
      run(mobileRun()),
      current: () => current,
    );
    current = false;
    pending.complete(json({'ok': true, 'taskId': 'old-private-task'}));
    await expectLater(future, throwsA(isA<ApiFailure>()));
  });
  test(
    'PC projection requires exact device and session and reads all directory pages',
    () async {
      final cursors = <String?>[];
      final dest = await resolve(
        _makeApi((request) async {
          cursors.add(request.url.queryParameters['after']);
          return cursors.length == 1
              ? json({
                  'items': [projection('wrong-device', 'another-pc', 1)],
                  'cursor': 1,
                  'hasMore': true,
                })
              : json({
                  'items': [projection('correct-projection', 'pc-owner', 2)],
                  'cursor': 2,
                  'hasMore': false,
                });
        }),
        run({'conversationId': 'pc-session'}),
      );
      expect(cursors, ['0', '1']);
      expect(dest.account?.id, 'correct-projection');
      expect(dest.taskId, isEmpty);
    },
  );
  test(
    'unsynced or deleted PC results never fall back to another device',
    () async {
      for (final rows in [
        [projection('wrong-device', 'another-pc', 1)],
        [
          {...projection('deleted', 'pc-owner', 1), 'deleted': true},
        ],
      ]) {
        await expectLater(
          resolve(
            _makeApi(
              (_) async => json({'items': rows, 'cursor': 1, 'hasMore': false}),
            ),
            run({'conversationId': 'pc-session'}),
          ),
          throwsA(isA<ApiFailure>()),
        );
      }
    },
  );
  test(
    'missing source identity and unsupported PC directory are explicit failures',
    () async {
      await expectLater(
        resolve(
          _makeApi((_) async => throw StateError('unexpected lookup')),
          run({'conversationId': 'pc-session'}),
          owner: '',
        ),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        resolve(
          _makeApi((_) async => json({'detail': 'unsupported'}, 404)),
          run({'conversationId': 'pc-session'}),
        ),
        throwsA(
          isA<ApiFailure>().having(
            (e) => e.message,
            'reason',
            contains('尚未提供'),
          ),
        ),
      );
    },
  );

  testWidgets(
    'conversation-only run is visible, deduplicates clicks, and retries failed result lookup',
    (tester) async {
      tester.view.physicalSize = const Size(320, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final pending = Completer<http.Response>();
      var reads = 0;
      final state = _State(
        _makeApi((request) async {
          if (request.url.path.contains('/conversation-handoffs/automation-')) {
            reads++;
            return reads == 1
                ? pending.future
                : json({'ok': true, 'phase': 'starting'});
          }
          if (request.url.path.endsWith('/runs')) {
            return json({
              'items': [mobileRun()],
            });
          }
          if (request.url.path.endsWith('/templates')) return json([]);
          return json([
            {'id': 'plan', 'title': '测试计划', 'enabled': false},
          ]);
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(app(state));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('运行记录'));
      await tester.tap(find.text('运行记录'));
      await tester.pumpAndSettle();
      expect(find.text('真实自动化会话'), findsOneWidget);
      await tester.tap(find.text('查看会话结果'));
      await tester.pump();
      expect(find.text('正在读取结果…'), findsOneWidget);
      await tester.tap(find.text('正在读取结果…'));
      await tester.pump();
      expect(reads, 1);
      pending.complete(json({'detail': '回执暂不可用'}, 503));
      await tester.pumpAndSettle();
      expect(find.text('重试查看结果'), findsOneWidget);
      await tester.tap(find.text('重试查看结果'));
      await tester.pumpAndSettle();
      expect(reads, 2);
      expect(find.text('会话尚未建立完成，请稍后重试查看结果。'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'cloud automation result selects the existing workspace without pushing a result page',
    (tester) async {
      final taskId = '11111111-1111-4111-8111-111111111111';
      final requestId = 'schedule-${List.filled(64, 'a').join()}';
      final state = _State(
        _makeApi((request) async {
          if (request.url.path == '/api/v1/tasks/$taskId') {
            return json({
              'id': taskId,
              'origin': 'cloud-conversation',
              'canViewExecution': true,
              'workRouting': {
                'cloudConversation': {'sessionId': requestId},
              },
            });
          }
          if (request.url.path.endsWith('/runs')) {
            return json({
              'items': [
                {
                  'id': runId,
                  'state': 'succeeded',
                  'taskId': taskId,
                  'conversationId': requestId,
                  'conversationTitle': '云自动化结果',
                  'receipt': {'executionMode': 'soduwork.cloud-automation/v1'},
                },
              ],
            });
          }
          if (request.url.path.endsWith('/templates')) return json([]);
          return json([
            {'id': 'plan', 'title': '测试计划', 'enabled': false},
          ]);
        }),
      );
      addTearDown(state.dispose);
      final navigator = GlobalKey<NavigatorState>();
      var opens = 0;
      state.workConversationNavigation.addListener(() {
        opens++;
        navigator.currentState!.popUntil((route) => route.isFirst);
      });
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            navigatorKey: navigator,
            home: const Scaffold(body: AutomationsScreen()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('运行记录'));
      await tester.tap(find.text('运行记录'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('查看会话结果'));
      await tester.pumpAndSettle();
      expect(opens, 1);
      expect(state.workConversationNavigation.destination!.taskId, taskId);
      expect(state.workConversationNavigation.destination!.title, '云自动化结果');
      expect(
        state.workConversationNavigation.destination!.identity,
        state.identityRevision,
      );
      expect(find.byType(CloudConversationScreen), findsNothing);
      expect(find.text('查看会话结果'), findsNothing);
      expect(navigator.currentState!.canPop(), isFalse);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'resolved mobile receipt opens actual cloud conversation and can return to history',
    (tester) async {
      final state = _State(
        _makeApi((request) async {
          if (request.url.path.contains('/conversation-handoffs/automation-')) {
            return json({
              'ok': true,
              'taskId': 'actual-cloud-task',
              'ref': 'actual-ref',
            });
          }
          if (request.url.path.endsWith('/runs')) {
            return json({
              'items': [mobileRun()],
            });
          }
          if (request.url.path.endsWith('/templates')) return json([]);
          if (request.url.path == '/api/v1/schedules') {
            return json([
              {'id': 'plan', 'title': '测试计划', 'enabled': false},
            ]);
          }
          return json({'ok': true, 'status': 'done', 'items': [], 'last': 0});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(app(state));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('运行记录'));
      await tester.tap(find.text('运行记录'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('查看会话结果'));
      await tester.pumpAndSettle();
      final screen = tester.widget<CloudConversationScreen>(
        find.byType(CloudConversationScreen),
      );
      expect(screen.taskId, 'actual-cloud-task');
      expect(screen.ref, 'actual-ref');
      Navigator.of(tester.element(find.byType(CloudConversationScreen))).pop();
      await tester.pumpAndSettle();
      expect(find.text('真实自动化会话'), findsOneWidget);
      expect(find.text('查看会话结果'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'account switch clears conversation result and ignores late lookup',
    (tester) async {
      final pending = Completer<http.Response>();
      final state = _State(
        _makeApi((request) async {
          if (request.url.path.contains('/conversation-handoffs/automation-')) {
            return pending.future;
          }
          if (request.url.path.endsWith('/runs')) {
            return json({
              'items': [mobileRun()],
            });
          }
          if (request.url.path.endsWith('/templates')) return json([]);
          return json([
            {'id': 'plan', 'title': '测试计划', 'enabled': false},
          ]);
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(app(state));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('运行记录'));
      await tester.tap(find.text('运行记录'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('查看会话结果'));
      await tester.pump();
      state.switchAccount();
      await tester.pump();
      pending.complete(json({'ok': true, 'taskId': 'old-private-task'}));
      await tester.pumpAndSettle();
      expect(find.text('真实自动化会话'), findsNothing);
      expect(find.text('账号已变化，请关闭后重新打开运行记录。'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

Widget app(MobileState state) => MobileScope(
  state: state,
  child: const MaterialApp(home: Scaffold(body: AutomationsScreen())),
);

class _State extends MobileState {
  int revision = 1;
  _State(SoduWorkApi client) {
    api = client;
    phase = MobilePhase.ready;
  }
  @override
  int get identityRevision => revision;
  void switchAccount() {
    revision++;
    notifyListeners();
  }
}

class _Api extends SoduWorkApi {
  _Api(http.Client client)
    : super(
        store: _Store(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://hub.test',
        ),
        client: client,
      );
  @override
  Future<Map<String, dynamic>> cloudConversationTargets() async => {
    'targets': [],
  };
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
}

import 'dart:convert';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/screens/task_detail_screen.dart';
import 'package:soduwork_mobile/screens/work_screen.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/requirement_acceptance_card.dart';
import 'package:soduwork_mobile/ui/requirement_capabilities.dart';
import 'package:soduwork_mobile/ui/task_lifecycle.dart';
import 'memory_device_auth.dart';

WorkTask task(Map<String, dynamic> data) =>
    WorkTask.fromJson({'id': 't', 'title': '本轮交付', ...data});
Map<String, dynamic> packet({
  String version = 'v1',
  bool allowed = true,
  String approval = 'direct:t',
}) => {
  'approvalId': approval,
  'canDecide': allowed,
  'artifactVersionId': version,
  'requirementVersion': 3,
  'criteria': [
    {'label': '能打开网页'},
  ],
  'attachments': [],
};
http.Response response(Object value) => http.Response(
  jsonEncode(value),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Widget app(MobileState state, Widget child) => MobileScope(
  state: state,
  child: MaterialApp(
    theme: SoduWorkTheme.light(),
    home: Scaffold(body: SingleChildScrollView(child: child)),
  ),
);
void main() {
  testWidgets(
    'reviewing requirement offers acceptance while execution task remains doing',
    (tester) async {
      final raw = <String, dynamic>{
        'id': 't',
        'title': '电脑交付',
        'kind': 'requirement',
        'status': 'doing',
        'requirementStage': 'reviewing',
        'canViewExecution': true,
      };
      final state = _TaskState(
        MockClient((request) async {
          if (request.url.path.endsWith('/review-packet')) {
            return response(packet());
          }
          return response({'items': []});
        }),
        () => raw,
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        app(
          state,
          const SizedBox(height: 700, child: TaskDetailScreen(taskId: 't')),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(RequirementAcceptanceCard), findsOneWidget);
    },
  );
  test(
    'maintenance respects authoritative locks, creator role, lifecycle and restore',
    () {
      final idle = task({
        'canEditRequirement': true,
        'myRoles': ['creator'],
        'requirementVersion': 3,
      });
      expect(requirementMaintenance(idle, {}).enabled, isTrue);
      expect(
        requirementMaintenance(idle, {'canArchiveRequirement': false}).visible,
        isFalse,
      );
      expect(
        requirementMaintenance(idle, {'maintenanceBlocked': true}).enabled,
        isFalse,
      );
      expect(
        requirementMaintenance(
          task({
            'canEditRequirement': true,
            'myRoles': ['assignee'],
          }),
          {},
        ).visible,
        isFalse,
      );
      expect(
        requirementMaintenance(
          task({'status': 'doing', 'canEditRequirement': true}),
          {},
        ).enabled,
        isFalse,
      );
      final archived = task({
        'archivedAt': 1,
        'canEditRequirement': true,
        'ai': {'state': 'running'},
      });
      expect(requirementMaintenance(archived, {}).enabled, isFalse);
      expect(
        requirementMaintenance(archived, {'maintenanceBlocked': false}).enabled,
        isTrue,
      );
    },
  );
  test(
    'role views keep running agents out of actionable unless attention is raised',
    () {
      final running = task({
        'status': 'doing',
        'myRoles': ['executor'],
        'ai': {'state': 'running'},
      });
      expect(requirementMatchesScope(running, 'assigned', {}), isTrue);
      expect(requirementMatchesScope(running, 'created', {}), isFalse);
      expect(requirementMatchesScope(running, 'actionable', {}), isFalse);
      expect(requirementMatchesScope(running, 'actionable', {'t'}), isTrue);
      expect(
        requirementMatchesScope(task({'archivedAt': 1}), 'actionable', {'t'}),
        isFalse,
      );
      expect(
        requirementMatchesScope(task({'needsMe': true}), 'actionable', {}),
        isTrue,
      );
      expect(
        requirementMatchesScope(
          task({'status': 'done', 'needsMe': true}),
          'actionable',
          {},
        ),
        isFalse,
      );
    },
  );
  test('pending personal review remains actionable before inbox refresh', () {
    final values = <String, dynamic>{
      'status': 'doing',
      'requirementStage': 'reviewing',
      'myRoles': ['creator'],
      'canReview': true,
      'ai': {'state': 'done'},
    };
    expect(requirementMatchesScope(task(values), 'actionable', {}), isTrue);
    expect(
      requirementMatchesScope(
        task({...values, 'canReview': false}),
        'actionable',
        {},
      ),
      isFalse,
    );
    expect(
      requirementMatchesScope(
        task({...values, 'canReview': null}),
        'actionable',
        {},
      ),
      isFalse,
    );
    expect(
      requirementMatchesScope(
        task({...values, 'archivedAt': 1}),
        'actionable',
        {},
      ),
      isFalse,
    );
    expect(
      requirementMatchesScope(
        task({
          ...values,
          'status': 'done',
          'reviewedAt': 1,
          'canReview': false,
        }),
        'actionable',
        {},
      ),
      isFalse,
    );
  });

  test(
    'phase attachment identity is explicit and local paths are not openable',
    () {
      expect(phaseEvidenceArtifact({'id': 'run-1', 'kind': 'check'}), isNull);
      expect(phaseEvidenceArtifact({'url': 'file:///C:/secret'}), isNull);
      expect(phaseEvidenceArtifact({'url': r'C:\secret'}), isNull);
      expect(
        phaseEvidenceArtifact({
          'attachmentId': 'a',
          'title': '报告',
        })?['attachmentId'],
        'a',
      );
    },
  );
  testWidgets(
    'archive fetches latest version and preserves optimistic concurrency',
    (tester) async {
      final writes = <Map<String, dynamic>>[];
      var raw = <String, dynamic>{
        'id': 't',
        'title': '归档测试',
        'status': 'todo',
        'canEditRequirement': true,
        'canArchiveRequirement': true,
        'myRoles': ['creator'],
        'requirementVersion': 9,
      };
      final state = _TaskState(
        MockClient((request) async {
          if (request.method == 'PATCH') {
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            writes.add(body);
            raw = {...raw, ...body};
          }
          return response(raw);
        }),
        () => raw,
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        app(
          state,
          const SizedBox(height: 700, child: TaskDetailScreen(taskId: 't')),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('归档需求'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '归档'));
      await tester.pumpAndSettle();
      expect(writes.single['requirementVersion'], 9);
      expect(writes.single['archivedAt'], isA<int>());
      expect(writes.single.containsKey('status'), false);
      expect(find.byTooltip('恢复需求'), findsOneWidget);
      await tester.tap(find.byTooltip('恢复需求'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, '恢复'));
      await tester.pumpAndSettle();
      expect(writes.last['archivedAt'], isNull);
      expect(writes.length, 2);
    },
  );
  testWidgets(
    'active and archived board remain separate and role views filter',
    (tester) async {
      final state = _State(MockClient((_) async => response({})));
      addTearDown(state.dispose);
      state.tasks = [
        task({
          'id': 'mine',
          'title': '我提出的需求',
          'myRoles': ['creator'],
        }),
        task({
          'id': 'assigned',
          'title': '承办需求',
          'myRoles': ['assignee'],
        }),
        task({
          'id': 'archived',
          'title': '归档记录',
          'archivedAt': 1,
          'myRoles': ['creator'],
        }),
      ];
      await tester.pumpWidget(
        app(state, const SizedBox(height: 700, child: WorkScreen())),
      );
      await tester.pumpAndSettle();
      expect(find.text('归档记录'), findsNothing);
      await tester.tap(find.text('我提出'));
      await tester.pumpAndSettle();
      expect(find.text('我提出的需求'), findsOneWidget);
      expect(find.text('承办需求'), findsNothing);
      await tester.tap(find.byTooltip('归档需求'));
      await tester.pumpAndSettle();
      expect(find.text('归档记录'), findsOneWidget);
      expect(find.text('我提出的需求'), findsNothing);
    },
  );
  testWidgets('phase evidence opens exact attachment through callback', (
    tester,
  ) async {
    Map<String, dynamic>? opened;
    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: TaskLifecyclePanel(
            task: task({'handler': 'auto'}),
            onOpenEvidence: (item) => opened = item,
            trace: {
              'phases': [
                {'key': 'delivery', 'name': '交付'},
              ],
              'stages': [
                {
                  'category': 'delivery',
                  'evidence': [
                    {'kind': 'file', 'attachmentId': 'a', 'title': '报告'},
                    {'kind': 'check', 'id': 'check', 'title': '复核'},
                  ],
                },
              ],
            },
          ),
        ),
      ),
    );
    await tester.tap(find.text('交付'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('报告'));
    await tester.pump();
    expect(opened?['attachmentId'], 'a');
    opened = null;
    await tester.tap(find.text('复核'));
    expect(opened, isNull);
  });
  testWidgets('late acceptance context cannot overwrite a different task', (
    tester,
  ) async {
    final delayed = Completer<http.Response>();
    final selected = ValueNotifier<WorkTask>(
      task({'id': 'first', 'status': 'done'}),
    );
    addTearDown(selected.dispose);
    final state = _State(
      MockClient((request) async {
        if (request.url.path.contains('/first/')) return delayed.future;
        return response({
          ...packet(allowed: false, approval: 'direct:second'),
          'criteria': [
            {'label': '第二项标准'},
          ],
        });
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      app(
        state,
        ValueListenableBuilder<WorkTask>(
          valueListenable: selected,
          builder: (_, value, _) => RequirementAcceptanceCard(
            task: value,
            onChanged: () async {},
            onOpen: (_) {},
          ),
        ),
      ),
    );
    await tester.pump();
    selected.value = task({'id': 'second', 'status': 'done'});
    await tester.pumpAndSettle();
    expect(find.textContaining('第二项标准'), findsOneWidget);
    delayed.complete(
      response({
        ...packet(approval: 'direct:first'),
        'criteria': [
          {'label': '过时标准'},
        ],
      }),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('第二项标准'), findsOneWidget);
    expect(find.textContaining('过时标准'), findsNothing);
    expect(find.text('确认验收'), findsNothing);
  });
  testWidgets(
    'switching task while preflight is pending never submits to either task',
    (tester) async {
      final delayed = Completer<http.Response>();
      final selected = ValueNotifier<WorkTask>(task({'status': 'done'}));
      addTearDown(selected.dispose);
      int reads = 0, writes = 0;
      final state = _State(
        MockClient((request) async {
          if (request.method != 'GET') {
            writes++;
            return response({});
          }
          if (request.url.path.contains('/second/')) {
            return response(packet(allowed: false, approval: 'direct:second'));
          }
          if (++reads == 2) return delayed.future;
          return response(packet());
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        app(
          state,
          ValueListenableBuilder<WorkTask>(
            valueListenable: selected,
            builder: (_, value, _) => RequirementAcceptanceCard(
              task: value,
              onChanged: () async {},
              onOpen: (_) {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('确认验收'));
      await tester.tap(find.text('确认验收'));
      await tester.pump();
      selected.value = task({'id': 'second', 'status': 'done'});
      await tester.pumpAndSettle();
      delayed.complete(response(packet()));
      await tester.pumpAndSettle();
      expect(writes, 0);
      expect(find.text('确认验收'), findsNothing);
    },
  );
  testWidgets(
    'direct acceptance refreshes version and never submits stale output',
    (tester) async {
      int reads = 0, writes = 0;
      final state = _State(
        MockClient((request) async {
          if (request.method == 'GET') {
            return response(packet(version: ++reads > 1 ? 'v2' : 'v1'));
          }
          writes++;
          return response({});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        app(
          state,
          RequirementAcceptanceCard(
            task: task({'status': 'done'}),
            onChanged: () async {},
            onOpen: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('确认验收'));
      await tester.tap(find.text('确认验收'));
      await tester.pumpAndSettle();
      expect(writes, 0);
      expect(find.textContaining('交付版本或验收权限已变化'), findsOneWidget);
    },
  );
  testWidgets('assigned review uses the formal approval endpoint inline', (
    tester,
  ) async {
    final writes = <http.Request>[];
    final state = _State(
      MockClient((request) async {
        if (request.method == 'GET') {
          return response(packet(approval: 'approval-1'));
        }
        writes.add(request);
        return response({'ok': true});
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      app(
        state,
        RequirementAcceptanceCard(
          task: task({'status': 'done'}),
          onChanged: () async {},
          onOpen: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('打开验收单'), findsNothing);
    await tester.ensureVisible(find.text('确认验收'));
    await tester.tap(find.text('确认验收'));
    await tester.pumpAndSettle();
    expect(writes.single.url.path, '/api/v1/approvals/approval-1/decision');
    expect(jsonDecode(writes.single.body)['decision'], 'approve');
  });
  testWidgets('read-only acceptance never offers mutation', (tester) async {
    final state = _State(
      MockClient((_) async => response(packet(allowed: false))),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      app(
        state,
        RequirementAcceptanceCard(
          task: task({'status': 'done'}),
          onChanged: () async {},
          onOpen: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('确认验收'), findsNothing);
    expect(find.text('退回修改'), findsNothing);
  });
  testWidgets('reject requires feedback and uses real review endpoint', (
    tester,
  ) async {
    final requests = <http.Request>[];
    final state = _State(
      MockClient((request) async {
        if (request.method == 'GET') return response(packet());
        requests.add(request);
        return response({'ok': true});
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      app(
        state,
        RequirementAcceptanceCard(
          task: task({'status': 'done'}),
          onChanged: () async {},
          onOpen: (_) {},
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('退回修改'));
    await tester.tap(find.text('退回修改'));
    await tester.pumpAndSettle();
    expect(requests, isEmpty);
    expect(find.text('请写清楚需要修改的地方。'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '缺少附件引用');
    await tester.ensureVisible(find.text('退回修改'));
    await tester.tap(find.text('退回修改'));
    await tester.pumpAndSettle();
    expect(requests.single.url.path, '/api/v1/tasks/t/reject-artifact');
    expect(jsonDecode(requests.single.body)['note'], '缺少附件引用');
    expect(jsonDecode(requests.single.body)['toAI'], true);
  });
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture';
}

class _State extends MobileState {
  _State(http.Client client) {
    api = SoduWorkApi(
      store: _Store(),
      endpoint: const EndpointSettings(
        baseUrl: 'https://hub.test',
        environment: SoduWorkEnvironment.development,
      ),
      client: client,
    );
  }
  @override
  Future<void> refreshAll() async {}
}

class _TaskState extends _State {
  final Map<String, dynamic> Function() data;
  _TaskState(super.client, this.data);
  @override
  Future<WorkTask> loadTask(String id) async => WorkTask.fromJson(data());
  @override
  Future<Map<String, dynamic>> loadTaskTrace(String id) async => {};
}

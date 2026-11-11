import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/screens/work_screen.dart';
import 'package:soduwork_mobile/screens/task_detail_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/requirement_assignment_sheet.dart';
import 'package:soduwork_mobile/ui/task_forms.dart';
import 'package:soduwork_mobile/ui/task_detail_sections.dart';

import 'memory_device_auth.dart';

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  test('PC review stage and task ownership gate assignment', () {
    expect(_task({'status': 'done'}).boardStage, 'reviewing');
    expect(
      _task({'status': 'done', 'reviewedAt': 123}).boardStage,
      'delivered',
    );
    expect(_task({'triageStage': 'intake'}).canArrange, isFalse);
    expect(_task({'readOnly': true}).canArrange, isFalse);
    expect(_task({'canViewExecution': false}).canArrange, isFalse);
    expect(
      _task({
        'ai': {'executionState': 'running'},
      }).canArrange,
      isFalse,
    );
    expect(
      _task({
        'workRouting': {
          'conversationTurn': {'state': 'queued'},
        },
      }).canArrange,
      isFalse,
    );
    expect(_task({}).canArrange, isTrue);
  });

  for (final registered in [null, 'another-runner', 'dev-runner']) {
    testWidgets(
      'local task execution requires matching registered developer runner ($registered)',
      (tester) async {
        Map<String, dynamic>? dispatched;
        final state = _State(
          MockClient((request) async {
            if (request.url.path.endsWith('task-execution-options')) {
              return _json({
                'substrates': [
                  {
                    'key': 'local:pi',
                    'name': 'Pi',
                    'cli': 'pi',
                    'available': true,
                    'locationMode': 'local',
                    'locations': [
                      {
                        'mode': 'local',
                        'label': '本机',
                        'runnerId': 'dev-runner',
                        'clientId': 'browser-device',
                        'machineKey': 'development-host',
                      },
                    ],
                  },
                ],
              });
            }
            dispatched = jsonDecode(request.body) as Map<String, dynamic>;
            return _json({
              'ok': true,
              'task': {'id': 'requirement', 'status': 'doing'},
            });
          }),
          localRunner: registered,
        );
        addTearDown(state.dispose);
        await tester.pumpWidget(
          _app(state, RequirementAssignmentSheet(task: _task({}))),
        );
        await tester.pumpAndSettle();
        final button = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, '确认派活'),
        );
        if (registered != 'dev-runner') {
          expect(button.onPressed, isNull);
          expect(dispatched, isNull);
        } else {
          await _selectLocation(tester, '开发电脑');
          await tester.tap(find.text('确认派活'));
          await tester.pumpAndSettle();
          expect(dispatched?['executionContext']['location']['mode'], 'local');
          expect(
            dispatched?['executionContext']['runner']['runnerId'],
            'dev-runner',
          );
          expect(
            dispatched?['executionContext']['runner']['clientId'],
            'browser-device',
          );
        }
      },
    );
  }

  testWidgets(
    'confirmed demand keeps its detail when conversation execution is selected',
    (tester) async {
      final state = _State(MockClient((_) async => _json({})));
      state.tasks = [
        _task({
          'origin': 'local',
          'workRouting': {
            'selectedStrategy': 'remote',
            'conversationTurn': {
              'state': 'done',
              'conversationId': 'prior-turn',
            },
          },
        }),
      ];
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, const WorkScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('需求标题'));
      await tester.pumpAndSettle();
      expect(find.byType(TaskDetailScreen), findsOneWidget);
      expect(find.text('安排 AI 执行'), findsOneWidget);
      expect(find.text('转给同事'), findsOneWidget);
    },
  );

  testWidgets(
    'remote catalog selects model and dispatch requires explicit confirmation',
    (tester) async {
      Map<String, dynamic>? dispatched;
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('task-execution-options')) {
            expect(jsonDecode(request.body)['taskId'], 'requirement');
            return _catalog();
          }
          expect(request.url.path, '/api/v1/tasks/requirement/ai-dispatch');
          dispatched = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({
            'ok': true,
            'task': {'id': 'requirement', 'status': 'doing'},
          });
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(state, RequirementAssignmentSheet(task: _task({}))),
      );
      await tester.pumpAndSettle();
      await _selectLocation(tester, '远程执行机');
      expect(find.text('Pi'), findsOneWidget);
      expect(dispatched, isNull);
      await tester.tap(find.text('使用底座默认模型'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('测试模型').last);
      await tester.pumpAndSettle();
      expect(dispatched, isNull);
      await tester.tap(find.text('确认派活'));
      await tester.pumpAndSettle();
      expect(dispatched?['assigneeId'], 'local:pi');
      expect(dispatched?['model'], 'test-model');
      expect(dispatched?['executionContext']['location']['mode'], 'remote');
      expect(dispatched?['executionContext']['strategy'], 'direct');
      expect(dispatched?.containsKey('ownerClientId'), isFalse);
      expect(state.loads, 1);
    },
  );

  testWidgets(
    'unavailable and device-local entries cannot be dispatched by phone',
    (tester) async {
      var requests = 0;
      final state = _State(
        MockClient((request) async {
          requests++;
          return _json({
            'substrates': [
              {
                'key': 'local:pi',
                'name': 'Pi',
                'available': true,
                'locationMode': 'local',
              },
              {
                'key': 'local:opencode',
                'name': 'OpenCode',
                'available': false,
                'locationMode': 'remote',
              },
            ],
          });
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(state, RequirementAssignmentSheet(task: _task({}))),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '确认派活'))
            .onPressed,
        isNull,
      );
      expect(requests, 1);
    },
  );

  for (final choice in [
    ('cloud-runner', '云端执行机 · 本机移动端执行器', '在所选云端执行机运行。'),
    ('work-runner', '我的电脑 · Cloud office', '在所选工作电脑运行，请保持该电脑在线。'),
    ('legacy-runner', '远程执行机 · Cloud legacy', '在所选远程执行机运行。'),
  ]) {
    testWidgets('execution labels preserve the selected target ${choice.$1}', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      Map<String, dynamic>? dispatched;
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('task-execution-options')) {
            return _json({
              'substrates': [
                {
                  'key': 'local:pi',
                  'name': 'Pi',
                  'cli': 'pi',
                  'available': true,
                  'modelPick': false,
                  'note': 'SoduWork 将在当前设备上按能力与负载选择可用席位',
                  'locations': [
                    {
                      'mode': 'remote',
                      'runnerId': 'cloud-runner',
                      'runnerKind': 'cloud',
                      'label': '远程 Runner · 本机移动端执行器',
                      'host': 'internal-cloud-host',
                    },
                    {
                      'mode': 'remote',
                      'runnerId': 'work-runner',
                      'runnerKind': 'work-computer',
                      'clientId': 'work-device',
                      'label': '远程 Runner · Cloud office',
                      'host': 'internal-work-host',
                    },
                    {
                      'mode': 'remote',
                      'runnerId': 'legacy-runner',
                      'label': '远程 Runner · Cloud legacy',
                      'host': 'internal-legacy-host',
                    },
                  ],
                },
              ],
            });
          }
          expect(request.url.path, '/api/v1/tasks/requirement/ai-dispatch');
          dispatched = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({
            'ok': true,
            'task': {'id': 'requirement', 'status': 'doing'},
          });
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(state, RequirementAssignmentSheet(task: _task({}))),
      );
      await tester.pumpAndSettle();
      expect(find.text('我的电脑 · Cloud office'), findsOneWidget);
      if (choice.$1 != 'work-runner') {
        await tester.tap(find.text('我的电脑 · Cloud office').first);
        await tester.pumpAndSettle();
        expect(find.text(choice.$2), findsWidgets);
        await tester.tap(find.text(choice.$2).last);
        await tester.pumpAndSettle();
      }
      expect(find.text(choice.$3), findsOneWidget);
      expect(find.textContaining('当前设备上按能力'), findsNothing);
      expect(
        dispatched,
        isNull,
        reason: 'choosing a target does not dispatch it',
      );
      expect(tester.takeException(), isNull);
      await tester.tap(find.text('确认派活'));
      await tester.pumpAndSettle();
      expect(dispatched?['executionContext']['runner']['runnerId'], choice.$1);
      expect(dispatched?['executionContext']['location']['mode'], 'remote');
      expect(dispatched?['executionContext']['location']['label'], choice.$2);
    });
  }

  testWidgets(
    'without an online personal computer cloud requires an explicit choice',
    (tester) async {
      final state = _State(
        MockClient(
          (request) async => _json({
            'substrates': [
              {
                'key': 'local:pi',
                'name': 'Pi',
                'available': true,
                'locations': [
                  {
                    'mode': 'remote',
                    'runnerId': 'cloud-only',
                    'runnerKind': 'cloud',
                    'runnerName': 'Shared execution',
                    'label': '远程 Runner',
                  },
                ],
              },
            ],
          }),
        ),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(state, RequirementAssignmentSheet(task: _task({}))),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '确认派活'))
            .onPressed,
        isNull,
      );
      await _selectLocation(tester, '云端执行机 · Shared execution');
      expect(find.text('云端执行机 · Shared execution'), findsOneWidget);
      expect(find.text('在所选云端执行机运行。'), findsOneWidget);
    },
  );

  testWidgets('dispatch rejection preserves note and permits correction', (
    tester,
  ) async {
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        return _json({'detail': '执行机离线，请稍后重试'}, 409);
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(state, RequirementAssignmentSheet(task: _task({}))),
    );
    await tester.pumpAndSettle();
    await _selectLocation(tester, '远程执行机');
    final note = find.byType(TextField);
    await tester.scrollUntilVisible(
      note,
      250,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.enterText(note, '保留验收口径');
    await tester.tap(find.text('确认派活'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(note).controller!.text, '保留验收口径');
    expect(state.loads, 0);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '确认派活'))
          .onPressed,
      isNotNull,
    );
  });

  testWidgets(
    'uncertain dispatch prevents repeated writes until task status is checked',
    (tester) async {
      var writes = 0;
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('task-execution-options')) {
            return _catalog();
          }
          writes++;
          throw http.ClientException('connection lost');
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(state, RequirementAssignmentSheet(task: _task({}))),
      );
      await tester.pumpAndSettle();
      await _selectLocation(tester, '远程执行机');
      await tester.tap(find.text('确认派活'));
      await tester.pumpAndSettle();
      expect(writes, 1);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '确认派活'))
            .onPressed,
        isNull,
      );
    },
  );

  testWidgets('changing account invalidates an already open assignment', (
    tester,
  ) async {
    var writes = 0;
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        writes++;
        return _json({});
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(state, RequirementAssignmentSheet(task: _task({}))),
    );
    await tester.pumpAndSettle();
    await _selectLocation(tester, '远程执行机');
    state.revision++;
    await tester.tap(find.text('确认派活'));
    await tester.pumpAndSettle();
    expect(writes, 0);
  });

  testWidgets('teammate selection is a draft until confirmed', (tester) async {
    final state = _State(MockClient((_) async => _json({})));
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        RequirementAssignmentSheet(task: _task({}), teammateFirst: true),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('测试同事'));
    await tester.pumpAndSettle();
    expect(state.handoffs, 0);
    await tester.tap(find.text('确认转交'));
    await tester.pumpAndSettle();
    expect(state.handoffs, 1);
    expect(state.person, 'mate-1');
  });

  testWidgets('editing preserves unrelated task fields and sends version', (
    tester,
  ) async {
    Map<String, dynamic>? patch;
    final state = _State(
      MockClient((request) async {
        expect(request.method, 'PATCH');
        patch = jsonDecode(request.body) as Map<String, dynamic>;
        return _json({'id': 'requirement', ...patch!});
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        RequirementEditSheet(
          task: _task({'canEditRequirement': true, 'requirementVersion': 7}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, '修改后的需求');
    await tester.tap(find.text('保存修改'));
    await tester.pumpAndSettle();
    expect(patch, {'requirementVersion': 7, 'title': '修改后的需求'});
    expect(state.loads, 1);
  });

  testWidgets(
    'intake exposes preparation without dispatching or changing state',
    (tester) async {
      var edits = 0;
      final state = _State(MockClient((_) async => _json({})));
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(
          state,
          TaskDetailActionBar(
            task: _task({'triageStage': 'intake', 'canEditRequirement': true}),
            busy: false,
            onEdit: () => edits++,
            onStatus: (_) => fail('unexpected status change'),
            onProgress: () {},
            onHandoff: () => fail('unexpected handoff'),
            onAi: () => fail('unexpected dispatch'),
          ),
        ),
      );
      expect(find.text('安排 AI 执行'), findsNothing);
      await tester.tap(find.text('完善需求'));
      expect(edits, 1);
    },
  );

  for (final stage in ['intake', 'clarifying']) {
    testWidgets(
      '$stage moves to ready with a versioned patch and no dispatch',
      (tester) async {
        final patches = <Map<String, dynamic>>[];
        late _State state;
        state = _State(
          MockClient((request) async {
            expect(request.method, 'PATCH');
            expect(request.url.path, '/api/v1/tasks/requirement');
            final patch = jsonDecode(request.body) as Map<String, dynamic>;
            patches.add(patch);
            state.taskValues['triageStage'] = patch['triageStage'];
            return _json({'id': 'requirement', ...state.taskValues});
          }),
        );
        state.taskValues = {
          'triageStage': stage,
          'canEditRequirement': true,
          'requirementVersion': 7,
          'acceptanceCriteria': ['File content matches'],
        };
        addTearDown(state.dispose);
        await tester.pumpWidget(
          _app(state, const TaskDetailScreen(taskId: 'requirement')),
        );
        await tester.pumpAndSettle();
        expect(find.text('安排 AI 执行'), findsNothing);
        await tester.tap(find.text('移至待开始'));
        await tester.pumpAndSettle();
        expect(patches, [
          {'requirementVersion': 7, 'triageStage': 'ready'},
        ]);
        expect(find.text('移至待开始'), findsNothing);
        expect(find.text('安排 AI 执行'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'preparation conflict keeps intake and displays the server error',
    (tester) async {
      final state = _State(
        MockClient((_) async => _json({'detail': '需求已更新，请刷新'}, 409)),
      );
      state.taskValues = {'triageStage': 'intake', 'canEditRequirement': true};
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(state, const TaskDetailScreen(taskId: 'requirement')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('移至待开始'));
      await tester.pumpAndSettle();
      expect(find.text('需求已更新，请刷新'), findsOneWidget);
      expect(find.text('移至待开始'), findsOneWidget);
      expect(find.text('安排 AI 执行'), findsNothing);
    },
  );

  testWidgets(
    'finished AI awaiting review does not claim execution is running',
    (tester) async {
      final state = _State(MockClient((_) async => _json({})));
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(
          state,
          TaskDetailActionBar(
            task: _task({
              'status': 'doing',
              'requirementStage': 'reviewing',
              'ai': {'state': 'done', 'executionState': 'done'},
            }),
            busy: false,
            onStatus: (_) => fail('unexpected status change'),
            onProgress: () {},
            onHandoff: () => fail('unexpected handoff'),
            onAi: () => fail('unexpected dispatch'),
          ),
        ),
      );
      expect(find.text('AI 执行中'), findsNothing);
      expect(find.text('安排 AI 执行'), findsNothing);
      expect(find.text('记录进展'), findsOneWidget);
    },
  );

  testWidgets('follow-only task never exposes execution actions', (
    tester,
  ) async {
    final state = _State(MockClient((_) async => _json({})));
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        TaskDetailActionBar(
          task: _task({'readOnly': true}),
          busy: false,
          onStatus: (_) => fail('read-only status'),
          onProgress: () => fail('read-only progress'),
          onHandoff: () => fail('read-only handoff'),
          onAi: () => fail('read-only dispatch'),
        ),
      ),
    );
    expect(find.text('安排 AI 执行'), findsNothing);
    expect(find.text('转给同事'), findsNothing);
    expect(find.textContaining('跟进视图'), findsOneWidget);
  });

  testWidgets(
    'human work can submit for review without being treated as AI running',
    (tester) async {
      String? status;
      final state = _State(MockClient((_) async => _json({})));
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(
          state,
          TaskDetailActionBar(
            task: _task({'status': 'doing'}),
            busy: false,
            onStatus: (value) => status = value,
            onProgress: () {},
            onHandoff: () {},
            onAi: () {},
          ),
        ),
      );
      expect(find.text('AI 执行中'), findsNothing);
      await tester.tap(find.text('提交验收'));
      expect(status, 'done');
    },
  );
}

WorkTask _task(Map<String, dynamic> values) => WorkTask.fromJson({
  'id': 'requirement',
  'title': '需求标题',
  'status': 'todo',
  ...values,
});
http.Response _catalog() => _json({
  'substrates': [
    {
      'key': 'local:pi',
      'name': 'Pi',
      'cli': 'pi',
      'available': true,
      'locationMode': 'remote',
      'modelPick': true,
    },
  ],
  'modelOptions': [
    {'name': 'test-model', 'label': '测试模型'},
  ],
  'selection': {'repoId': ''},
});
http.Response _json(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Widget _app(MobileState state, Widget child) => MobileScope(
  state: state,
  child: MaterialApp(
    theme: SoduWorkTheme.light(const SoduWorkBrandTheme()),
    home: Scaffold(body: child),
  ),
);

class _State extends MobileState {
  Map<String, dynamic> taskValues = {};
  int loads = 0, handoffs = 0, revision = 1;
  @override
  int get identityRevision => revision;
  String person = '';
  _State(http.Client client, {String? localRunner}) {
    api = _Api(
      localRunner: localRunner,
      store: _Store(),
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://hub.test',
      ),
      client: client,
    );
  }
  @override
  Future<Map<String, dynamic>> loadTaskTrace(String id) async => {};
  @override
  Future<WorkTask> loadTask(String id) async {
    loads++;
    return _task(taskValues);
  }

  @override
  Future<List<Map<String, dynamic>>> teammates() async => [
    {'id': 'mate-1', 'name': '测试同事'},
  ];
  @override
  Future<void> handoffTask(
    WorkTask task, {
    required String assigneeUserId,
    String note = '',
  }) async {
    handoffs++;
    person = assigneeUserId;
  }
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
}

class _Api extends SoduWorkApi {
  final String? localRunner;
  _Api({
    required super.store,
    required super.endpoint,
    required super.client,
    this.localRunner,
  });
  @override
  String? get localExecutionRunnerId => localRunner;
}

Future<void> _selectLocation(WidgetTester tester, String label) async {
  await tester.tap(find.text('请选择执行位置'));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.text(label).last);
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

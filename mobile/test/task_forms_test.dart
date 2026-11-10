import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/task_forms.dart';

void main() {
  testWidgets(
    'creation registers a requirement and returns it without dispatch',
    (tester) async {
      final state = _CreationState();
      addTearDown(state.dispose);
      WorkTask? returned;
      await _open(tester, state, (value) => returned = value);
      expect(find.text('交给 AI'), findsNothing);
      expect(find.text('执行方式'), findsNothing);
      await tester.enterText(find.byType(TextField).first, '核对交付清单');
      await tester.enterText(find.byType(TextField).last, '保留原需求上下文');
      await tester.ensureVisible(find.text('创建需求'));
      await tester.tap(find.text('创建需求'));
      await tester.pumpAndSettle();
      expect(state.requests, hasLength(1));
      expect(state.requests.single['title'], '核对交付清单');
      expect(state.requests.single['note'], '保留原需求上下文');
      expect(state.requests.single['handler'], 'me');
      expect(state.dispatches, 0);
      expect(returned?.id, 'created-requirement');
      expect(find.byType(CreateTaskSheet), findsNothing);
    },
  );

  testWidgets('blank requirement is rejected before creating or dispatching', (
    tester,
  ) async {
    final state = _CreationState();
    addTearDown(state.dispose);
    await _open(tester, state, (_) {});
    await tester.enterText(find.byType(TextField).first, '   ');
    await tester.ensureVisible(find.text('创建需求'));
    await tester.tap(find.text('创建需求'));
    await tester.pumpAndSettle();
    expect(find.text('请写清楚需要完成什么。'), findsOneWidget);
    expect(state.requests, isEmpty);
    expect(state.dispatches, 0);
  });

  testWidgets('saving disables repeated submission until receipt arrives', (
    tester,
  ) async {
    final state = _CreationState()..pending = Completer<WorkTask>();
    addTearDown(state.dispose);
    await _open(tester, state, (_) {});
    await tester.enterText(find.byType(TextField).first, '等待登记回执');
    await tester.ensureVisible(find.text('创建需求'));
    await tester.tap(find.text('创建需求'));
    await tester.pump();
    expect(find.text('正在创建…'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(
      tester.widget<OutlinedButton>(find.byType(OutlinedButton)).onPressed,
      isNull,
    );
    await tester.tapAt(tester.getCenter(find.byType(FilledButton)));
    await tester.pump();
    expect(state.requests, hasLength(1));
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.byType(CreateTaskSheet), findsOneWidget);
    state.pending!.complete(_CreationState.task());
    await tester.pumpAndSettle();
    expect(state.dispatches, 0);
  });

  testWidgets(
    'failed registration retains text and permits an explicit retry',
    (tester) async {
      final state = _CreationState()..fail = true;
      addTearDown(state.dispose);
      await _open(tester, state, (_) {});
      await tester.enterText(find.byType(TextField).first, '失败后保留内容');
      await tester.ensureVisible(find.text('创建需求'));
      await tester.tap(find.text('创建需求'));
      await tester.pumpAndSettle();
      expect(find.text('登记未成功，请重试'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField).first).controller!.text,
        '失败后保留内容',
      );
      state.fail = false;
      await tester.ensureVisible(find.text('创建需求'));
      await tester.tap(find.text('创建需求'));
      await tester.pumpAndSettle();
      expect(state.requests, hasLength(2));
      expect(state.dispatches, 0);
      expect(find.byType(CreateTaskSheet), findsNothing);
    },
  );

  testWidgets('cancelling creation does not register or execute anything', (
    tester,
  ) async {
    final state = _CreationState();
    addTearDown(state.dispose);
    await _open(tester, state, (_) {});
    await tester.ensureVisible(find.text('取消'));
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(state.requests, isEmpty);
    expect(state.dispatches, 0);
  });
  testWidgets('account switch invalidates an open requirement draft', (
    tester,
  ) async {
    final state = _CreationState();
    addTearDown(state.dispose);
    await _open(tester, state, (_) {});
    await tester.enterText(find.byType(TextField).first, '旧账号的需求');
    state.switchAccount();
    await tester.pumpAndSettle();
    expect(find.text('账号或会话已变化，请关闭后重新打开。'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(state.requests, isEmpty);
  });

  testWidgets(
    'unknown create result preserves draft and blocks duplicate creation',
    (tester) async {
      final state = _CreationState()..networkFailure = true;
      addTearDown(state.dispose);
      await _open(tester, state, (_) {});
      await tester.enterText(find.byType(TextField).first, '回执丢失');
      await tester.ensureVisible(find.text('创建需求'));
      await tester.tap(find.text('创建需求'));
      await tester.pumpAndSettle();
      expect(state.requests, hasLength(1));
      expect(find.textContaining('创建结果尚未确认'), findsOneWidget);
      expect(
        tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
        isNull,
      );
      expect(
        tester.widget<TextField>(find.byType(TextField).first).controller!.text,
        '回执丢失',
      );
    },
  );

  testWidgets(
    'saved requirement refresh retry does not repeat the versioned patch',
    (tester) async {
      final state = _EditState();
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: Scaffold(
              body: Builder(
                builder: (context) => TextButton(
                  child: const Text('编辑'),
                  onPressed: () => showModalBottomSheet<bool>(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => RequirementEditSheet(task: state.original),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('编辑'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, '新标题');
      await tester.tap(find.text('保存修改'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.textContaining('修改已保存，最新内容暂未加载'),
        200,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.textContaining('修改已保存，最新内容暂未加载'), findsOneWidget);
      expect(state.taskApi.patches, hasLength(1));
      expect(state.taskApi.patches.single, {
        'requirementVersion': 3,
        'title': '新标题',
      });
      await tester.tap(find.text('刷新已保存的需求'));
      await tester.pumpAndSettle();
      expect(state.taskApi.patches, hasLength(1));
      expect(state.reads, 2);
      expect(find.byType(RequirementEditSheet), findsNothing);
    },
  );
}

Future<void> _open(
  WidgetTester tester,
  _CreationState state,
  ValueChanged<WorkTask?> onResult,
) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                onResult(
                  await showModalBottomSheet<WorkTask>(
                    context: context,
                    isScrollControlled: true,
                    builder: (_) => const CreateTaskSheet(),
                  ),
                );
              },
              child: const Text('打开登记表'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开登记表'));
  await tester.pumpAndSettle();
}

class _CreationState extends MobileState {
  final requests = <Map<String, Object?>>[];
  int dispatches = 0;
  bool fail = false;
  bool networkFailure = false;
  int revision = 1;
  @override
  int get identityRevision => revision;
  void switchAccount() {
    revision++;
    notifyListeners();
  }

  Completer<WorkTask>? pending;
  _CreationState()
    : super(
        initialEndpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://unit.test',
        ),
      );

  static WorkTask task() => WorkTask.fromJson({
    'id': 'created-requirement',
    'title': '核对交付清单',
    'status': 'todo',
  });

  @override
  Future<WorkTask> createTask({
    required String title,
    String note = '',
    String priority = 'normal',
    String handler = 'me',
    String kind = 'requirement',
    String visibility = 'related',
    String triageStage = 'intake',
    List<String> acceptanceCriteria = const <String>[],
    List<String> tags = const <String>[],
    DateTime? start,
    DateTime? due,
  }) async {
    requests.add({
      'title': title,
      'note': note,
      'priority': priority,
      'handler': handler,
    });
    if (networkFailure) throw const ApiFailure('连接中断', isNetwork: true);
    if (fail) throw const ApiFailure('登记未成功，请重试');
    return pending == null ? task() : pending!.future;
  }

  @override
  Future<WorkTask> dispatchTaskToAi(
    WorkTask task, {
    required AiAssignee assignee,
    String brief = '',
  }) async {
    dispatches++;
    throw StateError('登记需求不得启动执行');
  }
}

class _EditState extends MobileState {
  final original = WorkTask.fromJson({
    'id': 'requirement',
    'title': '旧标题',
    'status': 'todo',
    'kind': 'requirement',
    'canEditRequirement': true,
    'requirementVersion': 3,
  });
  late final _TaskApi taskApi;
  int reads = 0;
  _EditState() {
    taskApi = _TaskApi();
    api = taskApi;
  }
  @override
  Future<WorkTask> loadTask(String id) async {
    if (++reads == 1) throw const ApiFailure('读取失败', isNetwork: true);
    return original;
  }
}

class _TaskApi extends SoduWorkApi {
  final patches = <Map<String, dynamic>>[];
  _TaskApi()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://unit.test',
        ),
      );
  @override
  Future<WorkTask> patchTask(String id, Map<String, dynamic> patch) async {
    patches.add(patch);
    return WorkTask.fromJson({'id': id, ...patch});
  }
}

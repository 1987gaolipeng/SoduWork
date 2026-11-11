import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/conversation_models.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/task_detail_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

class TaskFixture extends MobileState {
  TaskFixture({
    this.cloudOrigin = false,
    this.ai = false,
    this.allowView = true,
  }) {
    phase = MobilePhase.ready;
  }

  final bool cloudOrigin;
  final bool ai, allowView;
  String status = 'todo';
  final statuses = <String>[];
  int loads = 0;

  @override
  Future<WorkTask> loadTask(String id) async {
    loads++;
    return WorkTask.fromJson({
      'id': id,
      'title': '核对交付材料',
      'status': status,
      'handler': 'me',
      'origin': cloudOrigin ? 'cloud-conversation' : '',
      'canViewExecution': allowView,
      if (ai) 'ai': {'state': 'done', 'name': 'Pi'},
      'progress': [
        {'text': '已核对资料', 'at': 1780000000000},
      ],
    });
  }

  @override
  Future<AiExecutionStatus> loadAiStatus(String id) async =>
      AiExecutionStatus.fromJson({'dispatched': true, 'done': true});

  @override
  Future<Map<String, dynamic>> loadTaskTrace(String taskId) async => {
    'artifacts': [
      {'id': 'output', 'name': '交付记录.txt', 'role': 'output'},
    ],
    'attachments': [
      {'id': 'input', 'name': '参考资料.txt', 'role': 'input'},
    ],
  };

  @override
  Future<void> setTaskStatus(WorkTask task, String next) async {
    statuses.add(next);
    status = next;
  }

  @override
  Future<Map<String, dynamic>> loadConversationSession(
    String taskId, {
    String ref = '',
    int since = 0,
  }) async => {
    'ok': true,
    'status': 'done',
    'last': 1,
    'items': [
      {'seq': 1, 'kind': 'say', 'text': '来自原任务的会话'},
    ],
  };

  @override
  Future<List<ConversationAttachment>> loadConversationAttachments(
    String taskId,
  ) async => const [];
}

Future<void> showTask(WidgetTester tester, TaskFixture state) async {
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(),
        home: const TaskDetailScreen(taskId: 'task'),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('direct AI requirement opens original execution in workspace', (
    tester,
  ) async {
    final state = TaskFixture(ai: true);
    addTearDown(state.dispose);
    var opened = 0;
    state.workConversationNavigation.addListener(() => opened++);
    await showTask(tester, state);
    await tester.tap(find.text('打开执行会话'));
    await tester.pumpAndSettle();
    expect(opened, 1);
    expect(state.workConversationNavigation.destination?.taskId, 'task');
    expect(state.statuses, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
    'execution link respects explicit denial and hides on manual tasks',
    (tester) async {
      for (final state in [
        TaskFixture(ai: true, allowView: false),
        TaskFixture(),
      ]) {
        await showTask(tester, state);
        expect(find.text('打开执行会话'), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
        state.dispose();
      }
    },
  );
  testWidgets('task sections keep progress and output evidence together', (
    tester,
  ) async {
    final state = TaskFixture();
    addTearDown(state.dispose);
    await showTask(tester, state);

    expect(find.text('核对交付材料'), findsWidgets);
    expect(find.text('已核对资料'), findsOneWidget);
    await tester.drag(find.byType(ListView).first, const Offset(0, -400));
    await tester.pumpAndSettle();
    expect(find.text('交付记录.txt'), findsOneWidget);
    expect(find.text('参考资料.txt'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('task action callbacks still update and reload the same task', (
    tester,
  ) async {
    final state = TaskFixture();
    addTearDown(state.dispose);
    await showTask(tester, state);

    await tester.tap(find.text('我来处理'));
    // The running action has a continuous progress indicator. Advance frames
    // rather than waiting for that intentional animation to settle.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));
    expect(state.statuses, ['doing']);
    expect(state.loads, 2);
    expect(find.text('我来处理'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
    'cloud-origin banner opens the transcript for the original task',
    (tester) async {
      final state = TaskFixture(cloudOrigin: true);
      addTearDown(state.dispose);
      await showTask(tester, state);

      await tester.tap(find.text('这个任务来自一次云端会话'));
      await tester.pumpAndSettle();
      expect(find.text('来自原任务的会话'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}

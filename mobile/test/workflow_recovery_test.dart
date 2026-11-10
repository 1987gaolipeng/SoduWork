import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/ui/workflow_recovery_card.dart';
import 'library_screen_test.dart' show showPage, apiFor, reply;

Map<String, dynamic> card({
  String run = 'run-one',
  int attempt = 1,
  String state = 'failed',
  bool retry = true,
  String action = '',
}) => {
  'taskId': 'task-one',
  'runId': run,
  'canRetry': retry,
  'stage': {
    'key': 'execute',
    'name': '文本处理',
    'type': 'ai',
    'state': state,
    'attempt': attempt,
    'diagnosis': {'retryable': true, 'actionKey': action},
  },
};
Future<void> showRecovery(
  WidgetTester tester,
  Map<String, dynamic> initial,
  Future<http.Response> Function(http.Request) handler, {
  bool readOnly = false,
}) async {
  await showPage(
    tester,
    WorkflowRecoveryCard(
      task: WorkTask.fromJson({
        'id': 'task-one',
        'title': '验收',
        'readOnly': readOnly,
      }),
      trace: {'card': initial},
      onChanged: () async {},
    ),
    apiFor(handler),
  );
}

Future<void> confirmAction(WidgetTester tester, String title) async {
  await tester.tap(find.text(title));
  await tester.pumpAndSettle();
  await tester.tap(find.text('确认'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'recovery never replaces a human decision or readonly permissions',
    (tester) async {
      var calls = 0;
      for (final initial in [
        card(state: 'waiting_human'),
        card(retry: false),
      ]) {
        await showRecovery(tester, initial, (r) async {
          calls++;
          return reply({});
        });
        expect(find.text('重试当前关口'), findsNothing);
      }
      await showRecovery(tester, card(), (r) async {
        calls++;
        return reply({});
      }, readOnly: true);
      expect(find.text('重试当前关口'), findsNothing);
      expect(calls, 0);
    },
  );
  testWidgets('fresh attempt or run mismatch prevents retry request', (
    tester,
  ) async {
    var posts = 0;
    await showRecovery(tester, card(), (r) async {
      if (r.method == 'POST') posts++;
      return reply({'card': card(attempt: 2)});
    });
    await confirmAction(tester, '重试当前关口');
    expect(posts, 0);
    expect(find.text('运行、节点或权限已变化，请核对最新状态后再操作。'), findsOneWidget);
  });
  testWidgets('rework sends fixed node and requires same run receipt', (
    tester,
  ) async {
    final initial = card(action: 'resume-rework', state: 'rework');
    var posts = 0;
    await showRecovery(tester, initial, (r) async {
      if (r.method == 'GET') return reply({'card': initial});
      posts++;
      expect(r.url.path, '/api/v1/plugin-runs/run-one/retry-gate');
      expect(jsonDecode(r.body), {'nodeKey': 'execute', 'resumeRework': true});
      return reply({
        'ok': true,
        'run': {'id': 'other-run'},
      });
    });
    await confirmAction(tester, '按审查意见继续返修');
    expect(posts, 1);
    expect(find.text('操作结果未确认，请刷新核对运行记录，不要重复发起。'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
  });
  testWidgets(
    'recover confirms possible continuation and does not send a new task',
    (tester) async {
      final paths = <String>[];
      await showRecovery(tester, card(), (r) async {
        paths.add(r.url.path);
        if (r.method == 'GET') return reply({'card': card()});
        return reply({
          'ok': true,
          'run': {'id': 'run-one'},
        });
      });
      await tester.tap(find.text('检查并取回产出'));
      await tester.pumpAndSettle();
      expect(find.text('将检查已结束的执行并尝试收集产出；恢复成功后工作流可能继续执行后续节点。'), findsOneWidget);
      expect(paths, isEmpty);
      await tester.tap(find.text('确认'));
      await tester.pumpAndSettle();
      expect(paths, [
        '/api/v1/tasks/task-one/trace',
        '/api/v1/plugin-runs/run-one/recover-artifacts',
      ]);
      expect(find.text('操作已受理，请查看更新后的执行状态。'), findsOneWidget);
    },
  );
  testWidgets('known server rejection remains actionable with exact reason', (
    tester,
  ) async {
    await showRecovery(
      tester,
      card(),
      (r) async => r.method == 'GET'
          ? reply({'card': card()})
          : reply({'detail': '当前节点不可重试'}, 409),
    );
    await confirmAction(tester, '重试当前关口');
    expect(find.text('当前节点不可重试'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNotNull,
    );
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/work_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/state/session_feed.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/mobile_chrome.dart';
import 'package:soduwork_mobile/ui/conversation_drawer.dart';

WorkTask _task(String id, Map<String, dynamic> values) => WorkTask.fromJson({
  'id': id,
  'title': id,
  'createdBy': 'alice',
  'myRoles': ['creator'],
  ...values,
});

Map<String, dynamic> _workflowRouting() => {
  'selectedStrategy': 'workflow',
  'workflowBindingId': 'binding',
  'mobileWorkSubmission': {
    'requestId': 'mobile-request-1',
    'payloadHash': List.filled(64, 'a').join(),
    'ownerUserId': 'alice',
    'bindingId': 'binding',
    'phase': 'starting',
  },
};

ApprovalItem _approval(WorkTask task, {bool summaryOnly = false}) =>
    ApprovalItem.fromJson({
      'id': 'approval-${task.id}',
      'action': 'uat',
      'task': {
        'id': task.id,
        'title': task.title,
        if (!summaryOnly) 'origin': task.origin,
      },
    });

void main() {
  test('standalone plugin fence differs from a requirement using workflow', () {
    final standalone = _task('plugin-chat', {
      'workRouting': _workflowRouting(),
    });
    expect(standalone.isStandaloneWorkflow, isTrue);
    expect(standalone.isRequirement, isFalse);
    final requirementRouting = {
      'selectedStrategy': 'workflow',
      'workflowBindingId': 'binding',
      'workflowRunId': 'run',
      'workflow': {'input': 'existing requirement'},
    };
    final requirement = _task('confirmed-demand', {
      'workRouting': requirementRouting,
    });
    expect(requirement.isStandaloneWorkflow, isFalse);
    expect(requirement.isRequirement, isTrue);
    final marker = _workflowRouting()['mobileWorkSubmission'] as Map;
    for (final invalid in [
      null,
      'mobile-request-1',
      {'requestId': 'mobile-request-1'},
      {...marker, 'payloadHash': 'missing'},
      {...marker, 'bindingId': 'another-binding'},
      {...marker, 'ownerUserId': ''},
    ]) {
      final task = _task('requirement', {
        'workRouting': {...requirementRouting, 'mobileWorkSubmission': invalid},
      });
      expect(
        task.isRequirement,
        isTrue,
        reason: 'Malformed metadata must not hide a requirement.',
      );
    }
  });

  test(
    'only protocol provenance excludes execution carriers from requirements',
    () {
      for (final origin in [
        'cloud-conversation',
        'conversation-handoff',
        'automation',
      ]) {
        expect(_task(origin, {'origin': origin}).isRequirement, isFalse);
      }
      expect(_task('legacy-run', {'source': '定时派活'}).isRequirement, isFalse);
      for (final origin in ['', 'local', 'dispatch', 'gitlab', 'jira']) {
        final requirement = _task('你好', {
          'origin': origin,
          'handler': 'auto',
          'status': 'doing',
          'ai': {'state': 'running'},
          'workRouting': {
            'conversationTurn': {'state': 'running'},
          },
        });
        expect(
          requirement.isRequirement,
          isTrue,
          reason:
              'A real demand keeps its identity when AI or a conversation executes it.',
        );
      }
    },
  );

  test(
    'requirement counts never remove personal conversations from their store',
    () {
      final state = MobileState();
      addTearDown(state.dispose);
      final rows = [
        _task('需求', {'origin': 'local', 'status': 'doing'}),
        _task('聊天', {'origin': 'cloud-conversation', 'status': 'doing'}),
        _task('定时运行', {'origin': 'automation', 'status': 'doing'}),
        _task('独立插件工作', {'workRouting': _workflowRouting(), 'status': 'doing'}),
      ];
      state.tasks = rows;
      expect(state.requirementTasks.map((row) => row.id), ['需求']);
      expect(state.openTaskCount, 1);
      expect(state.runningCount, 1);
      expect(state.focusTasks.map((row) => row.id), ['需求']);
      expect(identical(state.tasks, rows), isTrue);
      expect(
        buildPersonalConversationFeed(
          state.tasks,
          ownerUserId: 'alice',
        ).map((row) => row.task.id),
        ['聊天'],
      );
    },
  );

  test(
    'requirement approval projection keeps global chat approvals intact',
    () {
      final state = MobileState();
      addTearDown(state.dispose);
      final chat = _task('chat', {'origin': 'cloud-conversation'});
      final demand = _task('demand', {'origin': 'local'});
      final run = _task('run', {'origin': 'automation'});
      final plugin = _task('plugin', {'workRouting': _workflowRouting()});
      state.tasks = [chat, demand, run, plugin];
      final all = [
        _approval(chat, summaryOnly: true),
        _approval(demand),
        _approval(run),
        _approval(plugin, summaryOnly: true),
        _approval(_task('external-chat', {'origin': 'cloud-conversation'})),
      ];
      state.pendingApprovals = all;
      expect(state.requirementApprovals.map((row) => row.task.id), ['demand']);
      expect(state.attentionCount, 1);
      expect(identical(state.pendingApprovals, all), isTrue);
      expect(state.pendingApprovals.length, 5);
      // Old summary-only requirement rows remain usable when the task list is
      // not loaded; explicit conversation provenance still excludes its row.
      state.tasks = [];
      state.pendingApprovals = [_approval(demand), _approval(chat)];
      expect(state.requirementApprovals.map((row) => row.task.id), ['demand']);
      expect(state.pendingApprovals.length, 2);
    },
  );

  testWidgets(
    'chat result approvals do not enter the pool, its badge or work snapshot',
    (tester) async {
      final state = MobileState();
      addTearDown(state.dispose);
      final chat = _task('chat', {
        'title': '聊天成果待确认',
        'origin': 'cloud-conversation',
        'ai': {'state': 'blocked'},
      });
      final demand = _task('demand', {'title': '真正需求待确认', 'origin': 'local'});
      state.tasks = [chat, demand];
      state.pendingApprovals = [
        _approval(chat, summaryOnly: true),
        _approval(demand),
      ];
      Widget host(Widget child) => MobileScope(
        state: state,
        child: MaterialApp(
          theme: SoduWorkTheme.light(),
          home: Scaffold(body: child),
        ),
      );
      await tester.pumpWidget(host(const WorkScreen()));
      await tester.pumpAndSettle();
      expect(find.byType(ApprovalLaneRow), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(ApprovalLaneRow),
          matching: find.text(demand.title),
        ),
        findsOneWidget,
      );
      expect(find.text(chat.title), findsNothing);
      expect(find.text('全部 1'), findsOneWidget);

      await tester.pumpWidget(host(WorkSnapshot(state: state)));
      await tester.pumpAndSettle();
      expect(find.text('1 项等待行动'), findsOneWidget);
      expect(find.text('3 项等待行动'), findsNothing);

      await tester.pumpWidget(
        host(
          ConversationDrawer(
            state: state,
            dark: false,
            onNew: () {},
            onTheme: () {},
            onDestination: (_) {},
            onEntry: (_) {},
          ),
        ),
      );
      await tester.pumpAndSettle();
      final requirementTile = find.ancestor(
        of: find.text('需求池'),
        matching: find.byType(ListTile),
      );
      expect(
        find.descendant(of: requirementTile, matching: find.byType(Badge)),
        findsOneWidget,
      );
      expect(
        find.descendant(of: requirementTile, matching: find.text('1')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: requirementTile, matching: find.text('2')),
        findsNothing,
      );
      expect(state.pendingApprovals.map((row) => row.task.id), [
        'chat',
        'demand',
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'pool search, counts and archive do not reintroduce conversation receipts',
    (tester) async {
      final state = MobileState();
      addTearDown(state.dispose);
      state.tasks = [
        _task('real', {'title': '同名工作', 'origin': 'local'}),
        _task('chat', {'title': '同名工作', 'origin': 'cloud-conversation'}),
        _task('transfer', {'title': '转移聊天', 'origin': 'conversation-handoff'}),
        _task('run', {'title': '自动化运行', 'origin': 'automation'}),
        _task('legacy-run', {'title': '旧自动化运行', 'source': '定时派活'}),
        _task('plugin', {'title': '独立插件执行', 'workRouting': _workflowRouting()}),
        _task('closed-chat', {
          'title': '归档聊天',
          'origin': 'cloud-conversation',
          'archivedAt': 1,
        }),
        _task('closed-work', {
          'title': '归档需求',
          'origin': 'local',
          'archivedAt': 1,
        }),
      ];
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: const Scaffold(body: WorkScreen()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('同名工作'), findsOneWidget);
      expect(find.text('全部 1'), findsOneWidget);
      for (final hidden in ['转移聊天', '自动化运行', '旧自动化运行', '归档聊天', '独立插件执行']) {
        expect(find.text(hidden), findsNothing);
      }
      await tester.enterText(find.byType(TextField), '同名');
      await tester.pumpAndSettle();
      expect(find.text('同名工作'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '');
      await tester.tap(find.byTooltip('归档需求'));
      await tester.pumpAndSettle();
      expect(find.text('归档需求'), findsWidgets);
      expect(find.text('归档聊天'), findsNothing);
      expect(state.tasks.length, 8);
    },
  );
}

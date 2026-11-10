import 'package:flutter/material.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/conversation_models.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/cloud_conversation_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

class ConversationFixture extends MobileState {
  ConversationFixture({this.status = 'done'}) {
    phase = MobilePhase.ready;
  }

  String status;
  final sent = <String>[];
  final decisions = <String>[];
  int stops = 0;
  int loads = 0;
  int attachmentLoads = 0;
  bool delayRound = false;
  bool uncertain = false;
  bool reject = false;
  bool truncateUserEvents = false;
  bool echoUserEvents = true;
  final messageIds = <String>[];
  final extraEvents = <Map<String, dynamic>>[];
  void finishRound() {
    status = 'done';
    extraEvents.add({
      'seq': 3 + extraEvents.length,
      'kind': 'say',
      'text': '追加工作已完成',
    });
  }

  @override
  Future<Map<String, dynamic>> loadConversationSession(
    String taskId, {
    String ref = '',
    int since = 0,
  }) async {
    loads++;
    return {
      'ok': true,
      'ref': 'conversation-ref',
      'last': 2 + extraEvents.length,
      'status': status,
      'items': [
        {'seq': 1, 'kind': 'user', 'text': '核对计划'},
        {'seq': 2, 'kind': 'say', 'text': '计划已核对'},
        ...extraEvents,
      ],
    };
  }

  int artifactSyncs = 0;
  bool artifactSyncFails = false;
  @override
  Future<AiExecutionStatus> loadAiStatus(String taskId) async {
    artifactSyncs++;
    if (artifactSyncFails) {
      throw const ApiFailure(
        'artifact sync temporarily unavailable',
        status: 503,
      );
    }
    return AiExecutionStatus.fromJson({'ok': true, 'status': status});
  }

  @override
  Future<List<ConversationAttachment>> loadConversationAttachments(
    String taskId,
  ) async {
    attachmentLoads++;
    return [
      ConversationAttachment.fromJson({
        'id': 'input',
        'filename': '参考材料.txt',
        'role': 'input',
      }),
      ConversationAttachment.fromJson({
        'id': 'output',
        'filename': extraEvents.any((item) => item['kind'] == 'say')
            ? '追加结果.txt'
            : '核对结果.txt',
        'role': 'output',
        'byAgent': true,
      }),
    ];
  }

  @override
  Future<Map<String, dynamic>> loadConversationDelivery(String taskId) async =>
      const {};

  @override
  Future<Map<String, dynamic>> sayToConversation(
    String taskId, {
    required String text,
    required String messageId,
    Map<String, String>? executionSelection,
  }) async {
    sent.add(text);
    messageIds.add(messageId);
    if (reject) throw const ApiFailure('当前设备无权继续该会话', status: 403);
    if (uncertain) {
      return {
        'ok': false,
        'pending': true,
        'uncertain': true,
        'error': '正在核对消息送达',
      };
    }
    if (echoUserEvents) {
      extraEvents.add({
        'seq': 3 + extraEvents.length,
        'kind': 'user',
        'text': truncateUserEvents && text.length > 4000
            ? text.substring(0, 4000)
            : text,
      });
    }
    if (!delayRound) status = 'running';
    return {'ok': true, 'delivery': 'accepted'};
  }

  @override
  Future<Map<String, dynamic>> stopConversation(String taskId) async {
    stops++;
    status = 'stopped';
    return {'ok': true};
  }

  @override
  Future<void> decideApproval(
    ApprovalItem item, {
    required String decision,
    String note = '',
  }) async {
    decisions.add('${item.id}:$decision:$note');
  }
}

Future<void> showConversation(
  WidgetTester tester,
  ConversationFixture state,
) async {
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(),
        home: const CloudConversationScreen(
          taskId: 'task',
          title: '计划核对',
          agentLabel: 'Pi',
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  setUp(() {
    TestWidgetsFlutterBinding.ensureInitialized();
  });

  testWidgets(
    'finished conversation keeps transcript and output-only delivery',
    (tester) async {
      final state = ConversationFixture();
      addTearDown(state.dispose);
      await showConversation(tester, state);

      expect(find.text('计划已核对'), findsOneWidget);
      expect(find.text('核对结果.txt'), findsOneWidget);
      expect(find.text('参考材料.txt'), findsNothing);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
      expect(state.loads, 1);
      expect(state.artifactSyncs, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'artifact synchronization failure keeps existing files and transcript available',
    (tester) async {
      final state = ConversationFixture()..artifactSyncFails = true;
      addTearDown(state.dispose);
      await showConversation(tester, state);
      expect(find.text('计划已核对'), findsOneWidget);
      expect(find.text('核对结果.txt'), findsOneWidget);
      expect(find.text('成果暂未同步，向下拉动可重试。'), findsOneWidget);
      expect(state.artifactSyncs, 1);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets('follow-up and confirmed stop keep a single screen lifecycle', (
    tester,
  ) async {
    final state = ConversationFixture(status: 'running');
    addTearDown(state.dispose);
    await showConversation(tester, state);

    await tester.enterText(find.byType(TextField), '补充日期');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(state.sent, ['补充日期']);
    expect(find.text('补充日期'), findsOneWidget);

    await tester.tap(find.text('叫停').first);
    await tester.pump(const Duration(milliseconds: 250));
    await tester.tap(find.text('继续执行'));
    await tester.pump(const Duration(milliseconds: 250));
    expect(state.stops, 0);

    await tester.tap(find.text('叫停').first);
    await tester.pump(const Duration(milliseconds: 250));
    await tester.tap(find.widgetWithText(FilledButton, '叫停'));
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pump();
    expect(state.stops, 1);
    expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
    'inline acceptance calls the approval bound to this conversation',
    (tester) async {
      final state = ConversationFixture()
        ..pendingApprovals = [
          ApprovalItem.fromJson({
            'id': 'approval',
            'action': 'uat',
            'status': 'pending',
            'task': {'id': 'task', 'title': '计划核对'},
          }),
        ];
      addTearDown(state.dispose);
      await showConversation(tester, state);
      await tester.tap(find.text('通过验收'));
      await tester.pump();

      expect(state.decisions, ['approval:approve:']);
      expect(find.text('已通过验收'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'finished work resumes polling through a stale terminal snapshot and reloads results',
    (tester) async {
      final state = ConversationFixture()..delayRound = true;
      addTearDown(state.dispose);
      await showConversation(tester, state);
      expect(state.attachmentLoads, 1);
      await tester.enterText(find.byType(TextField), '补充一版清单');
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('等待新一轮执行回执…'), findsOneWidget);
      final before = state.loads;
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(state.loads, greaterThan(before));
      state.finishRound();
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(find.text('计划已核对'), findsOneWidget);
      expect(find.text('追加工作已完成'), findsOneWidget);
      expect(find.text('追加结果.txt'), findsOneWidget);
      expect(state.attachmentLoads, 2);
      expect(find.text('等待新一轮执行回执…'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'uncertain messages retry the same id and old identical text is not an acknowledgement',
    (tester) async {
      final state = ConversationFixture()..uncertain = true;
      addTearDown(state.dispose);
      await showConversation(tester, state);
      await tester.enterText(find.byType(TextField), '核对计划');
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      expect(find.text('正在核对消息送达'), findsOneWidget);
      state.uncertain = false;
      await tester.tap(find.text('重试'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(state.sent, ['核对计划', '核对计划']);
      expect(state.messageIds.toSet(), hasLength(1));
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('a permission rejection preserves the follow-up for correction', (
    tester,
  ) async {
    final state = ConversationFixture()..reject = true;
    addTearDown(state.dispose);
    await showConversation(tester, state);
    await tester.enterText(find.byType(TextField), '补充日期');
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '补充日期',
    );
    expect(find.text('当前设备无权继续该会话'), findsOneWidget);
    expect(state.sent, ['补充日期']);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets(
    'a truncated long user event cannot keep an accepted message locked',
    (tester) async {
      final state = ConversationFixture()..truncateUserEvents = true;
      addTearDown(state.dispose);
      await showConversation(tester, state);
      await tester.enterText(find.byType(TextField), '长' * 4001);
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(state.sent.single.length, 4001);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
      state.finishRound();
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(find.text('追加工作已完成'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets(
    'an uncertain resumed send keeps polling after its user echo arrives before execution',
    (tester) async {
      final state = ConversationFixture()
        ..uncertain = true
        ..delayRound = true;
      addTearDown(state.dispose);
      await showConversation(tester, state);
      await tester.enterText(find.byType(TextField), '延迟执行的补充');
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      state.extraEvents.add({'seq': 3, 'kind': 'user', 'text': '延迟执行的补充'});
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      final before = state.loads;
      expect(find.text('等待新一轮执行回执…'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(state.loads, greaterThan(before));
      state.finishRound();
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(find.text('追加结果.txt'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'retry targets the uncertain message behind an accepted message without an echo',
    (tester) async {
      final state = ConversationFixture(status: 'running')
        ..echoUserEvents = false;
      addTearDown(state.dispose);
      await showConversation(tester, state);
      await tester.enterText(find.byType(TextField), '第一条');
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      state.uncertain = true;
      await tester.enterText(find.byType(TextField), '第二条');
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      state.uncertain = false;
      await tester.tap(find.text('重试'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(state.sent, ['第一条', '第二条', '第二条']);
      expect(state.messageIds[0], isNot(state.messageIds[1]));
      expect(state.messageIds[1], state.messageIds[2]);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}

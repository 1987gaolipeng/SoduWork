import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/models/account_conversation.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/conversation_composer.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets(
    'authorized computer and cloud seats remain distinct and dispatch to the chosen host',
    (tester) async {
      final state = _ComposerState()
        ..modelOptions = [
          {
            'id': 'runner:cloud:pi',
            'runnerId': 'cloud',
            'runnerKind': 'cloud',
            'cli': 'pi',
            'model': 'fast',
            'remote': true,
            'machineLabel': 'Cloud A',
          },
          {
            'id': 'runner:desk:pi',
            'runnerId': 'desk',
            'runnerKind': 'work-computer',
            'cli': 'pi',
            'model': 'fast',
            'remote': true,
            'machineLabel': 'My PC',
          },
        ];
      addTearDown(state.dispose);
      await _show(
        tester,
        state,
        branch: AccountConversation.fromJson({'id': 'source', 'revision': 6}),
      );
      expect(find.textContaining('云端执行机 · Cloud A'), findsOneWidget);
      await tester.tap(find.textContaining('本人电脑 · My PC'));
      await tester.enterText(
        find.byType(TextField),
        'Continue using this transcript',
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('派到本人电脑执行'));
      await tester.tap(find.text('派到本人电脑执行'));
      await tester.pumpAndSettle();
      expect(state.requests.single.options['targetRunnerId'], 'desk');
      expect(
        state.requests.single.options['targetRunnerKind'],
        'work-computer',
      );
      expect(state.requests.single.options['expectedRevision'], 6);
    },
  );

  testWidgets(
    'an online roster cannot enable dispatch when the handoff catalog is empty',
    (tester) async {
      final state = _ComposerState()..noTargets = true;
      addTearDown(state.dispose);
      await _show(tester, state);
      await tester.enterText(find.byType(TextField), 'Continue');
      await tester.pumpAndSettle();
      expect(find.text('暂时没有可接收本次会话的执行环境'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '派到云端执行'))
            .onPressed,
        isNull,
      );
      expect(state.requests, isEmpty);
    },
  );
  testWidgets(
    'work model picked before composing reaches the immutable dispatch payload',
    (tester) async {
      final state = _ComposerState()
        ..modelOptions = [
          {'id': 'fast', 'cli': 'pi', 'remote': true, 'model': 'fast'},
          {'id': 'careful', 'cli': 'pi', 'remote': true, 'model': 'careful'},
        ];
      addTearDown(state.dispose);
      final selected = AiAssignee.fromJson(state.modelOptions!.last);
      await _show(tester, state, initialAssignee: selected);
      await tester.enterText(find.byType(TextField), '核对模型传参');
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('派到云端执行'));
      await tester.tap(find.text('派到云端执行'));
      await tester.pumpAndSettle();
      expect(state.requests.single.options['model'], 'careful');
      expect(state.requests.single.options['agentId'], 'pi');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'typing does not restart environment discovery or loading state',
    (tester) async {
      final state = _ComposerState();
      addTearDown(state.dispose);
      await _show(tester, state);
      expect(state.rosterReads, 1);
      await tester.enterText(find.byType(TextField), '继续写一份完整的工作说明');
      await tester.pumpAndSettle();
      expect(state.rosterReads, 1);
      expect(find.text('正在读取执行环境…'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'continuation explains copied context and preserves the same branch after 503',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final state = _ComposerState()..serverUncertain = true;
      addTearDown(state.dispose);
      final branch = AccountConversation.fromJson({
        'id': 'source',
        'revision': 6,
        'title': '原电脑聊天',
      });
      await _show(tester, state, branch: branch);
      expect(find.text('用这段聊天继续'), findsOneWidget);
      expect(find.text('参考图片'), findsNothing);
      await tester.tap(find.textContaining('云端执行机 ·').first);
      await tester.enterText(find.byType(TextField), '继续整理');
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('派到云端执行'));
      await tester.tap(find.text('派到云端执行'));
      await tester.pumpAndSettle();
      expect(state.requests.single.isAccountBranch, isTrue);
      expect(state.requests.single.options['expectedRevision'], 6);
      expect(state.pendingCloudRequest, same(state.requests.single));
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('新建会话'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '继续整理',
      );
      await tester.ensureVisible(find.text('重试确认'));
      await tester.tap(find.text('重试确认'));
      await tester.pumpAndSettle();
      expect(state.requests.last, same(state.requests.first));
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'uncertain creation reopens the same immutable request and uses the foundation id',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final state = _ComposerState();
      addTearDown(state.dispose);
      await _show(tester, state);
      if (find.textContaining('云端执行机 ·').evaluate().isNotEmpty) {
        await tester.tap(find.textContaining('云端执行机 ·').first);
      }
      await tester.enterText(find.byType(TextField), '整理发布清单');
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '派到云端执行'))
            .onPressed,
        isNotNull,
      );
      await tester.ensureVisible(find.text('派到云端执行'));
      await tester.tap(find.text('派到云端执行'));
      await tester.pumpAndSettle();
      expect(state.requests.single.options['agentId'], 'pi');
      expect(state.pendingCloudRequest, same(state.requests.single));
      expect(tester.widget<TextField>(find.byType(TextField)).readOnly, isTrue);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('新建会话'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '整理发布清单',
      );
      await tester.ensureVisible(find.text('重试确认'));
      await tester.tap(find.text('重试确认'));
      await tester.pumpAndSettle();
      expect(state.requests, hasLength(2));
      expect(state.requests[1], same(state.requests[0]));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('local-only seats never enable remote conversation submission', (
    tester,
  ) async {
    final state = _ComposerState()..remote = false;
    addTearDown(state.dispose);
    await _show(tester, state);
    if (find.textContaining('云端执行机 ·').evaluate().isNotEmpty) {
        await tester.tap(find.textContaining('云端执行机 ·').first);
      }
      await tester.enterText(find.byType(TextField), '整理发布清单');
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '派到云端执行'))
          .onPressed,
      isNull,
    );
    expect(state.requests, isEmpty);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _show(
  WidgetTester tester,
  MobileState state, {
  AccountConversation? branch,
  AiAssignee? initialAssignee,
}) async {
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showConversationComposer(
                context,
                branch: branch,
                initialAssignee: initialAssignee,
              ),
              child: const Text('新建会话'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('新建会话'));
  await tester.pumpAndSettle();
}

class _ComposerState extends MobileState {
  final requests = <CloudConversationRequest>[];
  int rosterReads = 0;
  List<Map<String, dynamic>>? modelOptions;
  bool remote = true;
  bool noTargets = false;
  bool serverUncertain = false;
  _ComposerState()
    : super(
        initialEndpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://unit.test',
        ),
      );

  @override
  Future<AiRoster> aiAgents({bool force = false}) async {
    rosterReads++;
    return AiRoster.fromJson({
      'agents':
          modelOptions ??
          [
            {
              'id': 'runner:desk:pi',
              'cli': 'pi',
              'cliName': 'Pi',
              'remote': remote,
            },
          ],
    });
  }

  @override
  Future<Map<String, dynamic>> cloudConversationTargets() async => {
    'targets': noTargets
        ? []
        : [
            for (final row
                in modelOptions ??
                    [
                      {'id': 'runner:desk:pi', 'cli': 'pi', 'remote': remote},
                    ])
              {
                ...row,
                'agentId': row['cli'],
                'runnerId': row['runnerId'] ?? 'desk',
                'runnerKind': row['runnerKind'] ?? 'cloud',
              },
          ],
  };

  @override
  Future<Map<String, dynamic>> startCloudConversation({
    required String text,
    String agentId = '',
    String model = '',
    String title = '',
    List<XFile> files = const [],
    CloudConversationRequest? request,
  }) async {
    requests.add(request!);
    if (requests.length == 1) {
      if (serverUncertain) throw const ApiFailure('接单确认中', status: 503);
      throw const ApiFailure('网络断开', isNetwork: true);
    }
    return {'ok': true, 'taskId': 'confirmed-task'};
  }
}

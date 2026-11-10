import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/ui/pending_cloud_request_banner.dart';
import 'package:soduwork_mobile/ui/conversation_composer.dart';

class _State extends MobileState {
  final reply = Completer<Map<String, dynamic>>();
  int checks = 0;
  int discoveryReads = 0;
  @override
  Future<AiRoster> aiAgents({bool force = false}) async {
    discoveryReads++;
    throw StateError('Executor discovery is unavailable during recovery');
  }
  @override
  Future<Map<String, dynamic>> cloudConversationTargets() {
    discoveryReads++;
    throw StateError('Handoff discovery is unavailable during recovery');
  }
  @override
  Future<void> restorePendingBranch() async {}
  @override
  Future<Map<String, dynamic>> reconcilePendingCloudRequest() {
    checks++;
    return reply.future;
  }
}

void main() {
  Future<_State> pending() async {
    final state = _State();
    final request = await CloudConversationRequest.prepare(
      text: 'original',
      agentId: 'pi',
    );
    state.pendingCloudRequest = CloudConversationRequest.restoreCheckpoint(
      request.checkpoint(),
    );
    return state;
  }

  testWidgets(
    'receipt recovery works at narrow width and prevents duplicate checks',
    (tester) async {
      tester.view.physicalSize = const Size(320, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final state = await pending();
      addTearDown(state.dispose);
      Map<String, dynamic>? opened;
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(
              body: PendingCloudRequestBanner(
                onResolved: (receipt) => opened = receipt,
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('核对发送结果'));
      await tester.pump();
      expect(find.text('正在核对'), findsOneWidget);
      await tester.tap(find.text('正在核对'));
      expect(state.checks, 1);
      state.reply.complete({'taskId': 'task-1', 'ref': 'cloud-1'});
      await tester.pumpAndSettle();
      expect(opened?['taskId'], 'task-1');
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'missing receipt remains actionable and does not open a conversation',
    (tester) async {
      final state = await pending();
      addTearDown(state.dispose);
      var opened = false;
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(
              body: PendingCloudRequestBanner(onResolved: (_) => opened = true),
            ),
          ),
        ),
      );
      await tester.tap(find.text('核对发送结果'));
      state.reply.completeError(const ApiFailure('not found', status: 404));
      await tester.pumpAndSettle();
      expect(find.textContaining('云端暂未找到原请求回执'), findsOneWidget);
      expect(find.text('核对发送结果'), findsOneWidget);
      expect(state.pendingCloudRequest, isNotNull);
      expect(opened, isFalse);
    },
  );
  testWidgets(
    'native composer restores receipt-only request without casting missing draft',
    (tester) async {
      final state = await pending();
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: const MaterialApp(
            home: Scaffold(body: ConversationComposer()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('核对发送结果'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(state.discoveryReads, 0);
      expect(tester.takeException(), isNull);
    },
  );
}

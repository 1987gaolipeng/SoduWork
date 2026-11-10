import 'package:flutter/material.dart';
import '../screens/cloud_conversation_screen.dart';
import '../state/mobile_scope.dart';
import '../state/work_conversation_navigation.dart';

/// All workspace entry points target its existing conversation surface.
/// Isolated SDK screens retain their standalone navigation fallback.
Future<void> openWorkConversation(
  BuildContext context, {
  required String taskId,
  required String title,
  String agentLabel = '',
  String ref = '',
}) async {
  final state = MobileScope.read(context);
  final opened = state.workConversationNavigation.open(
    WorkConversationDestination(
      taskId: taskId,
      title: title,
      agentLabel: agentLabel,
      ref: ref,
      identity: state.identityRevision,
    ),
  );
  if (opened) return;
  await Navigator.of(context).push<void>(
    MaterialPageRoute(
      builder: (_) => CloudConversationScreen(
        taskId: taskId,
        title: title,
        agentLabel: agentLabel,
        ref: ref,
      ),
    ),
  );
}

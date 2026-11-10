import 'dart:convert';

import '../models/work_models.dart';
import 'requirement_review_conversation.dart';
import 'soduwork_api.dart';

/// Recover navigation hints from the submitted context, never access rights.
/// Both the source requirement and selected chat are authorized again by Hub.
bool matchesReviewHistory(
  Map<String, dynamic> row,
  RequirementReviewConversation review,
  String userId,
) {
  final task = WorkTask.fromJson(row);
  if (userId.isEmpty ||
      task.id.isEmpty ||
      task.id == review.taskId ||
      task.origin != 'cloud-conversation' ||
      task.cloudSessionId.isEmpty ||
      task.createdBy != userId ||
      !task.canSend ||
      task.canViewExecution == false ||
      task.archived ||
      !task.note.startsWith('【${review.label}】\n')) {
    return false;
  }
  const start = '\n固定版本材料：\n';
  const end = '\n验收人补充说明：\n';
  final first = task.note.indexOf(start);
  if (first < 0) return false;
  final last = task.note.indexOf(end, first + start.length);
  if (last < 0 || last - first > 50000 + start.length) return false;
  try {
    final data = jsonDecode(task.note.substring(first + start.length, last));
    return data is Map &&
        data['taskId'] == review.taskId &&
        data['approvalId'] == review.approvalId &&
        data['artifactVersionId'] == review.artifactVersionId &&
        data['requirementVersion'] == review.requirementVersion;
  } on FormatException {
    return false;
  }
}

Future<String> findReviewHistory(
  SoduWorkApi api,
  RequirementReviewConversation review,
  String userId,
  void Function() check,
) async {
  if (userId.isEmpty) throw const ApiFailure('请登录后重新打开验收分析。');
  // This endpoint returns the full visible task collection, not a history page.
  final rows = await api.cloudConversations();
  check();
  final matching =
      rows.where((row) => matchesReviewHistory(row, review, userId)).toList()
        ..sort((a, b) {
          final order = WorkTask.fromJson(
            b,
          ).createdAt.compareTo(WorkTask.fromJson(a).createdAt);
          return order != 0
              ? order
              : (b['id'] as String).compareTo(a['id'] as String);
        });
  if (matching.isEmpty) return '';
  final id = matching.first['id'] as String;
  final current = await api.taskData(id);
  check();
  if (current['id'] != id || !matchesReviewHistory(current, review, userId)) {
    throw const ApiFailure('原分析会话或访问权限已变化，请刷新后重试。');
  }
  await review.validate(api, check);
  if (review.automatic) {
    final session = await api.conversationSession(id);
    check();
    final automatic = jsonMap(session['mobileAcceptance']);
    final result = jsonMap(automatic['result']);
    if (result['error'] != null) return '';
  }
  return id;
}

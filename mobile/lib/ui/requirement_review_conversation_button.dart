import 'package:flutter/material.dart';
import '../core/requirement_review_conversation.dart';
import '../core/requirement_review_history.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../state/work_conversation_navigation.dart';
import 'mobile_display_preferences.dart';

class RequirementReviewConversationButton extends StatefulWidget {
  final String taskId;
  const RequirementReviewConversationButton({super.key, required this.taskId});
  @override
  State<RequirementReviewConversationButton> createState() =>
      _ReviewButtonState();
}

class _ReviewButtonState extends State<RequirementReviewConversationButton> {
  bool _busy = false;
  String _error = '';

  Future<void> _open({bool automatic = false}) async {
    if (_busy) return;
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    final taskId = widget.taskId;
    bool current() =>
        mounted &&
        state.identityRevision == identity &&
        widget.taskId == taskId;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final packet = await state.api.taskAcceptanceContext(taskId);
      if (!current()) return;
      final review = RequirementReviewConversation.fromPacket(
        taskId,
        packet,
        automatic: automatic,
      );
      final navigation = state.workConversationNavigation;
      var existing = review.automatic ? '' : navigation.taskForReview(review);
      if (existing.isEmpty) {
        existing = await findReviewHistory(
          state.api,
          review,
          state.enrollment?.ownerUserId ?? '',
          () {
            if (!current()) throw const ApiFailure('账号或页面已变化，请重新打开。');
          },
        );
        if (!current()) return;
        if (existing.isNotEmpty) navigation.bindReview(existing, review);
      }
      if (!navigation.open(
        WorkConversationDestination(
          taskId: existing,
          title: '${review.label} · ${review.title}',
          identity: identity,
          review: review,
        ),
      )) {
        throw const ApiFailure('请从移动端主界面的需求池打开验收分析。');
      }
    } on ApiFailure catch (error) {
      if (mounted && current()) {
        setState(() => _error = error.message);
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text(error.message)));
      }
    } finally {
      if (current()) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Wrap(
        spacing: 8,
        children: [
          OutlinedButton.icon(
            onPressed: _busy ? null : () => _open(),
            icon: const Icon(Icons.forum_outlined, size: 18),
            label: Text(mobileText(context, _busy ? '正在读取验收信息' : '在会话中分析')),
          ),
          OutlinedButton.icon(
            onPressed: _busy ? null : () => _open(automatic: true),
            icon: const Icon(Icons.fact_check_outlined, size: 18),
            label: Text(mobileText(context, '自动验收')),
          ),
        ],
      ),
      Text(mobileText(context, '分析当前交付版本，完成后回到此需求确认或退回。')),
      Text(mobileText(context, '自动验收会逐项核验，并按结果确认或退回修改；发送后开始。')),
      if (_error.isNotEmpty) Text(mobileText(context, _error)),
    ],
  );
}

import 'package:flutter/foundation.dart';
import '../core/requirement_review_conversation.dart';

/// Ephemeral workspace navigation only. Execution remains authoritative on Hub.
class WorkConversationDestination {
  final String taskId, title, agentLabel, ref;
  final int identity;
  final RequirementReviewConversation? review;
  const WorkConversationDestination({
    required this.taskId,
    required this.title,
    required this.identity,
    this.agentLabel = '',
    this.ref = '',
    this.review,
  });

  bool resumesReviewDraft({
    required String? activeTaskId,
    required RequirementReviewConversation? draft,
  }) =>
      taskId.isEmpty &&
      activeTaskId == null &&
      review != null &&
      draft?.key == review!.key;
}

class WorkConversationNavigation extends ChangeNotifier {
  WorkConversationDestination? destination;
  void Function(WorkConversationDestination)? beforeOpen;
  final _reviews = <String, RequirementReviewConversation>{};

  RequirementReviewConversation? reviewForTask(String? id) => _reviews[id];

  String taskForReview(RequirementReviewConversation review) {
    for (final entry in _reviews.entries) {
      if (entry.value.key == review.key) return entry.key;
    }
    return '';
  }

  void bindReview(String id, RequirementReviewConversation review) {
    if (id.isNotEmpty && id != review.taskId) _reviews[id] = review;
  }

  void clear() {
    destination = null;
    _reviews.clear();
  }

  bool open(WorkConversationDestination value) {
    if (!hasListeners || (value.taskId.isEmpty && value.review == null)) {
      return false;
    }
    // Validate before notifyListeners, which reports rather than rethrows errors.
    beforeOpen?.call(value);
    destination = value;
    notifyListeners();
    return true;
  }
}

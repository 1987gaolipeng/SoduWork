import '../models/conversation_models.dart';
import '../models/work_models.dart';

/// One row of the unified work feed. Every task — cloud conversation or
/// manual to-do — is presented through the same "session" shape so the
// Conversation and work tabs share a task-backed model.
class SessionFeedEntry {
  final WorkTask task;

  const SessionFeedEntry(this.task);

  bool get isCloudConversation => task.origin == 'cloud-conversation';

  bool get running => task.isRunning;

  bool get attention => task.needsAttention;

  bool get finished => task.status == 'done';

  bool get open => task.isOpen;

  /// Executor label with the same fallback chain as the conversation list.
  String get agentLabel {
    if (task.aiName.isNotEmpty) return task.aiName;
    if (task.createdByName.isNotEmpty) return task.createdByName;
    return '云端执行';
  }

  /// Last known activity line for the row subtitle.
  String get lastActivity {
    final progress = task.latestProgress;
    if (progress.isNotEmpty) return progress;
    if (task.note.isNotEmpty) return task.note;
    if (running) return '正在云端执行…';
    return '等待开始';
  }

  /// Compact status for the pill on a session row.
  String get statusLabel {
    if (task.aiState.isNotEmpty) {
      final label = conversationStateLabel(task.aiState);
      if (label.isNotEmpty) return label;
    }
    return switch (task.status) {
      'doing' => '执行中',
      'done' => '已完成',
      'cancel' || 'cancelled' || 'stopped' => '已停止',
      'todo' => '待推进',
      _ => '进行中',
    };
  }

  /// Accent color role for the row: attention > finished > running/queued.
  SessionTone get tone {
    if (attention) return SessionTone.attention;
    if (finished) return SessionTone.done;
    if (running) return SessionTone.running;
    return SessionTone.idle;
  }
}

enum SessionTone { attention, done, running, idle }

/// Builds the feed: items that need me first, then live ones, then the rest
/// by recency. Manual to-dos and cloud conversations stay interleaved so the
/// conversations tab reads as one continuous work stream.
List<SessionFeedEntry> buildSessionFeed(Iterable<WorkTask> tasks) {
  final rows = [for (final task in tasks) SessionFeedEntry(task)];
  rows.sort((a, b) {
    final rankA = _rank(a);
    final rankB = _rank(b);
    if (rankA != rankB) return rankA.compareTo(rankB);
    return b.task.createdAt.compareTo(a.task.createdAt);
  });
  return rows;
}

int _rank(SessionFeedEntry entry) {
  if (entry.attention) return 0;
  if (entry.running) return 1;
  if (entry.open) return 2;
  return 3;
}

/// Filter keys shared by the work tab segments: open / doing / attention /
/// done / all.
bool matchesFeedFilter(SessionFeedEntry entry, String filter) {
  return switch (filter) {
    'doing' => entry.running,
    'done' => entry.finished,
    'attention' => entry.attention,
    'all' => true,
    _ => entry.open,
  };
}

/// Personal history requires chat provenance or a recorded requirement execution,
/// plus an exact trusted creator account. Visibility alone is not ownership.
List<SessionFeedEntry> buildPersonalConversationFeed(
  Iterable<WorkTask> tasks, {
  required String ownerUserId,
}) {
  if (ownerUserId.isEmpty) return [];
  return buildSessionFeed(
    tasks.where((task) {
      final executedRequirement =
          task.isRequirement &&
          task.hasExecutionHistory &&
          task.runnerKind.isNotEmpty &&
          task.canViewExecution == true;
      if ((task.origin != 'cloud-conversation' && !executedRequirement) ||
          task.canViewExecution == false) {
        return false;
      }
      // Devices can change accounts; device ownership alone is not account provenance.
      return task.createdBy.isNotEmpty && task.createdBy == ownerUserId;
    }),
  );
}

/// Match projections by server-provided identities, never by display titles.
Set<String> cloudConversationSourceIds(Iterable<SessionFeedEntry> entries) => {
  for (final entry in entries.where((entry) => entry.isCloudConversation)) ...[
    'cloud-task:${entry.task.id}',
    if (entry.task.cloudSessionId.isNotEmpty) entry.task.cloudSessionId,
  ],
};

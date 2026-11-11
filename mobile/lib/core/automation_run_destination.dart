import '../models/account_conversation.dart';
import '../models/work_models.dart';
import '../state/account_conversation_sync.dart';
import 'soduwork_api.dart';

/// IDs from different execution systems are never interchangeable.
class AutomationRunDestination {
  final String taskId;
  final bool cloud;
  final String ref;
  final AccountConversation? account;

  const AutomationRunDestination({
    this.taskId = '',
    this.cloud = false,
    this.ref = '',
    this.account,
  });

  static Future<AutomationRunDestination> resolve({
    required AutomationRun run,
    required SoduWorkApi api,
    required String ownerClientId,
    required bool Function() isCurrent,
  }) async {
    void check() {
      if (!isCurrent()) throw const ApiFailure('账号或连接已变化，请重新打开运行记录。');
    }

    check();
    if (run.receipt['executionMode'] == 'soduwork.cloud-automation/v1') {
      final requestId = run.conversationId;
      if (!RegExp(r'^schedule-[a-f0-9]{64}$').hasMatch(requestId)) {
        throw const ApiFailure('云端会话回执不完整，请刷新运行记录后重试。');
      }
      final taskId = (run.receipt['taskId'] ?? run.taskId).toString().trim();
      if (!RegExp(r'^[a-f0-9-]{36}$').hasMatch(taskId)) {
        throw const ApiFailure('云端会话回执不完整，请刷新运行记录后重试。');
      }
      // Cloud tasks are account-scoped; handoff receipts are creator-device-scoped.
      // Revalidate the task and source session before opening a peer's result.
      final task = await api.task(taskId);
      check();
      if (task.id != taskId ||
          task.origin != 'cloud-conversation' ||
          task.cloudSessionId != requestId ||
          task.canViewExecution == false) {
        throw const ApiFailure('无法核对本次云端会话，请刷新运行记录后重试。');
      }
      return AutomationRunDestination(taskId: taskId, cloud: true);
    }
    if (run.taskId.isNotEmpty) {
      return AutomationRunDestination(taskId: run.taskId);
    }
    if (run.conversationId.isEmpty) {
      throw const ApiFailure('尚未收到会话回执，请刷新运行记录后重试。');
    }
    if (run.conversationId.startsWith('mobile-automation:')) {
      if (run.conversationId != 'mobile-automation:${run.id}') {
        throw const ApiFailure('会话回执与本次运行不匹配，请刷新后重试。');
      }
      final receipt = await api.automationConversationReceipt(
        run.conversationId,
      );
      check();
      final taskId = (receipt['taskId'] ?? '').toString().trim();
      if (receipt['ok'] != true || taskId.isEmpty) {
        throw const ApiFailure('会话尚未建立完成，请稍后重试查看结果。');
      }
      return AutomationRunDestination(
        taskId: taskId,
        cloud: true,
        ref: (receipt['ref'] ?? '').toString(),
      );
    }
    // PC receipts contain a device-local session ID. Only the authoritative
    // account directory can map that ID AND its owner device to a projection.
    if (ownerClientId.trim().isEmpty) {
      throw const ApiFailure('无法确定此会话的来源设备，请在执行该自动化的电脑上查看结果。');
    }
    final directory = AccountConversationSync();
    await directory.refresh(
      load: ({required after, required limit}) =>
          api.accountConversations(after: after, limit: limit),
      isCurrent: isCurrent,
      maxPages: 100,
    );
    check();
    if (directory.error.isNotEmpty) throw ApiFailure(directory.error);
    if (directory.hasMore) throw const ApiFailure('会话目录过大，尚未完整读取，请在来源电脑查看结果。');
    final matches = directory.conversations
        .where(
          (row) =>
              row.sourceClientId == ownerClientId &&
              row.sourceSessionId == run.conversationId,
        )
        .toList(growable: false);
    if (matches.length != 1) {
      throw const ApiFailure('此电脑会话尚未同步到当前账号，请在来源电脑查看，或同步后重试。');
    }
    return AutomationRunDestination(account: matches.single);
  }
}

import '../models/work_models.dart';

/// Mirrors client/core/requirements.js. The Hub remains authoritative.
bool requirementMatchesScope(WorkTask task, String scope, Set<String> pending) {
  final roles = task.myRoles;
  final closed = task.boardStage == 'closed';
  final approval = !closed && pending.contains(task.id);
  switch (scope) {
    case 'created':
      return roles.any(const {'creator', 'requester'}.contains);
    case 'assigned':
      return roles.any(const {'executor', 'assignee'}.contains);
    case 'related':
      return approval ||
          roles.any(
            const {'creator', 'requester', 'executor', 'assignee'}.contains,
          );
    case 'actionable':
      if (closed) return false;
      if (task.boardStage == 'reviewing' && task.canReview) return true;
      if (approval) return true;
      if (task.boardStage == 'delivered' ||
          task.canViewExecution == false ||
          task.status == 'done') {
        return false;
      }
      if (task.needsMe) return true;
      if (!roles.any(const {'executor', 'assignee'}.contains)) return false;
      if (const {'running', 'dispatching'}.contains(task.aiState) &&
          !task.aiAttentionRaised) {
        return false;
      }
      return task.aiState != 'done';
    default:
      return true;
  }
}

({bool visible, bool enabled, String reason}) requirementMaintenance(
  WorkTask task,
  Map<String, dynamic> raw,
) {
  final restore = task.boardStage == 'closed';
  final allowed = raw['canArchiveRequirement'] is bool
      ? raw['canArchiveRequirement'] == true
      : task.canArchiveRequirement ?? task.canEditRequirement;
  const hidden = (visible: false, enabled: false, reason: '没有维护此需求的权限');
  if (!allowed) return hidden;
  if (!restore &&
      const {'intake', 'clarifying', 'ready'}.contains(task.boardStage) &&
      !task.myRoles.contains('creator')) {
    return hidden;
  }
  const live = {
    'queued',
    'dispatching',
    'running',
    'starting',
    'preparing',
    'waiting',
    'waiting_human',
    'waiting_external',
    'paused',
  };
  final blocked = raw['maintenanceBlocked'] is bool
      ? raw['maintenanceBlocked'] == true
      : task.maintenanceBlocked ??
            (live.contains(task.conversationTurnState) ||
                live.contains(
                  task.aiExecutionState.isEmpty
                      ? task.aiState
                      : task.aiExecutionState,
                ));
  if (blocked) {
    return (
      visible: restore,
      enabled: false,
      reason:
          (raw['maintenanceBlockReason'] ??
                  (task.maintenanceBlockReason.isEmpty
                      ? null
                      : task.maintenanceBlockReason) ??
                  '关联流程或执行尚未结束，请先结束后再操作')
              .toString(),
    );
  }
  final enabled =
      restore ||
      const {
        'intake',
        'clarifying',
        'ready',
        'delivered',
      }.contains(task.boardStage);
  return (
    visible: enabled,
    enabled: enabled,
    reason: enabled ? '' : '当前需求尚未结束，不能归档',
  );
}

Map<String, dynamic>? phaseEvidenceArtifact(Map<String, dynamic> evidence) {
  final id = (evidence['attachmentId'] ?? '').toString().trim();
  final url = (evidence['url'] ?? '').toString().trim();
  // An execution/check id is never treated as an attachment id.
  if (id.isEmpty && url.isEmpty) return null;
  if (id.isEmpty) {
    final uri = Uri.tryParse(url);
    if (uri == null ||
        !{'http', 'https'}.contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      return null;
    }
  }
  return {
    ...evidence,
    'attachmentId': id,
    'url': url,
    'filename':
        evidence['filename'] ?? evidence['title'] ?? evidence['name'] ?? '阶段证据',
    'contentType':
        evidence['mime'] ??
        evidence['contentType'] ??
        'application/octet-stream',
  };
}

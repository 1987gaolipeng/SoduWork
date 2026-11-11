import '../models/work_models.dart';
import 'execution_target.dart';

/// Agent discovery supplies models, while the handoff catalog authorizes hosts.
AiRoster conversationTargetRoster(
  AiRoster models,
  Map<String, dynamic> catalog,
) {
  final agents = <AiAssignee>[];
  for (final raw in catalog['targets'] as List? ?? const []) {
    if (raw is! Map || raw['available'] == false) continue;
    final row = normalizeExecutionTarget(raw);
    if (!isUsableExecutionTarget(row) ||
        (row['runnerId'] as String).isEmpty ||
        !const ['cloud', 'work-computer'].contains(row['runnerKind'])) {
      continue;
    }
    agents.add(
      AiAssignee.fromJson({
        ...row,
        'id': row['id'] ?? 'runner:${row['runnerId']}:${row['agentId']}',
        'cli': row['agentId'],
        'machineLabel': row['runnerName'],
      }),
    );
  }
  return AiRoster(
    agents: agents,
    reason: '',
    provider: models.provider,
    defaultId: models.defaultId,
    modelNames: models.modelNames,
  );
}

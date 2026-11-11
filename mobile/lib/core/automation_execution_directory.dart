import 'soduwork_api.dart';
import 'execution_target.dart';

/// Preserve desktop execution options and add only account-authorized remote seats.
/// The Hub still validates the exact seat again during preflight and dispatch.
Future<Map<String, dynamic>> loadAutomationExecutionDirectory(
  SoduWorkApi api,
) async {
  final local = await api.automationExecutionOptions();
  final remote = await api.cloudConversationTargets();
  return mergeAutomationExecutionDirectory(local, remote);
}

Map<String, dynamic> mergeAutomationExecutionDirectory(
  Map<String, dynamic> local,
  Map<String, dynamic> remote,
) {
  final rows = <Map<String, dynamic>>[
    for (final row in local['substrates'] as List? ?? const [])
      if (row is Map) Map<String, dynamic>.from(row),
  ];
  final keys = rows.map((row) => row['key']).toSet();
  for (final value in remote['targets'] as List? ?? const []) {
    if (value is! Map || !isUsableExecutionTarget(value)) continue;
    final target = normalizeExecutionTarget(value);
    final id = target['id'];
    final agent = target['agentId'];
    if (id is! String ||
        !id.startsWith('runner:') ||
        agent is! String ||
        agent.isEmpty ||
        !keys.add(id)) {
      continue;
    }
    rows.add({
      'key': id,
      'name': value['name'] ?? agent,
      'cli': agent,
      'adapterId': agent,
      'available': true,
      'locationLabel':
          '${isWorkComputerExecutionTarget(target) ? '本人在线 PC' : '云端执行机'} · ${target['runnerName']}',
      'runnerKind': target['runnerKind'],
      'runnerId': target['runnerId'],
      'onlineSeats': 1,
    });
  }
  // Prefer an account-authorized online personal computer for new plans.
  // Existing plans keep their explicit assignee identifier.
  bool personal(Map<String, dynamic> row) =>
      row['runnerKind'] == 'work-computer' &&
      row['available'] != false &&
      row['online'] != false;
  final ordered = [
    ...rows.where(personal),
    ...rows.where((row) => !personal(row)),
  ];
  final availability = local['availability'] is Map
      ? Map<String, dynamic>.from(local['availability'] as Map)
      : <String, dynamic>{};
  if (rows.any((row) => row['available'] != false)) {
    availability['agentReason'] = '';
  }
  return {...local, 'substrates': ordered, 'availability': availability};
}

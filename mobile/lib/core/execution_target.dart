/// Normalize execution targets from both the PC roster and the Hub handoff catalog.
///
/// The PC roster includes explicit type/online/remote fields. Older Hub
/// responses omit those fields but still carry a runner id and an agent id
/// (or a runner-qualified target id). Mobile must consume both shapes.
Map<String, dynamic> normalizeExecutionTarget(Map raw) {
  final row = <String, dynamic>{};
  raw.forEach((key, value) => row[key.toString()] = value);
  var agent = _text(row['agentId']);
  if (agent.isEmpty) agent = _text(row['cli']);
  if (agent.isEmpty) {
    final id = _text(row['id']);
    if (id.startsWith('runner:')) {
      final parts = id.split(':');
      if (parts.length >= 3) agent = parts.last;
    }
  }
  final runner = _text(row['runnerId']);
  final runnerKind = _text(
    row['runnerKind'],
    fallback: row['isWorkComputer'] == true || _text(row['clientId']).isNotEmpty
        ? 'work-computer'
        : 'cloud',
  );
  final remote = row.containsKey('remote')
      ? row['remote'] == true
      : runner.isNotEmpty || _text(row['id']).startsWith('runner:');
  row['agentId'] = agent;
  row['type'] = _text(row['type'], fallback: 'agent');
  row['online'] = row.containsKey('online') ? row['online'] == true : remote;
  row['remote'] = remote;
  row['runnerId'] = runner;
  row['runnerKind'] = runnerKind;
  row['isWorkComputer'] = runnerKind == 'work-computer';
  row['modelPick'] =
      row['modelPick'] == true || _text(row['modelMode']) == 'managed';
  row['cliName'] = _text(
    row['cliName'],
    fallback: _text(row['name'], fallback: agent),
  );
  row['runnerName'] = _text(
    row['runnerName'],
    fallback: _text(row['machineLabel'], fallback: '远程执行电脑'),
  );
  return row;
}

bool isUsableExecutionTarget(Map raw) {
  final row = normalizeExecutionTarget(raw);
  return row['type'] == 'agent' &&
      row['remote'] == true &&
      row['online'] == true &&
      _text(row['agentId']).isNotEmpty;
}

String executionTargetAgentId(Map raw) =>
    _text(normalizeExecutionTarget(raw)['agentId']);

String executionTargetKind(Map raw) =>
    _text(normalizeExecutionTarget(raw)['runnerKind'], fallback: 'cloud');

bool isWorkComputerExecutionTarget(Map raw) =>
    executionTargetKind(raw) == 'work-computer';

String _text(dynamic value, {String fallback = ''}) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

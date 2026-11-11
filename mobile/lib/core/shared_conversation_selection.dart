import 'execution_target.dart';

/// Credential-free selection carried with the next accepted remote turn.
/// Hub remains authoritative for account ownership, policy and Runner support.
Map<String, String> normalizeSharedExecutionSelection(
  Map<String, dynamic> raw,
) {
  const limits = {'agentId': 80, 'modelName': 160, 'reasoningEffort': 24};
  if (raw.keys.any((key) => !limits.containsKey(key))) {
    throw const FormatException('执行选择格式不正确。');
  }
  final result = <String, String>{};
  for (final field in limits.entries) {
    final value = raw.containsKey(field.key) ? raw[field.key] : '';
    if (value is! String ||
        value.length > field.value ||
        value.runes.any((code) => code < 32)) {
      throw const FormatException('执行选择包含无效字段。');
    }
    result[field.key] = value.trim();
  }
  if (result['agentId']!.isEmpty) {
    throw const FormatException('请选择执行底座。');
  }
  final effort = result['reasoningEffort']!.toLowerCase();
  if (effort.isNotEmpty &&
      (result['agentId'] != 'codex' ||
          !const {
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'ultra',
          }.contains(effort))) {
    throw const FormatException('当前底座不支持所选思考强度。');
  }
  result['reasoningEffort'] = effort;
  return Map.unmodifiable(result);
}

/// Never substitute a different computer when the original Runner is offline.
List<Map<String, dynamic>> sharedConversationTargetsForRunner(
  Iterable<Map<String, dynamic>> targets,
  String runnerId,
) {
  if (runnerId.trim().isEmpty) return const [];
  final seen = <String>{};
  return List.unmodifiable(
    targets
        .map(normalizeExecutionTarget)
        .where((row) {
          final id = row['id']?.toString() ?? '';
          final qualifiedRunner = id.startsWith('runner:')
              ? id.split(':').skip(1).first
              : '';
          final rowRunner = row['runnerId']?.toString().trim().isNotEmpty == true
              ? row['runnerId'].toString().trim()
              : qualifiedRunner;
          final agent = row['agentId'];
          return rowRunner == runnerId &&
              isUsableExecutionTarget(row) &&
              agent is String &&
              agent.isNotEmpty &&
              seen.add(agent);
        })
        .map((row) => Map<String, dynamic>.unmodifiable(row)),
  );
}

Map<String, String> validateSharedExecutionSelection(
  Map<String, dynamic> raw, {
  required String runnerId,
  required Iterable<Map<String, dynamic>> targets,
  required Iterable<Map<String, dynamic>> usableModels,
}) {
  final selection = normalizeSharedExecutionSelection(raw);
  final matches = sharedConversationTargetsForRunner(
    targets,
    runnerId,
  ).where((row) => row['agentId'] == selection['agentId']);
  if (matches.isEmpty) {
    throw const FormatException('原执行环境尚未就绪，或未安装、未授权此底座。');
  }
  final target = matches.first;
  final mode = target['modelMode'];
  final model = selection['modelName']!;
  final managed = mode == 'managed' || mode == 'company';
  if (model.isNotEmpty) {
    if (managed) {
      if (!usableModels.any((row) => row['name'] == model)) {
        throw const FormatException('所选模型当前不可用，请重新选择。');
      }
    } else if (mode == 'account' && selection['agentId'] == 'codex') {
      if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$').hasMatch(model)) {
        throw const FormatException('此底座的模型名称无效。');
      }
    } else {
      throw const FormatException('此底座暂不支持在手机指定模型，请使用默认模型。');
    }
  }
  return selection;
}

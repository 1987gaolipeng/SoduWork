enum WorkCapabilityKind { workflow, skill, teammate }

/// One explicitly selected work capability, never permission to execute it.
class WorkCapability {
  final WorkCapabilityKind kind;
  final String id;
  final String label;
  final String description;
  final bool enabled;
  final String reason;
  final Map<String, dynamic> metadata;

  WorkCapability({
    required this.kind,
    required this.id,
    required this.label,
    this.description = '',
    this.enabled = true,
    this.reason = '',
    Map<String, dynamic> metadata = const {},
  }) : metadata = Map.unmodifiable(
         metadata.map((key, value) => MapEntry(key, _freeze(value))),
       );

  factory WorkCapability.workflow(Map<String, dynamic> row) {
    final capabilities = _map(row['capabilities']);
    final hasWorkflow = capabilities['hasWorkflow'] == true;
    final id = _text(row['bindingId']);
    final blockers = _map(row['readiness'])['blockers'];
    final details = blockers is List
        ? blockers
              .map(
                (item) => item is Map
                    ? _text(item['message'] ?? item['reason'])
                    : _text(item),
              )
              .where((item) => item.isNotEmpty)
              .join('；')
        : '';
    final reason = id.isEmpty
        ? '缺少可执行绑定，请刷新目录'
        : !hasWorkflow
        ? '此插件没有可执行工作流'
        : row['runnable'] != true
        ? (details.isEmpty ? '当前工作流暂不可执行，请检查配置' : details)
        : '';
    return WorkCapability(
      kind: WorkCapabilityKind.workflow,
      id: id,
      label: _text(row['name']).isEmpty ? '未命名工作流' : _text(row['name']),
      description: _text(row['description']),
      enabled: reason.isEmpty,
      reason: reason,
      metadata: {
        'pluginId': _text(row['pluginId']),
        'version': _text(row['version']),
        'inputs': row['inputs'] ?? const [],
      },
    );
  }

  factory WorkCapability.skill(Map<String, dynamic> row) {
    final name = _text(row['name']);
    const desktop = {
      'computer-use',
      'computer_use',
      'desktop',
      'local-desktop',
      'local_desktop',
    };
    final reason = name.isEmpty
        ? '缺少技能名称，请刷新目录'
        : row['localOnly'] == true || desktop.contains(name.toLowerCase())
        ? '此技能需要本机桌面，暂不能从移动端采用'
        : '';
    return WorkCapability(
      kind: WorkCapabilityKind.skill,
      id: name,
      label: _text(row['label']).isEmpty ? name : _text(row['label']),
      description: _text(row['description']),
      enabled: reason.isEmpty,
      reason: reason,
      // enabled is a default preference, not a grant for this explicit turn.
      metadata: {
        for (final key in [
          'scope',
          'source',
          'sourceKey',
          'version',
          'checksum',
          'downloadable',
          'runtimeAvailable',
          'localOnly',
          'enabled',
          'compatibility',
        ])
          if (row.containsKey(key)) key: row[key],
      },
    );
  }

  factory WorkCapability.teammate(Map<String, dynamic> row) {
    final id = _text(row['userId'] ?? row['id']);
    final reason = id.isEmpty
        ? '缺少同事账号，请刷新目录'
        : row['canReceive'] != true
        ? '该同事目前没有可接收消息的设备'
        : '';
    return WorkCapability(
      kind: WorkCapabilityKind.teammate,
      id: id,
      label: _text(row['name'] ?? row['displayName']).isEmpty
          ? '未命名同事'
          : _text(row['name'] ?? row['displayName']),
      description: _text(row['org']),
      enabled: reason.isEmpty,
      reason: reason,
      metadata: {
        if (row.containsKey('org')) 'org': row['org'],
        if (row.containsKey('deviceCount')) 'deviceCount': row['deviceCount'],
      },
    );
  }
}

String _text(dynamic value) => value is String ? value.trim() : '';
Map<String, dynamic> _map(dynamic value) => value is Map
    ? value.map((key, value) => MapEntry(key.toString(), value))
    : {};
dynamic _freeze(dynamic value) {
  if (value is Map) {
    return Map<String, dynamic>.unmodifiable(
      value.map((key, value) => MapEntry(key.toString(), _freeze(value))),
    );
  }
  if (value is List) return List<dynamic>.unmodifiable(value.map(_freeze));
  return value;
}

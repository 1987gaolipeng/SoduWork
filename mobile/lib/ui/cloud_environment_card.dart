import 'package:flutter/material.dart';

import 'mobile_display_preferences.dart';
import 'work_widgets.dart';

/// Displays the Hub's environment state. Agent installation is not permission
/// to dispatch: paused, revoked and deployment-restricted hosts stay unavailable.
class CloudEnvironmentCard extends StatelessWidget {
  final Map<String, dynamic> environment;
  const CloudEnvironmentCard({super.key, required this.environment});

  String _text(dynamic value) => value is String ? value.trim() : '';
  List<Map> _rows(dynamic value) =>
      value is List ? value.whereType<Map>().toList() : const [];

  String get _status {
    final explicit = _text(environment['status']);
    final management = _text(environment['managementState']);
    if (management.isNotEmpty) return management;
    if (environment['eligible'] == false ||
        environment['deploymentRestricted'] == true) {
      return explicit.isEmpty || explicit == 'ready'
          ? 'deployment_restricted'
          : explicit;
    }
    if (explicit.isNotEmpty && explicit != 'ready') return explicit;
    if (environment['online'] != true) return 'offline';
    if (environment['mode'] == 'paused' || environment['mode'] == 'disabled') {
      return environment['mode'] as String;
    }
    return explicit;
  }

  String get _label => switch (_status) {
    'ready' => '可执行',
    'offline' => '已离线',
    'pending' || 'pending_setup' || 'starting' => '准备中',
    'paused' => '暂停接单',
    'disabled' => '环境已停用',
    'revoked' || 'retired' => '环境授权已失效',
    'deployment_restricted' => '当前服务未允许此环境',
    'at_capacity' => '等待空闲',
    'missing_agent' => '需要准备执行底座',
    'auth_required' => '底座需要登录',
    'missing_workspace' => '需要配置工作目录',
    'missing_capabilities' => '执行能力未就绪',
    'update_required' => '执行机需要更新',
    _ =>
      _text(environment['statusText']).isNotEmpty
          ? _text(environment['statusText'])
          : '等待状态确认',
  };

  bool get _agentsAvailable => _status.isEmpty || _status == 'ready';

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final ready = _status == 'ready';
    final catalog = _rows(
      environment['availableAgents'],
    ).where((agent) => agent['installable'] != false).toList();
    final legacy = catalog.isEmpty;
    final agents = legacy ? _rows(environment['agents']) : catalog;
    final name = _text(environment['name']);
    final reason = _text(environment['statusReason']);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: WorkSurface(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  ready ? Icons.cloud_done_outlined : Icons.cloud_outlined,
                  color: ready ? scheme.primary : scheme.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    name.isEmpty ? '我的云端环境' : name,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              mobileText(context, _label),
              style: TextStyle(
                color: ready ? scheme.primary : scheme.onSurface,
              ),
            ),
            if (reason.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(reason, style: Theme.of(context).textTheme.bodySmall),
            ],
            const SizedBox(height: 8),
            Text(
              mobileText(
                context,
                '运行中 {0} / {1}',
                values: [
                  environment['busy'] ?? 0,
                  environment['maxConcurrent'] ?? 1,
                ],
              ),
            ),
            const SizedBox(height: 12),
            Text(
              mobileText(context, '执行底座'),
              style: Theme.of(context).textTheme.titleSmall,
            ),
            if (agents.isEmpty) Text(mobileText(context, '尚未上报底座信息')),
            for (final agent in agents)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(
                  _text(agent['name']).isEmpty
                      ? _text(agent['id'])
                      : _text(agent['name']),
                ),
                subtitle: Text(
                  mobileText(
                    context,
                    !_agentsAvailable
                        ? (_status == 'offline' ? '等待环境连接' : _label)
                        : agent['ready'] == true
                        ? '已就绪'
                        : !legacy && agent['installed'] != true
                        ? '未安装'
                        : _text(agent['reason']).isNotEmpty
                        ? _text(agent['reason'])
                        : '已安装，等待云端确认',
                  ),
                ),
                trailing: agent['ready'] == true && _agentsAvailable
                    ? const Icon(Icons.check_circle_outline_rounded, size: 20)
                    : null,
              ),
            if (catalog.any((agent) => agent['ready'] != true))
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  mobileText(
                    context,
                    '准备底座：在 PC「云端环境」打开同名环境，选择底座的“安装”或“检查”。完成后在这里刷新；已就绪且获授权的底座才会出现在对话中。',
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'plugin_workflow_contract.dart';

/// Shows the server's simulation and checks, never locally invented run status.
class PluginWorkflowPreview extends StatelessWidget {
  final Map<String, dynamic> preview;
  const PluginWorkflowPreview({super.key, required this.preview});
  @override
  Widget build(BuildContext context) {
    final simulation = workflowMap(preview['simulation']);
    final rows = workflowRows(simulation['order']);
    final checks = workflowRows(preview['checks']);
    if (rows.isEmpty && checks.isEmpty) return const SizedBox.shrink();
    return ExpansionTile(
      initiallyExpanded: true,
      title: const Text('服务端预检结果'),
      children: [
        if (simulation['sideEffectFree'] == true)
          const Padding(
            padding: EdgeInsets.all(12),
            child: Text('以下为结构预演，不执行实际操作。'),
          ),
        for (final row in rows)
          ListTile(
            leading: CircleAvatar(child: Text((row['index'] ?? '').toString())),
            title: Text((row['name'] ?? row['key'] ?? '节点').toString()),
            subtitle: Text(
              [
                pluginWorkflowTypes[row['type']] ??
                    row['type']?.toString() ??
                    '',
                ...workflowNames(row['handoffs']),
                if (row['route'] is Map)
                  ((row['route'] as Map)['agentKind'] ?? '企业默认').toString(),
              ].where((v) => v.isNotEmpty).join('\n'),
            ),
          ),
        for (final check in checks)
          ListTile(
            leading: Icon(
              check['ok'] == true
                  ? Icons.check_circle_outline
                  : Icons.info_outline,
            ),
            title: Text(
              (check['label'] ?? check['message'] ?? '检查项').toString(),
            ),
          ),
      ],
    );
  }
}

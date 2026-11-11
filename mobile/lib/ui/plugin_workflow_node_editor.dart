import 'mobile_input_border.dart';
import 'mobile_select_field.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'plugin_workflow_contract.dart';
import 'plugin_workflow_ports.dart';

Future<Map<String, dynamic>?> showPluginWorkflowNode(
  BuildContext context, {
  required Map<String, dynamic> value,
  required List<Map<String, dynamic>> nodes,
  required Map<String, dynamic> plugin,
  required int index,
}) => showDialog<Map<String, dynamic>>(
  context: context,
  useRootNavigator: false,
  builder: (_) =>
      _NodeEditor(value: value, nodes: nodes, plugin: plugin, index: index),
);

class _NodeEditor extends StatefulWidget {
  final Map<String, dynamic> value, plugin;
  final List<Map<String, dynamic>> nodes;
  final int index;
  const _NodeEditor({
    required this.value,
    required this.nodes,
    required this.plugin,
    required this.index,
  });
  @override
  State<_NodeEditor> createState() => _NodeEditorState();
}

class _NodeEditorState extends State<_NodeEditor> {
  late Map<String, dynamic> _node, _config;
  String _error = '';
  int _configurationRevision = 0;
  String get _type => (_node['type'] ?? 'ai').toString();
  @override
  void initState() {
    super.initState();
    _node = cloneWorkflow(widget.value);
    _config = workflowMap(_node['config']);
  }

  Widget _text(
    Map<String, dynamic> target,
    String field,
    String label, {
    int lines = 1,
    String? hint,
    bool number = false,
    String? prefix,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: TextFormField(
      key: ValueKey(
        '${prefix ?? 'node'}-$field-$_type${_configurationRevision == 0 ? '' : '-$_configurationRevision'}',
      ),
      initialValue: target[field]?.toString() ?? '',
      minLines: lines,
      maxLines: lines == 1 ? 1 : lines + 4,
      keyboardType: number ? TextInputType.number : TextInputType.multiline,
      decoration: InputDecoration(
        labelText: label,
        helperText: hint,
        helperMaxLines: 3,
        border: const MobileInputBorder(),
      ),
      onChanged: (v) => target[field] = number ? int.tryParse(v) ?? v : v,
    ),
  );

  Widget _choice(
    Map<String, dynamic> target,
    String field,
    String label,
    Map<String, String> values, {
    String fallback = '',
  }) {
    final value = (target[field] ?? fallback).toString();
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: MobileSelectField<String>(
        key: ValueKey('node-$field-$value'),
        initialValue: value,

        decoration: InputDecoration(
          labelText: label,
          border: const MobileInputBorder(),
        ),
        items: {...values, if (!values.containsKey(value)) value: '$value（导入值）'}
            .entries
            .map(
              (e) => DropdownMenuItem(
                value: e.key,
                child: Text(e.value, overflow: TextOverflow.ellipsis),
              ),
            )
            .toList(),
        onChanged: (v) => setState(() {
          if (v != null) target[field] = v;
          if (field == 'type') {
            // Type changes retain imported configuration. Defaults fill only
            // absent fields and never erase another type's extension data.
            for (final entry in workflowMap(
              newWorkflowNode(v!, 'unused')['config'],
            ).entries) {
              _config.putIfAbsent(entry.key, () => entry.value);
            }
          }
          _error = '';
        }),
      ),
    );
  }

  Future<void> _port(bool input, [int? index]) async {
    final key = input ? 'inputs' : 'outputs';
    final rows = workflowRows(_node[key]);
    final result = await showWorkflowPortEditor(
      context,
      value: index == null
          ? {
              'key':
                  (input ? 'input_' : 'output_') + (rows.length + 1).toString(),
              'label': '',
              if (!input) 'kind': 'evidence',
              'required': true,
            }
          : rows[index],
      input: input,
      node: _node,
      nodes: widget.nodes,
    );
    if (!mounted || result == null) return;
    setState(() {
      if (index == null) {
        rows.add(result);
      } else {
        rows[index] = result;
      }
      _node[key] = rows;
      _error = '';
    });
  }

  Widget _ports(bool input) {
    final key = input ? 'inputs' : 'outputs';
    final rows = workflowRows(_node[key]);
    final effective = input && rows.isEmpty
        ? workflowAutomaticInputs(_node, widget.nodes)
        : rows;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (input && rows.isEmpty)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text('与 PC 一致：没有指定输入时，自动接收直接上游的全部产出。'),
          ),
        for (var i = 0; i < effective.length; i++)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(
              (effective[i]['label'] ?? effective[i]['key']).toString(),
            ),
            subtitle: Text(
              input
                  ? '${effective[i]['fromNode']}.${effective[i]['outputKey']} → ${effective[i]['key']}'
                  : '${effective[i]['key']} · ${pluginWorkflowOutputs[effective[i]['kind']] ?? effective[i]['kind'].toString()}',
            ),
            onTap: input && rows.isEmpty ? null : () => _port(input, i),
            trailing: input && rows.isEmpty
                ? const Icon(Icons.auto_awesome_outlined)
                : IconButton(
                    tooltip: input ? '移除输入' : '移除产出',
                    icon: const Icon(Icons.close),
                    onPressed: () => setState(() {
                      rows.removeAt(i);
                      _node[key] = rows;
                    }),
                  ),
          ),
        Wrap(
          spacing: 8,
          children: [
            TextButton.icon(
              onPressed: rows.length >= (input ? 40 : 20)
                  ? null
                  : () => _port(input),
              icon: const Icon(Icons.add),
              label: Text(input ? '指定输入' : '添加产出'),
            ),
            if (input && rows.isEmpty && effective.isNotEmpty)
              TextButton(
                onPressed: () => setState(() => _node['inputs'] = effective),
                child: const Text('逐项调整交接'),
              ),
          ],
        ),
      ],
    );
  }

  Widget _capabilities() {
    final declared = {
      'skills': [
        ...workflowNames(widget.plugin['skills']),
        if (widget.plugin['key'] is String) widget.plugin['key'].toString(),
      ],
      'mcpServers': workflowNames(widget.plugin['mcpServers']),
      'runtime': workflowNames(
        widget.plugin['runtimeCapabilities'] ?? widget.plugin['runtime'],
      ),
    };
    const labels = {'skills': 'Skill', 'mcpServers': '连接器', 'runtime': '运行能力'};
    final caps = workflowMap(_node['capabilities']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('只能选择插件已声明的能力；未单独设置时沿用插件能力。'),
        for (final entry in declared.entries) ...[
          const SizedBox(height: 12),
          Text(
            labels[entry.key]!,
            style: Theme.of(context).textTheme.titleSmall,
          ),
          if (entry.value.isEmpty && workflowNames(caps[entry.key]).isEmpty)
            const Text('插件尚未声明此类能力'),
          for (final value in {
            ...entry.value,
            ...workflowNames(caps[entry.key]),
          })
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(
                value + (entry.value.contains(value) ? '' : '（插件未声明）'),
              ),
              value:
                  _node['capabilities'] == null ||
                  workflowNames(caps[entry.key]).contains(value),
              onChanged: (enabled) => setState(() {
                final updated = _node['capabilities'] == null
                    ? <String, dynamic>{
                        for (final e in declared.entries)
                          e.key: List<String>.from(e.value),
                      }
                    : workflowMap(_node['capabilities']);
                final values = workflowNames(updated[entry.key]);
                if (enabled == true) {
                  values.add(value);
                } else {
                  values.remove(value);
                }
                updated[entry.key] = values.toSet().toList();
                _node['capabilities'] = updated;
              }),
            ),
        ],
      ],
    );
  }

  Future<void> _editConfig() async {
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      useRootNavigator: false,
      builder: (_) => PluginWorkflowConfigDialog(value: _config),
    );
    if (mounted && result != null) {
      setState(() {
        _config = result;
        _configurationRevision++;
      });
    }
  }

  void _save() {
    _node['config'] = _config;
    final nodes = widget.nodes.map(cloneWorkflow).toList();
    final index = widget.index;
    if (index < 0) {
      nodes.add(_node);
    } else {
      nodes[index] = _node;
    }
    if (nodes.where((n) => n['key'] == _node['key']).length > 1) {
      setState(() => _error = '节点标识已存在，请使用另一标识');
      return;
    }
    // Validate rename against its rewritten links, then commit only this node.
    final adjusted = index < 0
        ? nodes
        : workflowRows(
            replaceWorkflowNode({'nodes': widget.nodes}, index, _node)['nodes'],
          );
    final errors = validatePluginWorkflowNode(_node, adjusted, widget.plugin);
    if (workflowLevels(adjusted) == null) errors.add('连接会形成循环或引用不存在的节点');
    if (errors.isNotEmpty) {
      setState(() => _error = errors.first);
      return;
    }
    Navigator.pop(context, _node);
  }

  @override
  Widget build(BuildContext context) {
    final retry = _node.putIfAbsent('retry', () => <String, dynamic>{}) is Map
        ? workflowMap(_node['retry'])
        : <String, dynamic>{};
    _node['retry'] = retry;
    final nested = _config['execution'] is Map;
    final route = nested ? workflowMap(_config['execution']) : _config;
    if (nested) _config['execution'] = route;
    final dependencies = workflowNames(_node['dependsOn']);
    return Dialog.fullscreen(
      child: Scaffold(
        appBar: AppBar(title: const Text('编辑流程节点')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _text(_node, 'name', '节点名称'),
            _text(_node, 'key', '节点标识', hint: '修改标识会同步更新流程内的节点引用'),
            _choice(_node, 'type', '节点类型', pluginWorkflowTypes, fallback: 'ai'),
            ExpansionTile(
              key: const ValueKey('node-dependencies'),
              title: const Text('上游与连接'),
              subtitle: Text(
                dependencies.isEmpty
                    ? '起点：接收原始需求'
                    : '连接 ${dependencies.length} 个上游',
              ),
              children: [
                for (final other in widget.nodes.where(
                  (n) => n['key'] != widget.value['key'],
                ))
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text((other['name'] ?? other['key']).toString()),
                    subtitle: Text(other['key'].toString()),
                    value: dependencies.contains(other['key']),
                    onChanged: (selected) => setState(() {
                      if (selected == true) {
                        dependencies.add(other['key'].toString());
                      } else {
                        dependencies.remove(other['key']);
                      }
                      _node['dependsOn'] = dependencies;
                    }),
                  ),
                for (final missing in dependencies.where(
                  (d) => !widget.nodes.any((n) => n['key'] == d),
                ))
                  ListTile(
                    title: Text('失效上游：$missing'),
                    trailing: IconButton(
                      tooltip: '移除失效连接',
                      icon: const Icon(Icons.close),
                      onPressed: () => setState(
                        () =>
                            _node['dependsOn'] = dependencies..remove(missing),
                      ),
                    ),
                  ),
              ],
            ),
            if (workflowIsAi(_type)) ...[
              const SizedBox(height: 16),
              _text(
                _config,
                'prompt',
                '工作指令',
                lines: 5,
                hint: '当前节点的职责与完成标准，最多 12000 字',
              ),
              ExpansionTile(
                title: const Text('执行偏好'),
                children: [
                  _text(
                    route,
                    'agentKind',
                    '执行底座类型',
                    hint: '留空跟随企业默认；hosted 或 local:pi 等可移植类型',
                  ),
                  _text(route, 'model', '模型', hint: '留空跟随底座。可用性由服务端预检确认'),
                  _choice(route, 'fallbackMode', '失败策略', {
                    '': '跟随默认',
                    'best-effort': '可换同类底座继续',
                    'strict': '严格使用指定底座',
                  }),
                  TextFormField(
                    key: ValueKey('node-runnerTags-$_type'),
                    initialValue: workflowNames(route['runnerTags']).join(', '),
                    decoration: const InputDecoration(
                      labelText: '执行机标签',
                      hintText: 'gpu, windows',
                    ),
                    onChanged: (v) => route['runnerTags'] = workflowNames(v),
                  ),
                  const SizedBox(height: 16),
                  _text(
                    _config,
                    'timeoutSeconds',
                    '超时（秒）',
                    number: true,
                    hint: '60 至 86400 秒',
                  ),
                ],
              ),
              ExpansionTile(
                title: const Text('节点能力'),
                children: [_capabilities()],
              ),
            ] else if (_type == 'human_review') ...[
              _text(_config, 'action', '验收动作', hint: '默认 uat'),
              _text(_config, 'summary', '验收说明', lines: 3),
            ] else if (_type == 'publish') ...[
              _text(_config, 'message', '办结说明', lines: 3),
            ] else ...[
              const SizedBox(height: 12),
              const Text('企业节点在插件审核、授权和项目绑定后执行；这里仅编辑配置。'),
              if (_type == 'spec')
                _text(_config, 'summary', '需求范围与验收标准', lines: 3),
              if (_type == 'approval')
                _text(_config, 'action', '审批动作', hint: '例如 merge'),
              if (_type == 'merge')
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('自动提交合并申请'),
                  value: _config['autoSubmit'] == true,
                  onChanged: (v) => setState(() => _config['autoSubmit'] = v),
                ),
              if (_type == 'validate') ...[
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('核对部署结果'),
                  value: _config['deployVerify'] == true,
                  onChanged: (v) => setState(() => _config['deployVerify'] = v),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('核对版本 SHA'),
                  value: _config['shaCheck'] == true,
                  onChanged: (v) => setState(() => _config['shaCheck'] = v),
                ),
              ],
              OutlinedButton.icon(
                onPressed: _editConfig,
                icon: const Icon(Icons.data_object),
                label: Text(_type == 'quality' ? '编辑检查命令与参数' : '编辑完整企业配置'),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  const JsonEncoder.withIndent('  ').convert(_config),
                  maxLines: 6,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ],
            ExpansionTile(
              title: const Text('重试设置'),
              children: [
                _text(
                  retry,
                  'maxAttempts',
                  '最多尝试次数',
                  number: true,
                  hint: '1 至 5 次',
                ),
              ],
            ),
            ExpansionTile(
              key: const ValueKey('node-inputs'),
              title: const Text('接收的输入'),
              children: [_ports(true)],
            ),
            ExpansionTile(
              key: const ValueKey('node-outputs'),
              title: const Text('交付给下游'),
              children: [_ports(false)],
            ),
            const SizedBox(height: 16),
          ],
        ),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_error.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      _error,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _save,
                    child: const Text('确认节点'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// PC enterprise nodes expose the complete JSON contract. Keep that escape
/// hatch for command arrays and environment-center fields without guessing.
class PluginWorkflowConfigDialog extends StatefulWidget {
  final Map<String, dynamic> value;
  const PluginWorkflowConfigDialog({super.key, required this.value});
  @override
  State<PluginWorkflowConfigDialog> createState() => _ConfigDialogState();
}

class _ConfigDialogState extends State<PluginWorkflowConfigDialog> {
  late final TextEditingController _text;
  String _error = '';
  @override
  void initState() {
    super.initState();
    _text = TextEditingController(
      text: const JsonEncoder.withIndent('  ').convert(widget.value),
    );
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _save() {
    try {
      final value = jsonDecode(_text.text);
      if (value is! Map<String, dynamic>) throw const FormatException();
      Navigator.pop(context, value);
    } catch (_) {
      setState(() => _error = '配置必须是合法的 JSON 对象；原配置尚未修改');
    }
  }

  @override
  Widget build(BuildContext context) => Dialog.fullscreen(
    child: Scaffold(
      appBar: AppBar(title: const Text('完整企业配置')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: TextField(
          key: const ValueKey('workflow-config-json'),
          controller: _text,
          minLines: null,
          maxLines: null,
          expands: true,
          textAlignVertical: TextAlignVertical.top,
          autocorrect: false,
          decoration: const InputDecoration(
            border: MobileInputBorder(),
            hintText: '输入与 PC 相同的配置对象',
          ),
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_error.isNotEmpty)
                Text(
                  _error,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _save,
                  child: const Text('确认配置'),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

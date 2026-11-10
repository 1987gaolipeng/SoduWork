import 'dart:convert';

import 'package:flutter/material.dart';
import '../state/mobile_scope.dart';
import 'plugin_workflow_contract.dart';
import 'plugin_workflow_node_editor.dart';

class PluginWorkflowEditor extends StatefulWidget {
  final Map<String, dynamic> value, plugin;
  final Map<String, dynamic> Function()? buildPlugin;
  final ValueChanged<Map<String, dynamic>> onChanged;
  const PluginWorkflowEditor({
    super.key,
    this.buildPlugin,
    required this.value,
    required this.plugin,
    required this.onChanged,
  });
  @override
  State<PluginWorkflowEditor> createState() => _PluginWorkflowEditorState();
}

class _PluginWorkflowEditorState extends State<PluginWorkflowEditor> {
  bool _opening = false;
  Future<void> _edit() async {
    if (_opening) return;
    final state = MobileScope.maybeOf(context);
    final identity = state?.identityRevision;
    setState(() => _opening = true);
    try {
      final result = await showDialog<Map<String, dynamic>>(
        context: context,
        useRootNavigator: false,
        builder: (_) => _WorkflowDialog(
          value: widget.value,
          plugin: widget.buildPlugin?.call() ?? widget.plugin,
        ),
      );
      if (!mounted ||
          result == null ||
          state?.identityRevision != identity ||
          !identical(state, MobileScope.maybeOf(context))) {
        return;
      }
      widget.onChanged(result);
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final nodes = workflowRows(widget.value['nodes']);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('执行编排', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Text(
            nodes.isEmpty
                ? '未自定义时，PC 预检会生成理解、执行、验收和办结的标准流程。'
                : '${nodes.length} 个节点 · 直接上游按产出契约交接',
          ),
          const SizedBox(height: 12),
          for (final node in nodes)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text(
                '${node['name'] ?? node['key']} · ${pluginWorkflowTypes[node['type']] ?? node['type'].toString()}',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          OutlinedButton.icon(
            key: const ValueKey('edit-plugin-workflow'),
            onPressed: _opening ? null : _edit,
            icon: const Icon(Icons.account_tree_outlined),
            label: const Text('编辑流程节点'),
          ),
        ],
      ),
    );
  }
}

class _WorkflowDialog extends StatefulWidget {
  final Map<String, dynamic> value, plugin;
  const _WorkflowDialog({required this.value, required this.plugin});
  @override
  State<_WorkflowDialog> createState() => _WorkflowDialogState();
}

class _WorkflowDialogState extends State<_WorkflowDialog> {
  late Map<String, dynamic> _value;
  String _error = '';
  bool _opening = false;
  bool _leaving = false;
  List<Map<String, dynamic>> get _nodes => workflowRows(_value['nodes']);
  @override
  void initState() {
    super.initState();
    _value = cloneWorkflow(widget.value);
  }

  Future<void> _edit(int index, {String type = 'ai'}) async {
    if (_opening) return;
    final nodes = _nodes;
    var sequence = nodes.length + 1;
    while (nodes.any((n) => n['key'] == 'step_$sequence')) {
      sequence++;
    }
    setState(() => _opening = true);
    try {
      final result = await showPluginWorkflowNode(
        context,
        value: index < 0
            ? newWorkflowNode(type, 'step_$sequence')
            : nodes[index],
        nodes: nodes,
        plugin: widget.plugin,
        index: index,
      );
      if (!mounted || result == null) return;
      setState(() {
        if (index < 0) {
          _value['nodes'] = [...nodes, result];
        } else {
          _value = replaceWorkflowNode(_value, index, result);
        }
        _error = '';
      });
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  Future<void> _add() async {
    final type = await showModalBottomSheet<String>(
      context: context,
      useRootNavigator: false,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: .65,
        maxChildSize: .9,
        builder: (_, controller) => ListView(
          controller: controller,
          padding: const EdgeInsets.all(16),
          children: [
            Text('选择节点类型', style: Theme.of(context).textTheme.titleLarge),
            for (final entry in pluginWorkflowTypes.entries)
              ListTile(
                title: Text(entry.value),
                onTap: () => Navigator.pop(context, entry.key),
              ),
          ],
        ),
      ),
    );
    if (mounted && type != null) await _edit(-1, type: type);
  }

  Future<void> _delete(int index) async {
    final nodes = _nodes;
    final removed = nodes[index];
    final dependants = nodes
        .where(
          (n) =>
              workflowNames(n['dependsOn']).contains(removed['key']) ||
              workflowRows(
                n['inputs'],
              ).any((i) => i['fromNode'] == removed['key']),
        )
        .length;
    final confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: false,
      builder: (context) => AlertDialog(
        title: const Text('删除流程节点？'),
        content: Text(
          '将删除“${removed['name'] ?? removed['key']}”${dependants == 0 ? '。' : '，并移除 $dependants 个下游节点对它的连接和输入引用。'}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除节点'),
          ),
        ],
      ),
    );
    if (mounted && confirmed == true) {
      setState(() {
        _value = removeWorkflowNode(_value, index);
        _error = '';
      });
    }
  }

  void _move(int from, int to) {
    final nodes = _nodes;
    final node = nodes.removeAt(from);
    nodes.insert(to, node);
    setState(() {
      _value['nodes'] = nodes;
      _error = '';
    });
  }

  Future<void> _requestBack() async {
    if (_leaving || _opening) return;
    if (jsonEncode(_value) == jsonEncode(widget.value)) {
      Navigator.pop(context);
      return;
    }
    _leaving = true;
    try {
      final choice = await showDialog<String>(
        context: context,
        useRootNavigator: false,
        builder: (context) => AlertDialog(
          title: const Text('保留流程修改？'),
          content: const Text(
            '已编辑的节点尚未返回插件表单。可以先保留为草稿，缺少的节点稍后补齐；提交检查时仍会校验完整流程。',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, 'discard'),
              child: const Text('放弃本次修改'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('继续编辑'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, 'keep'),
              child: const Text('保留草稿并返回'),
            ),
          ],
        ),
      );
      if (!mounted || choice == null) return;
      // Keeping an incomplete draft does not approve it for submission or execution.
      Navigator.pop(context, choice == 'keep' ? cloneWorkflow(_value) : null);
    } finally {
      _leaving = false;
    }
  }

  void _save() {
    final errors = validatePluginWorkflow(_value, plugin: widget.plugin);
    if (errors.isNotEmpty) {
      setState(() => _error = errors.first);
      return;
    }
    Navigator.pop(context, _value);
  }

  @override
  Widget build(BuildContext context) {
    final nodes = _nodes;
    final levels = workflowLevels(nodes);
    return PopScope<Map<String, dynamic>>(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop) _requestBack();
      },
      child: Dialog.fullscreen(
        child: Scaffold(
          appBar: AppBar(title: const Text('流程节点')),
          body: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const Text(
                '顺序用于展示；执行先后由上游连接决定。同一层的节点可以并行。完整流程需包含 AI 节点和办结沉淀节点；返回时可保留未完成草稿。',
              ),
              const SizedBox(height: 12),
              if (nodes.isEmpty) ...[
                const Text('尚未添加自定义节点。可使用 PC 标准流程作为起点。'),
                OutlinedButton(
                  onPressed: () => setState(() {
                    _value = {
                      ..._value,
                      ...defaultPluginWorkflow(
                        widget.plugin['instructions']?.toString() ?? '',
                      ),
                    };
                  }),
                  child: const Text('添加标准流程'),
                ),
              ],
              for (var i = 0; i < nodes.length; i++)
                Card(
                  clipBehavior: Clip.antiAlias,
                  child: ListTile(
                    key: ValueKey('workflow-node-${nodes[i]['key']}'),
                    leading: CircleAvatar(child: Text((i + 1).toString())),
                    title: Text(
                      (nodes[i]['name'] ?? nodes[i]['key']).toString(),
                    ),
                    subtitle: Text(
                      '${pluginWorkflowTypes[nodes[i]['type']] ?? nodes[i]['type'].toString()}\n${workflowNames(nodes[i]['dependsOn']).isEmpty ? '起点' : '接收：${workflowNames(nodes[i]['dependsOn']).join('、')}'}',
                    ),
                    isThreeLine: true,
                    onTap: _opening ? null : () => _edit(i),
                    trailing: PopupMenuButton<String>(
                      tooltip: '节点操作',
                      enabled: !_opening,
                      onSelected: (action) {
                        if (action == 'edit') {
                          _edit(i);
                        }
                        if (action == 'up') {
                          _move(i, i - 1);
                        }
                        if (action == 'down') {
                          _move(i, i + 1);
                        }
                        if (action == 'delete') {
                          _delete(i);
                        }
                      },
                      itemBuilder: (_) => [
                        const PopupMenuItem(value: 'edit', child: Text('编辑节点')),
                        if (i > 0)
                          const PopupMenuItem(value: 'up', child: Text('向上移动')),
                        if (i < nodes.length - 1)
                          const PopupMenuItem(
                            value: 'down',
                            child: Text('向下移动'),
                          ),
                        const PopupMenuItem(
                          value: 'delete',
                          child: Text('删除节点'),
                        ),
                      ],
                    ),
                  ),
                ),
              TextButton.icon(
                onPressed: _opening || nodes.length >= 30 ? null : _add,
                icon: const Icon(Icons.add),
                label: const Text('添加节点'),
              ),
              if (nodes.isNotEmpty)
                ExpansionTile(
                  title: const Text('检查执行层次'),
                  children: [
                    if (levels == null) const Text('当前连接有循环或无效上游，请修改后确认'),
                    if (levels != null)
                      for (var i = 0; i < levels.length; i++)
                        ListTile(
                          title: Text('第 ${i + 1} 层'),
                          subtitle: Text(
                            levels[i]
                                .map(
                                  (key) =>
                                      (nodes.firstWhere(
                                                (n) => n['key'] == key,
                                              )['name'] ??
                                              key)
                                          .toString(),
                                )
                                .join('、'),
                          ),
                        ),
                  ],
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
                      onPressed: _opening ? null : _save,
                      child: const Text('确认流程'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

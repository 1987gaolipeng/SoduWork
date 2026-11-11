import 'mobile_input_border.dart';
import 'mobile_select_field.dart';
import 'package:flutter/material.dart';
import 'plugin_workflow_contract.dart';

Future<Map<String, dynamic>?> showWorkflowPortEditor(
  BuildContext context, {
  required Map<String, dynamic> value,
  required bool input,
  required Map<String, dynamic> node,
  required List<Map<String, dynamic>> nodes,
}) => showDialog<Map<String, dynamic>>(
  context: context,
  useRootNavigator: false,
  builder: (_) =>
      _PortEditor(value: value, input: input, node: node, nodes: nodes),
);

class _PortEditor extends StatefulWidget {
  final Map<String, dynamic> value, node;
  final List<Map<String, dynamic>> nodes;
  final bool input;
  const _PortEditor({
    required this.value,
    required this.input,
    required this.node,
    required this.nodes,
  });
  @override
  State<_PortEditor> createState() => _PortEditorState();
}

class _PortEditorState extends State<_PortEditor> {
  late Map<String, dynamic> _value;
  String _error = '';
  @override
  void initState() {
    super.initState();
    _value = cloneWorkflow(widget.value);
  }

  Widget _text(String key, String label, {String? hint}) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: TextFormField(
      key: ValueKey('port-$key'),
      initialValue: _value[key]?.toString() ?? '',
      decoration: InputDecoration(
        labelText: label,
        helperText: hint,
        helperMaxLines: 3,
        border: const MobileInputBorder(),
      ),
      onChanged: (v) => _value[key] = v,
    ),
  );
  Widget _choice(String key, String label, Map<String, String> choices) {
    final selected = _value[key]?.toString() ?? '';
    final options = <String, String>{
      '': '请选择',
      ...choices,
      if (selected.isNotEmpty && !choices.containsKey(selected))
        selected: '$selected（引用已失效）',
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: MobileSelectField<String>(
        key: ValueKey('port-$key-$selected'),
        initialValue: selected,

        decoration: InputDecoration(
          labelText: label,
          border: const MobileInputBorder(),
        ),
        items: options.entries
            .map(
              (e) => DropdownMenuItem(
                value: e.key,
                child: Text(e.value, overflow: TextOverflow.ellipsis),
              ),
            )
            .toList(),
        onChanged: (v) => setState(() {
          _value[key] = v;
          _error = '';
        }),
      ),
    );
  }

  void _save() {
    final key = _value['key']?.toString().trim() ?? '';
    if (!RegExp(r'^[A-Za-z][A-Za-z0-9_-]{0,63}$').hasMatch(key)) {
      setState(() => _error = '标识需以字母开头，最多 64 位字母、数字、下划线或短横线');
      return;
    }
    _value['key'] = key;
    if (widget.input) {
      final sources = widget.nodes.where((n) => n['key'] == _value['fromNode']);
      if (!workflowNames(
            widget.node['dependsOn'],
          ).contains(_value['fromNode']) ||
          sources.isEmpty ||
          !workflowRows(
            sources.first['outputs'],
          ).any((o) => o['key'] == _value['outputKey'])) {
        setState(() => _error = '请选择直接上游已声明的产出');
        return;
      }
    } else {
      if (!pluginWorkflowOutputs.containsKey(_value['kind'])) {
        setState(() => _error = '请选择产出类型');
        return;
      }
      if (_value['kind'] == 'file' || _value['kind'] == 'decision') {
        final path = (_value['path'] ?? '').toString().replaceAll('\\', '/');
        if (path.isEmpty ||
            path.length > 300 ||
            path.contains(RegExp(r'[:\x00]')) ||
            path.split('/').any((s) => s.isEmpty || s == '.' || s == '..')) {
          setState(() => _error = '请填写工作目录内的相对文件路径');
          return;
        }
      }
    }
    Navigator.pop(context, _value);
  }

  @override
  Widget build(BuildContext context) {
    final sources = widget.nodes.where(
      (n) => workflowNames(widget.node['dependsOn']).contains(n['key']),
    );
    final parent = sources.where((n) => n['key'] == _value['fromNode']);
    return Dialog.fullscreen(
      child: Scaffold(
        appBar: AppBar(title: Text(widget.input ? '接收上游产出' : '编辑产出')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _text('key', '交接标识'),
            _text('label', '显示名称'),
            if (widget.input) ...[
              _choice('fromNode', '直接上游', {
                for (final n in sources)
                  n['key'].toString(): (n['name'] ?? n['key']).toString(),
              }),
              _choice('outputKey', '上游产出', {
                if (parent.isNotEmpty)
                  for (final p in workflowRows(parent.first['outputs']))
                    p['key'].toString(): (p['label'] ?? p['key']).toString(),
              }),
            ] else ...[
              _choice('kind', '产出类型', pluginWorkflowOutputs),
              if (_value['kind'] == 'file' || _value['kind'] == 'decision')
                _text(
                  'path',
                  '相对文件路径',
                  hint: '例如 reports/result.md，不能填写绝对路径或上级目录',
                ),
            ],
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('必须交付'),
              value: _value['required'] != false,
              onChanged: (v) => setState(() => _value['required'] = v),
            ),
          ],
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
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _save,
                    child: const Text('确认交接项'),
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

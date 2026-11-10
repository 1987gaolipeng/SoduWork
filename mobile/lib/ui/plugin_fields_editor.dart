import 'mobile_input_border.dart';
import 'mobile_select_field.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'plugin_fields_contract.dart';
import 'mobile_theme.dart';

/// Mobile editing surface for the exact PC inputs/setup fields.
/// Edits are committed to the parent only after explicit confirmation.
class PluginFieldsEditor extends StatelessWidget {
  final List<Map<String, dynamic>> inputs;
  final Map<String, dynamic> setup;
  final void Function(List<Map<String, dynamic>>, Map<String, dynamic>)
  onChanged;
  const PluginFieldsEditor({
    super.key,
    required this.inputs,
    required this.setup,
    required this.onChanged,
  });

  List<Map<String, dynamic>> _fields(bool preference) =>
      (preference ? pluginPreferenceFields(setup) : inputs)
          .map(copyPluginField)
          .toList();

  void _commit(bool preference, List<Map<String, dynamic>> fields) => onChanged(
    preference ? inputs : fields,
    preference ? {...setup, 'preferences': fields} : setup,
  );

  Future<void> _edit(BuildContext context, bool preference, int? index) async {
    final rows = _fields(preference);
    final used = rows.map((row) => row['key']).whereType<String>().toSet();
    final prefix = preference ? 'setup' : 'input';
    var number = rows.length + 1;
    while (used.contains('$prefix$number')) {
      number++;
    }
    final original = index == null
        ? <String, dynamic>{
            'key': '$prefix$number',
            'label': preference ? '使用偏好' : '启动参数',
            'type': 'text',
            'required': !preference,
          }
        : rows[index];
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      useSafeArea: false,
      builder: (_) => _FieldDialog(
        value: original,
        preference: preference,
        usedKeys: used
            .where((key) => index == null || key != original['key'])
            .toSet(),
      ),
    );
    if (result == null || !context.mounted) return;
    if (index == null) {
      rows.add(result);
    } else {
      rows[index] = result;
    }
    _commit(preference, rows);
  }

  Future<void> _description(BuildContext context) async {
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      useSafeArea: false,
      builder: (_) => _SetupDescriptionDialog(value: setup),
    );
    if (result != null && context.mounted) onChanged(inputs, result);
  }

  Widget _rows(BuildContext context, bool preference) {
    final rows = _fields(preference);
    final prefix = preference ? 'setup' : 'input';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (rows.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(
              preference
                  ? '无需每位同事单独配置时保持为空。账号和密钥请使用企业连接。'
                  : '直接使用对话内容；需要结构化启动时再添加参数。',
              style: TextStyle(color: context.soduWorkTheme.inkMuted, fontSize: 13),
            ),
          ),
        for (var i = 0; i < rows.length; i++)
          Card(
            elevation: 0,
            color: context.soduWorkTheme.surfaceMuted,
            child: ListTile(
              key: ValueKey('plugin-$prefix-$i'),
              title: Text(
                (rows[i]['label'] ?? rows[i]['key'] ?? '').toString(),
              ),
              subtitle: Text(
                '${rows[i]['key'] ?? ''} · ${pluginPreferenceTypes[pluginFieldType(rows[i]['type'])] ?? rows[i]['type'].toString()}${rows[i]['required'] == true ? ' · 必填' : ''}',
              ),
              onTap: () => _edit(context, preference, i),
              trailing: PopupMenuButton<String>(
                tooltip: '参数操作',
                key: ValueKey('plugin-$prefix-menu-$i'),
                onSelected: (action) {
                  if (action == 'edit') {
                    _edit(context, preference, i);
                    return;
                  }
                  final next = _fields(preference);
                  if (action == 'delete') {
                    next.removeAt(i);
                  }
                  if (action == 'up' && i > 0) {
                    final item = next.removeAt(i);
                    next.insert(i - 1, item);
                  }
                  if (action == 'down' && i + 1 < next.length) {
                    final item = next.removeAt(i);
                    next.insert(i + 1, item);
                  }
                  _commit(preference, next);
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'edit', child: Text('编辑')),
                  PopupMenuItem(
                    value: 'up',
                    enabled: i > 0,
                    child: const Text('上移'),
                  ),
                  PopupMenuItem(
                    value: 'down',
                    enabled: i + 1 < rows.length,
                    child: const Text('下移'),
                  ),
                  const PopupMenuItem(value: 'delete', child: Text('删除')),
                ],
              ),
            ),
          ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            key: ValueKey('plugin-$prefix-add'),
            onPressed: () => _edit(context, preference, null),
            icon: const Icon(Icons.add),
            label: Text(preference ? '添加使用偏好' : '添加启动参数'),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => Column(
    children: [
      ExpansionTile(
        key: const PageStorageKey('plugin-inputs-editor'),
        title: const Text('启动参数'),
        subtitle: Text('${inputs.length} 项 · 运行任务或自动化时填写'),
        childrenPadding: const EdgeInsets.all(12),
        children: [_rows(context, false)],
      ),
      ExpansionTile(
        key: const PageStorageKey('plugin-setup-editor'),
        title: const Text('安装设置'),
        subtitle: Text('${pluginPreferenceFields(setup).length} 项 · 每位使用者配置一次'),
        childrenPadding: const EdgeInsets.all(12),
        children: [
          if ((setup['title']?.toString() ?? '').isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                setup['title'].toString(),
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          if ((setup['description']?.toString() ?? '').isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: Text(setup['description'].toString()),
            ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => _description(context),
              child: const Text('编辑安装设置说明'),
            ),
          ),
          _rows(context, true),
        ],
      ),
    ],
  );
}

class _FieldDialog extends StatefulWidget {
  final Map<String, dynamic> value;
  final bool preference;
  final Set<String> usedKeys;
  const _FieldDialog({
    required this.value,
    required this.preference,
    required this.usedKeys,
  });
  @override
  State<_FieldDialog> createState() => _FieldDialogState();
}

class _FieldDialogState extends State<_FieldDialog> {
  late Map<String, dynamic> _draft;
  late List<dynamic> _options;
  late dynamic _default;
  late bool _hasDefault;
  String _error = '';
  String get _type => pluginFieldType(_draft['type']);

  @override
  void initState() {
    super.initState();
    _draft = copyPluginField(widget.value);
    _draft['type'] = pluginFieldType(_draft['type']);
    _options = _draft['options'] is List
        ? List<dynamic>.from(_draft['options'] as List)
        : [];
    _hasDefault = _draft.containsKey('default');
    _default = _draft['default'];
  }

  Widget _text(
    String field,
    String label, {
    int lines = 1,
    String? hint,
    TextInputType? keyboardType,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 14),
    child: TextFormField(
      key: ValueKey('field-$field'),
      initialValue: _draft[field]?.toString() ?? '',
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        border: const MobileInputBorder(),
      ),
      minLines: lines,
      maxLines: lines > 1 ? lines + 3 : 1,
      keyboardType: keyboardType,
      onChanged: (value) => _draft[field] = value,
    ),
  );

  Future<void> _option(int? index) async {
    final result = await showDialog<dynamic>(
      context: context,
      useSafeArea: false,
      builder: (_) =>
          _OptionDialog(value: index == null ? null : _options[index]),
    );
    if (!mounted || result == null) return;
    setState(() {
      if (index == null) {
        _options.add(result);
      } else {
        _options[index] = result;
      }
      _error = '';
    });
  }

  Widget _optionList() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Text('可选项', style: TextStyle(fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
      for (var i = 0; i < _options.length; i++)
        ListTile(
          key: ValueKey('field-option-$i'),
          contentPadding: EdgeInsets.zero,
          title: Text(pluginOptionLabel(_options[i])),
          subtitle: Text('值：${pluginOptionValue(_options[i])}'),
          onTap: () => _option(i),
          trailing: IconButton(
            tooltip: '删除选项',
            icon: const Icon(Icons.remove_circle_outline),
            onPressed: () => setState(() => _options.removeAt(i)),
          ),
        ),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          key: const ValueKey('field-add-option'),
          onPressed: () => _option(null),
          icon: const Icon(Icons.add),
          label: const Text('添加选项'),
        ),
      ),
    ],
  );

  Widget _defaultControl() {
    if (_type == 'boolean') {
      return MobileSelectField<bool>(
        key: const ValueKey('field-default-boolean'),
        initialValue: _default is bool ? _default as bool : null,
        decoration: const InputDecoration(
          labelText: '默认值',
          border: MobileInputBorder(),
        ),
        items: const [
          DropdownMenuItem(value: true, child: Text('开启')),
          DropdownMenuItem(value: false, child: Text('关闭')),
        ],
        onChanged: (value) => _default = value,
      );
    }
    if (_type == 'select') {
      final index = _options.indexWhere(
        (option) => pluginOptionValue(option) == _default,
      );
      return MobileSelectField<int>(
        key: ValueKey('field-default-select-${jsonEncode(_options)}'),
        initialValue: index < 0 ? null : index,

        decoration: const InputDecoration(
          labelText: '默认选项',
          border: MobileInputBorder(),
        ),
        items: [
          for (var i = 0; i < _options.length; i++)
            DropdownMenuItem(
              value: i,
              child: Text(
                pluginOptionLabel(_options[i]),
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        onChanged: (index) {
          if (index != null) _default = pluginOptionValue(_options[index]);
        },
      );
    }
    if (_type == 'multiselect') {
      final selected = _default is List
          ? List<dynamic>.from(_default as List)
          : <dynamic>[];
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('默认选项'),
          for (var i = 0; i < _options.length; i++)
            CheckboxListTile(
              key: ValueKey('field-default-multi-$i'),
              contentPadding: EdgeInsets.zero,
              title: Text(pluginOptionLabel(_options[i])),
              value: selected.contains(pluginOptionValue(_options[i])),
              onChanged: (value) => setState(() {
                final option = pluginOptionValue(_options[i]);
                if (value == true) {
                  selected.add(option);
                } else {
                  selected.remove(option);
                }
                _default = selected;
              }),
            ),
        ],
      );
    }
    return TextFormField(
      key: ValueKey('field-default-$_type'),
      initialValue: _default?.toString() ?? '',
      decoration: const InputDecoration(
        labelText: '默认值',
        border: MobileInputBorder(),
      ),
      keyboardType: _type == 'number'
          ? const TextInputType.numberWithOptions(decimal: true, signed: true)
          : null,
      minLines: _type == 'textarea' ? 3 : 1,
      maxLines: _type == 'textarea' ? 6 : 1,
      onChanged: (value) =>
          _default = _type == 'number' ? num.tryParse(value) ?? value : value,
    );
  }

  void _save() {
    final result = copyPluginField(_draft);
    for (final field in [
      'key',
      'label',
      'description',
      'placeholder',
      'group',
    ]) {
      if (result[field] is String) {
        result[field] = (result[field] as String).trim();
      }
    }
    if (_type == 'select' || _type == 'multiselect') {
      result['options'] = _options;
    } else if (_type != pluginFieldType(widget.value['type'])) {
      result.remove('options');
    }
    if (!_hasDefault) {
      result.remove('default');
    } else if (_type == 'number') {
      final number = _default is num ? _default as num : null;
      if (number == null || !number.isFinite) {
        setState(() => _error = '默认值必须为有限数字');
        return;
      }
      result['default'] = number;
    } else {
      result['default'] = _default ?? (_type == 'multiselect' ? [] : '');
    }
    for (final field in ['minLength', 'maxLength', 'minimum', 'maximum']) {
      if (!result.containsKey(field)) continue;
      final raw = result[field]?.toString() ?? '';
      if (raw.isEmpty) {
        result.remove(field);
        continue;
      }
      final number = field.endsWith('Length')
          ? int.tryParse(raw)
          : num.tryParse(raw);
      if (number == null || !number.isFinite) {
        setState(() => _error = '范围必须填写有效数字');
        return;
      }
      result[field] = number;
    }
    final errors = validatePluginFields(
      widget.preference ? [] : [result],
      widget.preference
          ? {
              'preferences': [result],
            }
          : {},
    );
    if (widget.usedKeys.contains(result['key'])) errors.add('参数标识已经存在，请使用另一标识');
    if (errors.isNotEmpty) {
      setState(() => _error = errors.first);
      return;
    }
    Navigator.of(context).pop(result);
  }

  @override
  Widget build(BuildContext context) {
    final types = widget.preference ? pluginPreferenceTypes : pluginInputTypes;
    final type = _type;
    return Dialog.fullscreen(
      child: Scaffold(
        appBar: AppBar(title: Text(widget.preference ? '编辑使用偏好' : '编辑启动参数')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _text('label', '显示名称'),
            _text('key', '参数标识', hint: '例如 report_topic'),
            MobileSelectField<String>(
              key: ValueKey('field-type-$type'),
              initialValue: type,

              decoration: const InputDecoration(
                labelText: '参数类型',
                border: MobileInputBorder(),
              ),
              items: [
                for (final item in types.entries)
                  DropdownMenuItem(value: item.key, child: Text(item.value)),
                if (!types.containsKey(type))
                  DropdownMenuItem(value: type, child: Text('不支持的类型：$type')),
              ],
              onChanged: (value) => setState(() {
                if (value != null) _draft['type'] = value;
                _error = '';
              }),
            ),
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('必填'),
              value: _draft['required'] == true,
              onChanged: (value) => setState(() => _draft['required'] = value),
            ),
            _text('description', '给使用者的说明', lines: 2),
            _text('placeholder', '输入提示'),
            if (widget.preference) _text('group', '分组', hint: '使用偏好'),
            if (type == 'select' || type == 'multiselect') _optionList(),
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('设置默认值'),
              key: const ValueKey('field-has-default'),
              value: _hasDefault,
              onChanged: (value) => setState(() => _hasDefault = value),
            ),
            if (_hasDefault) _defaultControl(),
            if (widget.preference &&
                const {'text', 'textarea', 'url', 'number'}.contains(type)) ...[
              const SizedBox(height: 18),
              _text(
                type == 'number' ? 'minimum' : 'minLength',
                type == 'number' ? '最小值' : '最小长度',
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                  signed: true,
                ),
              ),
              _text(
                type == 'number' ? 'maximum' : 'maxLength',
                type == 'number' ? '最大值' : '最大长度',
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                  signed: true,
                ),
              ),
            ],
            const SizedBox(height: 24),
          ],
        ),
        bottomNavigationBar: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_error.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      _error,
                      key: const ValueKey('field-error'),
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    key: const ValueKey('field-save'),
                    onPressed: _save,
                    child: const Text('保存参数'),
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

class _OptionDialog extends StatefulWidget {
  final dynamic value;
  const _OptionDialog({this.value});
  @override
  State<_OptionDialog> createState() => _OptionDialogState();
}

class _OptionDialogState extends State<_OptionDialog> {
  late String _type, _text, _label;
  String _error = '';
  @override
  void initState() {
    super.initState();
    final value = pluginOptionValue(widget.value);
    _type = value is bool
        ? 'boolean'
        : value is num
        ? 'number'
        : 'text';
    _text = value?.toString() ?? '';
    _label = pluginOptionLabel(widget.value);
  }

  void _save() {
    final dynamic value = _type == 'number'
        ? num.tryParse(_text)
        : _type == 'boolean'
        ? (_text == 'true'
              ? true
              : _text == 'false'
              ? false
              : null)
        : _text;
    if (value == null ||
        value is num && !value.isFinite ||
        value is String && value.isEmpty) {
      setState(() => _error = '请填写有效选项值');
      return;
    }
    final original = widget.value;
    Navigator.of(context).pop(<String, dynamic>{
      if (original is Map) ...Map<String, dynamic>.from(original),
      'value': value,
      'label': _label.trim().isEmpty ? value.toString() : _label.trim(),
    });
  }

  @override
  Widget build(BuildContext context) => Dialog.fullscreen(
    child: Scaffold(
      appBar: AppBar(title: const Text('编辑选项')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextFormField(
            key: const ValueKey('option-label'),
            initialValue: _label,
            decoration: const InputDecoration(
              labelText: '显示名称',
              border: MobileInputBorder(),
            ),
            onChanged: (value) => _label = value,
          ),
          const SizedBox(height: 16),
          MobileSelectField<String>(
            initialValue: _type,
            decoration: const InputDecoration(
              labelText: '选项值类型',
              border: MobileInputBorder(),
            ),
            items: const [
              DropdownMenuItem(value: 'text', child: Text('文本')),
              DropdownMenuItem(value: 'number', child: Text('数字')),
              DropdownMenuItem(value: 'boolean', child: Text('开关')),
            ],
            onChanged: (value) => setState(() {
              if (value != null) _type = value;
            }),
          ),
          const SizedBox(height: 16),
          if (_type == 'boolean')
            MobileSelectField<String>(
              initialValue: const ['true', 'false'].contains(_text)
                  ? _text
                  : null,
              decoration: const InputDecoration(
                labelText: '选项值',
                border: MobileInputBorder(),
              ),
              items: const [
                DropdownMenuItem(value: 'true', child: Text('开启')),
                DropdownMenuItem(value: 'false', child: Text('关闭')),
              ],
              onChanged: (value) => _text = value ?? '',
            )
          else
            TextFormField(
              key: ValueKey('option-value-$_type'),
              initialValue: _text,
              decoration: const InputDecoration(
                labelText: '选项值',
                helperText: '保存的真实值；不会用显示名称替代',
                border: MobileInputBorder(),
              ),
              keyboardType: _type == 'number'
                  ? const TextInputType.numberWithOptions(
                      decimal: true,
                      signed: true,
                    )
                  : null,
              onChanged: (value) => _text = value,
            ),
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                _error,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton(
            key: const ValueKey('option-save'),
            onPressed: _save,
            child: const Text('保存选项'),
          ),
        ),
      ),
    ),
  );
}

class _SetupDescriptionDialog extends StatefulWidget {
  final Map<String, dynamic> value;
  const _SetupDescriptionDialog({required this.value});
  @override
  State<_SetupDescriptionDialog> createState() =>
      _SetupDescriptionDialogState();
}

class _SetupDescriptionDialogState extends State<_SetupDescriptionDialog> {
  late String _title, _description;
  @override
  void initState() {
    super.initState();
    _title = widget.value['title']?.toString() ?? '';
    _description = widget.value['description']?.toString() ?? '';
  }

  @override
  Widget build(BuildContext context) => Dialog.fullscreen(
    child: Scaffold(
      appBar: AppBar(title: const Text('安装设置说明')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextFormField(
            initialValue: _title,
            decoration: const InputDecoration(
              labelText: '设置标题',
              border: MobileInputBorder(),
            ),
            onChanged: (value) => _title = value,
          ),
          const SizedBox(height: 16),
          TextFormField(
            initialValue: _description,
            minLines: 3,
            maxLines: 8,
            decoration: const InputDecoration(
              labelText: '设置说明',
              border: MobileInputBorder(),
            ),
            onChanged: (value) => _description = value,
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton(
            onPressed: () => Navigator.of(context).pop({
              ...widget.value,
              'title': _title.trim(),
              'description': _description.trim(),
            }),
            child: const Text('保存说明'),
          ),
        ),
      ),
    ),
  );
}

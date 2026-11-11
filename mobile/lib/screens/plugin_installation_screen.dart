import '../ui/mobile_input_border.dart';
import '../ui/mobile_select_field.dart';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/plugin_fields_contract.dart';

/// Installs the immutable catalog version the user reviewed.
class PluginInstallationScreen extends StatefulWidget {
  final Map<String, dynamic> item;
  const PluginInstallationScreen({super.key, required this.item});

  @override
  State<PluginInstallationScreen> createState() =>
      _PluginInstallationScreenState();
}

class _PluginInstallationScreenState extends State<PluginInstallationScreen> {
  late final Map<String, dynamic> _item;
  late final Map<String, dynamic> _setup;
  late final List<Map<String, dynamic>> _fields;
  final _values = <String, dynamic>{};
  final _controllers = <String, TextEditingController>{};
  final _errors = <String, String>{};
  MobileState? _state;
  int? _identity;
  bool _busy = false;
  String _error = '';
  Map<String, dynamic>? _probe;

  bool get _current =>
      mounted &&
      _state != null &&
      identical(_state, MobileScope.read(context)) &&
      _state!.identityRevision == _identity;
  String get _id => (_item['pluginId'] ?? '').toString();
  String get _version => (_item['versionId'] ?? '').toString();
  bool get _installed => _item['installed'] == true;
  String get _saveLabel => _item['updateAvailable'] == true
      ? '验证并升级'
      : _installed
      ? '保存设置'
      : '安装插件';

  @override
  void initState() {
    super.initState();
    _item = copyPluginField(widget.item);
    _setup = _item['setup'] is Map
        ? Map<String, dynamic>.from(_item['setup'])
        : {};
    _fields = pluginPreferenceFields(_setup);
    final stored = _item['setupConfig'] is Map
        ? _item['setupConfig'] as Map
        : {};
    for (final field in _fields) {
      final key = (field['key'] ?? '').toString();
      final type = pluginFieldType(field['type']);
      _values[key] = stored.containsKey(key)
          ? stored[key]
          : field.containsKey('default')
          ? field['default']
          : type == 'boolean'
          ? false
          : type == 'multiselect'
          ? <dynamic>[]
          : '';
      if (!{'boolean', 'select', 'multiselect'}.contains(type)) {
        _controllers[key] = TextEditingController(
          text: _values[key]?.toString() ?? '',
        );
      }
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    _state ??= state;
    _identity ??= state.identityRevision;
    if (!identical(_state, state) || _identity != state.identityRevision) {
      _error = '';
      _probe = null;
    }
  }

  @override
  void dispose() {
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  void _change(String key, dynamic value) {
    setState(() {
      _values[key] = value;
      _errors.remove(key);
      _error = '';
      _probe = null;
    });
  }

  Map<String, dynamic>? _collect() {
    _errors.clear();
    final config = <String, dynamic>{};
    final schemaErrors = validatePluginFields([], _setup);
    if (schemaErrors.isNotEmpty) {
      _error = '插件设置定义需要修正：${schemaErrors.first}';
      return null;
    }
    final secret = RegExp(
      r'(?:sk|pk|pat|ghp|glpat)-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S{8,}',
      caseSensitive: false,
    );
    for (final field in _fields) {
      final key = field['key'].toString();
      final type = pluginFieldType(field['type']);
      var value = _values[key];
      if (value is String && type != 'number') {
        value = value.trim();
      }
      final empty =
          value == null || value == '' || value is List && value.isEmpty;
      String? error;
      if (empty) {
        if (field['required'] == true) {
          error = '请填写此项';
        }
      } else if (type == 'number') {
        if (value is! num || !value.isFinite) {
          error = '请输入有效数字';
        } else if (field['minimum'] is num && value < field['minimum']) {
          error = '不能小于 ${field['minimum']}';
        } else if (field['maximum'] is num && value > field['maximum']) {
          error = '不能大于 ${field['maximum']}';
        }
      } else if (type == 'boolean') {
        if (value is! bool) {
          error = '请选择开关状态';
        }
      } else if (type == 'select' || type == 'multiselect') {
        final options = (field['options'] as List? ?? [])
            .map(pluginOptionValue)
            .toList();
        if (type == 'select' && !options.contains(value) ||
            type == 'multiselect' &&
                (value is! List ||
                    value.length > 50 ||
                    value.any((v) => !options.contains(v)))) {
          error = '请选择当前版本提供的选项';
        }
      } else if (value is! String) {
        error = '请输入文本';
      } else {
        if (value.length < (field['minLength'] as num? ?? 0)) {
          error = '内容太短';
        } else if (value.length > (field['maxLength'] as num? ?? 8000)) {
          error = '内容太长';
        } else if (type == 'url') {
          final uri = Uri.tryParse(value);
          if (uri == null ||
              !{'http', 'https'}.contains(uri.scheme) ||
              uri.host.isEmpty ||
              uri.userInfo.isNotEmpty) {
            error = '请输入不含账号密码的完整 http/https 地址';
          }
        }
        if (secret.hasMatch(value)) {
          error = '请通过企业连接配置凭据，不要填写在使用偏好中';
        }
      }
      if (error != null) {
        _errors[key] = error;
      } else if (!empty || type == 'boolean') {
        config[key] = value;
      }
    }
    if (_errors.isNotEmpty) {
      _error = '请检查标出的设置';
      return null;
    }
    if (utf8.encode(jsonEncode(config)).length > 32 * 1024) {
      _error = '设置内容不能超过 32KB';
      return null;
    }
    return config;
  }

  Future<void> _submit({bool probe = false, bool uninstall = false}) async {
    if (_busy || !_current) {
      return;
    }
    if (_id.isEmpty || _version.isEmpty) {
      setState(() => _error = '版本信息不完整，请返回目录刷新后重试。');
      return;
    }
    Map<String, dynamic>? config;
    if (!uninstall) {
      config = _collect();
      if (config == null) {
        setState(() {});
        return;
      }
    }
    if (uninstall) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('卸载插件？'),
          content: const Text('卸载后将无法继续调用此插件。已有对话和运行记录会保留。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('确认卸载'),
            ),
          ],
        ),
      );
      if (confirmed != true || !_current || _busy) {
        return;
      }
    }
    setState(() {
      _busy = true;
      _error = '';
      _probe = null;
    });
    try {
      final api = _state!.api;
      if (probe) {
        final result = await api.probePluginInstallation(
          _id,
          expectedVersionId: _version,
          config: config!,
        );
        if (_current) {
          setState(() => _probe = result);
        }
      } else {
        await api.setPluginInstallation(
          _id,
          enabled: !uninstall,
          expectedVersionId: _version,
          config: config,
        );
        if (mounted && _current) {
          Navigator.of(context).pop(true);
        }
      }
    } catch (error) {
      if (_current) {
        setState(() => _error = error.toString());
      }
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  Widget _field(Map<String, dynamic> field) {
    final key = field['key'].toString();
    final label =
        (field['label'] ?? key).toString() +
        (field['required'] == true ? ' *' : '');
    final type = pluginFieldType(field['type']);
    final options = field['options'] is List
        ? field['options'] as List
        : <dynamic>[];
    final value = _values[key];
    final decoration = InputDecoration(
      labelText: label,
      hintText: field['placeholder']?.toString(),
      errorText: _errors[key],
      errorMaxLines: 3,
      border: const MobileInputBorder(),
    );
    Widget control;
    if (type == 'boolean') {
      control = SwitchListTile.adaptive(
        contentPadding: EdgeInsets.zero,
        title: Text(label),
        subtitle: _errors[key] == null
            ? null
            : Text(
                _errors[key]!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
        value: value == true,
        onChanged: _busy || !_current ? null : (v) => _change(key, v),
      );
    } else if (type == 'select') {
      final selected = options.indexWhere((o) => pluginOptionValue(o) == value);
      control = MobileSelectField<int>(
        key: ValueKey('select-$key-$selected'),
        initialValue: selected >= 0 ? selected : -1,

        decoration: decoration,
        items: [
          DropdownMenuItem(
            value: -1,
            child: Text(
              selected < 0 && value != null && value != ''
                  ? '原选项已失效，请重新选择'
                  : '请选择',
            ),
          ),
          for (var i = 0; i < options.length; i++)
            DropdownMenuItem(
              value: i,
              child: Text(
                pluginOptionLabel(options[i]),
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        onChanged: _busy || !_current
            ? null
            : (index) => _change(
                key,
                index == null || index < 0
                    ? ''
                    : pluginOptionValue(options[index]),
              ),
      );
    } else if (type == 'multiselect') {
      control = InputDecorator(
        decoration: decoration,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (value is List)
              for (final invalid in value.where(
                (v) => !options.map(pluginOptionValue).contains(v),
              ))
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('已失效选项：$invalid'),
                  trailing: IconButton(
                    tooltip: '移除失效选项',
                    icon: const Icon(Icons.close),
                    onPressed: _busy || !_current
                        ? null
                        : () => _change(
                            key,
                            List<dynamic>.from(value)..remove(invalid),
                          ),
                  ),
                ),
            for (final option in options)
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                dense: true,
                controlAffinity: ListTileControlAffinity.leading,
                title: Text(pluginOptionLabel(option)),
                value:
                    value is List && value.contains(pluginOptionValue(option)),
                onChanged: _busy || !_current
                    ? null
                    : (selected) {
                        final list = value is List
                            ? List<dynamic>.from(value)
                            : <dynamic>[];
                        final actual = pluginOptionValue(option);
                        if (selected == true) {
                          list.add(actual);
                        } else {
                          list.remove(actual);
                        }
                        _change(key, list);
                      },
              ),
          ],
        ),
      );
    } else {
      control = TextField(
        key: ValueKey('preference-$key'),
        controller: _controllers[key],
        enabled: !_busy && _current,
        decoration: decoration,
        minLines: type == 'textarea' ? 3 : 1,
        maxLines: type == 'textarea' ? 6 : 1,
        keyboardType: type == 'number'
            ? const TextInputType.numberWithOptions(decimal: true, signed: true)
            : type == 'url'
            ? TextInputType.url
            : TextInputType.multiline,
        onChanged: (v) => _change(
          key,
          type == 'number'
              ? v.trim().isEmpty
                    ? ''
                    : num.tryParse(v.trim()) ?? v
              : v,
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          control,
          if ((field['description'] ?? '').toString().isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                field['description'].toString(),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
        ],
      ),
    );
  }

  Widget _connections() {
    final readiness = _item['dependencyReadiness'] is Map
        ? _item['dependencyReadiness'] as Map
        : {};
    final required = (readiness['requiredMcp'] as List? ?? [])
        .map((e) => e.toString())
        .where((e) => e != 'soduwork-media' && e.isNotEmpty)
        .toSet();
    final missing = readiness['missingMcp'] as List? ?? [];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('连接与权限', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (required.isEmpty) const Text('此插件未声明需要额外的企业连接。'),
        for (final name in required)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.link),
            title: Text(name),
            subtitle: Text(missing.contains(name) ? '等待管理员接入' : '已接入，尚未测试'),
          ),
        const SizedBox(height: 8),
        const Text('使用偏好只对你的安装生效。账号和密钥通过企业连接配置，安装不等于授予权限。'),
      ],
    );
  }

  Widget _probeView() {
    final result = _probe!;
    final success = result['ok'] == true;
    final connections = result['connections'] is List
        ? result['connections'] as List
        : [];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              success ? Icons.check_circle_outline : Icons.error_outline,
              color: success
                  ? Theme.of(context).colorScheme.primary
                  : Theme.of(context).colorScheme.error,
            ),
            const SizedBox(height: 8),
            Text(
              (result['message'] ?? (success ? '检查通过' : '检查未通过')).toString(),
            ),
            Text(success ? '保存时会再次验证设置与连接。' : '请修正设置或让管理员完成企业连接后重试。'),
            for (final connection in connections.whereType<Map>())
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text((connection['name'] ?? '连接').toString()),
                subtitle: Text(
                  connection['ok'] == true
                      ? '连接正常 · ${connection['toolCount'] ?? 0} 个工具'
                      : (connection['error'] ?? '连接未通过').toString(),
                ),
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    final current = _current;
    return PopScope(
      canPop: !_busy,
      child: Scaffold(
        appBar: AppBar(
          title: Text(_installed ? '插件设置' : '安装插件'),
          actions: [
            if (_installed)
              IconButton(
                tooltip: '卸载插件',
                onPressed: _busy || !current
                    ? null
                    : () => _submit(uninstall: true),
                icon: const Icon(Icons.delete_outline),
              ),
          ],
        ),
        body: current
            ? ListView(
                padding: const EdgeInsets.all(20),
                children: [
                  Text(
                    (_item['name'] ?? '插件').toString(),
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 6),
                  Text('版本 ${_item['version'] ?? '—'}'),
                  const SizedBox(height: 20),
                  if ((_setup['title'] ?? '').toString().isNotEmpty)
                    Text(
                      _setup['title'].toString(),
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  if ((_setup['description'] ?? '').toString().isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8, bottom: 16),
                      child: Text(_setup['description'].toString()),
                    ),
                  if (_fields.isEmpty)
                    const Padding(
                      padding: EdgeInsets.only(bottom: 20),
                      child: Text('此版本无需额外填写使用偏好。'),
                    ),
                  for (var i = 0; i < _fields.length; i++) ...[
                    if (i == 0 ||
                        _fields[i]['group'] != _fields[i - 1]['group'])
                      Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: Text(
                          (_fields[i]['group'] ?? '使用偏好').toString(),
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      ),
                    _field(_fields[i]),
                  ],
                  const Divider(height: 32),
                  _connections(),
                  if (_probe != null) ...[
                    const SizedBox(height: 16),
                    _probeView(),
                  ],
                ],
              )
            : const Center(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text('账号已切换，请返回插件目录重新打开。'),
                ),
              ),
        bottomNavigationBar: SafeArea(
          top: false,
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
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                if (_busy)
                  const Padding(
                    padding: EdgeInsets.only(bottom: 8),
                    child: LinearProgressIndicator(),
                  ),
                Row(
                  children: [
                    OutlinedButton(
                      onPressed: _busy || !current
                          ? null
                          : () => _submit(probe: true),
                      child: const Text('测试连接'),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton(
                        onPressed: _busy || !current ? null : () => _submit(),
                        child: Text(_busy ? '处理中…' : _saveLabel),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

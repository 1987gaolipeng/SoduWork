import '../ui/mobile_select_field.dart';
import 'dart:math';
import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../ui/capability_widgets.dart';

class ConnectorEditorScreen extends StatefulWidget {
  final Map<String, dynamic>? original;
  const ConnectorEditorScreen({super.key, this.original});
  @override
  State<ConnectorEditorScreen> createState() => _ConnectorEditorScreenState();
}

class _ConnectorEditorScreenState
    extends CapabilityState<ConnectorEditorScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _description = TextEditingController();
  final _url = TextEditingController();
  final _token = TextEditingController();
  final Map<String, TextEditingController> _fields = {};
  final String _id = List.generate(
    16,
    (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
  List<Map<String, dynamic>> _templates = [];
  String _template = '';
  bool _approved = false;
  bool _dirty = false;
  bool _saved = false;
  bool _enabled = false;
  Map<String, dynamic>? _checked;
  Map<String, dynamic>? _result;
  @override
  void initState() {
    super.initState();
    final old = widget.original ?? {};
    _name.text = old['name']?.toString() ?? '';
    _description.text = old['description']?.toString() ?? '';
    _url.text = old['url']?.toString() ?? '';
    _template = old['templateKey']?.toString() ?? '';
    _enabled = old['enabled'] == true;
  }

  @override
  void initialize() {
    perform((api) async {
      final result = await api.capabilityCatalog();
      if (!current) return;
      setState(() {
        // OAuth/API definitions require their dedicated authorization flow.
        _templates = capabilityRows(result['mcpTemplates'])
            .where(
              (row) =>
                  row['template'] is Map &&
                  (row['template'] as Map)['type'] == 'stdio',
            )
            .toList();
        _bindFields();
      });
    });
  }

  Map<String, dynamic>? get _selected {
    for (final row in _templates) {
      if (row['key'] == _template) return row;
    }
    return null;
  }

  void _bindFields() {
    for (final controller in _fields.values) {
      controller.dispose();
    }
    _fields.clear();
    final env = widget.original?['env'] as Map? ?? {};
    for (final field in capabilityRows(_selected?['connectionFields'])) {
      final key = field['key'].toString();
      final value = env[key]?.toString() ?? field['default']?.toString() ?? '';
      _fields[key] = TextEditingController(
        text: field['secret'] == true ? '' : value,
      );
    }
  }

  void _changed() => setState(() {
    _dirty = true;
    _checked = null;
    _result = null;
    _approved = false;
    error = '';
    receipt = '';
  });
  Map<String, dynamic> _spec() {
    final old = widget.original ?? <String, dynamic>{};
    final headers = Map<String, dynamic>.from(old['headers'] as Map? ?? {});
    if (_token.text.isNotEmpty) {
      headers['Authorization'] = 'Bearer ${_token.text}';
    }
    final env = Map<String, dynamic>.from(old['env'] as Map? ?? {});
    for (final field in capabilityRows(_selected?['connectionFields'])) {
      final key = field['key'].toString(), value = _fields[key]!.text;
      // Empty secret inputs retain masked references rather than clearing them.
      if (field['secret'] != true ||
          value.isNotEmpty ||
          !env.containsKey(key)) {
        env[key] = value;
      }
    }
    return {
      ...old,
      'id': old['id'] ?? _id,
      'name': _name.text.trim(),
      'description': _description.text.trim(),
      'type': _template.isEmpty ? 'http' : 'stdio',
      'templateKey': _template,
      'url': _template.isEmpty ? _url.text.trim() : '',
      'headers': headers,
      'env': env,
      'enabled': _enabled,
      'approved': _approved,
      'approvedTarget': _template.isEmpty ? _url.text.trim() : _template,
    };
  }

  Future<void> _check() async {
    if (!_form.currentState!.validate() || !_approved) return;
    final server = _spec();
    await perform((api) async {
      final result = await api.preflightConnector(server);
      if (!current) return;
      if (result['ok'] != true) throw const ApiFailure('配置检查未通过，请核对后重试。');
      setState(() {
        _checked = server;
        receipt = '配置检查通过，尚未测试执行机连接。';
      });
    });
  }

  Future<void> _save() => perform((api) async {
    if (_checked == null) return;
    final result = await api.saveConnector(
      _checked!,
      original: widget.original,
    );
    if (!current) return;
    if (result['ok'] != true) throw const ApiFailure('保存未确认，请返回目录核对。');
    setState(() {
      _saved = true;
      _dirty = false;
      receipt = result['warning']?.toString().isNotEmpty == true
          ? result['warning'].toString()
          : '连接配置已保存。';
    });
  });
  Future<void> _test() => perform((api) async {
    if (_checked == null) return;
    final result = await api.probeConnector(_checked!);
    if (current) setState(() => _result = result);
  });
  @override
  void dispose() {
    for (final c in [_name, _description, _url, _token, ..._fields.values]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final supported =
        widget.original == null ||
        widget.original!['oauth'] == null &&
            widget.original!['apiDefinition'] == null &&
            (widget.original!['type'] == 'http' || _selected != null);
    return CapabilityDraftGuard(
      dirty: !invalidated && _dirty,
      busy: !invalidated && busy,
      child: Scaffold(
        appBar: AppBar(title: text('连接器配置')),
        body: invalidated
            ? identityNotice
            : Form(
                key: _form,
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    const CapabilityScopeNote(),
                    ...feedback,
                    if (!supported) text('此连接使用专用授权配置，请在原设备的连接中心管理。'),
                    if (supported) ...[
                      if (widget.original == null)
                        MobileSelectField<String>(
                          initialValue: _template,
                          decoration: InputDecoration(label: text('连接方式')),

                          items: [
                            DropdownMenuItem(value: '', child: text('HTTP 服务')),
                            for (final row in _templates)
                              DropdownMenuItem(
                                value: row['key'].toString(),
                                child: Text(
                                  row['name'].toString(),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                          ],
                          onChanged: busy || _saved
                              ? null
                              : (value) {
                                  _template = value!;
                                  _bindFields();
                                  _changed();
                                },
                        ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _name,
                        enabled: !busy && !_saved,
                        maxLength: 60,
                        decoration: InputDecoration(label: text('连接名称')),
                        onChanged: (_) => _changed(),
                        validator: (v) => v!.trim().isEmpty ? '请填写连接名称' : null,
                      ),
                      TextFormField(
                        controller: _description,
                        enabled: !busy && !_saved,
                        maxLength: 200,
                        decoration: InputDecoration(label: text('用途')),
                        onChanged: (_) => _changed(),
                      ),
                      if (_template.isEmpty) ...[
                        TextFormField(
                          controller: _url,
                          enabled: !busy && !_saved,
                          maxLength: 400,
                          decoration: InputDecoration(
                            label: text('服务地址'),
                            hintText: 'https://example.com/mcp',
                          ),
                          onChanged: (_) => _changed(),
                          validator: (v) {
                            final uri = Uri.tryParse(v!.trim());
                            return uri != null &&
                                    ['http', 'https'].contains(uri.scheme) &&
                                    uri.host.isNotEmpty &&
                                    uri.userInfo.isEmpty
                                ? null
                                : '请填写完整的 HTTP 或 HTTPS 地址';
                          },
                        ),
                        TextFormField(
                          controller: _token,
                          enabled: !busy && !_saved,
                          obscureText: true,
                          enableSuggestions: false,
                          autocorrect: false,
                          maxLength: 4096,
                          decoration: InputDecoration(
                            label: text('访问令牌（可选）'),
                            helperText: '留空保留已有授权',
                          ),
                          onChanged: (_) => _changed(),
                        ),
                      ],
                      for (final field in capabilityRows(
                        _selected?['connectionFields'],
                      ))
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: TextFormField(
                            controller: _fields[field['key'].toString()],
                            enabled: !busy && !_saved,
                            obscureText: field['secret'] == true,
                            enableSuggestions: field['secret'] != true,
                            autocorrect: false,
                            decoration: InputDecoration(
                              labelText:
                                  field['label']?.toString() ??
                                  field['key'].toString(),
                              helperText: field['secret'] == true
                                  ? '留空保留已有授权'
                                  : field['hint']?.toString(),
                            ),
                            onChanged: (_) => _changed(),
                          ),
                        ),
                      SwitchListTile.adaptive(
                        contentPadding: EdgeInsets.zero,
                        title: text('保存后启用'),
                        value: _enabled,
                        onChanged: busy || _saved
                            ? null
                            : (value) {
                                _enabled = value;
                                _changed();
                              },
                      ),
                      CheckboxListTile(
                        contentPadding: EdgeInsets.zero,
                        title: text('允许连接此服务'),
                        subtitle: Text(
                          _template.isEmpty
                              ? _url.text
                              : _selected?['name']?.toString() ?? _template,
                        ),
                        value: _approved,
                        onChanged: busy || _saved
                            ? null
                            : (value) => setState(() {
                                _approved = value == true;
                                _checked = null;
                                _dirty = true;
                              }),
                      ),
                      if (_checked == null)
                        FilledButton(
                          onPressed: busy || _saved || !_approved
                              ? null
                              : _check,
                          child: text('检查配置'),
                        ),
                      if (_checked != null)
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            FilledButton(
                              onPressed: busy || _saved ? null : _save,
                              child: text('保存配置'),
                            ),
                            OutlinedButton(
                              onPressed: busy ? null : _test,
                              child: text('测试连接'),
                            ),
                          ],
                        ),
                      if (_result != null)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              text(
                                _result!['ok'] == true ? '连接测试通过' : '连接尚未就绪',
                              ),
                              Text(
                                (_result!['message'] ??
                                        _result!['error'] ??
                                        _result!['connectionState'] ??
                                        '')
                                    .toString(),
                              ),
                              if (_result!['runner'] is Map)
                                Text(
                                  (_result!['runner'] as Map)['host']
                                          ?.toString() ??
                                      '',
                                ),
                            ],
                          ),
                        ),
                      if (_saved)
                        TextButton(
                          onPressed: () => Navigator.pop(context, true),
                          child: text('返回目录'),
                        ),
                    ],
                  ],
                ),
              ),
      ),
    );
  }
}

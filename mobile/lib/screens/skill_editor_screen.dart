import '../ui/mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../core/soduwork_api.dart';
import '../core/work_file_picker.dart';
import '../ui/capability_widgets.dart';

class SkillEditorScreen extends StatefulWidget {
  final bool importing;
  final Future<List<XFile>> Function()? chooseFiles;
  const SkillEditorScreen({
    super.key,
    this.importing = false,
    this.chooseFiles,
  });
  @override
  State<SkillEditorScreen> createState() => _SkillEditorScreenState();
}

class _SkillEditorScreenState extends CapabilityState<SkillEditorScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _description = TextEditingController();
  final _instructions = TextEditingController();
  XFile? _file;
  Map<String, dynamic>? _preview;
  bool _saved = false;
  bool get _dirty =>
      !_saved &&
      (_file != null ||
          _name.text.isNotEmpty ||
          _description.text.isNotEmpty ||
          _instructions.text.isNotEmpty);

  Future<void> _pick() => perform((api) async {
    final files = await (widget.chooseFiles ?? pickWorkFiles)();
    if (!current || files.isEmpty) return;
    if (files.length != 1) throw const ApiFailure('每次请选择一个技能文件。');
    setState(() {
      _file = files.single;
      _preview = null;
      _saved = false;
    });
    final result = await api.preflightSkill(_file!);
    if (!current) return;
    if (result['ok'] != true) throw const ApiFailure('技能检查未通过，请核对文件。');
    setState(() => _preview = result);
  });

  Future<void> _save() async {
    if (!current || busy || _saved) return;
    if (!widget.importing && !_form.currentState!.validate()) return;
    if (widget.importing && (_file == null || _preview == null)) return;
    await perform((api) async {
      final result = widget.importing
          ? await api.importSkill(_file!)
          : await api.createSkill({
              'name': _name.text.trim(),
              'description': _description.text.trim(),
              'instructions': _instructions.text.trim(),
            });
      if (!current) return;
      if (result['ok'] != true) throw const ApiFailure('未收到保存回执，请返回目录核对。');
      setState(() {
        _saved = true;
        receipt = '技能已保存并启用；远程执行可用性请以目标环境为准。';
      });
    });
  }

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    _instructions.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CapabilityDraftGuard(
    dirty: !invalidated && _dirty,
    busy: !invalidated && busy,
    child: Scaffold(
      appBar: AppBar(title: text(widget.importing ? '导入技能' : '创建技能')),
      body: invalidated
          ? identityNotice
          : Form(
              key: _form,
              onChanged: () => setState(() {}),
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  const CapabilityScopeNote(),
                  if (widget.importing) ...[
                    text('选择 .skill 或 ZIP 包，先检查内容，再确认导入。'),
                    OutlinedButton.icon(
                      onPressed: busy || _saved ? null : _pick,
                      icon: const Icon(Icons.file_open_outlined),
                      label: text(_file == null ? '选择技能文件' : '重新选择'),
                    ),
                    if (_file != null) Text(_file!.name),
                    if (_preview != null) ...[
                      Text(
                        (_preview!['skill'] as Map?)?['name']?.toString() ?? '',
                      ),
                      for (final row in capabilityRows(_preview!['checks']))
                        ListTile(
                          leading: Icon(
                            row['ok'] == true
                                ? Icons.check_circle_outline
                                : Icons.info_outline,
                          ),
                          title: Text(row['label']?.toString() ?? ''),
                        ),
                      ExpansionTile(
                        title: text('随包文件'),
                        children: [
                          for (final row in capabilityRows(_preview!['files']))
                            ListTile(
                              title: Text(row['path']?.toString() ?? ''),
                              subtitle: Text('${row['bytes'] ?? 0} B'),
                            ),
                        ],
                      ),
                    ],
                  ] else ...[
                    TextFormField(
                      controller: _name,
                      enabled: !busy && !_saved,
                      maxLength: 64,
                      decoration: InputDecoration(
                        label: text('技能标识'),
                        helperText: mobileText(context, '例如 text-processing'),
                      ),
                      validator: (v) =>
                          RegExp(
                            r'^[a-z0-9]+(?:-[a-z0-9]+)*$',
                          ).hasMatch(v?.trim() ?? '')
                          ? null
                          : mobileText(context, '请使用小写字母、数字和连字符'),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _description,
                      enabled: !busy && !_saved,
                      minLines: 2,
                      maxLines: 4,
                      maxLength: 1024,
                      decoration: InputDecoration(label: text('用途')),
                      validator: (v) => v!.trim().isEmpty
                          ? mobileText(context, '请填写用途')
                          : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _instructions,
                      enabled: !busy && !_saved,
                      minLines: 8,
                      maxLines: 18,
                      maxLength: 50000,
                      decoration: InputDecoration(label: text('工作方法')),
                      validator: (v) => v!.trim().isEmpty
                          ? mobileText(context, '请填写工作方法')
                          : null,
                    ),
                  ],
                  ...feedback,
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed:
                        busy || _saved || (widget.importing && _preview == null)
                        ? null
                        : _save,
                    child: text(widget.importing ? '确认导入并启用' : '保存并启用'),
                  ),
                  if (_saved)
                    TextButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: text('返回目录'),
                    ),
                ],
              ),
            ),
    ),
  );
}

import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../ui/capability_widgets.dart';
import '../ui/mobile_display_preferences.dart';
import '../core/mobile_library.dart';

class LibraryNoteScreen extends StatefulWidget {
  final String folderId, storage;
  final LibraryLocation? location;
  const LibraryNoteScreen({
    super.key,
    this.folderId = '',
    this.storage = '',
    this.location,
  });
  @override
  State<LibraryNoteScreen> createState() => _LibraryNoteScreenState();
}

class _LibraryNoteScreenState extends CapabilityState<LibraryNoteScreen> {
  final _title = TextEditingController(), _body = TextEditingController();
  String _format = 'txt';
  bool _saved = false, _uncertain = false;
  MobileLibrary? _library;
  Future<void> _save() async {
    if (_title.text.trim().isEmpty) {
      setState(() => error = '请填写标题');
      return;
    }
    await perform((api) async {
      Map<String, dynamic> result;
      try {
        result = widget.location != null
            ? await (_library ??= MobileLibrary(
                api,
                widget.location!,
                checkOwner: () {
                  if (!current) throw const ApiFailure('账号已切换');
                },
              )).call(
                'createItem',
                body: {
                  'kind': 'document',
                  'format': _format,
                  'filename':
                      _title.text.trim().toLowerCase().endsWith('.$_format')
                      ? _title.text.trim()
                      : '${_title.text.trim()}.$_format',
                  'title': _title.text.trim(),
                  'content': _body.text,
                  'folderId': widget.folderId,
                },
              )
            : await api.createLibraryNote(
                _title.text.trim(),
                _body.text,
                folderId: widget.folderId,
                format: _format,
                storage: widget.storage,
              );
      } on ApiFailure catch (e) {
        if (current && e.isNetwork) setState(() => _uncertain = true);
        rethrow;
      }
      if (!current) return;
      if (result['ok'] != true) {
        setState(() => _uncertain = true);
        throw const ApiFailure('未收到保存回执，请刷新核对。');
      }
      setState(() {
        _saved = true;
        receipt = '资料已保存';
      });
    });
  }

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CapabilityDraftGuard(
    dirty:
        !invalidated &&
        !_saved &&
        (_title.text.isNotEmpty || _body.text.isNotEmpty),
    busy: !invalidated && busy,
    child: Scaffold(
      appBar: AppBar(title: text('新建文档')),
      body: invalidated
          ? identityNotice
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                TextField(
                  controller: _title,
                  enabled: !busy && !_saved && !_uncertain,
                  maxLength: 240,
                  decoration: InputDecoration(
                    labelText: mobileText(context, '标题'),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _format,
                  decoration: const InputDecoration(labelText: '文档格式'),
                  items: const [
                    DropdownMenuItem(value: 'txt', child: Text('TXT（纯文本）')),
                    DropdownMenuItem(value: 'md', child: Text('Markdown')),
                  ],
                  onChanged: busy || _saved || _uncertain
                      ? null
                      : (v) {
                          if (v != null) setState(() => _format = v);
                        },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _body,
                  enabled: !busy && !_saved && !_uncertain,
                  minLines: 10,
                  maxLines: 24,
                  maxLength: 100000,
                  decoration: InputDecoration(
                    labelText: mobileText(context, '文档内容'),
                  ),
                  onChanged: (_) => setState(() {}),
                ),
                ...feedback,
                if (_uncertain) text('保存结果未确认，请先返回资料库刷新核对，避免重复创建。'),
                FilledButton(
                  onPressed: busy || _saved || _uncertain ? null : _save,
                  child: text('保存文档'),
                ),
                if (_saved || _uncertain)
                  TextButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                    child: text('返回资料库'),
                  ),
              ],
            ),
    ),
  );
}

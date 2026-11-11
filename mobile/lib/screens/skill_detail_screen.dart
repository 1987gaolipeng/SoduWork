import '../ui/mobile_display_preferences.dart';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import '../ui/capability_widgets.dart';
import '../core/artifact_download.dart';
import '../ui/artifact_actions.dart';

class SkillDetailScreen extends StatefulWidget {
  final String name;
  const SkillDetailScreen({super.key, required this.name});
  @override
  State<SkillDetailScreen> createState() => _SkillDetailScreenState();
}

class _SkillDetailScreenState extends CapabilityState<SkillDetailScreen> {
  Map<String, dynamic>? _detail;
  Map<String, dynamic>? _content;
  String _path = '';
  String _body = '';
  @override
  void initialize() {
    _load();
  }

  Future<void> _load() => perform((api) async {
    // A failed reload must not leave an older version actionable.
    setState(() {
      _detail = null;
      _content = null;
      _body = '';
      _path = '';
    });
    final result = await api.skillDetails(widget.name);
    if (!current) return;
    setState(() => _detail = result);
  });
  Future<void> _read(String path, {bool more = false}) => perform((api) async {
    final checksum = _detail!['checksum']?.toString() ?? '';
    final offset = more ? (_content?['nextOffset'] as int? ?? 0) : 0;
    if (!more) {
      setState(() {
        _path = path;
        _body = '';
        _content = null;
      });
    }
    final result = await api.skillContent(
      widget.name,
      path,
      checksum,
      offset: offset,
    );
    if (!current) return;
    setState(() {
      _content = result;
      _body += result['text']?.toString() ?? '';
    });
  });
  Future<void> _download(String path) => perform((api) async {
    final file = await ArtifactDownloader(
      api,
    ).downloadSkill(widget.name, _detail!['checksum'].toString(), path);
    if (mounted && current) await exportMobileFile(context, file);
  });

  Future<void> _remove() async {
    if (!await confirm('删除个人技能？', '只删除当前身份保存的此技能，不会删除其他技能或任务。')) return;
    await perform((api) async {
      await api.removeSkill(widget.name, _detail!['checksum'].toString());
      if (mounted && current) Navigator.pop(context, true);
    });
  }

  Widget _image() {
    try {
      final Uint8List bytes = base64Decode(_content!['base64']);
      return Image.memory(bytes, errorBuilder: (_, _, _) => text('图片无法预览'));
    } on FormatException {
      return text('图片无法预览');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(widget.name),
      actions: [
        IconButton(
          tooltip: mobileText(context, '刷新'),
          onPressed: busy ? null : _load,
          icon: const Icon(Icons.refresh),
        ),
      ],
    ),
    body: invalidated
        ? identityNotice
        : ListView(
            padding: const EdgeInsets.all(16),
            children: [
              ...feedback,
              if (_detail != null) ...[
                Text(_detail!['description']?.toString() ?? ''),
                const CapabilityScopeNote(),
                for (final file in capabilityRows(_detail!['files']))
                  ListTile(
                    leading: const Icon(Icons.description_outlined),
                    title: Text(file['path']?.toString() ?? ''),
                    subtitle: Text('${file['bytes'] ?? 0} B'),
                    trailing: IconButton(
                      tooltip: mobileText(context, '下载文件'),
                      icon: const Icon(Icons.download_outlined),
                      onPressed: busy
                          ? null
                          : () => _download(file['path'].toString()),
                    ),
                    onTap: busy ? null : () => _read(file['path'].toString()),
                  ),
                if (_path.isNotEmpty)
                  Text(_path, style: Theme.of(context).textTheme.titleMedium),
                if (_body.isNotEmpty) SelectionArea(child: Text(_body)),
                if (_content?['kind'] == 'image' &&
                    _content?['base64'] is String)
                  _image(),
                if (_content?['message'] != null)
                  Text(_content!['message'].toString()),
                if (_content?['nextOffset'] is int)
                  TextButton(
                    onPressed: busy ? null : () => _read(_path, more: true),
                    child: text('继续读取'),
                  ),
                if (_detail!['canDelete'] == true)
                  Padding(
                    padding: const EdgeInsets.only(top: 24),
                    child: OutlinedButton.icon(
                      onPressed: busy ? null : _remove,
                      icon: const Icon(Icons.delete_outline),
                      label: text('删除个人技能'),
                    ),
                  ),
              ],
            ],
          ),
  );
}

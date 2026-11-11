import 'dart:convert';
import '../core/file_preview_content.dart';
import '../ui/file_preview.dart';
import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../ui/artifact_actions.dart';
import '../ui/capability_widgets.dart';
import '../core/mobile_library.dart';
import '../core/artifact_download.dart';
import '../ui/library_file_menu.dart';

class LibraryItemScreen extends StatefulWidget {
  final Map<String, dynamic> item;
  final Future<void> Function(List<DownloadedArtifact>, String)? onDiscuss;
  final Future<void> Function(String)? onSource;
  final bool canCopy;
  final LibraryLocation location;
  const LibraryItemScreen({
    super.key,
    required this.item,
    this.onDiscuss,
    this.onSource,
    this.canCopy = false,
    this.location = const LibraryLocation(),
  });
  @override
  State<LibraryItemScreen> createState() => _LibraryItemScreenState();
}

class _LibraryItemScreenState extends CapabilityState<LibraryItemScreen>
    with LibraryFileCommands<LibraryItemScreen> {
  late Map<String, dynamic> _item;
  DownloadedArtifact? _file;
  List<Map<String, dynamic>>? _archiveMembers;
  String notice = '';
  String get _id => _item['id'].toString();
  bool get _deleted => _item['isDeleted'] == true;
  MobileLibrary? _library;
  @override
  MobileLibrary get library => _library ??= MobileLibrary(
    owner!.api,
    widget.location,
    checkOwner: () {
      if (!current) throw const ApiFailure('账号已切换，请重新打开资料');
    },
  );
  @override
  void initState() {
    super.initState();
    _item = Map.of(widget.item);
  }

  @override
  void initialize() {
    if (!_deleted) _read();
  }

  Future<void> _read() => perform((_) async {
    final filename = _item['filename']?.toString() ?? libraryDisplayName(_item);
    final mime = _item['contentType']?.toString() ?? 'application/octet-stream';
    final kind = filePreviewKind(filename, mime);
    if (kind == PreviewKind.text || kind == PreviewKind.markdown) {
      final result = await library.call('readContent', id: _id);
      if (!current) return;
      if (result['ok'] != true ||
          (result['item'] as Map?)?['id'] != _id ||
          result['content'] is! String) {
        throw const ApiFailure('资料已变化，请重新打开。');
      }
      final meta = result['preview'] as Map?;
      setState(() {
        _file = DownloadedArtifact(
          filename: filename,
          contentType: mime,
          bytes: utf8.encode(result['content'] as String),
        );
        notice =
            meta?['notice']?.toString() ??
            (meta?['truncated'] == true ? '仅显示部分内容，下载可查看原件。' : '');
      });
    } else if (kind == PreviewKind.zip &&
        !widget.location.desktop &&
        (_item['size'] as num? ?? 0) > 32 * 1024 * 1024) {
      final result = await library.call('archive', id: _id);
      if (current) {
        setState(
          () => _archiveMembers = capabilityRows(result['archive']?['files']),
        );
      }
    } else if (kind != PreviewKind.other) {
      final file = await library.read(_item);
      if (current) setState(() => _file = file);
    }
  });
  Future<void> _act(FileCommand command) async {
    if (command == FileCommand.system) {
      await perform((_) async {
        final original = await library.read(_item);
        if (mounted && current) await shareDeviceFile(context, original);
      });
      return;
    }
    await runFileCommand(
      command,
      _item,
      onDiscuss: widget.onDiscuss,
      onSource: widget.onSource,
      onUpdated: (next) => setState(() {
        _item = next;
        if (command == FileCommand.edit || command == FileCommand.trash) {
          _file = null;
          _archiveMembers = null;
          notice = '';
        }
        receipt = '资料已更新';
      }),
      onPurged: () => Navigator.pop(context),
    );
    if (current &&
        error.isEmpty &&
        (command == FileCommand.edit || command == FileCommand.restore)) {
      await _read();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: Text(
        libraryDisplayName(_item),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      actions: [
        if (!invalidated && !_deleted)
          IconButton(
            tooltip: '下载文件',
            icon: const Icon(Icons.download_outlined),
            onPressed: busy ? null : () => _act(FileCommand.download),
          ),
        if (!invalidated)
          LibraryFileMenu(
            item: _item,
            enabled: !busy,
            detail: true,
            desktop: widget.location.desktop,
            canCopy: widget.canCopy,
            canDiscuss: widget.onDiscuss != null,
            canSource: widget.onSource != null,
            history:
                widget.location.storage == 'local' && !widget.location.desktop,
            onSelected: _act,
          ),
      ],
    ),
    body: invalidated
        ? identityNotice
        : Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ...feedback,
              if (notice.isNotEmpty)
                Padding(padding: const EdgeInsets.all(8), child: Text(notice)),
              if (_deleted)
                FilledButton(
                  onPressed: busy ? null : () => _act(FileCommand.restore),
                  child: text('恢复资料'),
                )
              else if (_archiveMembers != null)
                Expanded(
                  child: ListView(
                    children: [
                      for (final row in _archiveMembers!)
                        ListTile(
                          title: Text(row['path']?.toString() ?? ''),
                          enabled: !busy && row['isDirectory'] != true,
                          onTap: () => perform((api) async {
                            final file = await ArtifactDownloader(api)
                                .downloadLibraryMember(
                                  _id,
                                  row['path'].toString(),
                                );
                            library.check();
                            if (context.mounted && current) {
                              await exportMobileFile(
                                context,
                                file,
                                openOnDevice: true,
                              );
                            }
                          }),
                        ),
                    ],
                  ),
                )
              else if (_file != null)
                Expanded(
                  child: FilePreview(
                    key: ObjectKey(_file),
                    file: _file!,
                    openMember: (member, {entry, resources}) =>
                        exportMobileFile(
                          context,
                          member,
                          openOnDevice: true,
                          entry: entry,
                          resources: resources,
                        ),
                  ),
                )
              else if (!busy)
                Expanded(
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (error.isNotEmpty)
                          TextButton(onPressed: _read, child: text('重新加载预览'))
                        else
                          text('此格式可保存到设备，或选择其他应用打开。'),
                        OutlinedButton.icon(
                          onPressed: () => _act(FileCommand.system),
                          icon: const Icon(Icons.open_in_new),
                          label: text('系统分享或打开'),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
  );
}

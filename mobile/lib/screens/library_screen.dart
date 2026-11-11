import '../ui/location_switch_row.dart';
import 'dart:async';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../core/work_file_picker.dart';
import '../ui/capability_widgets.dart';
import '../ui/mobile_display_preferences.dart';
import 'library_item_screen.dart';
import '../ui/library_file_menu.dart';
import '../ui/library_entry_tile.dart';
import '../ui/library_actions.dart';
import 'library_note_screen.dart';
import '../core/mobile_library.dart';
import '../core/artifact_download.dart';
import '../ui/library_location_picker.dart';
import '../ui/work_widgets.dart' show formatDateTime;

class LibraryScreen extends StatefulWidget {
  final Future<void> Function(List<DownloadedArtifact>, String)? onDiscuss;
  final Future<void> Function(String, String)? onSource;
  final LibraryLocation? initialLocation;
  final bool pick;
  final DownloadedArtifact? saveFile;
  final Map<String, dynamic> source;
  const LibraryScreen({
    super.key,
    this.initialLocation,
    this.onDiscuss,
    this.onSource,
    this.pick = false,
    this.saveFile,
    this.source = const {},
  });
  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends CapabilityState<LibraryScreen>
    with LibraryFileCommands<LibraryScreen> {
  final _search = TextEditingController();
  final _trail = <Map<String, dynamic>>[];
  String _scope = 'recommended';
  String _folderOrigin = 'all';
  Map<String, dynamic>? _data;
  Timer? _debounce;
  bool _reloadRequested = false;
  LibraryLocation _location = const LibraryLocation(label: '本地存储');
  bool get _hasLocation => _location.desktop || _location.storage.isNotEmpty;
  LibraryLocation? _remoteTarget;
  bool get _remote =>
      !_location.desktop && const {'nfs', 'minio'}.contains(_location.storage);
  bool get _history =>
      _remote && _trail.isNotEmpty && _trail.first['historyRoot'] == true;
  LibraryLocation get _effective => _history
      ? const LibraryLocation(storage: 'local', label: '历史服务器资料')
      : _location;
  String _kind = 'all';
  bool _showHidden = false, _grid = false;
  LibraryLocation? _lastComputer;
  String _remoteMessage = '远程存储未连接';
  late final _prefs = SharedPreferencesAsync();
  Future<void> _readPreferences() async {
    try {
      final grid = await _prefs.getBool('library.grid') ?? false;
      final hidden = await _prefs.getBool('library.hidden') ?? false;
      if (current) {
        setState(() {
          _grid = grid;
          _showHidden = hidden;
        });
      }
    } catch (_) {}
  }

  Future<void> _savePref(String key, bool value) async {
    try {
      await _prefs.setBool('library.$key', value);
    } catch (_) {}
  }

  bool _selecting = false;
  final _selected = <String>{};
  void _clearSelection() {
    _selected.clear();
    _selecting = false;
  }

  MobileLibrary? _library;
  final _transfer = MobileLibrary.requestId();
  @override
  MobileLibrary get library => _library ??= MobileLibrary(
    owner!.api,
    _effective,
    checkOwner: () {
      if (!current) throw const ApiFailure('账号已切换，请重新打开资料库');
    },
  );
  String get _folder =>
      _scope == 'all' ? (_trail.lastOrNull?['id']?.toString() ?? '') : '';
  String get _storage => _effective.storage;

  String _modifiedLabel(Map<String, dynamic> item) {
    final raw = item[_scope == 'trash' ? 'deletedAt' : 'updatedAt'];
    final date = DateTime.tryParse(raw?.toString() ?? '')?.toLocal();
    if (date == null) return '';
    final year = date.year == DateTime.now().year ? '' : '${date.year}年';
    return '$year${formatDateTime(date, context: context)}';
  }

  String _sizeLabel(Object? value) {
    final size = num.tryParse(value?.toString() ?? '');
    if (size == null || size < 0) return '';
    if (size < 1024) return '${size.toInt()} B';
    if (size < 1024 * 1024) return '${(size / 1024).toStringAsFixed(1)} KB';
    return '${(size / 1024 / 1024).toStringAsFixed(1)} MB';
  }

  @override
  void initialize() {
    _readPreferences();
    if (widget.saveFile != null) _scope = 'all';
    if (widget.initialLocation != null) {
      _location = widget.initialLocation!;
      _load();
    } else {
      _openDefault();
    }
  }

  Future<void> _openDefault() async {
    await perform((api) async {
      final targets = await LibraryTargets.load(api);
      if (!current) return;
      _remoteTarget = targets.remoteReady ? targets.remoteLocation : null;
      final remote = targets.remote,
          quota = remote['quota'] is Map ? remote['quota'] as Map : remote;
      _remoteMessage = targets.remoteReady && quota['remainingBytes'] is num
          ? '可用空间 ${_sizeLabel(quota['remainingBytes'])}'
          : remote['message']?.toString() ?? '远程存储未连接';
      final pcs = targets.computers.where(LibraryTargets.usable).toList();
      if (pcs.length == 1) {
        setState(() {
          _location = LibraryTargets.pc(pcs.single);
          _lastComputer = _location;
        });
      } else if (targets.computerError.isNotEmpty) {
        throw ApiFailure(targets.computerError);
      }
    });
    if (current && _hasLocation) await _load();
  }

  Future<void> _load() async {
    if (!_hasLocation) return;
    if (busy) {
      _reloadRequested = true;
      return;
    }
    _reloadRequested = false;
    final query = _search.text.trim(), scope = _scope, folder = _folder;
    await perform((api) async {
      final result = await library.list(
        scope: scope,
        query: query,
        folderId: folder,
      );
      if (!current) return;
      if (result['ok'] != true) throw const ApiFailure('资料库读取未完成，请刷新重试。');
      if (query == _search.text.trim() &&
          scope == _scope &&
          folder == _folder) {
        setState(() => _data = result);
      }
    });
    if (current && _reloadRequested) await _load();
  }

  Future<void> _upload() async {
    await perform((api) async {
      final files = await pickWorkFiles();
      if (!current || files.isEmpty) return;
      final destination = library, folder = _folder;
      for (final file in files) {
        if (await file.length() > 32 * 1024 * 1024) {
          throw ApiFailure('${file.name} 超出手机上传限制');
        }
      }
      var count = 0;
      for (final file in files) {
        destination.check();
        try {
          final result = await destination.upload(
            DownloadedArtifact(
              bytes: await file.readAsBytes(),
              filename: file.name,
              contentType: file.mimeType ?? 'application/octet-stream',
            ),
            folderId: folder,
          );
          if (result['ok'] != true) throw const ApiFailure('未收到保存回执');
        } catch (e) {
          throw ApiFailure('已保存 $count 份，${file.name} 未确认，请刷新核对。$e');
        }
        count++;
      }
      receipt = '已保存 $count 份资料';
    });
    if (current && error.isEmpty) await _load();
  }

  Future<void> _folderCreate() async {
    final name = await libraryTextDialog(
      context,
      title: '新建文件夹',
      initial: '',
      maxLength: 160,
    );
    if (!current || name == null) return;
    await perform((api) async {
      final result = await library.call(
        'createFolder',
        body: {'name': name, 'parentId': _folder},
      );
      if (!current) return;
      if (result['ok'] != true) throw const ApiFailure('未收到保存回执，请刷新核对。');
    });
    if (current && error.isEmpty) await _load();
  }

  Future<void> _note() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => LibraryNoteScreen(
          folderId: _folder,
          storage: _storage,
          location: _effective,
        ),
      ),
    );
    if (current) await _load();
  }

  Future<void> _item(Map<String, dynamic> item) async {
    if (widget.pick) {
      await perform((_) async {
        final file = await library.read(item, limit: 16 * 1024 * 1024);
        if (mounted && current) Navigator.of(context).pop(file);
      });
      return;
    }
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => LibraryItemScreen(
          item: item,
          location: _effective,
          canCopy: _remoteTarget != null,
          onDiscuss: widget.onDiscuss,
          onSource: widget.onSource == null
              ? null
              : (id) => widget.onSource!(id, _location.clientId),
        ),
      ),
    );
    if (current) await _load();
  }

  Future<void> _rowCommand(
    FileCommand command,
    Map<String, dynamic> item,
  ) async {
    var changed = false;
    await runFileCommand(
      command,
      item,
      onDiscuss: widget.onDiscuss,
      onSource: widget.onSource == null
          ? null
          : (id) => widget.onSource!(id, _location.clientId),
      onUpdated: (_) => changed = true,
      onPurged: () => changed = true,
    );
    if (current && changed) await _load();
  }

  void _toggle(Map row) => setState(() {
    final id = row['id'].toString();
    if (!_selected.remove(id)) _selected.add(id);
  });
  Widget _checkBox(Map row) => Checkbox(
    value: _selected.contains(row['id']),
    onChanged: busy ? null : (_) => _toggle(row),
  );
  Future<void> _batch(
    String action,
    List<Map<String, dynamic>> files,
    List<Map<String, dynamic>> folders,
  ) async {
    if (files.length + folders.length > 100) {
      setState(() => error = '一次最多选择 100 项');
      return;
    }
    if (action == '移入回收站' &&
        !await confirm('移入回收站？', '将选中的 ${files.length} 份资料移入回收站。')) {
      return;
    }
    if (action == '存储到远程' && !await confirm('存储到远程？', '将选中的资料复制到远程存储，保留原件。')) {
      return;
    }
    String message = '';
    var cancelled = false;
    await perform((_) async {
      if (action == '分享') {
        cancelled = !await shareLibrarySelection(
          context,
          library,
          files,
          folders,
        );
      } else if (action == '对话') {
        if (files.length > 20) throw const ApiFailure('一次最多选择 20 份资料');
        final data = <DownloadedArtifact>[];
        var total = 0;
        for (final row in files) {
          final file = await library.read(row, limit: 16 * 1024 * 1024);
          total += file.bytes.length;
          if (total > 90 * 1024 * 1024) {
            throw const ApiFailure('聊天材料合计不能超过 90 MB');
          }
          data.add(file);
        }
        if (current) await widget.onDiscuss?.call(data, '');
      } else if (action == '存储到远程') {
        final target = _remoteTarget!;
        for (final row in files) {
          final recorded = await library.copyToRemote(row, target, reuse: true);
          if (!recorded) message = '远程副本已保存，电脑上的复制记录未确认。';
          if (current) _selected.remove(row['id']);
        }
      } else {
        final result = await library.trashSelection(files);
        final succeeded = result['succeeded'] as List? ?? [];
        if (current) {
          for (final entry in succeeded) {
            _selected.remove(entry is Map ? entry['id'] : entry);
          }
        }
        final failed = capabilityRows(result['failed']);
        if (failed.isNotEmpty) {
          message = '部分资料未移入回收站：${failed.first['message']}';
        }
      }
    });
    if (current && !cancelled && error.isEmpty) {
      if (message.isEmpty) {
        setState(_clearSelection);
      }
      await _load();
      if (current && message.isNotEmpty) setState(() => error = message);
    }
  }

  Future<void> _refreshView() async {
    if (!_hasLocation) {
      await _openDefault();
      return;
    }
    if (busy) return;
    final previous = _location;
    final targets = await LibraryTargets.load(owner!.api);
    if (!current || !identical(previous, _location)) return;
    setState(() {
      _remoteTarget = targets.remoteReady ? targets.remoteLocation : null;
      _remoteMessage = targets.remote['message']?.toString() ?? '远程存储未连接';
    });
    if (_remote && _location.storage != _remoteTarget?.storage) {
      setState(() {
        _data = null;
        error = '当前远程存储不可用，请重新选择位置';
      });
      return;
    }
    await _load();
  }

  Future<void> _choose() async {
    final location = await chooseLibraryLocation(context);
    if (!current || location == null) return;
    await _enterLocation(location);
  }

  Future<void> _enterLocation(LibraryLocation location) async {
    if (!current || busy) return;
    setState(() {
      _location = location;
      if (location.desktop) _lastComputer = location;
      if (!location.desktop) _remoteTarget = location;
      _clearSelection();
      _search.clear();
      _kind = 'all';
      _library = null;
      _trail.clear();
      _data = null;
    });
    await _load();
  }

  Future<void> _saveHere() => perform((_) async {
    final result = await library.upload(
      widget.saveFile!,
      folderId: _folder,
      transferId: _transfer,
      source: widget.source,
    );
    if (result['ok'] != true) throw const ApiFailure('保存结果未确认，请刷新核对');
    if (mounted && current) Navigator.of(context).pop(true);
  });
  void _openFolder(Map<String, dynamic> folder) {
    if (_selecting && folder['historyRoot'] != true) {
      _toggle(folder);
      return;
    }
    setState(() {
      if (_trail.isEmpty) _folderOrigin = _scope;
      _scope = 'all';
      _kind = 'all';
      _clearSelection();
      _library = null;
      _trail.add(folder);
      _data = null;
      _search.clear();
    });
    _load();
  }

  Future<void> _folderAction(Map<String, dynamic> folder, String action) async {
    if (action == 'open') return;
    if (action == 'share') {
      await perform((_) async {
        await shareLibrarySelection(context, library, [], [folder]);
      });
      return;
    }
    Map<String, dynamic> body = {};
    if (action == 'rename') {
      final name = await libraryTextDialog(
        context,
        title: '重命名文件夹',
        initial: folder['name']?.toString() ?? '',
      );
      if (!current || name == null) return;
      body = {'name': name};
    } else if (action == 'favorite') {
      body = {'favorite': folder['favorite'] != true};
    } else if (!await confirm('删除空文件夹？', '文件夹内还有资料时不会删除。')) {
      return;
    }
    await perform((_) async {
      await library.call(
        action == 'delete' ? 'deleteFolder' : 'updateFolder',
        id: folder['id'].toString(),
        body: body,
      );
    });
    if (current && error.isEmpty) await _load();
  }

  Iterable<Widget> _gridRows(List<Widget> tiles, int columns) sync* {
    for (var start = 0; start < tiles.length; start += columns) {
      yield Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var col = 0; col < columns; col++) ...[
            if (col > 0) const SizedBox(width: 8),
            Expanded(
              child: start + col < tiles.length
                  ? tiles[start + col]
                  : const SizedBox.shrink(),
            ),
          ],
        ],
      );
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  void _enterScope(String scope) {
    setState(() {
      final wasTrash = _scope == 'trash';
      _scope = scope;
      _clearSelection();
      if (_history && (wasTrash || scope == 'trash')) {
        _trail.removeRange(1, _trail.length);
      } else {
        _trail.clear();
      }
      _library = null;
      _data = null;
    });
    _load();
  }

  Future<void> _create(String kind) async {
    if (!current) return;
    if (kind == 'upload') {
      await _upload();
    } else if (kind == 'folder') {
      await _folderCreate();
    } else if (kind == 'document') {
      await _note();
    } else {
      await widget.onDiscuss?.call(
        [],
        '请帮我创建$kind。请先询问主题、用途和要求，完成后提醒我将成果保存到资料库。',
      );
    }
  }

  Widget _createMenu() => MenuAnchor(
    menuChildren: [
      for (final e in {
        'document': '文档',
        if (widget.onDiscuss != null) ...{
          '图像': '图像',
          '电子表格': '电子表格',
          '演示文稿': '演示文稿',
        },
        'folder': '文件夹',
        'upload': '上传文件',
      }.entries)
        MenuItemButton(onPressed: () => _create(e.key), child: text(e.value)),
    ],
    builder: (context, menu, _) => Tooltip(
      message: mobileText(context, '新建'),
      child: FilledButton(
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 10),
        ),
        onPressed: busy ? null : () => menu.isOpen ? menu.close() : menu.open(),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [text('新建'), const Icon(Icons.arrow_drop_down, size: 18)],
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    if (invalidated) return identityNotice;
    final folders = capabilityRows(_data?['folders'])
        .where(
          (f) =>
              const {'all', 'folders', 'favorites'}.contains(_scope) &&
              (_showHidden || !(f['name'] ?? '').toString().startsWith('.')) &&
              (_kind == 'all' || _kind == 'folder'),
        )
        .toList();
    if (_remote &&
        _trail.isEmpty &&
        _search.text.trim().isEmpty &&
        widget.saveFile == null &&
        const {'all', 'folders'}.contains(_scope) &&
        (_kind == 'folder' || _kind == 'all') &&
        _data != null) {
      folders.insert(0, {'id': '', 'name': '历史服务器资料', 'historyRoot': true});
    }
    final items =
        _scope == 'folders' || _kind == 'folder' || widget.saveFile != null
        ? <Map<String, dynamic>>[]
        : capabilityRows(_data?['items']).where((r) {
            final extra = r['extra'];
            final hidden =
                (extra is Map ? extra['hidden'] : r['hidden']) ??
                (r['filename'] ?? '').toString().startsWith('.');
            final type = r['kind'];
            final image =
                type == 'image' ||
                (r['contentType'] ?? '').toString().startsWith('image/');
            return (_scope == 'trash' || _showHidden || hidden != true) &&
                (_scope != 'images' || image) &&
                (_scope != 'favorites' || r['favorite'] == true) &&
                (_kind == 'all' ||
                    (_kind == 'image'
                        ? image
                        : _kind == 'document'
                        ? type == 'note' || type == 'document'
                        : type == _kind));
          }).toList();
    int recent(Map row) =>
        DateTime.tryParse(
          (row['updatedAt'] ?? row['createdAt'] ?? row['deletedAt'] ?? '')
              .toString(),
        )?.millisecondsSinceEpoch ??
        0;
    folders.sort((a, b) => recent(b).compareTo(recent(a)));
    items.sort((a, b) => recent(b).compareTo(recent(a)));
    final visible = {
      for (final r in [...folders, ...items])
        if (r['historyRoot'] != true) r['id'].toString(),
    };
    _selected.retainAll(visible);
    Widget folderCard(Map<String, dynamic> f) {
      final historyRoot = f['historyRoot'] == true;
      return LibraryEntryTile(
        grid: _grid,
        name: f['name']?.toString() ?? '文件夹',
        info: historyRoot
            ? '旧版资料'
            : mobileText(context, '{0} 份资料', values: [f['itemCount'] ?? 0]),
        date: _modifiedLabel(f),
        leading: _selecting && !historyRoot
            ? _checkBox(f)
            : Icon(historyRoot ? Icons.history : Icons.folder_outlined),
        trailing:
            widget.pick ||
                widget.saveFile != null ||
                _selecting ||
                _history ||
                historyRoot
            ? const Icon(Icons.chevron_right)
            : PopupMenuButton<String>(
                enabled: !busy,
                tooltip: '文件夹操作',
                onSelected: (value) => _folderAction(f, value),
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'share', child: Text('分享文件夹')),
                  const PopupMenuItem(value: 'rename', child: Text('重命名')),
                  PopupMenuItem(
                    value: 'favorite',
                    child: text(f['favorite'] == true ? '取消收藏' : '收藏'),
                  ),
                  const PopupMenuItem(value: 'delete', child: Text('删除空文件夹')),
                ],
              ),
        onTap: busy ? null : () => _openFolder(f),
      );
    }

    Widget itemCard(Map<String, dynamic> item) {
      final icon = item['isDeleted'] == true
          ? Icons.delete_outline
          : item['kind'] == 'image'
          ? Icons.image_outlined
          : Icons.description_outlined;
      return LibraryEntryTile(
        grid: _grid,
        name: libraryDisplayName(item),
        date: _modifiedLabel(item),
        info: [
          librarySourceLabel(item),
          _sizeLabel(item['size']),
        ].where((s) => s.isNotEmpty).join(' · '),
        leading: _selecting
            ? _checkBox(item)
            : icon == Icons.image_outlined && item['favorite'] != true
            ? LibraryImageThumbnail(
                key: ValueKey((library, item['id'], item['updatedAt'])),
                library: library,
                item: item,
              )
            : Icon(item['favorite'] == true ? Icons.star : icon),
        trailing: widget.pick || _selecting
            ? const Icon(Icons.chevron_right)
            : LibraryFileMenu(
                desktop: _location.desktop,
                history: _history,
                canCopy: _remoteTarget != null,
                canDiscuss: widget.onDiscuss != null,
                canSource: widget.onSource != null,
                item: item,
                enabled: !busy,
                onSelected: (action) => _rowCommand(action, item),
              ),
        onTap: busy
            ? null
            : _selecting
            ? () => _toggle(item)
            : () => _item(item),
      );
    }

    final toolbar = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          children: [
            ChoiceChip(
              label: text('本地存储'),
              selected: !_remote,
              onSelected: busy
                  ? null
                  : (_) {
                      if (_remote && _lastComputer != null) {
                        _enterLocation(_lastComputer!);
                      } else {
                        _choose();
                      }
                    },
            ),
            Tooltip(
              message: _remoteMessage,
              child: ChoiceChip(
                label: text('远程存储'),
                selected: _remote,
                onSelected: busy || _remoteTarget == null
                    ? null
                    : (_) => _enterLocation(_remoteTarget!),
              ),
            ),
          ],
        ),
        LocationSwitchRow(
          icon: _remote ? Icons.cloud_outlined : Icons.computer_outlined,
          label: _location.desktop
              ? _location.label
              : _remote
              ? _remoteMessage
              : mobileText(context, '选择资料位置'),
          maxLines: _remote ? 2 : 1,
          onTap: busy ? null : _choose,
        ),
        if (_hasLocation) ...[
          if (widget.saveFile != null && !_history)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('保存 ${widget.saveFile!.filename}'),
                    const SizedBox(height: 8),
                    FilledButton.icon(
                      onPressed: busy ? null : _saveHere,
                      icon: const Icon(Icons.save_outlined),
                      label: const Text('保存到当前文件夹'),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              IconButton(
                tooltip: _grid ? '切换为列表视图' : '切换为网格视图',
                icon: Icon(
                  _grid ? Icons.view_list_outlined : Icons.grid_view_outlined,
                ),
                onPressed: () {
                  setState(() => _grid = !_grid);
                  _savePref('grid', _grid);
                },
              ),
              Expanded(
                child: TextField(
                  controller: _search,
                  maxLength: 120,
                  decoration: InputDecoration(
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(vertical: 9),
                    prefixIconConstraints: const BoxConstraints(minWidth: 32),
                    prefixIcon: const Icon(Icons.search, size: 18),
                    hintText: mobileText(context, '搜索资料'),
                    counterText: '',
                  ),
                  onChanged: (_) {
                    _debounce?.cancel();
                    _debounce = Timer(const Duration(milliseconds: 350), _load);
                  },
                ),
              ),
              if (!widget.pick &&
                  widget.saveFile == null &&
                  _scope != 'trash' &&
                  !_history) ...[
                const SizedBox(width: 6),
                _createMenu(),
              ],
              PopupMenuButton<String>(
                tooltip: '筛选与显示',
                icon: const Icon(Icons.tune),
                enabled: !busy,
                onSelected: (v) {
                  if (v == 'trash') {
                    _enterScope(v);
                    return;
                  }
                  setState(() {
                    _clearSelection();
                    if (v == 'hidden') {
                      _showHidden = !_showHidden;
                      _savePref('hidden', _showHidden);
                    } else {
                      _kind = v;
                      if (v == 'folder' &&
                          !const {
                            'folders',
                            'all',
                            'favorites',
                          }.contains(_scope)) {
                        _scope = 'folders';
                        _data = null;
                        _load();
                      }
                    }
                  });
                },
                itemBuilder: (_) => [
                  for (final e in const {
                    'all': '全部类型',
                    'document': '文档',
                    'image': '图像',
                    'folder': '文件夹',
                    'spreadsheet': '电子表格',
                    'presentation': '演示文稿',
                  }.entries)
                    CheckedPopupMenuItem(
                      value: e.key,
                      checked: _kind == e.key,
                      child: Text(e.value),
                    ),
                  const PopupMenuDivider(),
                  CheckedPopupMenuItem(
                    value: 'hidden',
                    checked: _showHidden,
                    child: const Text('显示隐藏资料'),
                  ),
                  if (!widget.pick && widget.saveFile == null)
                    const PopupMenuItem(
                      value: 'trash',
                      child: Row(
                        children: [
                          Icon(Icons.delete_outline, size: 20),
                          SizedBox(width: 12),
                          Text('回收站'),
                        ],
                      ),
                    ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (final entry in const {
                        'recommended': '推荐',
                        'favorites': '收藏',
                        'folders': '文件夹',
                        'images': '图像',
                        'all': '全部',
                      }.entries)
                        Padding(
                          padding: const EdgeInsets.only(right: 4),
                          child: ChoiceChip(
                            label: text(entry.value),
                            selected: _scope == entry.key,
                            showCheckmark: false,
                            visualDensity: VisualDensity.compact,
                            labelPadding: const EdgeInsets.symmetric(
                              horizontal: 3,
                            ),
                            onSelected: busy
                                ? null
                                : (_) => _enterScope(entry.key),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              if (!widget.pick && widget.saveFile == null && _scope != 'trash')
                TextButton.icon(
                  onPressed: busy
                      ? null
                      : () => setState(() {
                          _selected.clear();
                          _selecting = !_selecting;
                        }),
                  icon: const Icon(Icons.checklist),
                  label: text(_selecting ? '取消选择' : '选择'),
                ),
            ],
          ),
          if (_scope == 'trash')
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Text(
                '回收站',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          if (_selecting) ...[
            Wrap(
              children: [
                TextButton(
                  onPressed: busy
                      ? null
                      : () => setState(() {
                          if (_selected.containsAll(visible)) {
                            _selected.clear();
                          } else {
                            _selected.addAll(visible);
                          }
                        }),
                  child: text('全选'),
                ),
                for (final action in [
                  '分享',
                  if (widget.onDiscuss != null) '对话',
                  if (_location.desktop && _remoteTarget != null) '存储到远程',
                  '移入回收站',
                ])
                  TextButton(
                    onPressed:
                        busy ||
                            _selected.isEmpty ||
                            (action != '分享' &&
                                folders.any((r) => _selected.contains(r['id'])))
                        ? null
                        : () => _batch(
                            action,
                            items
                                .where((r) => _selected.contains(r['id']))
                                .toList(),
                            folders
                                .where((r) => _selected.contains(r['id']))
                                .toList(),
                          ),
                    child: text(action),
                  ),
              ],
            ),
          ],
          if (_trail.isNotEmpty && _scope == 'all')
            ListTile(
              leading: const Icon(Icons.arrow_back),
              title: Text(_trail.last['name']?.toString() ?? ''),
              subtitle: text('返回上一级'),
              onTap: busy
                  ? null
                  : () {
                      setState(() {
                        _clearSelection();
                        _library = null;
                        _trail.removeLast();
                        if (_trail.isEmpty) _scope = _folderOrigin;
                        _data = null;
                      });
                      _load();
                    },
            ),
        ],
      ],
    );
    final results = RefreshIndicator(
      onRefresh: _refreshView,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 16),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          ...feedback,
          if (_hasLocation) ...[
            if (_scope == 'trash' && !widget.pick)
              TextButton.icon(
                icon: const Icon(Icons.delete_forever),
                label: const Text('清空回收站'),
                onPressed: busy
                    ? null
                    : () async {
                        if (!_location.desktop && _location.storage.isEmpty) {
                          await _choose();
                          return;
                        }
                        if (!await confirm('永久清空回收站？', '此操作不可恢复，仅清空当前存储位置。')) {
                          return;
                        }
                        var partial = false;
                        await perform((_) async {
                          final result = await library.call('emptyTrash');
                          partial = result['partial'] == true;
                        });
                        if (current && error.isEmpty) {
                          await _load();
                          if (current && partial) {
                            setState(() => error = '部分资料未能删除，请查看回收站后重试。');
                          }
                        }
                      },
              ),
            if (error.isNotEmpty)
              TextButton.icon(
                onPressed: busy ? null : _load,
                icon: const Icon(Icons.refresh),
                label: text('刷新'),
              ),
            if (_data != null &&
                folders.isEmpty &&
                items.isEmpty &&
                !busy &&
                error.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 40),
                child: Center(
                  child: text(
                    _scope == 'folders' || widget.saveFile != null
                        ? '这里还没有文件夹'
                        : '这里还没有资料',
                  ),
                ),
              ),
            if (_grid)
              ..._gridRows([
                for (final folder in folders) folderCard(folder),
                for (final item in items) itemCard(item),
              ], MediaQuery.sizeOf(context).width >= 672 ? 3 : 2)
            else ...[
              for (final folder in folders) folderCard(folder),
              for (final item in items) itemCard(item),
            ],
            if (items.length >= 500 || folders.length >= 500)
              text('当前最多显示 500 项，请使用搜索缩小范围。'),
          ],
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: LayoutBuilder(
        builder: (context, bounds) => Column(
          children: [
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: bounds.maxHeight * 0.78),
              child: SingleChildScrollView(primary: false, child: toolbar),
            ),
            const SizedBox(height: 16),
            Expanded(child: results),
          ],
        ),
      ),
    );
  }
}

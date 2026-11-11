import '../ui/mobile_select_field.dart';
import '../ui/mobile_display_preferences.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_sheet.dart';
import '../ui/mobile_theme.dart';

class MemoriesScreen extends StatefulWidget {
  const MemoriesScreen({super.key});
  @override
  State<MemoriesScreen> createState() => _MemoriesScreenState();
}

class _MemoriesScreenState extends State<MemoriesScreen> {
  MobileState? _state;
  int _identity = -1, _request = 0;
  final _search = TextEditingController();
  String _scope = '', _error = '';
  bool _archived = false, _loading = true, _hasMore = false;
  List<Map<String, dynamic>> _items = [];
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state != state || _identity != state.identityRevision) {
      _state = state;
      _identity = state.identityRevision;
      _items = [];
      _search.clear();
      _scope = '';
      _archived = false;
      _load();
    }
  }

  bool _current(int identity, int request) =>
      mounted &&
      _identity == identity &&
      _state?.identityRevision == identity &&
      _request == request;
  Future<void> _load({bool more = false}) async {
    final state = _state!, identity = _identity, request = ++_request;
    final offset = more ? _items.length : 0;
    setState(() {
      _loading = true;
      _error = '';
      if (!more) _items = [];
    });
    try {
      final data = await state.api.memoryRecords(
        scope: _scope,
        search: _search.text.trim(),
        archived: _archived,
        offset: offset,
      );
      if (!_current(identity, request)) return;
      if (data['items'] is! List) {
        throw const FormatException('invalid memory list');
      }
      final items = (data['items'] as List)
          .map((r) => Map<String, dynamic>.from(r as Map))
          .toList();
      setState(() {
        _items = [...(more ? _items : <Map<String, dynamic>>[]), ...items];
        _hasMore = data['hasMore'] == true;
      });
    } catch (e) {
      if (_current(identity, request)) setState(() => _error = _memoryError(e));
    } finally {
      if (_current(identity, request)) setState(() => _loading = false);
    }
  }

  Future<void> _open([Map<String, dynamic>? row]) async {
    final identity = _identity;
    final changed = await showMobileSheet<bool>(
      context,
      title: row == null ? '添加记忆' : '记忆详情',
      builder: (_, scroll) => _MemoryEditor(
        scroll: scroll,
        id: row?['id']?.toString(),
        identity: identity,
      ),
    );
    if (mounted && _state?.identityRevision == identity && changed == true) {
      await _load();
    }
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 12, 14),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  mobileText(context, '管理账号已保存的摘要记忆'),
                  style: TextStyle(color: theme.inkMuted, fontSize: 13),
                ),
              ),
              IconButton(
                tooltip: mobileText(context, '添加记忆'),
                onPressed: _loading ? null : _open,
                icon: const Icon(CupertinoIcons.plus),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: TextField(
            controller: _search,
            maxLength: 120,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _load(),
            decoration: InputDecoration(
              hintText: mobileText(context, '搜索记忆标题'),
              counterText: '',
              prefixIcon: const Icon(CupertinoIcons.search),
              suffixIcon: IconButton(
                tooltip: mobileText(context, '搜索记忆'),
                onPressed: _loading ? null : () => _load(),
                icon: const Icon(CupertinoIcons.arrow_right),
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 6),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final item in const [
                  ('', '全部'),
                  ('session', '会话'),
                  ('workspace', '工作区'),
                  ('project', '项目'),
                ])
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(item.$2),
                      selected: _scope == item.$1,
                      onSelected: (_) {
                        setState(() => _scope = item.$1);
                        _load();
                      },
                    ),
                  ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  mobileText(context, '包含已归档记忆'),
                  style: TextStyle(color: theme.inkMuted, fontSize: 13),
                ),
              ),
              Switch(
                value: _archived,
                onChanged: (v) {
                  setState(() => _archived = v);
                  _load();
                },
              ),
            ],
          ),
        ),
        if (_loading) const LinearProgressIndicator(),
        Expanded(
          child: ListView(
            controller: MobileSheetScope.maybeOf(context)?.scrollController,
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 30),
            children: [
              if (_error.isNotEmpty) ...[
                Text(mobileText(context, _error)),
                TextButton(
                  onPressed: () => _load(),
                  child: Text(mobileText(context, '重试')),
                ),
              ],
              if (!_loading && _error.isEmpty && _items.isEmpty) ...[
                const SizedBox(height: 54),
                Icon(CupertinoIcons.book, size: 34, color: theme.inkMuted),
                const SizedBox(height: 18),
                Center(child: Text(mobileText(context, '还没有匹配的记忆'))),
              ],
              for (final row in _items)
                ListTile(
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  leading: const Icon(CupertinoIcons.book),
                  title: Text('${row['title'] ?? '未命名记忆'}'),
                  subtitle: Text(
                    '${_scopeLabel(row['scope'])}${row['archived'] == true ? ' · 已归档' : ''}\n${row['summary'] ?? ''}',
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
                  trailing: const Icon(CupertinoIcons.chevron_right, size: 15),
                  onTap: () => _open(row),
                ),
              if (_hasMore && _error.isEmpty)
                TextButton(
                  onPressed: _loading ? null : () => _load(more: true),
                  child: Text(mobileText(context, '加载更多记忆')),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _MemoryEditor extends StatefulWidget {
  final ScrollController scroll;
  final String? id;
  final int identity;
  const _MemoryEditor({required this.scroll, required this.identity, this.id});
  @override
  State<_MemoryEditor> createState() => _MemoryEditorState();
}

class _MemoryEditorState extends State<_MemoryEditor> {
  final _title = TextEditingController();
  final _fields = <String, TextEditingController>{};
  final _dimensionKey = TextEditingController();
  Map<String, dynamic> _row = {};
  String _scope = 'session', _error = '';
  MobileState? _state;
  bool _loading = true, _saving = false, _started = false, _revoked = false;
  bool get _current =>
      mounted && !_revoked && _state?.identityRevision == widget.identity;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _state = MobileScope.of(context);
    if (_state!.identityRevision != widget.identity) {
      _revoked = true;
      _title.clear();
      _dimensionKey.clear();
      for (final c in _fields.values) {
        c.clear();
      }
      _row = {};
      return;
    }
    if (!_started) {
      _started = true;
      _load();
    }
  }

  Future<void> _load() async {
    if (widget.id == null) {
      _fields['summary'] = TextEditingController();
      _loading = false;
      return;
    }
    try {
      final data = await _state!.api.memoryRecord(widget.id!);
      if (!_current) return;
      final row = Map<String, dynamic>.from(data['item'] as Map);
      final fields = Map<String, dynamic>.from(row['fields'] as Map);
      if (fields.isEmpty ||
          fields.length > 16 ||
          fields.values.any((v) => v is! String)) {
        throw const FormatException('invalid fields');
      }
      setState(() {
        _row = row;
        _title.text = '${row['title'] ?? ''}';
        _scope = '${row['scope'] ?? 'session'}';
        for (final entry in fields.entries) {
          _fields[entry.key] = TextEditingController(text: entry.value);
        }
      });
    } catch (e) {
      if (_current) setState(() => _error = _memoryError(e));
    } finally {
      if (_current) setState(() => _loading = false);
    }
  }

  Future<void> _action(String action) async {
    if (!_current || _saving) return;
    final state = _state!;
    if (action == 'delete') {
      final yes = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(mobileText(context, '删除这条记忆？')),
          content: Text(mobileText(context, '将从账号中永久删除这份摘要，无法恢复。原会话记录会保留。')),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(mobileText(context, '取消')),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(mobileText(context, '删除记忆')),
            ),
          ],
        ),
      );
      if (yes != true || !_current) return;
    }
    if (action == 'save' &&
        (_title.text.trim().isEmpty ||
            _fields.values.every((c) => c.text.trim().isEmpty))) {
      setState(() => _error = '请填写标题和记忆内容');
      return;
    }
    if (widget.id == null &&
        _scope != 'session' &&
        _dimensionKey.text.trim().isEmpty) {
      setState(() => _error = '请填写该工作区或项目在PC端的记忆标识');
      return;
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    try {
      if (action == 'save') {
        final key = widget.id == null
            ? (_scope == 'session'
                  ? 'mobile-memory-${DateTime.now().microsecondsSinceEpoch}'
                  : _dimensionKey.text.trim())
            : _row['key'];
        await state.api.saveMemoryRecord(widget.id, {
          'title': _title.text.trim(),
          'fields': {
            for (final e in _fields.entries) e.key: e.value.text.trim(),
          },
          'scope': _scope,
          'key': key,
          'confirmed': true,
          'revision': _row['revision'] ?? 1,
          if (widget.id == null && _scope == 'workspace') 'workspaceKey': key,
          if (widget.id == null && _scope == 'project') 'projectKey': key,
        });
      } else {
        await state.api.memoryRecordAction(widget.id!, action);
      }
      if (mounted && _current) Navigator.pop(context, true);
    } catch (e) {
      if (_current) setState(() => _error = _memoryError(e));
    } finally {
      if (_current) setState(() => _saving = false);
    }
  }

  @override
  void dispose() {
    _title.dispose();
    _dimensionKey.dispose();
    for (final c in _fields.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    if (!_current) {
      return Center(child: Text(mobileText(context, '账号已切换，请关闭后重新打开记忆。')));
    }
    return ListView(
      controller: widget.scroll,
      padding: EdgeInsets.fromLTRB(
        22,
        8,
        22,
        MediaQuery.viewInsetsOf(context).bottom + 28,
      ),
      children: [
        if (_loading) const LinearProgressIndicator(),
        if (_error.isNotEmpty && _fields.isEmpty) ...[
          Text(
            mobileText(context, _error),
            style: TextStyle(color: theme.inkSecondary),
          ),
          if (_fields.isEmpty && !_loading)
            TextButton(
              onPressed: () {
                setState(() {
                  _error = '';
                  _loading = true;
                });
                _load();
              },
              child: Text(mobileText(context, '重新读取')),
            ),
        ],
        if (!_loading && _fields.isNotEmpty) ...[
          TextField(
            controller: _title,
            enabled: !_saving,
            maxLength: 240,
            decoration: InputDecoration(labelText: mobileText(context, '标题')),
          ),
          const SizedBox(height: 12),
          if (widget.id == null)
            MobileSelectField<String>(
              initialValue: _scope,
              items: [
                for (final scope in ['session', 'workspace', 'project'])
                  DropdownMenuItem(
                    value: scope,
                    child: Text(_scopeLabel(scope)),
                  ),
              ],
              onChanged: _saving ? null : (v) => setState(() => _scope = v!),
              decoration: InputDecoration(
                labelText: mobileText(context, '记忆范围'),
              ),
            )
          else
            Text(
              '${_scopeLabel(_scope)} · ${_row['archived'] == true ? '已归档' : '当前记忆'}',
              style: TextStyle(color: theme.inkMuted),
            ),
          if (widget.id == null && _scope != 'session') ...[
            const SizedBox(height: 14),
            TextField(
              controller: _dimensionKey,
              enabled: !_saving,
              maxLength: 240,
              decoration: InputDecoration(
                labelText: mobileText(context, 'PC端记忆标识'),
                helperText: mobileText(context, '精确标识用于关联，项目名称不能替代标识'),
              ),
            ),
          ],
          for (final entry in _fields.entries) ...[
            const SizedBox(height: 18),
            TextField(
              controller: entry.value,
              enabled: !_saving,
              minLines: 4,
              maxLines: 12,
              maxLength: 6000,
              decoration: InputDecoration(labelText: _fieldLabel(entry.key)),
            ),
          ],
          const SizedBox(height: 10),
          if (_error.isNotEmpty)
            Semantics(
              liveRegion: true,
              child: Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  _error,
                  style: TextStyle(color: theme.inkSecondary),
                ),
              ),
            ),
          Text(mobileText(context, '保存前请核对内容。只保存你确认的摘要，不会修改原会话。')),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _saving ? null : () => _action('save'),
            child: Text(
              _saving
                  ? mobileText(context, '正在保存…')
                  : mobileText(context, '确认并保存'),
            ),
          ),
          if (widget.id != null) ...[
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: _saving
                  ? null
                  : () => _action(
                      _row['archived'] == true ? 'restore' : 'archive',
                    ),
              child: Text(
                _row['archived'] == true
                    ? mobileText(context, '恢复记忆')
                    : mobileText(context, '归档记忆'),
              ),
            ),
            TextButton(
              onPressed: _saving ? null : () => _action('delete'),
              child: Text(mobileText(context, '删除记忆')),
            ),
          ],
        ],
      ],
    );
  }
}

String _scopeLabel(dynamic value) => switch (value) {
  'workspace' => '工作区记忆',
  'project' => '项目记忆',
  _ => '会话记忆',
};
String _memoryError(Object e) => e is ApiFailure
    ? switch (e.status) {
        404 => '当前服务尚未提供这项记忆，或记录已移除，请确认后台版本后重试。',
        409 => '记忆已在其他设备更新，请关闭详情并重新读取后编辑。',
        401 || 403 => '登录或权限已失效，请重新登录后打开记忆。',
        _ => e.message,
      }
    : '记忆暂时无法读取或保存，请重试。';

String _fieldLabel(String key) => switch (key) {
  'summary' => '记忆内容',
  'decisions' => '已确认的决定',
  'facts' => '已知事实',
  'constraints' => '约束与偏好',
  'nextSteps' => '下一步',
  'context' => '背景',
  'preferences' => '偏好',
  _ => key,
};

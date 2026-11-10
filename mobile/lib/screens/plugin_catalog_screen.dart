import '../ui/pinned_list_layout.dart';
import '../ui/mobile_input_border.dart';
import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../core/plugin_presentation.dart';
import '../core/plugin_publication.dart';
import 'plugin_submission_screen.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_theme.dart';
import 'plugin_builder_screen.dart';
import 'plugin_installation_screen.dart';
import 'plugin_package_screen.dart';

class PluginCatalogScreen extends StatefulWidget {
  final VoidCallback? onConversationCreate;
  final bool marketOnly;
  const PluginCatalogScreen({
    super.key,
    this.onConversationCreate,
    this.marketOnly = false,
  });
  @override
  State<PluginCatalogScreen> createState() => _PluginCatalogScreenState();
}

class _PluginCatalogScreenState extends State<PluginCatalogScreen> {
  MobileState? _state;
  int? _identity;
  int _generation = 0;
  bool _loading = true;
  String _error = '';
  String _query = '';
  final _search = TextEditingController();
  int _tab = 0;
  List<Map<String, dynamic>> _items = [];
  List<Map<String, dynamic>> _submissions = [];
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (!identical(state, _state)) {
      _state?.removeListener(_changed);
      _items = [];
      _submissions = [];
      _state = state;
      _identity = state.identityRevision;
      state.addListener(_changed);
      _load();
    }
  }

  @override
  void dispose() {
    _state?.removeListener(_changed);
    _search.dispose();
    super.dispose();
  }

  void _changed() {
    if (_identity == _state?.identityRevision || !mounted) return;
    _identity = _state!.identityRevision;
    _query = '';
    _search.clear();
    _items = [];
    _submissions = [];
    _load();
  }

  List<Map<String, dynamic>> _rows(dynamic value) => value is List
      ? value.whereType<Map>().map((v) => Map<String, dynamic>.from(v)).toList()
      : [];
  Future<void> _load() async {
    final state = _state!;
    final generation = ++_generation;
    final identity = state.identityRevision;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final result = await state.api.pluginCatalog();
      if (!mounted ||
          generation != _generation ||
          identity != state.identityRevision) {
        return;
      }
      setState(() {
        _items = _rows(result['items']);
        _submissions = _rows(result['submissions']);
      });
    } catch (error) {
      if (mounted &&
          generation == _generation &&
          identity == state.identityRevision) {
        setState(
          () => _error = error is ApiFailure ? error.message : '插件目录未能加载，请重试。',
        );
      }
    } finally {
      if (mounted && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _open(Widget page, {bool showSavedSubmission = false}) async {
    final owner = _state!;
    final identity = owner.identityRevision;
    final result = await Navigator.of(
      context,
    ).push<Object?>(MaterialPageRoute(builder: (_) => page));
    if (!mounted ||
        !identical(owner, _state) ||
        identity != owner.identityRevision) {
      return;
    }
    final saved =
        showSavedSubmission &&
        result is Map &&
        result['ok'] == true &&
        result['plugin'] is Map &&
        (result['plugin'] as Map)['id']?.toString().isNotEmpty == true;
    if (saved) {
      setState(() {
        _tab = 2;
        _query = '';
        _search.clear();
      });
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('插件已保存，可在“我的提交”查看审核状态。')));
    }
    await _load();
  }

  String _status(Map<String, dynamic> row) {
    if (_tab == 2) return PluginPublication(row).status;
    if (row['updateAvailable'] == true) return '有更新';
    if (row['installed'] == true) return '已安装';
    return '未安装';
  }

  Widget _card(Map<String, dynamic> row) {
    final policy = row['marketPolicy'] is Map
        ? row['marketPolicy'] as Map
        : const {};
    final permissions = row['permissions'] is Map
        ? row['permissions'] as Map
        : const {};
    final canManage =
        _tab != 2 &&
        (row['installed'] == true ||
            (permissions['canUse'] == true &&
                policy['installation'] != 'not_available'));
    final note = _tab == 2
        ? (row['reviewNote']?.toString().trim().isNotEmpty == true
              ? row['reviewNote'].toString()
              : PluginPublication(row).current.detail)
        : row['description']?.toString() ?? '';
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      color: context.soduWorkTheme.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: context.soduWorkTheme.line),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    color: context.soduWorkTheme.primarySoft,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(
                    Icons.extension_outlined,
                    color: context.soduWorkTheme.primary,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    row['name']?.toString() ?? '未命名插件',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
              ],
            ),
            if (note.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(
                  note,
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: context.soduWorkTheme.inkSecondary,
                    height: 1.4,
                  ),
                ),
              ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  _status(row),
                  style: TextStyle(
                    color: context.soduWorkTheme.primary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  'v${row['version'] ?? ''}',
                  style: TextStyle(color: context.soduWorkTheme.inkMuted),
                ),
                if (_tab == 2)
                  OutlinedButton.icon(
                    onPressed: _loading
                        ? null
                        : () => _open(PluginSubmissionScreen(item: row)),
                    icon: const Icon(Icons.chevron_right),
                    label: const Text('查看审核进度'),
                  ),
                if (canManage)
                  OutlinedButton(
                    onPressed: _loading
                        ? null
                        : () => _open(PluginInstallationScreen(item: row)),
                    child: Text(row['installed'] == true ? '管理与设置' : '查看并安装'),
                  ),
              ],
            ),
            if (_tab != 2 &&
                row['installed'] == true &&
                (row['conversationEntrypoints'] is Map &&
                    (row['conversationEntrypoints'] as Map)['conversation'] ==
                        true))
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  '已安装到账号；普通插件对话请在电脑端使用。手机可使用企业已配置的工作流。',
                  style: TextStyle(
                    color: context.soduWorkTheme.inkMuted,
                    fontSize: 12,
                  ),
                ),
              ),
            if (_tab != 2 && !canManage)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('此插件按企业配置用于需求或自动化。'),
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final source = _tab == 2 ? _submissions : _items;
    final rows = source
        .where(
          (row) =>
              !isWorkspaceApplication(row) &&
              (!widget.marketOnly ||
                  (row['personal'] != true && row['listed'] != false)) &&
              (_tab != 1 || row['installed'] == true) &&
              '${row['name'] ?? ''} ${row['description'] ?? ''} ${row['version'] ?? ''}'
                  .toLowerCase()
                  .contains(_query.toLowerCase()),
        )
        .toList();
    return PinnedListLayout(
      onRefresh: _load,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      header: [
        if (!widget.marketOnly)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton.icon(
                onPressed: widget.onConversationCreate,
                icon: const Icon(Icons.auto_awesome_outlined),
                label: const Text('对话制作'),
              ),
              OutlinedButton.icon(
                onPressed: () => _open(
                  PluginBuilderScreen(
                    onConversationCreate: widget.onConversationCreate == null
                        ? null
                        : () {
                            Navigator.of(context).pop();
                            widget.onConversationCreate!();
                          },
                  ),
                  showSavedSubmission: true,
                ),
                icon: const Icon(Icons.edit_note),
                label: const Text('编辑草稿'),
              ),
              TextButton.icon(
                onPressed: () => _open(const PluginPackageScreen()),
                icon: const Icon(Icons.file_open_outlined),
                label: const Text('导入插件'),
              ),
            ],
          ),
        const SizedBox(height: 8),
        Text(
          '这里显示企业授权的插件；电脑本机的内置和个人插件不在此列表。提交的草稿可在“我的提交”跟进审核。',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 16),
        TextField(
          controller: _search,
          onChanged: (value) => setState(() => _query = value),
          decoration: InputDecoration(
            prefixIcon: const Icon(Icons.search),
            hintText: '搜索名称或用途',
            suffixIcon: _query.isEmpty
                ? null
                : IconButton(
                    tooltip: '清空搜索',
                    icon: const Icon(Icons.close_rounded),
                    onPressed: () => setState(() {
                      _query = '';
                      _search.clear();
                    }),
                  ),
            border: const MobileInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          children: [
            for (final item in [
              (0, '全部'),
              (1, '已安装'),
              if (!widget.marketOnly) (2, '我的提交'),
            ])
              ChoiceChip(
                label: Text(item.$2),
                selected: _tab == item.$1,
                onSelected: (_) => setState(() => _tab = item.$1),
              ),
          ],
        ),
      ],
      children: [
        if (_loading)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator()),
          ),
        if (_error.isNotEmpty)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  Text(_error),
                  TextButton(onPressed: _load, child: const Text('重新加载')),
                ],
              ),
            ),
          ),
        if (!_loading && _error.isEmpty && rows.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 32),
            child: Column(
              children: [
                Icon(
                  Icons.extension_outlined,
                  size: 40,
                  color: context.soduWorkTheme.inkMuted,
                ),
                const SizedBox(height: 12),
                Text(
                  _query.isNotEmpty
                      ? '没有匹配的插件'
                      : _tab == 2
                      ? '还没有提交记录'
                      : _tab == 1
                      ? '还没有安装插件'
                      : '当前账号暂无已授权的插件',
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ...rows.map(_card),
      ],
    );
  }
}

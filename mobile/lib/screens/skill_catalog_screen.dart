import '../ui/pinned_list_layout.dart';
import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../ui/capability_widgets.dart';
import 'skill_editor_screen.dart';
import 'skill_detail_screen.dart';

class SkillCatalogScreen extends StatefulWidget {
  const SkillCatalogScreen({super.key});
  @override
  State<SkillCatalogScreen> createState() => _SkillCatalogScreenState();
}

class _SkillCatalogScreenState extends CapabilityState<SkillCatalogScreen> {
  List<Map<String, dynamic>> _rows = [];
  final _search = TextEditingController();
  bool _enabledOnly = false;
  bool _loaded = false;
  @override
  void initialize() {
    _load();
  }

  Future<void> _load({bool refresh = false}) => perform((api) async {
    final result = await (refresh
        ? api.refreshSkills()
        : api.capabilityCatalog());
    if (!current) return;
    setState(() {
      _rows = capabilityRows(result['skills']);
      _loaded = true;
      receipt = result['refreshWarning']?.toString() ?? '';
    });
  });

  Future<void> _toggle(Map<String, dynamic> row, bool enabled) => perform((
    api,
  ) async {
    // Read the complete selection first, preserving unrelated and hidden skills.
    final latest = await api.workSkillCatalog();
    if (!current) return;
    final name = row['name'].toString();
    if (!capabilityRows(latest['skills']).any((item) => item['name'] == name)) {
      throw const ApiFailure('技能权限已变化，请刷新目录后重试。');
    }
    final selected = (latest['enabled'] as List? ?? [])
        .whereType<String>()
        .toSet();
    if (enabled) {
      selected.add(name);
    } else {
      selected.remove(name);
    }
    final result = await api.saveSkillSelection(selected.toList());
    if (!current) return;
    if (result['ok'] != true || result['enabled'] is! List) {
      throw const ApiFailure('未收到保存回执，请刷新目录核对。');
    }
    final accepted = (result['enabled'] as List).contains(name);
    setState(() {
      for (final item in _rows) {
        item['enabled'] = (result['enabled'] as List).contains(item['name']);
      }
      receipt = accepted == enabled
          ? '选择已保存，下次任务按实际权限生效。'
          : '服务端未接受此选择，请刷新目录核对权限。';
    });
  });

  Future<void> _open(Widget screen) async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
    if (current) await _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (invalidated) return identityNotice;
    final query = _search.text.trim().toLowerCase();
    final rows = _rows
        .where(
          (row) =>
              (!_enabledOnly || row['enabled'] == true) &&
              '${row['name']} ${row['description']} ${row['source']} ${row['version']}'
                  .toLowerCase()
                  .contains(query),
        )
        .toList();
    return PinnedListLayout(
      onRefresh: _load,
      header: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton.icon(
              onPressed: busy ? null : () => _open(const SkillEditorScreen()),
              icon: const Icon(Icons.add),
              label: text('创建技能'),
            ),
            OutlinedButton.icon(
              onPressed: busy
                  ? null
                  : () => _open(const SkillEditorScreen(importing: true)),
              icon: const Icon(Icons.file_open_outlined),
              label: text('导入技能'),
            ),
            TextButton.icon(
              onPressed: busy ? null : () => _load(refresh: true),
              icon: const Icon(Icons.refresh),
              label: text('刷新目录'),
            ),
          ],
        ),
        const CapabilityScopeNote(),
        TextField(
          controller: _search,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            label: text('搜索技能或来源'),
            prefixIcon: const Icon(Icons.search),
            suffixIcon: _search.text.isEmpty
                ? null
                : IconButton(
                    tooltip: '清空搜索',
                    onPressed: () => setState(_search.clear),
                    icon: const Icon(Icons.close),
                  ),
          ),
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: FilterChip(
            label: text('仅已启用'),
            selected: _enabledOnly,
            onSelected: (value) => setState(() => _enabledOnly = value),
          ),
        ),
      ],
      children: [
        ...feedback,
        if (error.isNotEmpty)
          TextButton(onPressed: busy ? null : _load, child: text('重新加载')),
        if (_loaded && !busy && error.isEmpty && rows.isEmpty)
          Padding(
            padding: const EdgeInsets.all(24),
            child: text(query.isEmpty ? '当前目录没有可用技能' : '没有匹配的技能'),
          ),
        for (final row in rows)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    row['name']?.toString() ?? '',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  if (row['description']?.toString().isNotEmpty == true)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Text(row['description'].toString()),
                    ),
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      Text(row['source']?.toString() ?? ''),
                      if (row['version']?.toString().isNotEmpty == true)
                        Text(row['version'].toString()),
                      text(
                        row['available'] != true
                            ? '未授权'
                            : row['runtimeAvailable'] == true
                            ? '执行端已发现'
                            : '执行端待确认',
                      ),
                      if (row['hasScripts'] == true) text('包含脚本'),
                    ],
                  ),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: busy
                              ? null
                              : () => _open(
                                  SkillDetailScreen(
                                    name: row['name'].toString(),
                                  ),
                                ),
                          child: text('查看用法与文件'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Switch.adaptive(
                        value: row['enabled'] == true,
                        onChanged: busy || row['available'] != true
                            ? null
                            : (value) => _toggle(row, value),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

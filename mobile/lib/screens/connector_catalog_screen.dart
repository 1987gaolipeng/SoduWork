import '../ui/pinned_list_layout.dart';
import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../ui/capability_widgets.dart';
import 'connector_editor_screen.dart';

class ConnectorCatalogScreen extends StatefulWidget {
  const ConnectorCatalogScreen({super.key});
  @override
  State<ConnectorCatalogScreen> createState() => _ConnectorCatalogScreenState();
}

class _ConnectorCatalogScreenState
    extends CapabilityState<ConnectorCatalogScreen> {
  Map<String, dynamic> _catalog = {};
  final _search = TextEditingController();
  String _scope = 'all';
  bool _loaded = false;
  Map<String, dynamic>? _probe;
  String _probeName = '';
  @override
  void initialize() {
    _load();
  }

  void _check(Map<String, dynamic> result) {
    if (result['ok'] == false) {
      throw ApiFailure(
        (result['error'] ?? result['reason'] ?? '操作未完成，请刷新后核对。').toString(),
      );
    }
    if (result['company'] is! List || result['personal'] is! List) {
      throw const ApiFailure('目录回执不完整，请刷新后核对。');
    }
  }

  Future<void> _load() => perform((api) async {
    final result = await api.connectorCatalog();
    _check(result);
    if (current) {
      setState(() {
        _catalog = result;
        _loaded = true;
        _probe = null;
      });
    }
  });
  Future<void> _toggle(Map<String, dynamic> row, bool company, bool enabled) =>
      perform((api) async {
        final result = await api.selectConnector(
          company ? 'company' : 'personal',
          (company ? row['name'] : row['id']).toString(),
          enabled,
        );
        _check(result);
        if (!current) return;
        setState(() {
          _catalog = result;
          receipt = result['warning']?.toString().isNotEmpty == true
              ? result['warning'].toString()
              : '选择已保存，下次任务按实际权限生效。';
        });
      });
  Future<void> _test(Map<String, dynamic> row, bool company) =>
      perform((api) async {
        setState(() {
          _probe = null;
          _probeName = row['name'].toString();
        });
        final result = await api.probeConnector(row, company: company);
        if (current) setState(() => _probe = result);
      });
  Future<void> _remove(Map<String, dynamic> row) async {
    if (!await confirm('删除个人连接器？', '此操作只移除当前连接配置，不删除远端业务数据。')) return;
    await perform((api) async {
      final result = await api.removeConnector(row['id'].toString());
      _check(result);
      if (current) setState(() => _catalog = result);
    });
  }

  Future<void> _edit([Map<String, dynamic>? row]) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => ConnectorEditorScreen(original: row)),
    );
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
    final rows =
        [
              ...capabilityRows(_catalog['company']).map((row) => (row, true)),
              ...capabilityRows(
                _catalog['personal'],
              ).map((row) => (row, false)),
            ]
            .where(
              (entry) =>
                  (_scope == 'all' || (_scope == 'company') == entry.$2) &&
                  '${entry.$1['name']} ${entry.$1['description']}'
                      .toLowerCase()
                      .contains(_search.text.trim().toLowerCase()),
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
              onPressed: busy ? null : () => _edit(),
              icon: const Icon(Icons.add_link),
              label: text('添加连接器'),
            ),
            TextButton.icon(
              onPressed: busy ? null : _load,
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
            label: text('搜索连接器'),
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
        Wrap(
          spacing: 8,
          children: [
            for (final entry in [
              ('all', '全部'),
              ('company', '企业'),
              ('personal', '个人'),
            ])
              ChoiceChip(
                label: text(entry.$2),
                selected: _scope == entry.$1,
                onSelected: (_) => setState(() => _scope = entry.$1),
              ),
          ],
        ),
      ],
      children: [
        ...feedback,
        if (error.isNotEmpty)
          TextButton(onPressed: busy ? null : _load, child: text('重新加载')),
        if (_probe != null)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _probeName,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  text(_probe!['ok'] == true ? '连接测试通过' : '连接尚未就绪'),
                  Text(
                    (_probe!['message'] ??
                            _probe!['error'] ??
                            _probe!['connectionState'] ??
                            '')
                        .toString(),
                  ),
                  if (_probe!['verificationScope'] != null)
                    Text(_probe!['verificationScope'].toString()),
                  if (_probe!['runOn'] != null)
                    Text('${_probe!['runOn']} ${_probe!['runnerHost'] ?? ''}'),
                  if (_probe!['runner'] is Map)
                    Text((_probe!['runner'] as Map)['host']?.toString() ?? ''),
                  for (final tool
                      in _probe!['tools'] is List
                          ? _probe!['tools'] as List
                          : [])
                    Text(
                      tool is Map
                          ? tool['name']?.toString() ?? ''
                          : tool.toString(),
                    ),
                ],
              ),
            ),
          ),
        if (_loaded && !busy && error.isEmpty && rows.isEmpty)
          Padding(padding: const EdgeInsets.all(24), child: text('当前筛选下没有连接器')),
        for (final entry in rows) _card(entry.$1, entry.$2),
      ],
    );
  }

  Widget _card(Map<String, dynamic> row, bool company) => Card(
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
            children: [
              text(company ? '企业' : '个人'),
              if (row['builtIn'] == true) text('内置'),
              Text(row['type']?.toString() ?? ''),
            ],
          ),
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            title: text('下次任务启用'),
            value: company ? row['selected'] == true : row['enabled'] == true,
            onChanged: busy ? null : (value) => _toggle(row, company, value),
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: busy ? null : () => _test(row, company),
                icon: const Icon(Icons.network_check),
                label: text('测试连接'),
              ),
              if (!company && row['canEdit'] == true)
                TextButton(
                  onPressed: busy ? null : () => _edit(row),
                  child: text('编辑配置'),
                ),
              if (!company && row['canDelete'] == true)
                TextButton(
                  onPressed: busy ? null : () => _remove(row),
                  child: text('删除'),
                ),
            ],
          ),
        ],
      ),
    ),
  );
}

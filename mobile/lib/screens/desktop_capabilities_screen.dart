import '../ui/location_switch_row.dart';
import '../ui/pinned_list_layout.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../models/account_conversation.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import 'account_conversation_screen.dart';
import 'plugin_builder_screen.dart';

/// The selected desktop owns this catalog and every operation on it.
class DesktopCapabilitiesScreen extends StatefulWidget {
  final VoidCallback onEnterprise;
  const DesktopCapabilitiesScreen({super.key, required this.onEnterprise});
  @override
  State<DesktopCapabilitiesScreen> createState() =>
      _DesktopCapabilitiesScreenState();
}

class _DesktopCapabilitiesScreenState extends State<DesktopCapabilitiesScreen> {
  MobileState? _owner;
  int? _identity;
  int _generation = 0, _tab = 0, _serial = 0;
  bool _busy = false;
  String _target = '', _error = '', _search = '', _notice = '';
  List<Map<String, dynamic>> _targets = [];
  Map<String, dynamic> _catalog = {};
  final Map<String, String> _requests = {};
  Map<String, dynamic>? _conversationReceipt;
  Map<String, dynamic>? _useArgs;
  final Set<String> _expanded = {};
  static const _sections = ['plugins', 'connectors', 'skills', 'market'];
  static const _labels = ['插件', '连接器', '技能', '市场'];
  List<Map<String, dynamic>> _rows(dynamic value) => value is List
      ? value
            .whereType<Map>()
            .map((row) => Map<String, dynamic>.from(row))
            .toList()
      : [];
  bool get _current =>
      mounted &&
      identical(MobileScope.read(context), _owner) &&
      _owner?.identityRevision == _identity;
  Map<String, dynamic> get _device =>
      _targets.where((row) => row['id'] == _target).firstOrNull ?? {};

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final owner = MobileScope.of(context);
    if (!identical(_owner, owner) || _identity != owner.identityRevision) {
      _owner = owner;
      _identity = owner.identityRevision;
      _generation++;
      _target = '';
      _targets = [];
      _catalog = {};
      _requests.clear();
      _conversationReceipt = null;
      _useArgs = null;
      _error = '';
      _notice = '';
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_current) _load();
      });
    }
  }

  Future<Map<String, dynamic>> _request(
    String target,
    String operation,
    Map<String, dynamic> args,
  ) {
    if (!_current || target != _target) {
      throw const ApiFailure('账号或电脑已切换，请重新操作');
    }
    final key = jsonEncode([target, operation, args]);
    final id = _requests.putIfAbsent(
      key,
      () => 'mobile-${DateTime.now().microsecondsSinceEpoch}-${_serial++}',
    );
    return _owner!.api.desktopCapabilityRequest(target, operation, args, id);
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _busy = true;
      _error = '';
      _catalog = {};
    });
    try {
      final result = await _owner!.api.desktopCapabilityTargets();
      if (!_current || generation != _generation) return;
      _targets = _rows(result['items']);
      if (_target.isEmpty) {
        _target =
            (_targets.where((row) => row['ready'] == true).firstOrNull ??
                    _targets.firstOrNull)?['id']
                ?.toString() ??
            '';
      } else if (!_targets.any((row) => row['id'] == _target)) {
        _target = '';
        _error = '原电脑已不可访问，请重新选择';
      }
      if (_target.isNotEmpty && _device['ready'] == true) {
        final catalog = await _request(_target, 'catalog', {});
        if (!_current || generation != _generation) return;
        _catalog = catalog;
      }
    } catch (error) {
      if (_current && generation == _generation) _error = error.toString();
    } finally {
      if (_current && generation == _generation) setState(() => _busy = false);
    }
  }

  Future<void> _chooseComputer() async {
    final generation = _generation, owner = _owner!;
    final selected = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: ListenableBuilder(
            listenable: owner,
            builder: (_, _) {
              if (!_current || generation != _generation) {
                return const Text('列表已更新，请重新选择');
              }
              return Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('选择本人电脑', style: Theme.of(sheet).textTheme.titleMedium),
                  for (final row in _targets)
                    ListTile(
                      leading: const Icon(Icons.computer_outlined),
                      title: Text(row['name']?.toString() ?? '本人电脑'),
                      trailing: row['id'] == _target
                          ? const Icon(Icons.check)
                          : null,
                      subtitle: row['ready'] == true
                          ? null
                          : Text(
                              row['reason']?.toString().isNotEmpty == true
                                  ? row['reason'].toString()
                                  : '电脑未就绪',
                            ),
                      enabled: row['ready'] == true,
                      onTap: () => Navigator.pop(sheet, row['id'].toString()),
                    ),
                ],
              );
            },
          ),
        ),
      ),
    );
    if (!_current ||
        generation != _generation ||
        selected == null ||
        selected == _target) {
      return;
    }
    setState(() {
      _target = selected;
      _catalog = {};
      _conversationReceipt = null;
      _useArgs = null;
      _notice = '';
    });
    await _load();
  }

  Future<void> _edit([Map<String, dynamic>? row]) async {
    final target = _target, generation = _generation;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      Map<String, dynamic> draft = {};
      if (row != null) {
        final detail = await _request(target, 'plugin.get', {
          'pluginId': row['pluginId'],
        });
        final plugin = Map<String, dynamic>.from(detail['plugin'] as Map);
        draft = Map<String, dynamic>.from(plugin['localDraft'] as Map);
        final parts = (draft['version']?.toString() ?? '').split('.');
        if (parts.length == 3 && int.tryParse(parts[2]) != null) {
          draft['version'] =
              '${parts[0]}.${parts[1]}.${int.parse(parts[2]) + 1}';
        }
      }
      if (!mounted || !_current || generation != _generation) return;
      final installed = await Navigator.of(context).push<Map<String, dynamic>>(
        MaterialPageRoute(
          builder: (_) => PluginBuilderScreen(
            initialValues: draft,
            targetComputer: _device['name']?.toString() ?? '本人电脑',
            onPreflight: (body) => _request(target, 'plugin.preflight', {
              'draft': body,
              if (row != null) ...{
                'pluginId': row['pluginId'],
                'expectedChecksum': row['checksum'],
              },
            }),
            onInstall: (body) => _request(target, 'plugin.install', {
              'draft': body,
              if (row != null) ...{
                'pluginId': row['pluginId'],
                'expectedChecksum': row['checksum'],
              },
            }),
          ),
        ),
      );
      if (!_current || generation != _generation) return;
      if (installed != null) _notice = '已安装到 ${_device['name']}，可以开始使用。';
      await _load();
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    } finally {
      if (_current) setState(() => _busy = false);
    }
  }

  Future<void> _use(Map<String, dynamic> row) async {
    final target = _target, generation = _generation;
    final input = TextEditingController();
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      builder: (context) => Padding(
        padding: EdgeInsets.fromLTRB(
          20,
          0,
          20,
          MediaQuery.viewInsetsOf(context).bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      row['name']?.toString() ?? '使用插件',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              Text(
                '在 ${_device['name']} 上开始新会话',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 16),
              TextField(
                controller: input,
                minLines: 4,
                maxLines: 6,
                decoration: const InputDecoration(hintText: '描述这次要完成的工作…'),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  icon: const Icon(Icons.arrow_upward, size: 18),
                  onPressed: () {
                    if (input.text.trim().isNotEmpty) {
                      Navigator.pop(context, input.text.trim());
                    }
                  },
                  label: const Text('开始执行'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    Future<void>.delayed(const Duration(milliseconds: 400), input.dispose);
    if (text == null || !_current || generation != _generation) return;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final args = {
        'pluginId': row['pluginId'],
        'expectedChecksum': row['checksum'],
        'text': text,
      };
      if (_conversationReceipt != null) {
        _requests.remove(jsonEncode([target, 'plugin.use', args]));
        _conversationReceipt = null;
      }
      final receipt = await _request(target, 'plugin.use', args);
      if (!_current || generation != _generation) return;
      _conversationReceipt = receipt;
      _useArgs = args;
      _notice = '电脑已接收，结果会同步到会话。';
      await _openConversation();
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    } finally {
      if (_current) setState(() => _busy = false);
    }
  }

  Future<void> _setSkill(Map<String, dynamic> row, bool enabled) async {
    final target = _target, generation = _generation;
    final args = <String, dynamic>{'name': row['name'], 'enabled': enabled};
    // Each explicit switch gesture is a new desired-state operation, including a retry after an outage.
    _requests.remove(jsonEncode([target, 'skill.set', args]));
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final result = await _request(target, 'skill.set', args);
      if (!_current || generation != _generation) return;
      if (result['ok'] != true ||
          result['name'] != row['name'] ||
          result['enabled'] != enabled) {
        throw const ApiFailure('设置尚未确认，请刷新后核对');
      }
      _requests.remove(jsonEncode([target, 'skill.set', args]));
      setState(() {
        row['enabled'] = enabled;
        _catalog['skills'] = _rows(
          _catalog['skills'],
        ).map((item) => item['name'] == row['name'] ? row : item).toList();
      });
    } catch (error) {
      if (_current && generation == _generation) {
        setState(() => _error = error.toString());
      }
    } finally {
      if (_current && generation == _generation) setState(() => _busy = false);
    }
  }

  Widget _card(Map<String, dynamic> row) {
    final theme = Theme.of(context), colors = Theme.of(context).colorScheme;
    final skill = _tab == 2, plugin = _tab == 0;
    final name = row['name']?.toString() ?? '';
    final description = row['description']?.toString() ?? '';
    final key = '$_target:$_tab:$name';
    final expanded = _expanded.contains(key);
    final meta = <String>[
      if (row['builtIn'] == true)
        '内置'
      else if ((row['source'] ?? '').toString().isNotEmpty)
        row['source'].toString(),
      if ((row['version'] ?? '').toString().trim().isNotEmpty)
        row['version'].toString(),
      if (skill) row['installed'] == true ? '本机已安装' : '启用后同步到本机',
    ];
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.outline),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: colors.surfaceContainer,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    skill
                        ? Icons.auto_awesome_outlined
                        : plugin
                        ? Icons.extension_outlined
                        : Icons.grid_view_outlined,
                    size: 20,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    name,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                if (skill)
                  SizedBox(
                    height: 36,
                    child: Switch.adaptive(
                      key: ValueKey('skill-$name'),
                      value: row['enabled'] == true,
                      onChanged: _busy
                          ? null
                          : (value) => _setSkill(row, value),
                    ),
                  ),
              ],
            ),
            if (description.isNotEmpty) ...[
              const SizedBox(height: 10),
              InkWell(
                onTap: () => setState(() {
                  if (expanded) {
                    _expanded.remove(key);
                  } else {
                    _expanded.add(key);
                  }
                }),
                child: Text(
                  description,
                  maxLines: expanded ? null : 2,
                  overflow: expanded ? null : TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colors.onSurfaceVariant,
                    height: 1.5,
                  ),
                ),
              ),
            ],
            const SizedBox(height: 12),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final value in meta)
                  Text(
                    value,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: colors.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
            if (plugin) ...[
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  if (row['builtIn'] != true)
                    TextButton(
                      onPressed: _busy ? null : () => _edit(row),
                      child: const Text('编辑'),
                    ),
                  const SizedBox(width: 8),
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(80, 40),
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                    ),
                    onPressed: _busy || row['enabled'] == false
                        ? null
                        : () => _use(row),
                    icon: const Icon(Icons.play_arrow_rounded, size: 18),
                    label: const Text('使用'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _openConversation() async {
    final receipt = _conversationReceipt;
    if (receipt == null) return;
    try {
      final result = receipt['conversation'] is Map
          ? receipt
          : await _request(_target, 'plugin.use', _useArgs!);
      if (!mounted || !_current || !identical(receipt, _conversationReceipt)) {
        return;
      }
      final row = result['conversation'] is Map
          ? Map<String, dynamic>.from(result['conversation'] as Map)
          : null;
      if (row == null) {
        setState(() => _notice = '电脑已接收，会话同步中；稍后点“查看会话”即可。');
        return;
      }
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => AccountConversationScreen(
            conversation: AccountConversation.fromJson(row),
          ),
        ),
      );
    } catch (error) {
      if (_current) setState(() => _error = error.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final section = _sections[_tab];
    final items = _rows(_catalog[section])
        .where(
          (row) => '${row['name']} ${row['description']}'
              .toLowerCase()
              .contains(_search.toLowerCase()),
        )
        .toList();
    final sectionError =
        (_catalog['errors'] is Map ? _catalog['errors'][section] : null)
            ?.toString() ??
        '';
    return PinnedListLayout(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      header: [
        Row(
          children: [
            const Expanded(
              child: Text(
                '本人电脑',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            TextButton(
              onPressed: _busy ? null : widget.onEnterprise,
              child: const Text('企业目录'),
            ),
            IconButton(
              onPressed: _busy ? null : _load,
              tooltip: '刷新',
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        if (_targets.isNotEmpty)
          LocationSwitchRow(
            icon: Icons.computer_outlined,
            label: _target.isEmpty
                ? '选择电脑'
                : "${_device['name'] ?? '本人电脑'}${_device['ready'] == true ? '' : ' · 未就绪'}",
            onTap: _busy ? null : _chooseComputer,
          ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (var i = 0; i < _labels.length; i++)
              ChoiceChip(
                label: Text(_labels[i]),
                selected: _tab == i,
                onSelected: (_) => setState(() => _tab = i),
              ),
          ],
        ),
        const SizedBox(height: 16),
        Text(
          _tab == 2 ? '开关自动保存到这台电脑，下次任务生效。' : '与所选电脑同步，创建与安装也保存在这台电脑。',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        SizedBox(
          height: 12,
          child: _busy
              ? const Center(child: LinearProgressIndicator(minHeight: 2))
              : null,
        ),
        if (_device['ready'] == true) ...[
          if (_tab == 0)
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.icon(
                onPressed: _busy ? null : () => _edit(),
                icon: const Icon(Icons.add),
                label: const Text('创建插件'),
              ),
            ),
          const SizedBox(height: 12),
          TextField(
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: '搜索名称或用途',
            ),
            onChanged: (value) => setState(() => _search = value),
          ),
        ],
      ],
      children: [
        if (_error.isNotEmpty || sectionError.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Text(
              _error.isNotEmpty ? _error : sectionError,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          ),
        if (!_busy && _targets.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 32),
            child: Text('暂未找到本人电脑，请在电脑打开 SoduWork 并登录同一账号。'),
          ),
        if (!_busy && _target.isNotEmpty && _device['ready'] != true)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Text(_device['reason']?.toString() ?? '请先连接这台电脑'),
          ),
        if (_notice.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Text(_notice),
          ),
        if (_conversationReceipt != null)
          OutlinedButton.icon(
            onPressed: _busy ? null : _openConversation,
            icon: const Icon(Icons.chat_bubble_outline),
            label: const Text('查看会话'),
          ),
        if (_device['ready'] == true) ...[
          if (!_busy && sectionError.isEmpty && items.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Text('这台电脑暂无${_labels[_tab]}'),
            ),
          for (final row in items) _card(row),
        ],
      ],
    );
  }
}

import 'mobile_input_border.dart';
import 'mobile_display_preferences.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../models/work_capability.dart';
import '../sdk/soduwork_brand.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import 'mobile_theme.dart';

Future<WorkCapability?> showWorkCapabilityPicker(
  BuildContext context, {
  String prefix = '/',
  VoidCallback? onCreatePlugin,
}) => showModalBottomSheet<WorkCapability>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  backgroundColor: context.soduWorkTheme.surface,
  constraints: const BoxConstraints(maxWidth: 600),
  shape: const RoundedRectangleBorder(
    borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
  ),
  builder: (_) =>
      WorkCapabilityPicker(prefix: prefix, onCreatePlugin: onCreatePlugin),
);

class WorkCapabilityPicker extends StatefulWidget {
  final String prefix;
  final bool embedded;
  final bool workflowOnly;
  final ValueChanged<WorkCapability>? onSelected;
  final VoidCallback? onCreatePlugin;
  final bool closeOnCreate;
  const WorkCapabilityPicker({
    super.key,
    this.prefix = '/',
    this.embedded = false,
    this.workflowOnly = false,
    this.onSelected,
    this.onCreatePlugin,
    this.closeOnCreate = true,
  });
  @override
  State<WorkCapabilityPicker> createState() => _WorkCapabilityPickerState();
}

class _WorkCapabilityPickerState extends State<WorkCapabilityPicker> {
  final _search = TextEditingController();
  final _scroll = ScrollController();
  final _items = <WorkCapabilityKind, List<WorkCapability>>{};
  final _errors = <WorkCapabilityKind, String>{};
  final _loading = <WorkCapabilityKind>{};
  List<Map<String, dynamic>> _privateInspections = const [];
  MobileState? _state;
  int? _identity;
  late WorkCapabilityKind _kind;
  bool _identityChanged = false;
  @override
  void initState() {
    super.initState();
    _kind = widget.workflowOnly
        ? WorkCapabilityKind.workflow
        : _kindFor(widget.prefix);
    _search.text = RegExp(r'^[/#@]').hasMatch(widget.prefix)
        ? widget.prefix.substring(1)
        : widget.prefix;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _load(_kind);
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (!identical(_state, state)) {
      _state?.removeListener(_changed);
      _state = state;
      _identity = state.identityRevision;
      state.addListener(_changed);
    }
  }

  void _changed() {
    final state = _state;
    if (!mounted || state == null || state.identityRevision == _identity) {
      return;
    }
    setState(() {
      _identity = state.identityRevision;
      _identityChanged = true;
      _items.clear();
      _errors.clear();
      _privateInspections = const [];
      _loading.clear();
    });
  }

  bool get _current =>
      mounted &&
      _state != null &&
      !_identityChanged &&
      _state!.identityRevision == _identity;
  Future<void> _load(WorkCapabilityKind kind) async {
    if (!_current || _loading.contains(kind)) return;
    final state = _state!;
    final revision = state.identityRevision;
    setState(() {
      _loading.add(kind);
      _errors.remove(kind);
    });
    try {
      List<WorkCapability> rows;
      switch (kind) {
        case WorkCapabilityKind.workflow:
          final response = await state.api.workPluginBindings();
          rows = _rows(response['items']).map(WorkCapability.workflow).toList();
          if (widget.embedded &&
              widget.onSelected == null &&
              state.api.isLocalDevelopment) {
            final inspections = await state.api.localPluginInspections();
            if (_current && state.identityRevision == revision) {
              _privateInspections = inspections;
            }
          }
        case WorkCapabilityKind.skill:
          final response = await state.api.workSkillCatalog();
          rows = _rows(response['skills']).map(WorkCapability.skill).toList();
        case WorkCapabilityKind.teammate:
          rows = (await state.api.teammates())
              .map(WorkCapability.teammate)
              .toList();
      }
      if (!_current || state.identityRevision != revision) return;
      setState(() => _items[kind] = rows);
    } catch (_) {
      if (_current && state.identityRevision == revision) {
        setState(() => _errors[kind] = '目录暂时无法读取，请检查连接后重试。');
      }
    } finally {
      if (_current && state.identityRevision == revision) {
        setState(() => _loading.remove(kind));
      }
    }
  }

  void _selectKind(WorkCapabilityKind value) {
    if (_scroll.hasClients) _scroll.jumpTo(0);
    setState(() => _kind = value);
    if (!_items.containsKey(value)) _load(value);
  }

  @override
  void dispose() {
    _state?.removeListener(_changed);
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    final theme = context.soduWorkTheme;
    final query = _search.text
        .replaceFirst(RegExp(r'^[/#@]'), '')
        .trim()
        .toLowerCase();
    final rows = (_items[_kind] ?? []).where((row) {
      final haystack =
          '${row.label} ${row.id} ${row.description} ${row.reason}';
      return haystack.toLowerCase().contains(query);
    }).toList();
    return LayoutBuilder(
      builder: (context, constraints) {
        final keyboard = MediaQuery.viewInsetsOf(context).bottom;
        final screen = MediaQuery.sizeOf(context).height;
        final max = constraints.maxHeight.isFinite
            ? constraints.maxHeight
            : screen;
        final available = (max - keyboard).clamp(0.0, max).toDouble();
        return Padding(
          padding: EdgeInsets.only(bottom: keyboard),
          child: SizedBox(
            height: widget.embedded
                ? available
                : (screen * .78).clamp(0.0, available).toDouble(),
            child: Column(
              children: [
                if (!widget.embedded)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 0, 12, 6),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            mobileText(context, '选择工作能力'),
                            style: TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.w700,
                              color: theme.ink,
                            ),
                          ),
                        ),
                        IconButton(
                          key: const Key('work-capability-close'),
                          tooltip: mobileText(context, '关闭'),
                          constraints: const BoxConstraints(
                            minWidth: 44,
                            minHeight: 44,
                          ),
                          onPressed: () => Navigator.pop(context),
                          icon: Icon(
                            CupertinoIcons.xmark,
                            size: 21,
                            color: theme.inkSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                if (widget.embedded && widget.onSelected == null)
                  _CreatePluginCard(
                    theme: theme,
                    onCreate: widget.onCreatePlugin,
                    closeOnCreate: widget.closeOnCreate,
                  ),
                if (_identityChanged)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
                    child: _InfoBox(theme: theme, text: '账号已切换，请关闭后重新选择。'),
                  ),
                if (_current) ...[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                    child: TextField(
                      key: const Key('work-capability-search'),
                      controller: _search,
                      onChanged: (_) => setState(() {}),
                      textInputAction: TextInputAction.search,
                      style: TextStyle(color: theme.ink, fontSize: 14.5),
                      decoration: InputDecoration(
                        hintText: _kind == WorkCapabilityKind.teammate
                            ? mobileText(context, '搜索同事或部门')
                            : mobileText(context, '搜索名称或说明'),
                        hintStyle: TextStyle(
                          color: theme.inkMuted,
                          fontSize: 14.5,
                        ),
                        filled: true,
                        fillColor: theme.surfaceMuted,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 12,
                        ),
                        prefixIcon: Icon(
                          CupertinoIcons.search,
                          size: 21,
                          color: theme.inkMuted,
                        ),
                        suffixIcon: _search.text.isEmpty
                            ? null
                            : IconButton(
                                onPressed: () {
                                  _search.clear();
                                  setState(() {});
                                },
                                tooltip: mobileText(context, '清空搜索'),
                                icon: const Icon(
                                  CupertinoIcons.xmark_circle_fill,
                                ),
                              ),
                        border: MobileInputBorder(
                          borderRadius: BorderRadius.circular(16),
                          borderSide: BorderSide.none,
                        ),
                      ),
                    ),
                  ),
                  _KindTabs(
                    kind: _kind,
                    workflowOnly: widget.workflowOnly,
                    theme: theme,
                    onChanged: _selectKind,
                  ),
                ],
                Expanded(
                  child: _current
                      ? _Results(
                          key: const Key('work-capability-results'),
                          controller: _scroll,
                          rows: rows,
                          kind: _kind,
                          loading: _loading.contains(_kind),
                          error: _errors[_kind],
                          privateInspections: _privateInspections,
                          theme: theme,
                          onRetry: () => _load(_kind),
                          onSelected: (row) {
                            if (!row.enabled) return;
                            widget.onSelected?.call(row);
                            if (widget.onSelected == null && !widget.embedded) {
                              Navigator.pop(context, row);
                            }
                          },
                        )
                      : const SizedBox.shrink(),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _CreatePluginCard extends StatelessWidget {
  final SoduWorkBrandTheme theme;
  final VoidCallback? onCreate;
  final bool closeOnCreate;
  const _CreatePluginCard({
    required this.theme,
    required this.onCreate,
    required this.closeOnCreate,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
    child: Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 12, 14),
      decoration: BoxDecoration(
        color: theme.surfaceMuted,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: theme.line),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: theme.primary.withValues(alpha: .12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              CupertinoIcons.wand_stars,
              color: theme.primary,
              size: 21,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  mobileText(context, '对话创建插件'),
                  style: TextStyle(
                    color: theme.ink,
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  mobileText(
                    context,
                    '先描述要重复完成的工作，SoduWork 会在新对话中生成草稿，再打开结构化表单确认。',
                  ),
                  style: TextStyle(
                    color: theme.inkMuted,
                    height: 1.35,
                    fontSize: 12.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            key: const Key('work-capability-create-plugin'),
            onPressed: onCreate == null
                ? null
                : () {
                    if (closeOnCreate) Navigator.of(context).pop();
                    onCreate!();
                  },
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
              minimumSize: const Size(0, 40),
            ),
            child: Text(mobileText(context, '对话创建')),
          ),
        ],
      ),
    ),
  );
}

class _KindTabs extends StatelessWidget {
  final WorkCapabilityKind kind;
  final bool workflowOnly;
  final SoduWorkBrandTheme theme;
  final ValueChanged<WorkCapabilityKind> onChanged;
  const _KindTabs({
    required this.kind,
    required this.workflowOnly,
    required this.theme,
    required this.onChanged,
  });
  @override
  Widget build(BuildContext context) {
    final kinds = workflowOnly
        ? [WorkCapabilityKind.workflow]
        : WorkCapabilityKind.values;
    return SizedBox(
      height: 42,
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        scrollDirection: Axis.horizontal,
        itemCount: kinds.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (_, i) {
          final value = kinds[i];
          final selected = value == kind;
          final label = value == WorkCapabilityKind.workflow
              ? '/ 插件'
              : value == WorkCapabilityKind.skill
              ? '# 技能'
              : '@ 同事';
          return ChoiceChip(
            key: Key('work-capability-kind-${value.name}'),
            selected: selected,
            label: Text(label),
            onSelected: (_) => onChanged(value),
            labelStyle: TextStyle(
              color: selected ? theme.primary : theme.inkSecondary,
              fontWeight: FontWeight.w600,
            ),
            side: BorderSide(
              color: selected
                  ? theme.primary.withValues(alpha: .35)
                  : theme.line,
            ),
            backgroundColor: theme.surface,
            selectedColor: theme.primarySoft,
            showCheckmark: false,
          );
        },
      ),
    );
  }
}

class _Results extends StatelessWidget {
  final ScrollController controller;
  final List<WorkCapability> rows;
  final WorkCapabilityKind kind;
  final bool loading;
  final String? error;
  final List<Map<String, dynamic>> privateInspections;
  final SoduWorkBrandTheme theme;
  final VoidCallback onRetry;
  final ValueChanged<WorkCapability> onSelected;
  const _Results({
    super.key,
    required this.controller,
    required this.rows,
    required this.kind,
    required this.loading,
    required this.error,
    required this.privateInspections,
    required this.theme,
    required this.onRetry,
    required this.onSelected,
  });
  @override
  Widget build(BuildContext context) {
    if (loading && rows.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error != null && rows.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              CupertinoIcons.wifi_exclamationmark,
              color: theme.inkMuted,
              size: 30,
            ),
            const SizedBox(height: 8),
            Text(error!, style: TextStyle(color: theme.inkMuted)),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: onRetry,
              child: Text(mobileText(context, '重新读取')),
            ),
          ],
        ),
      );
    }
    final children = <Widget>[];
    if (rows.isNotEmpty) {
      children.addAll(
        rows.map(
          (row) => _CapabilityTile(
            row: row,
            kind: kind,
            theme: theme,
            onTap: () => onSelected(row),
          ),
        ),
      );
    } else if (privateInspections.isNotEmpty) {
      children.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
          child: Text(
            mobileText(context, '暂未接通可执行插件。下方是你的个人导入检查结果。'),
            style: TextStyle(color: theme.inkMuted, height: 1.45),
          ),
        ),
      );
      children.addAll(
        privateInspections.map(
          (row) => _InspectionTile(row: row, theme: theme),
        ),
      );
    } else {
      children.add(
        Padding(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: Text(
              mobileText(context, '暂无匹配的工作能力'),
              style: TextStyle(color: theme.inkMuted),
            ),
          ),
        ),
      );
    }
    return ListView(
      key: const Key('work-capability-results-list'),
      controller: controller,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 22),
      children: children,
    );
  }
}

class _CapabilityTile extends StatelessWidget {
  final WorkCapability row;
  final WorkCapabilityKind kind;
  final SoduWorkBrandTheme theme;
  final VoidCallback onTap;
  const _CapabilityTile({
    required this.row,
    required this.kind,
    required this.theme,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    elevation: 0,
    color: theme.surface,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(16),
      side: BorderSide(color: theme.line),
    ),
    child: ListTile(
      enabled: row.enabled,
      onTap: onTap,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 5),
      leading: kind == WorkCapabilityKind.teammate
          ? CircleAvatar(
              key: Key('work-capability-avatar:${row.id}'),
              backgroundColor: theme.surfaceMuted,
              child: Text(
                row.label.isEmpty ? '?' : row.label.substring(0, 1),
                style: TextStyle(
                  color: theme.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            )
          : Icon(
              row.enabled
                  ? CupertinoIcons.square_stack_3d_up
                  : CupertinoIcons.lock,
              color: row.enabled ? theme.primary : theme.inkMuted,
            ),
      title: Text(
        row.label,
        style: TextStyle(color: theme.ink, fontWeight: FontWeight.w700),
      ),
      subtitle:
          kind == WorkCapabilityKind.teammate && row.description.isNotEmpty
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  row.description,
                  style: TextStyle(color: theme.inkMuted, height: 1.3),
                ),
                if (row.reason.isNotEmpty)
                  Text(
                    row.reason,
                    style: TextStyle(color: theme.inkMuted, height: 1.3),
                  ),
              ],
            )
          : Text(
              row.reason.isNotEmpty ? row.reason : row.description,
              style: TextStyle(color: theme.inkMuted, height: 1.35),
            ),
      trailing: row.enabled
          ? Icon(CupertinoIcons.chevron_right, size: 17, color: theme.inkMuted)
          : null,
    ),
  );
}

class _InspectionTile extends StatelessWidget {
  final Map<String, dynamic> row;
  final SoduWorkBrandTheme theme;
  const _InspectionTile({required this.row, required this.theme});
  @override
  Widget build(BuildContext context) {
    final issues = row['issues'];
    final issue = issues is List
        ? issues.join('；')
        : issues?.toString() ?? '仅供检查';
    final version = row['version']?.toString() ?? '-';
    final count = row['resourceCount']?.toString() ?? '0';
    return ListTile(
      leading: Icon(CupertinoIcons.lock, color: theme.inkMuted),
      title: Text(
        row['name']?.toString() ?? '个人草稿',
        style: TextStyle(color: theme.ink, fontWeight: FontWeight.w700),
      ),
      subtitle: Text(
        '仅本人 · v$version · $count 个资源\n$issue',
        style: TextStyle(color: theme.inkMuted, height: 1.4),
      ),
    );
  }
}

class _InfoBox extends StatelessWidget {
  final SoduWorkBrandTheme theme;
  final String text;
  const _InfoBox({required this.theme, required this.text});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: theme.primarySoft,
      borderRadius: BorderRadius.circular(14),
    ),
    child: Row(
      children: [
        Icon(CupertinoIcons.person_crop_circle, color: theme.primary, size: 20),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            mobileText(context, text),
            style: TextStyle(color: theme.ink, height: 1.3),
          ),
        ),
      ],
    ),
  );
}

List<Map<String, dynamic>> _rows(dynamic value) => value is List
    ? value
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList()
    : const [];
WorkCapabilityKind _kindFor(String prefix) {
  if (prefix.startsWith('#')) return WorkCapabilityKind.skill;
  if (prefix.startsWith('@')) return WorkCapabilityKind.teammate;
  return WorkCapabilityKind.workflow;
}

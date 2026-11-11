import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';

Future<AiAssignee?> showAiAssigneeSheet(
  BuildContext context, {
  AiAssignee? selected,
}) {
  return showModalBottomSheet<AiAssignee>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => _AiAssigneeSheet(selected: selected),
  );
}

class _AiAssigneeSheet extends StatefulWidget {
  final AiAssignee? selected;

  const _AiAssigneeSheet({this.selected});

  @override
  State<_AiAssigneeSheet> createState() => _AiAssigneeSheetState();
}

class _AiAssigneeSheetState extends State<_AiAssigneeSheet> {
  AiRoster? _roster;
  bool _loading = true;
  String _error = '';

  MobileState? _state;
  int? _identity;
  int _request = 0;
  bool _accountChanged = false;
  bool get _current =>
      mounted &&
      !_accountChanged &&
      identical(MobileScope.maybeOf(context), _state) &&
      _state?.identityRevision == _identity;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state == null) {
      _state = state;
      _identity = state.identityRevision;
      _load();
    } else if (_state != state || _identity != state.identityRevision) {
      _accountChanged = true;
      _request++;
      _roster = null;
      _loading = false;
      _error = '账号已变化，请关闭后重新选择执行机。';
    }
  }

  Future<void> _load({bool force = false}) async {
    if (!_current) return;
    final request = ++_request;
    bool current() => _current && request == _request;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final roster = await _state!.aiAgents(force: force);
      if (current()) setState(() => _roster = roster);
    } on ApiFailure catch (error) {
      if (current()) setState(() => _error = error.message);
    } catch (_) {
      if (current()) setState(() => _error = '暂时无法读取执行机，请重试。');
    } finally {
      if (current()) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final maxHeight = MediaQuery.sizeOf(context).height * .72;
    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: maxHeight),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 22),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        mobileText(context, '\u4ea4\u7ed9 AI'),
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        mobileText(
                          context,
                          '\u5728\u4f60\u7684\u5728\u7ebf\u7535\u8111\u4e0a\u6267\u884c\uff0c\u624b\u673a\u6301\u7eed\u540c\u6b65\u8fdb\u5c55\u548c\u7ed3\u679c\u3002',
                        ),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: mobileText(context, '\u91cd\u65b0\u63a2\u6d4b'),
                  onPressed: _loading || !_current
                      ? null
                      : () => _load(force: true),
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Flexible(child: _body(context)),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    if (_loading) {
      return const SizedBox(height: 260, child: LoadingPane());
    }
    if (_error.isNotEmpty) {
      return SizedBox(
        height: 280,
        child: EmptyPane(
          icon: Icons.cloud_off_outlined,
          title: '\u6682\u65f6\u65e0\u6cd5\u8bfb\u53d6\u6267\u884c\u673a',
          message: mobileText(context, _error),
          actionLabel: _accountChanged ? null : '\u91cd\u8bd5',
          onAction: _accountChanged ? null : () => _load(force: true),
        ),
      );
    }
    final roster = _roster;
    final rows = roster?.selectableAgents ?? const <AiAssignee>[];
    if (rows.isEmpty) {
      final reason = roster?.reason.trim() ?? '';
      return SizedBox(
        height: 300,
        child: EmptyPane(
          icon: Icons.laptop_chromebook_outlined,
          title: '\u6ca1\u6709\u5728\u7ebf\u7684\u7535\u8111\u6267\u884c\u673a',
          message: reason.isNotEmpty
              ? reason
              : '\u8bf7\u5728\u4f60\u7684\u7535\u8111\u4e0a\u6253\u5f00 ${context.soduWorkTheme.brandName} \u5e76\u4fdd\u6301 Runner \u5728\u7ebf\uff0c\u518d\u56de\u5230\u624b\u673a\u91cd\u8bd5\u3002',
          actionLabel: '\u91cd\u65b0\u63a2\u6d4b',
          onAction: () => _load(force: true),
        ),
      );
    }

    final recommended = roster?.recommended;
    return WorkSurface(
      padding: EdgeInsets.zero,
      child: ListView.separated(
        shrinkWrap: true,
        itemCount: rows.length,
        separatorBuilder: (_, _) => const Divider(indent: 58, endIndent: 12),
        itemBuilder: (context, index) {
          final item = rows[index];
          return _AgentRow(
            item: item,
            selected: widget.selected?.id == item.id,
            recommended: recommended?.id == item.id,
            onTap: () {
              if (_current) Navigator.of(context).pop(item);
            },
          );
        },
      ),
    );
  }
}

class _AgentRow extends StatelessWidget {
  final AiAssignee item;
  final bool selected;
  final bool recommended;
  final VoidCallback onTap;

  const _AgentRow({
    required this.item,
    required this.selected,
    required this.recommended,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return ListTile(
      minTileHeight: 68,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      onTap: onTap,
      leading: Container(
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          color: selected ? theme.primarySoft : theme.surfaceMuted,
          borderRadius: BorderRadius.circular(theme.radiusSmall + 2),
        ),
        child: Icon(
          _agentIcon(item.cli),
          size: 20,
          color: selected ? theme.primary : theme.inkSecondary,
        ),
      ),
      title: Row(
        children: [
          Flexible(
            child: Text(
              item.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (recommended) ...[
            const SizedBox(width: 7),
            _TinyLabel(
              label: mobileText(context, '推荐'),
              color: theme.secondary,
              background: theme.secondarySoft,
            ),
          ],
        ],
      ),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 3),
        child: Text(
          '${item.foundationLabel} \u00b7 ${item.machineLabel}',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      trailing: selected
          ? Icon(Icons.check_circle_rounded, color: theme.primary, size: 21)
          : _TinyLabel(
              label: mobileText(context, item.busy ? '会排队' : '可执行'),
              color: item.busy ? theme.warning : theme.success,
              background: item.busy ? theme.warningSoft : theme.successSoft,
            ),
    );
  }
}

class _TinyLabel extends StatelessWidget {
  final String label;
  final Color color;
  final Color background;

  const _TinyLabel({
    required this.label,
    required this.color,
    required this.background,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 10.5,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

IconData _agentIcon(String cli) {
  return switch (cli.toLowerCase()) {
    'pi' => Icons.bolt_rounded,
    'opencode' => Icons.code_rounded,
    'claude' => Icons.auto_awesome_outlined,
    'codex' => Icons.terminal_rounded,
    _ => Icons.smart_toy_outlined,
  };
}

import '../ui/pinned_list_layout.dart';
import '../ui/mobile_display_preferences.dart';
import 'dart:async';
import '../ui/mobile_sheet.dart';
import 'package:flutter/material.dart';

import '../core/soduwork_api.dart';
import '../core/automation_readiness.dart';
import '../core/automation_run_destination.dart';
import 'account_conversation_screen.dart';
import '../ui/open_work_conversation.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/automation_editor.dart';
import '../ui/automation_templates.dart';
import '../ui/automation_chat.dart';
import '../ui/mobile_chrome.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';
import 'task_detail_screen.dart';

class AutomationsScreen extends StatefulWidget {
  final VoidCallback? onCreate;
  const AutomationsScreen({super.key, this.onCreate});

  @override
  State<AutomationsScreen> createState() => _AutomationsScreenState();
}

class _AutomationsScreenState extends State<AutomationsScreen> {
  List<AutomationSchedule> _items = const [];
  List<Map<String, dynamic>> _templates = const [];
  String _templateError = '';
  int _templateRequest = 0;
  final Set<String> _busyIds = <String>{};
  final Map<String, String> _actionErrors = {};
  final Set<String> _uncertainRuns = <String>{};
  bool _loading = true;
  String _error = '';
  MobileState? _state;
  int? _identity;
  int _request = 0;
  bool _editorOpen = false;
  String _query = '';
  String _filter = 'all';
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  bool get _current => mounted && _state?.identityRevision == _identity;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state != state || _identity != state.identityRevision) {
      _state = state;
      _identity = state.identityRevision;
      _items = const [];
      _query = '';
      _filter = 'all';
      _search.clear();
      _templates = const [];
      _templateError = '';
      _busyIds.clear();
      _actionErrors.clear();
      _uncertainRuns.clear();
      _error = '';
      _loading = true;
      _editorOpen = false;
      _load();
    }
  }

  Future<void> _load({bool silent = false}) async {
    unawaited(_loadTemplates());
    final state = _state!;
    final identity = _identity;
    final request = ++_request;
    bool current() => _current && identity == _identity && request == _request;
    if (!silent) {
      setState(() {
        _loading = true;
        _error = '';
      });
    }
    try {
      final rows = await state.loadAutomations();
      if (!current()) return;
      setState(() {
        _items = rows;
        _error = '';
      });
    } on ApiFailure catch (error) {
      if (current()) setState(() => _error = error.message);
    } finally {
      if (current() && !silent) setState(() => _loading = false);
    }
  }

  Future<void> _loadTemplates() async {
    final identity = _identity;
    final request = ++_templateRequest;
    try {
      final rows = await _state!.api.automationTemplates();
      if (!_current || identity != _identity || request != _templateRequest) {
        return;
      }
      setState(() {
        _templates = rows.where((row) => row['enabled'] != false).toList();
        _templateError = '';
      });
    } on ApiFailure catch (error) {
      if (!_current || identity != _identity || request != _templateRequest) {
        return;
      }
      setState(() => _templateError = error.message);
    }
  }

  Future<void> _fromTemplate() async {
    if (!_current || _editorOpen) return;
    final identity = _identity;
    setState(() => _editorOpen = true);
    try {
      final values = await showAutomationTemplates(context, _templates);
      if (!mounted || !_current || identity != _identity || values == null) {
        return;
      }
      await showAutomationEditor(context, initialValues: values);
      if (_current && identity == _identity) await _load(silent: true);
    } finally {
      if (_current && identity == _identity) {
        setState(() => _editorOpen = false);
      }
    }
  }

  Future<void> _requireReady(AutomationSchedule item) async {
    final state = _state!;
    final identity = _identity;
    void checkCurrent() {
      if (!_current || !identical(state, _state) || identity != _identity) {
        throw const ApiFailure('账号已变化，请重新打开自动化。');
      }
    }

    final result = await state.api.preflightAutomation({'scheduleId': item.id});
    checkCurrent();
    if (result['state'] != 'ready') {
      throw ApiFailure(result['message']?.toString() ?? '执行条件尚未就绪，请检查执行底座后重试。');
    }
    await ensureAutomationExecutionReady(
      state.api,
      configuration: {
        ...item.configuration,
        'pluginBindingId': item.pluginBindingId,
      },
      checkCurrent: checkCurrent,
      preflight: result,
    );
  }

  Future<void> _toggle(AutomationSchedule item, bool enabled) async {
    if (!_current || _busyIds.contains(item.id)) return;
    final identity = _identity;
    bool current() => _current && identity == _identity;
    setState(() {
      _busyIds.add(item.id);
      _actionErrors.remove(item.id);
    });
    try {
      if (enabled) await _requireReady(item);
      if (!current()) return;
      final updated = await _state!.setAutomationEnabled(item, enabled);
      if (!current()) return;
      if (updated.id != item.id || updated.enabled != enabled) {
        throw const ApiFailure('启停结果尚未确认，请刷新自动化列表核对。', isNetwork: true);
      }
      setState(() {
        final index = _items.indexWhere((row) => row.id == updated.id);
        if (index >= 0) _items = [..._items]..[index] = updated;
      });
      _toast(enabled ? '自动化已启用' : '自动化已暂停');
    } on ApiFailure catch (error) {
      if (current()) {
        setState(() => _actionErrors[item.id] = error.message);
      }
    } finally {
      if (current()) setState(() => _busyIds.remove(item.id));
    }
  }

  Future<void> _run(AutomationSchedule item) async {
    if (!_current || _busyIds.contains(item.id)) return;
    final identity = _identity;
    final state = _state;
    bool current() =>
        _current && identical(state, _state) && identity == _identity;
    if (_uncertainRuns.contains(item.id)) {
      final confirmed = await showDialog<bool>(
        context: context,
        useRootNavigator: false,
        builder: (context) => AlertDialog(
          title: Text(mobileText(context, '确认再次运行？')),
          content: Text(
            mobileText(context, '上次运行结果尚未确认。请先核对运行记录；再次运行可能产生另一条运行记录。'),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(mobileText(context, '返回核对')),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(mobileText(context, '确认再次运行')),
            ),
          ],
        ),
      );
      if (!current() || confirmed != true) return;
    }
    setState(() {
      _busyIds.add(item.id);
      _actionErrors.remove(item.id);
    });
    var submitting = false;
    try {
      await _requireReady(item);
      if (!current()) return;
      submitting = true;
      final receipt = await state!.runAutomation(item);
      if (!current()) return;
      if (receipt['ok'] != true ||
          (receipt['scheduleRunId']?.toString().trim() ?? '').isEmpty) {
        throw const ApiFailure('运行结果尚未确认，请查看运行记录核对。', isNetwork: true);
      }
      _uncertainRuns.remove(item.id);
      _toast(
        receipt['waitingForDevice'] == true
            ? '已安排运行，等待在线电脑接收；可在运行记录中跟进'
            : '已发起运行，可在运行记录中跟进',
      );
    } on ApiFailure catch (error) {
      if (!current()) return;
      setState(() => _actionErrors[item.id] = error.message);
      if (submitting && (error.isNetwork || error.status >= 500)) {
        _uncertainRuns.add(item.id);
        _toast('运行结果尚未确认，请先核对运行记录，避免重复运行。');
      }
    } catch (_) {
      if (!current()) return;
      if (submitting) _uncertainRuns.add(item.id);
      _toast(submitting ? '运行结果尚未确认，请先核对运行记录。' : '暂时无法检查执行条件，请重试。');
    } finally {
      if (current()) {
        setState(() => _busyIds.remove(item.id));
        if (submitting) {
          unawaited(_load(silent: true));
          _openRuns(item);
        }
      }
    }
  }

  Future<void> _edit([AutomationSchedule? item]) async {
    if (!_current || _editorOpen) return;
    if (item == null && widget.onCreate != null) {
      widget.onCreate!();
      return;
    }
    final identity = _identity;
    setState(() => _editorOpen = true);
    try {
      if (item == null) {
        await showAutomationChat(context);
      } else {
        await showAutomationEditor(context, schedule: item);
      }
      if (_current && identity == _identity) await _load(silent: true);
    } finally {
      if (_current && identity == _identity) {
        setState(() => _editorOpen = false);
      }
    }
  }

  Future<void> _delete(AutomationSchedule item) async {
    if (!_current || _busyIds.contains(item.id)) return;
    final identity = _identity;
    final confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: false,
      builder: (context) => AlertDialog(
        title: Text(mobileText(context, '删除自动化？')),
        content: Text(
          mobileText(
            context,
            "删除“{0}”后不再按此计划触发。已经开始的工作不会因此停止。",
            values: [item.title],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(mobileText(context, '取消')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(mobileText(context, '删除')),
          ),
        ],
      ),
    );
    if (confirmed != true || !_current || identity != _identity) return;
    setState(() {
      _busyIds.add(item.id);
      _actionErrors.remove(item.id);
    });
    try {
      await _state!.api.deleteAutomation(item.id);
      if (!_current || identity != _identity) return;
      setState(
        () => _items = _items.where((row) => row.id != item.id).toList(),
      );
      _toast('自动化已删除');
    } on ApiFailure catch (error) {
      if (_current && identity == _identity) {
        _toast(error.isNetwork ? '删除结果尚未确认，请刷新列表核对。' : error.message);
      }
    } finally {
      if (_current && identity == _identity) {
        setState(() => _busyIds.remove(item.id));
      }
    }
  }

  void _openRuns(AutomationSchedule item) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _RunHistorySheet(schedule: item),
    );
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(mobileText(context, message))));
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    final enabled = _items.where((item) => item.enabled).length;
    final retrying = _items.where((item) => item.retrying).length;
    final attention = _items.where((item) => item.needsAttention).length;
    final rows = _items.where((item) {
      final matches = '${item.title} ${item.note}'.toLowerCase().contains(
        _query.toLowerCase(),
      );
      return matches &&
          switch (_filter) {
            'enabled' => item.enabled,
            'paused' => !item.enabled,
            'attention' => item.needsAttention || item.retrying,
            _ => true,
          };
    }).toList();
    return Scaffold(
      appBar: MobileSheetScope.maybeOf(context) != null
          ? null
          : AppBar(
              title: Text(mobileText(context, '我的自动化')),
              actions: [
                IconButton(
                  tooltip: mobileText(context, '刷新'),
                  onPressed: _loading ? null : _load,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
      body: PinnedListLayout(
        onRefresh: _load,
        controller: MobileSheetScope.maybeOf(context)?.scrollController,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
        header: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              FilledButton.icon(
                onPressed: _editorOpen ? null : () => _edit(),
                icon: const Icon(Icons.add_rounded),
                label: Text(mobileText(context, '新建自动化')),
              ),
              if (_templates.isNotEmpty)
                TextButton.icon(
                  onPressed: _editorOpen ? null : _fromTemplate,
                  icon: const Icon(Icons.auto_awesome_motion_outlined),
                  label: Text(mobileText(context, '使用组织模板')),
                ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            _state?.api.isLocalDevelopment == true
                ? mobileText(context, '本地联调环境：计划按所选执行位置运行，请保持对应执行机在线。')
                : mobileText(context, '查看执行计划、运行记录与失败恢复。'),
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 16),
          _AutomationSummary(
            enabled: enabled,
            retrying: retrying,
            attention: attention,
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _search,
            onChanged: (value) => setState(() => _query = value),
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search_rounded),
              hintText: mobileText(context, '搜索计划名称或内容'),
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      tooltip: mobileText(context, '清空搜索'),
                      icon: const Icon(Icons.close_rounded),
                      onPressed: () => setState(() {
                        _search.clear();
                        _query = '';
                      }),
                    ),
            ),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final option in const [
                ('all', '全部'),
                ('enabled', '已启用'),
                ('paused', '已暂停'),
                ('attention', '需处理'),
              ])
                ChoiceChip(
                  label: Text(mobileText(context, option.$2)),
                  selected: _filter == option.$1,
                  onSelected: (_) => setState(() => _filter = option.$1),
                ),
            ],
          ),
        ],
        children: [
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          if (_error.isNotEmpty && _items.isEmpty)
            Text(
              mobileText(context, '自动化暂时无法加载'),
              style: Theme.of(context).textTheme.titleMedium,
            ),
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: InlineError(
                message: mobileText(context, _error),
                onRetry: _load,
              ),
            ),
          if (_templateError.isNotEmpty)
            TextButton.icon(
              onPressed: _loadTemplates,
              icon: const Icon(Icons.refresh_rounded),
              label: Text(mobileText(context, '模板加载失败，点击重试')),
            ),
          if (!_loading && _error.isEmpty && rows.isEmpty)
            WorkSurface(
              padding: EdgeInsets.zero,
              child: SoduWorkEmptyState(
                icon: Icons.auto_mode_outlined,
                title: mobileText(
                  context,
                  _items.isEmpty ? '还没有个人自动化' : '没有匹配的计划',
                ),
                message: mobileText(
                  context,
                  _items.isEmpty
                      ? '可在这里新建计划。当前服务按设备保存自动化；电脑端已有计划不会自动出现在此设备。'
                      : '调整筛选条件或清空搜索后再试。',
                ),
              ),
            ),
          for (final item in rows)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: _AutomationCard(
                item: item,
                busy: _busyIds.contains(item.id),
                actionError: _actionErrors[item.id] ?? '',
                onToggle: (value) => _toggle(item, value),
                onRun: () => _run(item),
                onRuns: () => _openRuns(item),
                onEdit: () => _edit(item),
                onDelete: () => _delete(item),
              ),
            ),
        ],
      ),
    );
  }
}

class _AutomationSummary extends StatelessWidget {
  final int enabled;
  final int retrying;
  final int attention;

  const _AutomationSummary({
    required this.enabled,
    required this.retrying,
    required this.attention,
  });

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 16,
      runSpacing: 8,
      children: [
        for (final metric in [
          (enabled, '已启用', context.soduWorkTheme.success),
          (retrying, '重试中', context.soduWorkTheme.warning),
          (attention, '需处理', context.soduWorkTheme.danger),
        ])
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.circle, size: 6, color: metric.$3),
              const SizedBox(width: 6),
              Text(
                '${mobileText(context, metric.$2)} ${metric.$1}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
      ],
    );
  }
}

class _AutomationCard extends StatelessWidget {
  final AutomationSchedule item;
  final bool busy;
  final String actionError;
  final ValueChanged<bool> onToggle;
  final VoidCallback onRun;
  final VoidCallback onRuns;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  const _AutomationCard({
    required this.item,
    required this.busy,
    required this.onToggle,
    required this.actionError,
    required this.onRun,
    required this.onRuns,
    required this.onEdit,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    final brand = context.soduWorkTheme;
    final fired =
        item.every == 'once' && item.configuration['onceFired'] == true;
    final state = item.needsAttention
        ? ('运行失败', brand.danger, brand.dangerSoft)
        : item.retrying
        ? ('正在重试', brand.warning, brand.warningSoft)
        : fired
        ? ('已触发一次', brand.inkMuted, brand.surfaceMuted)
        : item.enabled
        ? ('已启用', brand.success, brand.successSoft)
        : ('已暂停', brand.inkMuted, brand.surfaceMuted);
    return WorkSurface(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: brand.primarySoft,
                  borderRadius: BorderRadius.circular(13),
                ),
                child: Icon(Icons.auto_mode_rounded, color: brand.primary),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 5),
                    StatePill(
                      label: mobileText(context, state.$1),
                      color: state.$2,
                      background: state.$3,
                    ),
                  ],
                ),
              ),
              PopupMenuButton<String>(
                tooltip: mobileText(context, '管理自动化'),
                enabled: !busy,
                onSelected: (value) => value == 'edit' ? onEdit() : onDelete(),
                itemBuilder: (_) => [
                  PopupMenuItem(
                    value: 'edit',
                    child: Text(mobileText(context, '编辑计划')),
                  ),
                  PopupMenuItem(
                    value: 'delete',
                    child: Text(mobileText(context, '删除计划')),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  mobileText(context, fired ? '再次定时运行，请修改时间' : '按计划自动运行'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
              Switch.adaptive(
                value: item.enabled,
                onChanged: busy || fired ? null : onToggle,
              ),
            ],
          ),
          if (item.note.isNotEmpty) ...[
            const SizedBox(height: 13),
            Text(
              item.note,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
          const SizedBox(height: 15),
          _MetaLine(
            icon: Icons.schedule_rounded,
            label: '下次运行',
            value: fired
                ? mobileText(
                    context,
                    item.retrying ? '等待重试' : '本次定时已触发，进展请查看运行记录',
                  )
                : !item.enabled
                ? mobileText(context, '已暂停，启用后安排')
                : item.nextRunLocal.isEmpty
                ? mobileText(context, '等待服务端安排')
                : _friendlyTime(item.nextRunLocal),
          ),
          const SizedBox(height: 9),
          _MetaLine(
            icon: Icons.extension_outlined,
            label: '执行方式',
            value: mobileText(context, item.methodLabel),
          ),
          const SizedBox(height: 9),
          _MetaLine(
            icon: Icons.public_rounded,
            label: '时区',
            value: item.timeZone,
          ),
          if (item.requiredCapabilities.isNotEmpty) ...[
            const SizedBox(height: 9),
            _MetaLine(
              icon: Icons.bolt_rounded,
              label: '能力',
              value: item.requiredCapabilities.join(' · '),
            ),
          ],
          if (item.retrying) ...[
            const SizedBox(height: 12),
            _NoticeStrip(
              icon: Icons.refresh_rounded,
              color: brand.warning,
              background: brand.warningSoft,
              message:
                  '第 ${item.retryCount}/${item.retryLimit} 次恢复${item.nextRetryAt.isEmpty ? '' : ' · ${_friendlyTime(item.nextRetryAt)}'}',
            ),
          ] else if (item.lastError.isNotEmpty) ...[
            const SizedBox(height: 12),
            _NoticeStrip(
              icon: Icons.error_outline_rounded,
              color: brand.danger,
              background: brand.dangerSoft,
              message: item.lastError,
            ),
          ],
          const SizedBox(height: 15),
          Divider(height: 1, color: brand.line),
          const SizedBox(height: 10),
          OverflowBar(
            alignment: MainAxisAlignment.spaceBetween,
            overflowAlignment: OverflowBarAlignment.end,
            spacing: 8,
            overflowSpacing: 8,
            children: [
              TextButton.icon(
                onPressed: onRuns,
                icon: const Icon(Icons.history_rounded, size: 19),
                label: Text(mobileText(context, '运行记录')),
              ),
              FilledButton.tonalIcon(
                onPressed: busy ? null : onRun,
                icon: busy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.play_arrow_rounded, size: 20),
                label: Text(
                  busy
                      ? mobileText(context, '正在发起')
                      : mobileText(context, '立即运行'),
                ),
              ),
            ],
          ),
          if (actionError.isNotEmpty) ...[
            const SizedBox(height: 12),
            _NoticeStrip(
              icon: Icons.info_outline_rounded,
              color: brand.warning,
              background: brand.warningSoft,
              message: actionError,
            ),
          ],
        ],
      ),
    );
  }
}

class _MetaLine extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _MetaLine({
    required this.icon,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 18, color: context.soduWorkTheme.inkMuted),
        const SizedBox(width: 8),
        SizedBox(
          width: 62,
          child: Text(
            mobileText(context, label),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: Theme.of(
              context,
            ).textTheme.bodyMedium?.copyWith(color: context.soduWorkTheme.ink),
          ),
        ),
      ],
    );
  }
}

class _NoticeStrip extends StatelessWidget {
  final IconData icon;
  final Color color;
  final Color background;
  final String message;

  const _NoticeStrip({
    required this.icon,
    required this.color,
    required this.background,
    required this.message,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: color),
            ),
          ),
        ],
      ),
    );
  }
}

class _RunHistorySheet extends StatefulWidget {
  final AutomationSchedule schedule;

  const _RunHistorySheet({required this.schedule});

  @override
  State<_RunHistorySheet> createState() => _RunHistorySheetState();
}

class _RunHistorySheetState extends State<_RunHistorySheet>
    with WidgetsBindingObserver {
  List<AutomationRun> _items = const [];
  bool _loading = true;
  String _error = '';
  MobileState? _state;
  int? _identity;
  int _request = 0;
  bool _accountChanged = false;
  Timer? _refreshTimer;
  String? _opening;
  String? _resultErrorId;
  String _resultError = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _refreshTimer?.cancel();
    if (state == AppLifecycleState.resumed && !_accountChanged && !_loading) {
      _load();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state == null) {
      _state = state;
      _identity = state.identityRevision;
      _load();
    } else if (_state != state || _identity != state.identityRevision) {
      _request++;
      _items = const [];
      _opening = null;
      _resultErrorId = null;
      _resultError = '';
      _loading = false;
      _accountChanged = true;
      _refreshTimer?.cancel();
      _error = '账号已变化，请关闭后重新打开运行记录。';
    }
  }

  Future<void> _load() async {
    if (_accountChanged || !mounted) return;
    _refreshTimer?.cancel();
    final state = _state!;
    final identity = _identity;
    final request = ++_request;
    bool current() =>
        mounted &&
        !_accountChanged &&
        state.identityRevision == identity &&
        request == _request;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final rows = await state.loadAutomationRuns(widget.schedule.id);
      if (!current()) return;
      setState(() => _items = rows);
    } on ApiFailure catch (error) {
      if (current()) setState(() => _error = error.message);
    } finally {
      if (current()) {
        setState(() => _loading = false);
        if (_items.any((item) => item.active) &&
            (WidgetsBinding.instance.lifecycleState == null ||
                WidgetsBinding.instance.lifecycleState ==
                    AppLifecycleState.resumed)) {
          _refreshTimer = Timer(const Duration(seconds: 5), () {
            if (current()) _load();
          });
        }
      }
    }
  }

  Future<void> _openResult(AutomationRun run) async {
    if (_opening != null || _accountChanged || !mounted) return;
    final state = _state!;
    final identity = _identity;
    bool current() =>
        mounted &&
        !_accountChanged &&
        identical(_state, state) &&
        state.identityRevision == identity;
    setState(() {
      _opening = run.id;
      _resultErrorId = null;
      _resultError = '';
    });
    try {
      final result = await AutomationRunDestination.resolve(
        run: run,
        api: state.api,
        ownerClientId:
            (widget.schedule.configuration['ownerClientId'] ??
                    state.enrollment?.deviceId ??
                    '')
                .toString(),
        isCurrent: current,
      );
      if (!mounted || !current()) return;
      if (result.cloud) {
        await openWorkConversation(
          context,
          taskId: result.taskId,
          title: run.resultTitle.isEmpty
              ? widget.schedule.title
              : run.resultTitle,
          ref: result.ref,
        );
        return;
      }
      final Widget screen = result.account != null
          ? AccountConversationScreen(conversation: result.account!)
          : TaskDetailScreen(taskId: result.taskId);
      await Navigator.of(
        context,
      ).push(MaterialPageRoute<void>(builder: (_) => screen));
    } catch (error) {
      if (current()) {
        setState(() {
          _resultErrorId = run.id;
          _resultError = error is ApiFailure
              ? error.message
              : '暂时无法读取运行结果，请重试。';
        });
      }
    } finally {
      if (current()) setState(() => _opening = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FractionallySizedBox(
      heightFactor: 0.88,
      child: Material(
        color: context.soduWorkTheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            const SizedBox(height: 10),
            Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(
                color: context.soduWorkTheme.lineStrong,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 12, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          mobileText(context, '运行记录'),
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          widget.schedule.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: mobileText(context, '刷新'),
                    onPressed: _loading || _accountChanged ? null : _load,
                    icon: const Icon(Icons.refresh_rounded),
                  ),
                  IconButton(
                    tooltip: mobileText(context, '关闭'),
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: context.soduWorkTheme.line),
            if (_error.isNotEmpty && _items.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  '刷新失败，以下为上次读取的记录：$_error',
                  style: TextStyle(color: context.soduWorkTheme.danger),
                ),
              ),
            Expanded(
              child: _loading && _items.isEmpty
                  ? LoadingPane(label: mobileText(context, '正在读取真实运行回执…'))
                  : _error.isNotEmpty && _items.isEmpty
                  ? EmptyPane(
                      icon: Icons.history_toggle_off_rounded,
                      title: '运行记录加载失败',
                      message: mobileText(context, _error),
                      actionLabel: _accountChanged ? null : '重试',
                      onAction: _accountChanged ? null : _load,
                    )
                  : _items.isEmpty
                  ? const EmptyPane(
                      icon: Icons.history_rounded,
                      title: '还没有运行记录',
                      message: '首次按计划触发或手动运行后，这里会保留可追溯回执。',
                    )
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
                        itemCount: _items.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 10),
                        itemBuilder: (context, index) => _RunCard(
                          item: _items[index],
                          onTask: _items[index].hasResult && _opening == null
                              ? () => _openResult(_items[index])
                              : null,
                          opening: _opening == _items[index].id,
                          resultError: _resultErrorId == _items[index].id
                              ? _resultError
                              : '',
                        ),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RunCard extends StatelessWidget {
  final AutomationRun item;
  final VoidCallback? onTask;
  final bool opening;
  final String resultError;

  const _RunCard({
    required this.item,
    this.onTask,
    this.opening = false,
    this.resultError = '',
  });

  @override
  Widget build(BuildContext context) {
    final brand = context.soduWorkTheme;
    final color = item.succeeded
        ? brand.success
        : item.active
        ? brand.warning
        : brand.danger;
    final background = item.succeeded
        ? brand.successSoft
        : item.active
        ? brand.warningSoft
        : brand.dangerSoft;
    return WorkSurface(
      padding: const EdgeInsets.all(15),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              StatePill(
                label: mobileText(context, item.stateLabel),
                color: color,
                background: background,
              ),
              const SizedBox(width: 8),
              Text(
                mobileText(context, item.triggerLabel),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const Spacer(),
              Text(
                _friendlyTime(item.startedAt),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          if (item.resultTitle.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(
              item.resultTitle,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ],
          if (item.pluginLabel.isNotEmpty) ...[
            const SizedBox(height: 9),
            _MetaLine(
              icon: Icons.extension_outlined,
              label: '插件',
              value: item.pluginLabel,
            ),
          ],
          if (item.routeLabel.isNotEmpty) ...[
            const SizedBox(height: 8),
            _MetaLine(
              icon: Icons.route_outlined,
              label: '执行路径',
              value: item.routeLabel,
            ),
          ],
          if (item.durationSeconds != null) ...[
            const SizedBox(height: 8),
            _MetaLine(
              icon: Icons.timer_outlined,
              label: '耗时',
              value: _durationLabel(context, item.durationSeconds!),
            ),
          ],
          if (item.error.isNotEmpty) ...[
            const SizedBox(height: 11),
            _NoticeStrip(
              icon: Icons.error_outline_rounded,
              color: brand.danger,
              background: brand.dangerSoft,
              message: item.error,
            ),
          ],
          if (resultError.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(resultError, style: TextStyle(color: brand.danger)),
          ],
          if (!item.hasResult && item.conversationMode) ...[
            const SizedBox(height: 10),
            Text(
              '尚未收到会话回执，可刷新记录后查看。',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          if (item.hasResult) ...[
            const SizedBox(height: 9),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton.icon(
                onPressed: onTask,
                icon: opening
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.open_in_new_rounded, size: 18),
                label: Text(
                  mobileText(
                    context,
                    opening
                        ? '正在读取结果…'
                        : resultError.isNotEmpty
                        ? '重试查看结果'
                        : item.conversationId.isNotEmpty
                        ? '查看会话结果'
                        : '查看关联任务',
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

String _friendlyTime(String value) {
  if (value.isEmpty) return '—';
  final parsed = DateTime.tryParse(value.replaceFirst(' ', 'T'));
  if (parsed == null) return value;
  final time = parsed.isUtc ? parsed.toLocal() : parsed;
  String two(int number) => number.toString().padLeft(2, '0');
  return '${two(time.month)}/${two(time.day)} ${two(time.hour)}:${two(time.minute)}';
}

String _durationLabel(BuildContext context, int seconds) {
  if (seconds < 60) return mobileText(context, '{0} 秒', values: [seconds]);
  final minutes = seconds ~/ 60;
  final remain = seconds % 60;
  return remain == 0
      ? mobileText(context, '{0} 分钟', values: [minutes])
      : mobileText(context, '{0} 分 {1} 秒', values: [minutes, remain]);
}

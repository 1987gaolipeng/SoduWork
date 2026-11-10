import '../ui/pinned_list_layout.dart';
import '../ui/mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../state/session_feed.dart';
import '../ui/mobile_chrome.dart';
import '../ui/mobile_theme.dart';
import '../ui/task_forms.dart';
import '../ui/requirement_capabilities.dart';
import '../ui/work_widgets.dart';
import 'approval_detail_screen.dart';
import 'notifications_screen.dart';
import 'task_detail_screen.dart';

/// The requirement pool uses the shared Task store without including ordinary
/// conversation receipts or automation runs. Their histories remain separate.
class WorkScreen extends StatefulWidget {
  final VoidCallback? onCreate;
  const WorkScreen({super.key, this.onCreate});

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

class _WorkScreenState extends State<WorkScreen> {
  final _search = TextEditingController();
  String _filter = 'all';
  String _scope = 'all';
  bool _archived = false;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<SessionFeedEntry> _rows(List<SessionFeedEntry> source) {
    final query = _search.text.trim().toLowerCase();
    return source
        .where((entry) {
          if (_filter != 'all' &&
              (entry.task.boardStage == 'clarifying'
                      ? 'intake'
                      : entry.task.boardStage) !=
                  _filter) {
            return false;
          }
          if (query.isEmpty) return true;
          return entry.task.title.toLowerCase().contains(query) ||
              entry.task.note.toLowerCase().contains(query) ||
              entry.task.tags.any((tag) => tag.toLowerCase().contains(query));
        })
        .toList(growable: false);
  }

  Future<void> _createTask() async {
    if (widget.onCreate != null) {
      widget.onCreate!();
      return;
    }
    final task = await showModalBottomSheet<WorkTask>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => const CreateTaskSheet(),
    );
    if (task == null || !mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TaskDetailScreen(taskId: task.id),
      ),
    );
  }

  void _openEntry(SessionFeedEntry entry) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TaskDetailScreen(taskId: entry.task.id),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final state = MobileScope.of(context);
    final pending = state.requirementApprovals
        .map((item) => item.task.id)
        .toSet();
    final feed = buildSessionFeed(
      state.requirementTasks.where(
        (task) =>
            (task.boardStage == 'closed') == _archived &&
            requirementMatchesScope(task, _scope, pending),
      ),
    );
    final rows = _rows(feed);
    final filters = [
      ('all', '全部', feed.length),
      for (final stage in const [
        ('intake', '收集箱'),
        ('ready', '待开始'),
        ('delivering', '进行中'),
        ('reviewing', '待验收'),
        ('delivered', '已完成'),
      ])
        (
          stage.$1,
          stage.$2,
          feed
              .where(
                (entry) =>
                    (entry.task.boardStage == 'clarifying'
                        ? 'intake'
                        : entry.task.boardStage) ==
                    stage.$1,
              )
              .length,
        ),
    ];

    return SafeArea(
      bottom: false,
      child: PinnedListLayout(
        onRefresh: MobileScope.read(context).refreshAll,
        padding: EdgeInsets.zero,
        header: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 14, 8, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _archived
                        ? mobileText(context, '归档需求')
                        : mobileText(context, '需求池'),
                    style: TextStyle(
                      color: theme.ink,
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -.5,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: _archived
                      ? mobileText(context, '返回需求池')
                      : mobileText(context, '归档需求'),
                  onPressed: () => setState(() {
                    _archived = !_archived;
                    _filter = 'all';
                    _scope = 'all';
                  }),
                  icon: Icon(
                    _archived ? Icons.inventory_2 : Icons.inventory_2_outlined,
                  ),
                ),
                IconButton(
                  tooltip: mobileText(context, '通知'),
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => Theme(
                        data: Theme.of(context),
                        child: const NotificationsScreen(),
                      ),
                    ),
                  ),
                  icon: Badge(
                    isLabelVisible: (state.unreadMessageCount ?? 0) > 0,
                    label: Text('${state.unreadMessageCount}'),
                    child: const Icon(
                      Icons.notifications_none_rounded,
                      size: 24,
                    ),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Wrap(
              spacing: 12,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                FilledButton.icon(
                  onPressed: _createTask,
                  icon: const Icon(Icons.add_rounded),
                  label: Text(mobileText(context, '新建需求')),
                ),
                Text(
                  mobileText(context, '从需求到执行，跟进每一步'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 2, 20, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  height: 44,
                  child: TextField(
                    controller: _search,
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      hintText: mobileText(context, '搜索需求'),
                      prefixIcon: const Icon(Icons.search_rounded, size: 19),
                      suffixIcon: _search.text.isEmpty
                          ? null
                          : IconButton(
                              tooltip: mobileText(context, '清空'),
                              onPressed: () {
                                _search.clear();
                                setState(() {});
                              },
                              icon: const Icon(Icons.close_rounded, size: 18),
                            ),
                    ),
                  ),
                ),
                const SizedBox(height: 11),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      for (final scope in const [
                        ('all', '全部'),
                        ('related', '与我相关'),
                        ('created', '我提出'),
                        ('assigned', '我承办'),
                        ('actionable', '需要我处理'),
                      ])
                        if (!_archived ||
                            !{'created', 'actionable'}.contains(scope.$1))
                          Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: ChoiceChip(
                              label: Text(mobileText(context, scope.$2)),
                              selected: _scope == scope.$1,
                              onSelected: (_) =>
                                  setState(() => _scope = scope.$1),
                            ),
                          ),
                    ],
                  ),
                ),
                if (!_archived) const SizedBox(height: 8),
                if (!_archived)
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: [
                        for (final filter in filters)
                          Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: ChoiceChip(
                              label: Text(
                                '${mobileText(context, filter.$2)} ${filter.$3}',
                              ),
                              selected: _filter == filter.$1,
                              onSelected: (_) =>
                                  setState(() => _filter = filter.$1),
                            ),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
        children: [
          if (state.syncing && feed.isNotEmpty)
            LinearProgressIndicator(
              minHeight: 1.5,
              color: theme.secondary,
              backgroundColor: Colors.transparent,
            ),
          if (state.refreshError.isNotEmpty)
            InlineError(message: state.refreshError, onRetry: state.refreshAll),
          if (!_archived && state.requirementApprovals.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: _Group(
                children: [
                  for (final item in state.requirementApprovals.take(3))
                    ApprovalLaneRow(
                      title: item.task.title,
                      detail: item.hasGateContract
                          ? '${item.actionLabel} · 已附 ${item.evidenceCount} 份证据'
                          : item.actionLabel,
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) =>
                              ApprovalDetailScreen(approvalId: item.id),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],
          if (rows.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 10, 20, 24),
              child: _Group(
                children: [
                  SoduWorkEmptyState(
                    icon: Icons.workspaces_outlined,
                    title: _archived
                        ? mobileText(context, '暂无符合条件的归档需求')
                        : mobileText(context, '暂无符合条件的需求'),
                    message: _archived
                        ? mobileText(context, '归档会保留需求和成果，在详情中可以恢复。')
                        : mobileText(context, '可调整视角和阶段，或点击“新建需求”记录工作。'),
                  ),
                ],
              ),
            )
          else
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 2, 20, 24),
              child: _Group(
                child: Column(
                  children: [
                    for (var index = 0; index < rows.length; index++) ...[
                      _WorkRow(
                        entry: rows[index],
                        onTap: () => _openEntry(rows[index]),
                      ),
                      if (index < rows.length - 1)
                        Divider(indent: 40, endIndent: 14),
                    ],
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// One pending approval as a compact lane row.
class ApprovalLaneRow extends StatelessWidget {
  final String title;
  final String detail;
  final VoidCallback onTap;

  const ApprovalLaneRow({
    super.key,
    required this.title,
    required this.detail,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
          child: Row(
            children: [
              Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(
                  color: theme.primarySoft,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.verified_outlined,
                  size: 17,
                  color: theme.primary,
                ),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: theme.ink,
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      detail,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: theme.inkMuted, fontSize: 11.5),
                    ),
                  ],
                ),
              ),
              StatePill(
                label: mobileText(context, '待确认'),
                color: theme.primary,
                background: theme.primarySoft,
              ),
              const SizedBox(width: 2),
              Icon(
                Icons.chevron_right_rounded,
                size: 18,
                color: theme.inkMuted,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WorkRow extends StatelessWidget {
  final SessionFeedEntry entry;
  final VoidCallback onTap;

  const _WorkRow({required this.entry, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final tone = entry.tone;
    final accent = switch (tone) {
      SessionTone.attention => theme.danger,
      SessionTone.done => theme.success,
      SessionTone.running => theme.secondary,
      SessionTone.idle => theme.inkMuted,
    };
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
          child: Row(
            children: [
              StatusBeacon(size: 8, color: accent, pulse: entry.running),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      entry.task.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: theme.ink,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            entry.task.assigneeName.isNotEmpty
                                ? entry.task.assigneeName
                                : entry.agentLabel,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: theme.inkMuted,
                              fontSize: 11.5,
                            ),
                          ),
                        ),
                        if (entry.lastActivity.isNotEmpty) ...[
                          Text(
                            ' · ',
                            style: TextStyle(
                              color: theme.inkMuted,
                              fontSize: 11.5,
                            ),
                          ),
                          Flexible(
                            child: Text(
                              entry.lastActivity,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: theme.inkMuted,
                                fontSize: 11.5,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Text(
                formatRelativeTime(
                  DateTime.fromMillisecondsSinceEpoch(entry.task.createdAt),
                  context: context,
                ),
                style: TextStyle(
                  color: theme.inkMuted.withValues(alpha: .75),
                  fontSize: 11,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Borderless white group (hairline border, soft corners) used across the
/// work tab so lists read as calm text, not stacked cards.
class _Group extends StatelessWidget {
  final List<Widget>? children;
  final Widget? child;

  const _Group({this.children, this.child});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Container(
      decoration: BoxDecoration(
        color: theme.surface,
        borderRadius: BorderRadius.circular(theme.radiusMedium),
        border: Border.all(color: theme.line.withValues(alpha: .5)),
      ),
      child: children != null ? Column(children: children!) : child,
    );
  }
}

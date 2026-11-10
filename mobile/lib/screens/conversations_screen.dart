import '../ui/mobile_input_border.dart';
import '../ui/mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../core/device_store.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../state/session_feed.dart';
import '../sdk/soduwork_brand.dart';
import '../ui/conversation_composer.dart';
import '../ui/mobile_chrome.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';
import '../ui/open_work_conversation.dart';
import 'notifications_screen.dart';
import 'task_detail_screen.dart';

/// The conversations tab, styled after the DeepSeek / ChatGPT mobile homes:
/// a calm, text-first session list with one prominent dispatch button.
class ConversationsScreen extends StatefulWidget {
  const ConversationsScreen({super.key});

  @override
  State<ConversationsScreen> createState() => _ConversationsScreenState();
}

class _ConversationsScreenState extends State<ConversationsScreen> {
  bool _initialised = false;
  bool _loading = false;
  String _error = '';
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _search.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.read(context);
    // The hub only talks to the backend once enrollment is ready; in widget
    // tests a bare MobileState never triggers any request.
    if (state.phase != MobilePhase.ready || state.enrollment == null) return;
    if (_initialised) return;
    _initialised = true;
    // Defer out of the build phase: refresh notifies listeners, which would
    // mark the scope dirty while the framework is still building.
    Future.microtask(_refresh);
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final state = MobileScope.read(context);
      await state.refreshAll();
      await state.loadConversations();
      if (mounted) setState(() => _loading = false);
    } catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = '会话暂时没有同步过来：$error';
        });
      }
    }
  }

  Future<void> _dispatch() async {
    final receipt = await showConversationComposer(context);
    if (receipt == null || !mounted) return;
    final taskId = (receipt['taskId'] ?? '').toString();
    if (taskId.isEmpty) {
      await _refresh();
      return;
    }
    // Open the dispatched task's conversation immediately for follow-up instructions and progress.
    final task = MobileScope.read(context).findTask(taskId);
    await openWorkConversation(
      context,
      taskId: taskId,
      title: task?.title ?? '新的会话',
      agentLabel: task?.aiName ?? '',
    );
    if (mounted) await _refresh();
  }

  void _openEntry(SessionFeedEntry entry) {
    if (entry.isCloudConversation) {
      openWorkConversation(
        context,
        taskId: entry.task.id,
        title: entry.task.title,
        agentLabel: entry.agentLabel,
      );
    } else {
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => TaskDetailScreen(taskId: entry.task.id),
        ),
      );
    }
  }

  bool _matches(SessionFeedEntry entry, String query) {
    if (query.isEmpty) return true;
    final task = entry.task;
    return task.title.toLowerCase().contains(query) ||
        task.note.toLowerCase().contains(query) ||
        entry.agentLabel.toLowerCase().contains(query) ||
        task.tags.any((tag) => tag.toLowerCase().contains(query));
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final state = MobileScope.of(context);
    final query = _search.text.trim().toLowerCase();
    final entries = buildSessionFeed(
      state.tasks,
    ).where((e) => _matches(e, query)).toList();
    final running = entries.where((entry) => entry.running).toList();
    const maxIdleRows = 14;
    final idle = entries
        .where((entry) => !entry.running)
        .take(maxIdleRows)
        .toList(growable: false);

    return Scaffold(
      backgroundColor: theme.canvas,
      floatingActionButton: _DispatchButton(onPressed: _dispatch),
      floatingActionButtonLocation: FloatingActionButtonLocation.centerFloat,
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.only(bottom: 110),
            children: [
              _HomeHeader(state: state),
              if (state.syncing && entries.isNotEmpty)
                LinearProgressIndicator(
                  minHeight: 1.5,
                  color: theme.secondary,
                  backgroundColor: Colors.transparent,
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (state.refreshError.isNotEmpty) ...[
                      InlineError(
                        message: state.refreshError,
                        onRetry: state.refreshAll,
                      ),
                      const SizedBox(height: 12),
                    ],
                    _SearchField(controller: _search),
                    const SizedBox(height: 14),
                    if (state.pendingApprovals.isNotEmpty) ...[
                      _ApprovalBanner(
                        count: state.pendingApprovals.length,
                        title: state.pendingApprovals.first.task.title,
                        onTap: () => state.selectTab(1),
                      ),
                      const SizedBox(height: 16),
                    ],
                    if (_error.isNotEmpty) ...[
                      InlineError(
                        message: mobileText(context, _error),
                        onRetry: _refresh,
                      ),
                      const SizedBox(height: 14),
                    ],
                    if (_loading && entries.isEmpty && _error.isEmpty)
                      Padding(
                        padding: EdgeInsets.symmetric(vertical: 42),
                        child: LoadingPane(
                          label: mobileText(context, '正在同步会话…'),
                        ),
                      )
                    else if (entries.isEmpty && _error.isEmpty)
                      _EmptySessions(onDispatch: _dispatch)
                    else ...[
                      if (running.isNotEmpty) ...[
                        _SectionHead(title: '进行中', count: running.length),
                        _SessionCard(
                          children: [
                            for (
                              var index = 0;
                              index < running.length;
                              index++
                            ) ...[
                              _SessionRow(
                                entry: running[index],
                                onTap: () => _openEntry(running[index]),
                              ),
                              if (index < running.length - 1) _hairline(theme),
                            ],
                          ],
                        ),
                        const SizedBox(height: 24),
                      ],
                      if (idle.isNotEmpty) ...[
                        _SectionHead(title: '最近', count: null),
                        _SessionCard(
                          children: [
                            for (
                              var index = 0;
                              index < idle.length;
                              index++
                            ) ...[
                              _SessionRow(
                                entry: idle[index],
                                onTap: () => _openEntry(idle[index]),
                              ),
                              if (index < idle.length - 1) _hairline(theme),
                            ],
                          ],
                        ),
                      ],
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Widget _hairline(SoduWorkBrandTheme theme) => Divider(
  height: 1,
  thickness: 0.6,
  indent: 30,
  endIndent: 16,
  color: theme.line.withValues(alpha: .6),
);

/// Slim top bar: brand mark, cloud link status, notification bell.
class _HomeHeader extends StatelessWidget {
  final MobileState state;

  const _HomeHeader({required this.state});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final connected =
        state.phase == MobilePhase.ready && state.enrollment != null;
    final envLabel = state.endpoint.environment == SoduWorkEnvironment.development
        ? '开发'
        : '生产';
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 12, 4),
      child: Row(
        children: [
          SoduWorkMark(size: 30),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              theme.brandName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: theme.ink,
                fontSize: 18,
                fontWeight: FontWeight.w800,
                letterSpacing: -.3,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: connected ? theme.successSoft : theme.surfaceMuted,
              borderRadius: BorderRadius.circular(20),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                StatusBeacon(
                  size: 6,
                  color: connected ? theme.success : theme.inkMuted,
                  pulse: connected,
                ),
                const SizedBox(width: 5),
                Text(
                  connected
                      ? mobileText(context, "云端已连接 · {0}", values: [envLabel])
                      : mobileText(context, '未连接'),
                  style: TextStyle(
                    color: connected ? theme.success : theme.inkMuted,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          NotificationBell(
            count: state.unreadMessageCount,
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const NotificationsScreen()),
            ),
          ),
        ],
      ),
    );
  }
}

/// Rounded, borderless search input in the DeepSeek style.
class _SearchField extends StatelessWidget {
  final TextEditingController controller;

  const _SearchField({required this.controller});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return TextField(
      controller: controller,
      style: TextStyle(color: theme.ink, fontSize: 13.5),
      decoration: InputDecoration(
        hintText: mobileText(context, '搜索会话'),
        hintStyle: TextStyle(color: theme.inkMuted, fontSize: 13.5),
        prefixIcon: Icon(Icons.search_rounded, size: 19, color: theme.inkMuted),
        suffixIcon: controller.text.isEmpty
            ? null
            : IconButton(
                tooltip: mobileText(context, '清空'),
                onPressed: controller.clear,
                icon: Icon(
                  Icons.close_rounded,
                  size: 17,
                  color: theme.inkMuted,
                ),
              ),
        filled: true,
        fillColor: theme.surfaceMuted.withValues(alpha: .55),
        contentPadding: const EdgeInsets.symmetric(vertical: 10),
        border: MobileInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
        isDense: true,
      ),
    );
  }
}

/// One-line approval banner that jumps to the work tab.
class _ApprovalBanner extends StatelessWidget {
  final int count;
  final String title;
  final VoidCallback onTap;

  const _ApprovalBanner({
    required this.count,
    required this.title,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(theme.radiusMedium),
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: BoxDecoration(
            color: theme.primarySoft.withValues(alpha: .7),
            borderRadius: BorderRadius.circular(theme.radiusMedium),
            border: Border.all(color: theme.primary.withValues(alpha: .18)),
          ),
          child: Row(
            children: [
              Icon(Icons.verified_outlined, size: 16, color: theme.primary),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  count > 1
                      ? mobileText(
                          context,
                          "{0} 项成果待你确认 · {1}",
                          values: [count, title],
                        )
                      : mobileText(context, "成果待你确认 · {0}", values: [title]),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: theme.primary,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Icon(Icons.chevron_right_rounded, size: 17, color: theme.primary),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionHead extends StatelessWidget {
  final String title;
  final int? count;

  const _SectionHead({required this.title, this.count});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        children: [
          Text(
            title,
            style: TextStyle(
              color: theme.inkMuted,
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: .3,
            ),
          ),
          if (count != null) ...[
            const SizedBox(width: 6),
            Text(
              '$count',
              style: TextStyle(
                color: theme.inkMuted.withValues(alpha: .7),
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Borderless white group holding the session rows.
class _SessionCard extends StatelessWidget {
  final List<Widget> children;

  const _SessionCard({required this.children});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Container(
      decoration: BoxDecoration(
        color: theme.surface,
        borderRadius: BorderRadius.circular(theme.radiusMedium),
        border: Border.all(color: theme.line.withValues(alpha: .5)),
      ),
      child: Column(children: children),
    );
  }
}

/// A calm text-first session row: beacon, title, latest line, time.
class _SessionRow extends StatelessWidget {
  final SessionFeedEntry entry;
  final VoidCallback onTap;

  const _SessionRow({required this.entry, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final accent = switch (entry.tone) {
      SessionTone.attention => theme.danger,
      SessionTone.done => theme.success,
      SessionTone.running => theme.secondary,
      SessionTone.idle => theme.inkMuted,
    };
    final time = formatRelativeTime(
      DateTime.fromMillisecondsSinceEpoch(entry.task.createdAt),
      context: context,
    );
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: StatusBeacon(
                  size: 8,
                  color: accent,
                  pulse: entry.running,
                ),
              ),
              const SizedBox(width: 11),
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
                    const SizedBox(height: 3),
                    Row(
                      children: [
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
                        Text(
                          '  ·  $time',
                          style: TextStyle(
                            color: theme.inkMuted.withValues(alpha: .75),
                            fontSize: 11,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The DeepSeek-style centered dispatch button.
class _DispatchButton extends StatelessWidget {
  final VoidCallback onPressed;

  const _DispatchButton({required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return SizedBox(
      width: 188,
      height: 50,
      child: FilledButton.icon(
        onPressed: onPressed,
        style: FilledButton.styleFrom(
          backgroundColor: theme.primary,
          foregroundColor: theme.surface,
          elevation: 4,
          shadowColor: theme.primary.withValues(alpha: .35),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(25),
          ),
        ),
        icon: const Icon(Icons.add_rounded, size: 21),
        label: Text(
          mobileText(context, '新的工作'),
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}

class _EmptySessions extends StatelessWidget {
  final VoidCallback onDispatch;

  const _EmptySessions({required this.onDispatch});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 42),
      child: Column(
        children: [
          Container(
            width: 62,
            height: 62,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: theme.surfaceMuted,
            ),
            child: Icon(Icons.forum_outlined, size: 26, color: theme.inkMuted),
          ),
          const SizedBox(height: 16),
          Text(
            mobileText(context, '还没有会话'),
            style: TextStyle(
              color: theme.ink,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            mobileText(context, '点下方「新的工作」说清需求，\n云端电脑执行、进度实时回到这里。'),
            textAlign: TextAlign.center,
            style: TextStyle(
              color: theme.inkMuted,
              fontSize: 12.5,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }
}

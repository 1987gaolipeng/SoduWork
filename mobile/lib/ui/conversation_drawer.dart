import 'dart:math' as math;
import '../core/conversation_projects.dart';
import '../core/local_chat_directory.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../state/mobile_state.dart';
import '../models/account_conversation.dart';
import '../state/session_feed.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';
import 'conversation_chrome.dart';
import 'mobile_display_preferences.dart';

class ConversationDrawer extends StatefulWidget {
  final MobileState state;
  final List<LocalChatEntry> localChats;
  final ValueChanged<LocalChatEntry>? onLocalEntry;
  final List<Map<String, dynamic>> workCards;
  final ValueChanged<Map<String, dynamic>>? onWorkCard;
  final bool preview, dark;
  final VoidCallback onNew, onTheme;
  final VoidCallback? onSearch, onSettings;
  final ValueChanged<int> onDestination;
  final ValueChanged<SessionFeedEntry> onEntry;
  final ValueChanged<AccountConversation>? onAccountEntry;
  final ValueChanged<String>? onResource;
  const ConversationDrawer({
    super.key,
    required this.state,
    this.localChats = const [],
    this.onLocalEntry,
    this.workCards = const [],
    this.onWorkCard,
    this.preview = false,
    required this.dark,
    required this.onNew,
    required this.onDestination,
    required this.onEntry,
    required this.onTheme,
    this.onAccountEntry,
    this.onResource,
    this.onSearch,
    this.onSettings,
  });
  @override
  State<ConversationDrawer> createState() => _ConversationDrawerState();
}

class _DrawerChat {
  final Set<String> ids;
  final String title, subtitle;
  final int at;
  final VoidCallback open;
  final IconData icon;
  const _DrawerChat(
    this.ids,
    this.title,
    this.subtitle,
    this.at,
    this.open, [
    this.icon = CupertinoIcons.chat_bubble_text,
  ]);
}

class _ConversationDrawerState extends State<ConversationDrawer> {
  bool _archived = false;
  bool _more = false;
  String _projectScope = '';
  List<ConversationProject> _projects = [];
  final Set<String> _collapsedProjects = {};
  int _projectRequest = 0;
  bool _projectReadFailed = false;

  @override
  void initState() {
    super.initState();
    ConversationProjects.changes.addListener(_loadProjects);
    _checkProjectScope();
  }

  @override
  void didUpdateWidget(covariant ConversationDrawer oldWidget) {
    super.didUpdateWidget(oldWidget);
    _checkProjectScope();
  }

  ConversationProjects get _projectStore => ConversationProjects(
    widget.state.endpoint.baseUrl,
    widget.preview
        ? 'offline-preview'
        : widget.state.enrollment?.ownerUserId ?? '',
    api: widget.preview || (widget.state.enrollment?.ownerUserId ?? '').isEmpty
        ? null
        : widget.state.api,
  );

  void _checkProjectScope() {
    final key = _projectStore.storageKey;
    if (_projectScope == key) return;
    _projectScope = key;
    _projects = [];
    _collapsedProjects.clear();
    _loadProjects();
  }

  Future<void> _loadProjects() async {
    final store = _projectStore, request = ++_projectRequest;
    if (store.storageKey.isEmpty) return;
    try {
      final projects = await store.read();
      if (!mounted ||
          request != _projectRequest ||
          store.storageKey != _projectStore.storageKey) {
        return;
      }
      setState(() {
        _projects = projects;
        _projectReadFailed = false;
      });
    } catch (_) {
      if (mounted && request == _projectRequest) {
        setState(() => _projectReadFailed = true);
      }
    }
  }

  @override
  void dispose() {
    ConversationProjects.changes.removeListener(_loadProjects);
    super.dispose();
  }

  List<_DrawerChat> _chats(List<SessionFeedEntry> entries) {
    final accounts = widget.state.accountConversations.conversations;
    final sourceIds = cloudConversationSourceIds(entries);
    final rows = <_DrawerChat>[
      if (!_archived) ...[
        for (final entry in entries)
          _DrawerChat(
            {
              'task:${entry.task.id}',
              'cloud-task:${entry.task.id}',
              for (final account in accounts)
                if (account.taskProjectionId == entry.task.id ||
                    account.sourceSessionId == 'cloud-task:${entry.task.id}' ||
                    (entry.task.cloudSessionId.isNotEmpty &&
                        account.sourceSessionId ==
                            entry.task.cloudSessionId)) ...[
                  'account:${account.id}',
                  'source:${account.sourceClientId}:${account.sourceSessionId}',
                ],
            },
            entry.task.title,
            entry.statusLabel,
            entry.task.createdAt,
            () => widget.onEntry(entry),
            entry.task.runnerKind == 'work-computer'
                ? CupertinoIcons.desktopcomputer
                : CupertinoIcons.cloud,
          ),
        for (final card in widget.workCards)
          if (card['saved'] != true &&
              !entries.any((entry) => entry.task.id == card['taskId']))
            _DrawerChat(
              {'work:${card['id']}'},
              card['title'] as String? ?? '',
              card['saved'] == true ? '已保存' : '草稿',
              (card['updatedAt'] as num?)?.toInt() ?? 0,
              () => widget.onWorkCard?.call(card),
            ),
        for (final chat in widget.localChats)
          _DrawerChat(
            {'local:${chat.sessionId}'},
            chat.title,
            '等待同步',
            0,
            () => widget.onLocalEntry?.call(chat),
          ),
      ],
      for (final account in accounts)
        if (!account.deleted &&
            !account.isEmptyPlaceholder &&
            account.archived == _archived &&
            (_archived ||
                !entries.any(
                  (entry) => account.taskProjectionId == entry.task.id,
                )) &&
            (_archived || !sourceIds.contains(account.sourceSessionId)))
          _DrawerChat(
            {
              'account:${account.id}',
              'source:${account.sourceClientId}:${account.sourceSessionId}',
            },
            account.displayTitle,
            account.sourceDeviceName.isEmpty
                ? '聊天记录'
                : account.sourceDeviceName,
            account.updatedAt?.millisecondsSinceEpoch ?? 0,
            () => widget.onAccountEntry?.call(account),
            account.sourceSessionId.startsWith('cloud-task:')
                ? CupertinoIcons.cloud
                : CupertinoIcons.desktopcomputer,
          ),
    ];
    rows.sort((a, b) {
      final time = b.at.compareTo(a.at);
      if (time != 0) return time;
      final aTask = a.ids.first.startsWith('task:');
      final bTask = b.ids.first.startsWith('task:');
      if (aTask != bTask) return aTask ? -1 : 1;
      return a.ids.first.compareTo(b.ids.first);
    });
    return rows;
  }

  Widget _chatRow(_DrawerChat row) => _historyRow(
    title: row.title,
    subtitle: row.subtitle,
    icon: row.icon,
    onTap: row.open,
  );

  List<Widget> _projectWidgets(List<_DrawerChat> rows) {
    final theme = context.soduWorkTheme;
    // Legacy account and task aliases can refer to one conversation.
    final claimed = <_DrawerChat>{};
    final children = <String, List<_DrawerChat>>{};
    for (final project in _projects) {
      children[project.id] = rows
          .where(
            (row) => row.ids.any(project.chatIds.contains) && claimed.add(row),
          )
          .toList();
    }
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 20, 0, 2),
        child: Row(
          children: [
            Expanded(
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => widget.onResource?.call('projects'),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Text(
                    mobileText(context, '项目'),
                    style: TextStyle(
                      color: theme.inkMuted,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ),
            IconButton(
              tooltip: mobileText(context, '管理项目'),
              onPressed: () => widget.onResource?.call('projects'),
              icon: Icon(CupertinoIcons.plus, size: 18, color: theme.inkMuted),
            ),
          ],
        ),
      ),
      if (_projects.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Text(
            mobileText(
              context,
              _projectReadFailed ? '项目暂时无法读取，请重试' : '创建项目，整理会话',
            ),
            style: TextStyle(color: theme.inkMuted, fontSize: 12),
          ),
        ),
      for (final project in _projects) ...[
        ListTile(
          key: ValueKey('project:${project.id}'),
          minTileHeight: 48,
          minLeadingWidth: 20,
          horizontalTitleGap: 10,
          contentPadding: const EdgeInsets.symmetric(horizontal: 12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          leading: Icon(CupertinoIcons.folder, color: theme.inkMuted, size: 20),
          title: Text(
            project.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: theme.ink,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
          trailing: Icon(
            _collapsedProjects.contains(project.id)
                ? CupertinoIcons.chevron_right
                : CupertinoIcons.chevron_down,
            size: 14,
            color: theme.inkMuted,
          ),
          onTap: () => setState(() {
            if (!_collapsedProjects.add(project.id)) {
              _collapsedProjects.remove(project.id);
            }
          }),
        ),
        if (!_collapsedProjects.contains(project.id))
          Padding(
            padding: const EdgeInsets.only(left: 20),
            child: DecoratedBox(
              decoration: BoxDecoration(
                border: Border(
                  left: BorderSide(
                    color: theme.inkMuted.withValues(alpha: .16),
                  ),
                ),
              ),
              child: Column(
                children: [
                  for (final row in children[project.id]!) _chatRow(row),
                  if (children[project.id]!.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Text(
                        mobileText(context, '暂无会话'),
                        style: TextStyle(color: theme.inkMuted, fontSize: 12),
                      ),
                    ),
                ],
              ),
            ),
          ),
      ],
    ];
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final sync = widget.state.accountConversations;
    final entries = widget.preview
        ? buildSessionFeed(widget.state.tasks)
        : buildPersonalConversationFeed(
            widget.state.tasks,
            ownerUserId: widget.state.enrollment?.ownerUserId ?? '',
          );
    final rows = _chats(entries);
    final groupedIds = _projects.expand((p) => p.chatIds).toSet();
    final recent = _archived || widget.onResource == null
        ? rows
        : rows.where((r) => !r.ids.any(groupedIds.contains)).toList();
    return Drawer(
      width: math.min(320, MediaQuery.sizeOf(context).width * .79),
      backgroundColor: theme.surface,
      elevation: 0,
      shape: const RoundedRectangleBorder(),
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 16, 14),
              child: Row(
                children: [
                  const SoduWorkMark(size: 24),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      theme.brandName,
                      style: TextStyle(
                        color: theme.ink,
                        fontSize: 21,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -.5,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: mobileText(context, '搜索会话'),
                    style: conversationCircleStyle(context),
                    onPressed: widget.onSearch,
                    icon: const Icon(CupertinoIcons.search, size: 22),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 18),
                children: [
                  _destination(
                    CupertinoIcons.chat_bubble_text,
                    '主页',
                    () => widget.onDestination(0),
                  ),
                  _destination(
                    CupertinoIcons.tray,
                    '需求池',
                    () => widget.onDestination(3),
                    count: widget.state.requirementApprovals.length,
                  ),
                  if (widget.onResource != null) ...[
                    _destination(
                      CupertinoIcons.square_grid_2x2,
                      '插件',
                      () => widget.onResource!('tools'),
                    ),
                    _destination(
                      CupertinoIcons.folder,
                      '资料库',
                      () => widget.onResource!('library'),
                    ),
                    _destination(
                      CupertinoIcons.clock,
                      '自动化',
                      () => widget.onResource!('automations'),
                    ),
                    _destination(
                      CupertinoIcons.bell,
                      '通知',
                      () => widget.onResource!('notifications'),
                      count: widget.state.unreadMessageCount ?? 0,
                    ),
                    _destination(
                      _more
                          ? CupertinoIcons.chevron_up
                          : CupertinoIcons.ellipsis,
                      _more ? '收起' : '更多',
                      () => setState(() => _more = !_more),
                    ),
                    if (_more) ...[
                      _destination(
                        CupertinoIcons.slider_horizontal_3,
                        '我的模型',
                        () => widget.onResource!('models'),
                      ),
                      _destination(
                        CupertinoIcons.cloud,
                        '云端环境',
                        () => widget.onResource!('cloud'),
                      ),
                    ],
                  ],
                  if (!_archived && widget.onResource != null)
                    ..._projectWidgets(rows),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 20, 0, 2),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            mobileText(context, _archived ? '已归档' : '最近会话'),
                            style: TextStyle(
                              color: theme.inkMuted,
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        if (sync.loading)
                          const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 1.5),
                          ),
                        if (!widget.preview)
                          PopupMenuButton<String>(
                            color: theme.surface,
                            surfaceTintColor: Colors.transparent,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(16),
                            ),
                            tooltip: mobileText(context, '会话选项'),
                            icon: Icon(
                              sync.error.isEmpty
                                  ? CupertinoIcons.ellipsis
                                  : CupertinoIcons.exclamationmark_circle,
                              size: 19,
                              color: theme.inkMuted,
                            ),
                            onSelected: (value) {
                              if (value == 'archive') {
                                setState(() => _archived = !_archived);
                              } else {
                                widget.state.loadAccountConversations();
                              }
                            },
                            itemBuilder: (_) => [
                              PopupMenuItem(
                                value: 'archive',
                                child: Text(
                                  mobileText(
                                    context,
                                    _archived ? '返回最近' : '已归档',
                                  ),
                                ),
                              ),
                              PopupMenuItem(
                                value: 'refresh',
                                child: Text(mobileText(context, '同步电脑会话')),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),
                  if (sync.supported == false)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 8,
                      ),
                      child: Text(
                        mobileText(context, '当前企业服务暂不支持双端会话同步'),
                        style: TextStyle(
                          color: theme.inkMuted,
                          fontSize: 12,
                          height: 1.5,
                        ),
                      ),
                    ),
                  if (recent.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Text(
                        mobileText(context, _archived ? '暂无已归档会话' : '暂无最近会话'),
                        style: TextStyle(color: theme.inkMuted, fontSize: 13),
                      ),
                    )
                  else
                    for (final row in recent) _chatRow(row),
                  if (sync.hasMore)
                    TextButton(
                      onPressed: sync.loading
                          ? null
                          : widget.state.loadAccountConversations,
                      child: Text(mobileText(context, '加载更多会话')),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 16, 18),
              child: Row(
                children: [
                  Flexible(
                    child: FilledButton.icon(
                      onPressed: widget.onNew,
                      icon: const Icon(CupertinoIcons.square_pencil, size: 21),
                      label: Text(mobileText(context, '新对话'), maxLines: 1),
                      style: FilledButton.styleFrom(
                        backgroundColor: theme.ink,
                        foregroundColor: theme.surface,
                        minimumSize: const Size(0, 46),
                        padding: const EdgeInsets.symmetric(horizontal: 20),
                        shape: const StadiumBorder(),
                      ),
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    tooltip: mobileText(context, '设置'),
                    style: conversationCircleStyle(context),
                    onPressed:
                        widget.onSettings ?? () => widget.onDestination(2),
                    icon: const Icon(CupertinoIcons.gear_alt, size: 24),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _historyRow({
    required String title,
    required String subtitle,
    required IconData icon,
    required VoidCallback onTap,
  }) {
    final theme = context.soduWorkTheme;
    // Shorten display text only; preserve the original title and navigation identity.
    final displayTitle = title
        .trim()
        .replaceFirst(RegExp(r'^名称[：:]\s*'), '')
        .split(RegExp(r'[\r\n。]'))
        .first
        .trim();
    return Tooltip(
      message: title,
      child: ListTile(
        minTileHeight: 56,
        minLeadingWidth: 20,
        horizontalTitleGap: 10,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        leading: Icon(icon, size: 19, color: theme.inkMuted),
        title: Text(
          displayTitle.isEmpty ? '未命名会话' : displayTitle,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: theme.ink,
            fontSize: 14,
            fontWeight: FontWeight.w500,
          ),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 3),
          child: Text(
            mobileText(context, subtitle),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: theme.inkMuted, fontSize: 11, height: 1.4),
          ),
        ),
        onTap: onTap,
      ),
    );
  }

  Widget _destination(
    IconData icon,
    String label,
    VoidCallback onTap, {
    int count = 0,
  }) => ListTile(
    minTileHeight: 48,
    horizontalTitleGap: 14,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
    leading: Icon(icon, size: 23, color: context.soduWorkTheme.ink),
    title: Text(
      mobileText(context, label),
      style: TextStyle(
        color: context.soduWorkTheme.ink,
        fontSize: 15.5,
        fontWeight: FontWeight.w500,
      ),
    ),
    trailing: count == 0 ? null : Badge(label: Text('$count')),
    onTap: onTap,
  );
}

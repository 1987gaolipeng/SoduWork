import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../models/account_conversation.dart';
import '../state/mobile_scope.dart';
import '../state/session_feed.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_sheet.dart';
import '../ui/mobile_theme.dart';
import '../ui/conversation_chrome.dart';

class ConversationSearchSelection {
  final AccountConversation? account;
  final SessionFeedEntry? task;
  final bool newChat;
  const ConversationSearchSelection({
    this.account,
    this.task,
    this.newChat = false,
  });
}

Future<ConversationSearchSelection?> showConversationSearch(
  BuildContext context, {
  bool preview = false,
}) {
  final preferences = MobileDisplayScope.maybeOf(context);
  final brand = context.soduWorkTheme;
  final state = MobileScope.read(context);
  return showGeneralDialog<ConversationSearchSelection>(
    context: context,
    useRootNavigator: false,
    barrierDismissible: false,
    transitionDuration: MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : const Duration(milliseconds: 230),
    pageBuilder: (_, _, _) => MobileScope(
      state: state,
      child: MobilePresentationTheme(
        preferences: preferences,
        base: brand,
        child: ConversationSearch(preview: preview),
      ),
    ),
    transitionBuilder: (_, animation, _, child) => FadeTransition(
      opacity: animation,
      child: SlideTransition(
        position: Tween<Offset>(begin: const Offset(0, .04), end: Offset.zero)
            .animate(
              CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
            ),
        child: child,
      ),
    ),
  );
}

class ConversationSearch extends StatefulWidget {
  final bool preview;
  const ConversationSearch({super.key, this.preview = false});
  @override
  State<ConversationSearch> createState() => _ConversationSearchState();
}

class _ConversationSearchState extends State<ConversationSearch> {
  final _text = TextEditingController();
  final _focus = FocusNode();
  int? _identity;
  String _filter = '全部';
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final identity = MobileScope.of(context).identityRevision;
    if (_identity != null && identity != _identity) {
      _text.clear();
      _filter = '全部';
    }
    _identity = identity;
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    final brand = context.soduWorkTheme;
    final query = _text.text.trim().toLowerCase();
    final tasks = (widget.preview
        ? buildSessionFeed(state.tasks)
        : buildPersonalConversationFeed(
            state.tasks,
            ownerUserId: state.enrollment?.ownerUserId ?? '',
          ));
    final work = buildSessionFeed(
      state.tasks.where((t) => t.origin != 'cloud-conversation'),
    );
    final taskSessionIds = cloudConversationSourceIds(tasks);
    final sync = state.accountConversations;
    final rows =
        <
              ({
                String title,
                String summary,
                bool chat,
                ConversationSearchSelection selected,
              })
            >[
              for (final account in sync.conversations.where(
                (row) =>
                    !row.deleted &&
                    (row.archived ||
                        !taskSessionIds.contains(row.sourceSessionId)),
              ))
                (
                  title: account.displayTitle,
                  summary: account.sourceDeviceName.isEmpty
                      ? mobileText(context, '电脑会话')
                      : account.sourceDeviceName,
                  chat: true,
                  selected: ConversationSearchSelection(account: account),
                ),
              for (final row in [...tasks, ...work])
                (
                  title: row.task.title,
                  summary: row.task.note.isNotEmpty
                      ? row.task.note
                      : row.lastActivity,
                  chat: row.isCloudConversation,
                  selected: ConversationSearchSelection(task: row),
                ),
            ]
            .where(
              (row) =>
                  query.isNotEmpty &&
                  ('${row.title} ${row.summary}'.toLowerCase().contains(
                    query,
                  )) &&
                  (_filter == '全部' || (_filter == '会话' ? row.chat : !row.chat)),
            )
            .toList();
    return Scaffold(
      backgroundColor: brand.surface,
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        child: Column(
          children: [
            if (query.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
                child: Row(
                  children: [
                    for (final category in const ['全部', '会话', '任务'])
                      Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: TextButton(
                          onPressed: () => setState(() => _filter = category),
                          style: TextButton.styleFrom(
                            backgroundColor: _filter == category
                                ? brand.surfaceMuted
                                : Colors.transparent,
                            foregroundColor: _filter == category
                                ? brand.ink
                                : brand.inkMuted,
                            shape: const StadiumBorder(),
                            minimumSize: const Size(58, 44),
                          ),
                          child: Text(mobileText(context, category)),
                        ),
                      ),
                  ],
                ),
              ),
            Expanded(
              child: query.isEmpty
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            CupertinoIcons.search,
                            size: 29,
                            color: brand.inkSecondary,
                          ),
                          const SizedBox(height: 20),
                          Text(
                            mobileText(context, '搜索工作会话'),
                            style: TextStyle(color: brand.ink, fontSize: 16),
                          ),
                        ],
                      ),
                    )
                  : rows.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: brand.surfaceMuted,
                                borderRadius: BorderRadius.circular(16),
                              ),
                              child: Icon(
                                CupertinoIcons.search,
                                size: 25,
                                color: brand.ink,
                              ),
                            ),
                            const SizedBox(height: 16),
                            Text(
                              mobileText(context, '无结果'),
                              style: TextStyle(color: brand.ink, fontSize: 17),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              mobileText(context, '试试其他关键词，或开始新的工作。'),
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: brand.inkMuted,
                                fontSize: 13,
                              ),
                            ),
                            const SizedBox(height: 18),
                            FilledButton(
                              onPressed: () => Navigator.pop(
                                context,
                                const ConversationSearchSelection(
                                  newChat: true,
                                ),
                              ),
                              style: FilledButton.styleFrom(
                                backgroundColor: brand.ink,
                                foregroundColor: brand.surface,
                                shape: const StadiumBorder(),
                              ),
                              child: Text(mobileText(context, '新对话')),
                            ),
                          ],
                        ),
                      ),
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
                      keyboardDismissBehavior:
                          ScrollViewKeyboardDismissBehavior.onDrag,
                      itemCount: rows.length,
                      itemBuilder: (context, index) {
                        final row = rows[index];
                        return ListTile(
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 8,
                          ),
                          leading: Container(
                            width: 42,
                            height: 42,
                            decoration: BoxDecoration(
                              border: Border.all(color: brand.line),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Icon(
                              row.chat
                                  ? CupertinoIcons.chat_bubble
                                  : CupertinoIcons.folder,
                              size: 22,
                              color: brand.ink,
                            ),
                          ),
                          title: Text(
                            row.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: brand.ink,
                              fontSize: 15.5,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          subtitle: Text(
                            row.summary,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: brand.inkMuted,
                              fontSize: 12.5,
                            ),
                          ),
                          onTap: () => Navigator.pop(context, row.selected),
                        );
                      },
                    ),
            ),
            if (query.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 4,
                ),
                child: Text(
                  mobileText(context, '当前匹配已同步的标题与工作摘要'),
                  textAlign: TextAlign.center,
                  style: TextStyle(color: brand.inkMuted, fontSize: 10.5),
                ),
              ),
            if (sync.error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18),
                child: TextButton(
                  onPressed: sync.loading
                      ? null
                      : state.loadAccountConversations,
                  child: Text(
                    sync.error,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
            if (sync.hasMore)
              TextButton(
                onPressed: sync.loading ? null : state.loadAccountConversations,
                child: Text(mobileText(context, '加载更多会话')),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
              child: Row(
                children: [
                  Expanded(
                    child: ConversationInputSurface(
                      child: TextField(
                        key: const Key('conversation-search-input'),
                        controller: _text,
                        focusNode: _focus,
                        autofocus: true,
                        textInputAction: TextInputAction.search,
                        onChanged: (_) => setState(() {}),
                        decoration: InputDecoration(
                          hintText: mobileText(context, '搜索'),
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 14,
                            vertical: 12,
                          ),
                          prefixIcon: const Icon(
                            CupertinoIcons.search,
                            size: 21,
                          ),
                          suffixIcon: _text.text.isEmpty
                              ? null
                              : IconButton(
                                  tooltip: mobileText(context, '清空搜索'),
                                  onPressed: () =>
                                      setState(() => _text.clear()),
                                  icon: const Icon(
                                    CupertinoIcons.clear_circled_solid,
                                    size: 18,
                                  ),
                                ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    tooltip: mobileText(context, '关闭'),
                    style: conversationCircleStyle(context),
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(CupertinoIcons.xmark, size: 23),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

import '../ui/mobile_display_preferences.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../core/conversation_projects.dart';
import '../models/account_conversation.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../state/session_feed.dart';
import '../ui/mobile_sheet.dart';
import '../ui/mobile_theme.dart';

class ProjectsScreen extends StatefulWidget {
  final bool preview;
  final ValueChanged<AccountConversation> onAccount;
  final ValueChanged<SessionFeedEntry> onEntry;
  const ProjectsScreen({
    super.key,
    this.preview = false,
    required this.onAccount,
    required this.onEntry,
  });
  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  MobileState? _state;
  ConversationProjects? _store;
  int _identity = -1, _request = 0;
  List<ConversationProject> _projects = [];
  String? _selected;
  String _error = '';
  bool _loading = true, _saving = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state != state || _identity != state.identityRevision) {
      _state = state;
      _identity = state.identityRevision;
      _selected = null;
      _projects = [];
      _error = '';
      _saving = false;
      _store = ConversationProjects(
        state.endpoint.baseUrl,
        widget.preview
            ? 'offline-preview'
            : state.enrollment?.ownerUserId ?? '',
        api: widget.preview ? null : state.api,
      );
      _load();
    }
  }

  bool _current(int identity) =>
      mounted && _identity == identity && _state?.identityRevision == identity;
  Future<void> _load() async {
    final identity = _identity, request = ++_request;
    _loading = true;
    try {
      final rows = await _store!.read();
      if (!_current(identity) || request != _request) return;
      setState(() {
        _projects = rows;
        _error = '';
      });
    } catch (e) {
      if (_current(identity) && request == _request) {
        setState(() => _error = _message(e));
      }
    } finally {
      if (_current(identity) && request == _request) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _mutate(
    Future<void> Function(ConversationProjects) action,
  ) async {
    if (_saving) return;
    final identity = _identity, store = _store!;
    setState(() => _saving = true);
    try {
      await action(store);
      if (_current(identity)) await _load();
    } catch (e) {
      if (_current(identity)) setState(() => _error = _message(e));
    } finally {
      if (_current(identity)) setState(() => _saving = false);
    }
  }

  Future<void> _name([ConversationProject? project]) async {
    final identity = _identity;
    final value = await showMobileSheet<String>(
      context,
      title: project == null ? '新建项目' : '重命名项目',
      initialSize: .6,
      builder: (_, scroll) => _ProjectNameForm(
        scroll: scroll,
        identity: identity,
        initial: project?.name ?? '',
      ),
    );
    if (!_current(identity) || value == null) return;
    await _mutate((store) => store.save(value, id: project?.id));
  }

  List<({String id, String title, VoidCallback open})> _chats() {
    final state = _state!;
    return [
      for (final row in state.accountConversations.conversations.where(
        (r) => !r.deleted && !r.archived,
      ))
        (
          id: 'account:${row.id}',
          title: row.displayTitle,
          open: () => widget.onAccount(row),
        ),
      for (final row
          in widget.preview
              ? buildSessionFeed(state.tasks)
              : buildPersonalConversationFeed(
                  state.tasks,
                  ownerUserId: state.enrollment?.ownerUserId ?? '',
                ))
        (
          id: 'task:${row.task.id}',
          title: row.task.title,
          open: () => widget.onEntry(row),
        ),
    ];
  }

  Future<void> _organize(ConversationProject project) async {
    final identity = _identity;
    final chats = _chats();
    final selected = project.chatIds.toSet();
    final value = await showMobileSheet<List<String>>(
      context,
      title: '整理会话',
      builder: (_, scroll) => StatefulBuilder(
        builder: (context, setLocal) =>
            MobileScope.of(context).identityRevision != identity
            ? Center(child: Text(mobileText(context, '账号已切换，请关闭后重试。')))
            : Material(
                color: Colors.transparent,
                child: ListView(
                  controller: scroll,
                  padding: const EdgeInsets.all(18),
                  children: [
                    Text(mobileText(context, '每个会话归入一个项目，移动分组不会改变会话内容。')),
                    const SizedBox(height: 12),
                    if (chats.isEmpty)
                      Padding(
                        padding: EdgeInsets.all(24),
                        child: Text(mobileText(context, '还没有可整理的会话，先开始一项工作吧。')),
                      ),
                    for (final chat in chats)
                      CheckboxListTile(
                        title: Text(chat.title),
                        value: selected.contains(chat.id),
                        onChanged: (v) => setLocal(() {
                          if (v == true) {
                            selected.add(chat.id);
                          } else {
                            selected.remove(chat.id);
                          }
                        }),
                      ),
                    const SizedBox(height: 20),
                    FilledButton(
                      onPressed: () =>
                          popMobileSheet(context, selected.toList()),
                      child: Text(mobileText(context, '保存分组')),
                    ),
                  ],
                ),
              ),
      ),
    );
    if (!_current(identity) || value == null) return;
    await _mutate((store) => store.assign(project.id, value));
  }

  Future<void> _remove(ConversationProject project) async {
    final identity = _identity;
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(mobileText(context, '移除项目？')),
        content: Text(mobileText(context, '只移除分组，会话和工作记录都会保留。')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(mobileText(context, '取消')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(mobileText(context, '移除分组')),
          ),
        ],
      ),
    );
    if (!_current(identity) || yes != true) return;
    await _mutate((store) => store.remove(project.id));
    if (_current(identity) && !_projects.any((r) => r.id == _selected)) {
      setState(() => _selected = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final selected = _projects.where((r) => r.id == _selected).firstOrNull;
    final chats = _chats();
    return Material(
      color: Colors.transparent,
      child: ListView(
        controller: MobileSheetScope.maybeOf(context)?.scrollController,
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  selected?.name ?? mobileText(context, '把相关会话放在一起'),
                  style: TextStyle(
                    color: theme.ink,
                    fontSize: 22,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              IconButton(
                tooltip: selected == null
                    ? mobileText(context, '新建项目')
                    : mobileText(context, '返回项目列表'),
                onPressed: _saving
                    ? null
                    : selected == null
                    ? _name
                    : () => setState(() => _selected = null),
                icon: Icon(
                  selected == null
                      ? CupertinoIcons.plus
                      : CupertinoIcons.square_grid_2x2,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            mobileText(context, '项目分组保存在此设备，按企业和账号隔离，暂未与电脑分组同步。'),
            style: TextStyle(color: theme.inkMuted, fontSize: 13, height: 1.5),
          ),
          const SizedBox(height: 24),
          if (_loading || _saving) const LinearProgressIndicator(),
          if (_error.isNotEmpty) ...[
            Text(mobileText(context, _error)),
            TextButton(
              onPressed: _load,
              child: Text(mobileText(context, '重新读取')),
            ),
          ],
          if (!_loading && _error.isEmpty && _projects.isEmpty) ...[
            const SizedBox(height: 70),
            Icon(CupertinoIcons.folder, size: 36, color: theme.inkMuted),
            const SizedBox(height: 20),
            Center(child: Text(mobileText(context, '开始你的第一个项目'))),
            const SizedBox(height: 16),
            Center(
              child: FilledButton(
                onPressed: _saving ? null : _name,
                child: Text(mobileText(context, '新建项目')),
              ),
            ),
          ],
          if (selected == null)
            for (final project in _projects)
              ListTile(
                contentPadding: const EdgeInsets.symmetric(
                  vertical: 8,
                  horizontal: 4,
                ),
                leading: const Icon(CupertinoIcons.folder),
                title: Text(project.name),
                subtitle: Text(
                  mobileText(
                    context,
                    "{0} 个可用会话",
                    values: [
                      chats.where((c) => project.chatIds.contains(c.id)).length,
                    ],
                  ),
                ),
                trailing: const Icon(CupertinoIcons.chevron_right, size: 16),
                onTap: () => setState(() => _selected = project.id),
              ),
          if (selected != null) ...[
            Wrap(
              spacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: _saving ? null : () => _organize(selected),
                  icon: const Icon(CupertinoIcons.plus, size: 17),
                  label: Text(mobileText(context, '整理会话')),
                ),
                TextButton(
                  onPressed: _saving ? null : () => _name(selected),
                  child: Text(mobileText(context, '重命名')),
                ),
                TextButton(
                  onPressed: _saving ? null : () => _remove(selected),
                  child: Text(mobileText(context, '移除分组')),
                ),
              ],
            ),
            const SizedBox(height: 16),
            if (!chats.any((c) => selected.chatIds.contains(c.id)))
              Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Text(mobileText(context, '项目中还没有会话，点击“整理会话”添加。')),
              ),
            for (final chat in chats.where(
              (c) => selected.chatIds.contains(c.id),
            ))
              ListTile(
                leading: const Icon(CupertinoIcons.chat_bubble),
                title: Text(chat.title),
                onTap: chat.open,
              ),
          ],
        ],
      ),
    );
  }
}

String _message(Object error) =>
    error is FormatException ? error.message : '项目操作未完成，请重试。';

class _ProjectNameForm extends StatefulWidget {
  final ScrollController scroll;
  final String initial;
  final int identity;
  const _ProjectNameForm({
    required this.scroll,
    required this.initial,
    required this.identity,
  });
  @override
  State<_ProjectNameForm> createState() => _ProjectNameFormState();
}

class _ProjectNameFormState extends State<_ProjectNameForm> {
  late final _name = TextEditingController(text: widget.initial);
  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      MobileScope.of(context).identityRevision != widget.identity
      ? Center(child: Text(mobileText(context, '账号已切换，请关闭后重试。')))
      : ListView(
          controller: widget.scroll,
          padding: EdgeInsets.fromLTRB(
            22,
            10,
            22,
            MediaQuery.viewInsetsOf(context).bottom + 24,
          ),
          children: [
            TextField(
              controller: _name,
              autofocus: true,
              maxLength: 80,
              decoration: InputDecoration(
                hintText: mobileText(context, '项目名称'),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 20),
            FilledButton(
              onPressed: () {
                final value = _name.text.trim();
                if (value.isEmpty) return;
                popMobileSheet(context, value);
              },
              child: Text(mobileText(context, '保存')),
            ),
          ],
        );
}

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/artifact_download.dart';
import '../core/soduwork_api.dart';

import '../models/team_message.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../state/team_message_inbox.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';
import 'task_detail_screen.dart';
import '../ui/mobile_sheet.dart';
import '../ui/mobile_display_preferences.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});
  static Future<void> show(BuildContext context) => showMobileSheet<void>(
    context,
    title: '消息通知',
    builder: (_, _) => const NotificationsScreen(),
  );

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  TeamMessageFolder _folder = TeamMessageFolder.received;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(MobileScope.read(context).loadTeamMessages());
    });
  }

  Future<void> _refresh() =>
      MobileScope.read(context).teamMessages.refresh(_folder);

  void _select(TeamMessageFolder folder) {
    setState(() => _folder = folder);
    unawaited(_refresh());
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    final inbox = state.teamMessages;
    final folder = inbox.folder(_folder);
    final messages = folder.messages;
    final sent = _folder == TeamMessageFolder.sent;
    final theme = context.soduWorkTheme;
    return Scaffold(
      appBar: MobileSheetScope.maybeOf(context) != null
          ? null
          : AppBar(
              title: Text(mobileText(context, '消息通知')),
              actions: [
                IconButton(
                  tooltip: mobileText(context, '刷新消息'),
                  onPressed: folder.loading ? null : _refresh,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    mobileText(context, '团队的消息，随时接续。'),
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 6),
                  Text(
                    inbox.unreadCount == null
                        ? mobileText(context, '与电脑同步你的私有收件箱')
                        : mobileText(
                            context,
                            "{0} 条未读 · 与电脑同步",
                            values: [inbox.unreadCount],
                          ),
                    style: TextStyle(color: theme.inkMuted, fontSize: 12),
                  ),
                  const SizedBox(height: 16),
                  SegmentedButton<TeamMessageFolder>(
                    segments: [
                      ButtonSegment(
                        value: TeamMessageFolder.received,
                        label: Text(mobileText(context, '收到的')),
                        icon: Icon(Icons.inbox_outlined),
                      ),
                      ButtonSegment(
                        value: TeamMessageFolder.sent,
                        label: Text(mobileText(context, '已发送')),
                        icon: Icon(Icons.outbox_outlined),
                      ),
                    ],
                    selected: {_folder},
                    onSelectionChanged: (items) => _select(items.single),
                  ),
                ],
              ),
            ),
            if (folder.loading) const LinearProgressIndicator(minHeight: 2),
            if (folder.error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 8,
                ),
                child: InlineError(message: folder.error, onRetry: _refresh),
              ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _refresh,
                child: ListView.builder(
                  controller: MobileSheetScope.maybeOf(
                    context,
                  )?.scrollController,
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 28),
                  itemCount: messages.isEmpty
                      ? 1
                      : messages.length + (folder.hasMore ? 1 : 0),
                  itemBuilder: (context, index) {
                    if (messages.isEmpty) {
                      return Padding(
                        padding: const EdgeInsets.symmetric(
                          vertical: 72,
                          horizontal: 20,
                        ),
                        child: Column(
                          children: [
                            Icon(
                              sent
                                  ? Icons.outbox_outlined
                                  : Icons.notifications_none_rounded,
                              size: 44,
                              color: theme.inkMuted,
                            ),
                            const SizedBox(height: 14),
                            Text(
                              mobileText(
                                context,
                                folder.loading
                                    ? '正在获取消息…'
                                    : sent
                                    ? '还没有发出的消息'
                                    : '暂时没有消息',
                              ),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              mobileText(context, '同事留言和工作交办会保存在这里。'),
                              style: TextStyle(color: theme.inkMuted),
                              textAlign: TextAlign.center,
                            ),
                          ],
                        ),
                      );
                    }
                    if (index == messages.length) {
                      return TextButton(
                        onPressed: folder.loading
                            ? null
                            : () => inbox.loadMore(_folder),
                        child: Text(mobileText(context, '加载更早消息')),
                      );
                    }
                    final message = messages[index];
                    final unread = !sent && message.isUnread;
                    return Card(
                      margin: const EdgeInsets.only(bottom: 10),
                      elevation: 0,
                      color: unread ? theme.secondarySoft : theme.surface,
                      child: ListTile(
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                          vertical: 6,
                        ),
                        leading: CircleAvatar(
                          backgroundColor: theme.surfaceMuted,
                          child: Icon(
                            message.isTaskAssignment
                                ? Icons.assignment_outlined
                                : Icons.chat_bubble_outline_rounded,
                            color: theme.inkSecondary,
                            size: 21,
                          ),
                        ),
                        title: Row(
                          children: [
                            Expanded(
                              child: Text(
                                sent
                                    ? mobileText(
                                        context,
                                        "发给 {0}",
                                        values: [message.displayRecipient],
                                      )
                                    : message.displaySender,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontWeight: unread
                                      ? FontWeight.w700
                                      : FontWeight.w500,
                                ),
                              ),
                            ),
                            if (unread)
                              Semantics(
                                label: '未读',
                                child: Container(
                                  width: 8,
                                  height: 8,
                                  decoration: BoxDecoration(
                                    color: theme.secondary,
                                    shape: BoxShape.circle,
                                  ),
                                ),
                              ),
                          ],
                        ),
                        subtitle: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const SizedBox(height: 4),
                            Text(
                              message.previewText,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 6),
                            Text(
                              '${_messageTime(message.createdAt)}${sent ? ' · ${_receipt(message)}' : ''}',
                              style: TextStyle(
                                fontSize: 12,
                                color: theme.inkMuted,
                              ),
                            ),
                          ],
                        ),
                        onTap: () => showMobileSheet<void>(
                          context,
                          title: '消息详情',
                          builder: (_, _) => _MessageDetail(
                            id: message.id,
                            folder: _folder,
                            identity: state.identityRevision,
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageDetail extends StatefulWidget {
  final String id;
  final TeamMessageFolder folder;
  final int identity;
  const _MessageDetail({
    required this.id,
    required this.folder,
    required this.identity,
  });
  @override
  State<_MessageDetail> createState() => _MessageDetailState();
}

class _MessageDetailState extends State<_MessageDetail> {
  String _openingAttachment = '';
  final _attachmentErrors = <String, String>{};

  bool _current(MobileState state) =>
      mounted &&
      state.identityRevision == widget.identity &&
      state.phase == MobilePhase.ready;

  Future<void> _openAttachment(String id) async {
    final state = MobileScope.read(context);
    if (!_current(state) || _openingAttachment.isNotEmpty) return;
    final message = state.teamMessages.folder(widget.folder).find(widget.id);
    if (id.isEmpty ||
        message == null ||
        message.attachments.where((file) => file['id'] == id).length != 1) {
      return;
    }
    setState(() {
      _openingAttachment = id;
      _attachmentErrors.remove(id);
    });
    try {
      final uri = await ArtifactDownloader(
        state.api,
      ).messageAttachmentAccess(id);
      if (!_current(state)) return;
      final latest = state.teamMessages.folder(widget.folder).find(widget.id);
      if (latest == null ||
          !latest.attachments.any((file) => file['id'] == id)) {
        throw const ApiFailure('消息附件已变化，请刷新后重试。');
      }
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw const ApiFailure('无法打开附件，请重试或在浏览器中下载。');
      }
    } catch (error) {
      if (_current(state)) {
        setState(
          () => _attachmentErrors[id] = error is ApiFailure
              ? error.message
              : '附件暂时无法打开，请重试。',
        );
      }
    } finally {
      if (_current(state)) setState(() => _openingAttachment = '');
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final state = MobileScope.read(context);
      if (widget.folder == TeamMessageFolder.received &&
          state.identityRevision == widget.identity &&
          state.phase == MobilePhase.ready) {
        unawaited(state.teamMessages.markRead(widget.id));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    final current =
        state.identityRevision == widget.identity &&
        state.phase == MobilePhase.ready;
    final inbox = state.teamMessages;
    final message = current
        ? inbox.folder(widget.folder).find(widget.id)
        : null;
    final sent = widget.folder == TeamMessageFolder.sent;
    return Scaffold(
      appBar: MobileSheetScope.maybeOf(context) != null
          ? null
          : AppBar(title: Text(mobileText(context, '消息详情'))),
      body: message == null
          ? Center(child: Text(mobileText(context, '消息已关闭，请返回后刷新。')))
          : ListView(
              controller: MobileSheetScope.maybeOf(context)?.scrollController,
              padding: const EdgeInsets.all(24),
              children: [
                Text(
                  sent
                      ? mobileText(
                          context,
                          "发给 {0}",
                          values: [message.displayRecipient],
                        )
                      : message.displaySender,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                Text(_messageTime(message.createdAt)),
                const SizedBox(height: 24),
                SelectableText(
                  message.text.isEmpty ? message.previewText : message.text,
                  style: const TextStyle(fontSize: 16, height: 1.7),
                ),
                if (message.attachments.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  Text(
                    mobileText(
                      context,
                      "附件（{0}）",
                      values: [message.attachments.length],
                    ),
                  ),
                  for (final file in message.attachments)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.attach_file_rounded),
                      title: Text(
                        (file['name'] ?? file['filename'] ?? '附件').toString(),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        _attachmentErrors[file['id']] ??
                            (_openingAttachment == file['id']
                                ? '正在打开…'
                                : file['id'] is! String ||
                                      (file['id'] as String).isEmpty
                                ? '附件信息不完整，请刷新消息'
                                : '点击查看或下载'),
                      ),
                      trailing: _openingAttachment == file['id']
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.open_in_new_rounded, size: 19),
                      onTap:
                          _openingAttachment.isNotEmpty ||
                              file['id'] is! String ||
                              (file['id'] as String).isEmpty
                          ? null
                          : () => _openAttachment(file['id'] as String),
                    ),
                ],
                const SizedBox(height: 24),
                if (!sent && inbox.readError(widget.id).isNotEmpty)
                  InlineError(
                    message: inbox.readError(widget.id),
                    onRetry: () => inbox.markRead(widget.id),
                  ),
                if (!sent && inbox.isReading(widget.id))
                  const LinearProgressIndicator(),
                const SizedBox(height: 12),
                Text(
                  sent
                      ? _receipt(message)
                      : message.isUnread
                      ? mobileText(context, '已读状态尚未确认')
                      : mobileText(context, '已读，电脑端将同步此状态'),
                ),
                const SizedBox(height: 20),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      onPressed: () async {
                        await Clipboard.setData(
                          ClipboardData(text: message.text),
                        );
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(mobileText(context, '已复制消息')),
                            ),
                          );
                        }
                      },
                      icon: const Icon(Icons.copy_rounded),
                      label: Text(mobileText(context, '复制消息')),
                    ),
                    if (message.taskId.isNotEmpty)
                      FilledButton.icon(
                        onPressed: () => Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) => Theme(
                              data: Theme.of(context),
                              child: TaskDetailScreen(taskId: message.taskId),
                            ),
                          ),
                        ),
                        icon: const Icon(Icons.open_in_new_rounded),
                        label: Text(mobileText(context, '查看关联工作')),
                      ),
                  ],
                ),
              ],
            ),
    );
  }
}

String _receipt(TeamMessage message) =>
    message.readAt != null || message.status == 'read'
    ? '已读'
    : message.deliveredAt != null || message.status == 'delivered'
    ? '已送达'
    : '已保存，等待接收';

String _messageTime(DateTime? value) {
  if (value == null) return '时间待同步';
  final time = value.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${time.month}/${time.day} ${two(time.hour)}:${two(time.minute)}';
}

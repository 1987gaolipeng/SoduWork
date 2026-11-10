import '../ui/mobile_display_preferences.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/account_conversation.dart';
import '../state/account_transcript_sync.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_theme.dart';
import '../ui/conversation_markdown.dart';
import '../ui/conversation_composer.dart';
import '../ui/open_work_conversation.dart';
import '../ui/personal_relay_sheet.dart';

class AccountConversationScreen extends StatefulWidget {
  final AccountConversation conversation;
  const AccountConversationScreen({super.key, required this.conversation});

  @override
  State<AccountConversationScreen> createState() =>
      _AccountConversationScreenState();
}

class _AccountConversationScreenState extends State<AccountConversationScreen>
    with WidgetsBindingObserver {
  final _transcript = AccountTranscriptSync();
  Timer? _timer;
  MobileState? _state;
  int? _scope;
  bool _foreground = true;
  StreamSubscription<void>? _accountEvents;

  bool get _current =>
      mounted &&
      _state?.phase == MobilePhase.ready &&
      _state?.identityRevision == _scope;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state == null) {
      _state = state;
      _scope = state.identityRevision;
      _accountEvents = state.accountConversationEvents.listen((_) {
        if (_current) unawaited(_load());
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_load());
      });
    }
  }

  void _schedule() {
    _timer?.cancel();
    if (_current && _foreground && !_transcript.inaccessible) {
      _timer = Timer(const Duration(seconds: 5), () => unawaited(_load()));
    }
  }

  Future<void> _load() async {
    if (!_current || _transcript.loading) return;
    final future = _transcript.refresh(
      conversationId: widget.conversation.id,
      load: ({required after, required limit}) =>
          _state!.api.accountConversationMessages(
            widget.conversation.id,
            after: after,
            limit: limit,
          ),
      isCurrent: () => _current,
    );
    setState(() {});
    await future;
    if (mounted) {
      setState(() {});
      _schedule();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) {
      unawaited(_load());
    } else {
      _timer?.cancel();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    unawaited(_accountEvents?.cancel());
    _accountEvents = null;
    _transcript.clear();
    super.dispose();
  }

  Future<void> _continueConversation() async {
    if (!_current || _transcript.inaccessible) return;
    final source = _transcript.conversation ?? widget.conversation;
    final scope = _scope;
    final receipt = await showConversationComposer(context, branch: source);
    if (!mounted || !_current || _scope != scope || receipt == null) return;
    final taskId = (receipt['taskId'] ?? '').toString();
    if (taskId.isEmpty) return;
    await openWorkConversation(context, taskId: taskId, title: '接续工作');
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    final theme = context.soduWorkTheme;
    final current = _current;
    final row = _transcript.conversation ?? widget.conversation;
    final messages = current
        ? _transcript.messages
        : <AccountConversationMessage>[];
    return Scaffold(
      appBar: AppBar(
        title: Text(current ? row.displayTitle : mobileText(context, '会话已关闭')),
        actions: [
          IconButton(
            tooltip: mobileText(context, '更新聊天记录'),
            onPressed: current && !_transcript.loading ? _load : null,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (_transcript.loading)
              const LinearProgressIndicator(minHeight: 2),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
              child: Row(
                children: [
                  Icon(Icons.devices_rounded, size: 16, color: theme.inkMuted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      current
                          ? mobileText(
                              context,
                              "{0} · 自动同步的聊天记录",
                              values: [
                                row.sourceDeviceName.isEmpty
                                    ? '来源电脑'
                                    : row.sourceDeviceName,
                              ],
                            )
                          : mobileText(context, '登录状态已变化，请返回后重新打开会话。'),
                      style: TextStyle(fontSize: 12, color: theme.inkMuted),
                    ),
                  ),
                ],
              ),
            ),
            if (current && _transcript.error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 8,
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        _transcript.error,
                        style: TextStyle(color: theme.danger),
                      ),
                    ),
                    if (!_transcript.inaccessible)
                      TextButton(
                        onPressed: _load,
                        child: Text(mobileText(context, '重试')),
                      ),
                  ],
                ),
              ),
            Expanded(
              child: messages.isEmpty
                  ? Center(
                      child: Text(
                        !current
                            ? mobileText(context, '请返回工作空间')
                            : _transcript.loading
                            ? mobileText(context, '正在同步聊天记录…')
                            : _transcript.inaccessible
                            ? mobileText(context, '会话暂不可访问')
                            : mobileText(context, '尚无已同步的聊天内容'),
                        style: TextStyle(color: theme.inkMuted),
                      ),
                    )
                  : ListView.builder(
                      key: const Key('account-transcript'),
                      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
                      itemCount:
                          messages.length + (_transcript.hasMore ? 1 : 0),
                      itemBuilder: (context, index) {
                        if (index == messages.length) {
                          return TextButton(
                            onPressed: _transcript.loading ? null : _load,
                            child: Text(mobileText(context, '加载更多聊天记录')),
                          );
                        }
                        final message = messages[index];
                        final user = message.role == 'user';
                        return Align(
                          alignment: user
                              ? Alignment.centerRight
                              : Alignment.centerLeft,
                          child: Container(
                            key: ValueKey(message.id),
                            constraints: const BoxConstraints(maxWidth: 720),
                            padding: const EdgeInsets.all(16),
                            margin: EdgeInsets.only(
                              bottom: 16,
                              left: user ? 28 : 0,
                              right: user ? 0 : 12,
                            ),
                            decoration: BoxDecoration(
                              color: user ? theme.surfaceMuted : theme.surface,
                              borderRadius: BorderRadius.circular(18),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  user
                                      ? mobileText(context, '你')
                                      : mobileText(context, '助手'),
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: theme.inkMuted,
                                  ),
                                ),
                                const SizedBox(height: 8),
                                if (user)
                                  Semantics(
                                    container: true,
                                    label: message.text,
                                    child: ExcludeSemantics(
                                      child: SelectableText(message.text),
                                    ),
                                  )
                                else
                                  Semantics(
                                    container: true,
                                    child: ConversationMarkdown(
                                      data: message.text,
                                    ),
                                  ),
                                Align(
                                  alignment: Alignment.centerRight,
                                  child: IconButton(
                                    tooltip: mobileText(context, '复制消息'),
                                    icon: const Icon(
                                      Icons.copy_rounded,
                                      size: 16,
                                    ),
                                    onPressed: () async {
                                      await Clipboard.setData(
                                        ClipboardData(text: message.text),
                                      );
                                      if (context.mounted) {
                                        ScaffoldMessenger.of(
                                          context,
                                        ).showSnackBar(
                                          SnackBar(
                                            content: Text(
                                              mobileText(context, '已复制消息'),
                                            ),
                                          ),
                                        );
                                      }
                                    },
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
            ),
            if (current && !_transcript.inaccessible)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (row.canContinue && messages.isNotEmpty) ...[
                      FilledButton.icon(
                        style: FilledButton.styleFrom(
                          minimumSize: const Size(0, 48),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 16,
                            vertical: 12,
                          ),
                        ),
                        onPressed: _transcript.loading
                            ? null
                            : () async {
                                await showPersonalRelaySheet(context, row);
                                if (_current) unawaited(_load());
                              },
                        icon: const Icon(Icons.computer_rounded),
                        label: Text(
                          mobileText(context, '在本人 PC 原会话继续'),
                          textAlign: TextAlign.center,
                        ),
                      ),
                      const SizedBox(height: 10),
                    ],
                    OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 48),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 12,
                        ),
                      ),
                      onPressed:
                          row.canContinue &&
                              messages.isNotEmpty &&
                              !_transcript.loading
                          ? _continueConversation
                          : null,
                      icon: const Icon(Icons.fork_right_rounded),
                      label: Text(
                        mobileText(context, '用这段聊天新建会话'),
                        textAlign: TextAlign.center,
                      ),
                    ),
                    const SizedBox(height: 10),
                    Text(
                      mobileText(context, '原会话继续使用原电脑；新会话可重新选择执行位置。'),
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12, color: theme.inkMuted),
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

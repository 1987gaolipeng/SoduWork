import 'package:flutter/cupertino.dart';
import 'dart:async';

import 'package:flutter/material.dart';

import '../models/account_conversation.dart';
import '../models/general_chat.dart';
import '../state/general_chat_controller.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/conversation_markdown.dart';
import '../ui/mobile_theme.dart';
import '../ui/anchored_popover.dart';
import '../ui/adaptive_conversation_input.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/work_widgets.dart';
import 'ai_resources_screen.dart';

class GeneralChatScreen extends StatefulWidget {
  final VoidCallback? onInitialAccepted;
  final String initialText;
  final String sourceSessionId;
  final AccountConversation? conversation;
  const GeneralChatScreen({
    super.key,
    this.initialText = '',
    this.sourceSessionId = '',
    this.onInitialAccepted,
    this.conversation,
  });
  @override
  State<GeneralChatScreen> createState() => _GeneralChatScreenState();
}

class _GeneralChatScreenState extends State<GeneralChatScreen>
    with WidgetsBindingObserver {
  final _draft = TextEditingController();
  final _focus = FocusNode();
  final _scroll = ScrollController();
  final _chatModelAnchor = GlobalKey();
  GeneralChatController? _chat;
  MobileState? _state;
  int? _identity;
  String _closed = '';
  bool _opened = false;
  bool _initialAccepted = false;
  bool _leaving = false;
  bool _allowPop = false;

  @override
  void initState() {
    super.initState();
    _draft.text = widget.initialText;
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_opened) {
      if (state != _state ||
          _identity != state.identityRevision ||
          state.phase != MobilePhase.ready) {
        _chat?.removeListener(_changed);
        _chat?.dispose();
        _chat = null;
        _draft.clear();
        _closed = '账号已变化，请返回后重新打开聊天。';
      }
      return;
    }
    _opened = true;
    _state = state;
    _identity = state.identityRevision;
    final registered = state.enrollment;
    if (registered == null || registered.ownerUserId.isEmpty) {
      _closed = '请先登录企业账号。';
      return;
    }
    final identity = state.identityRevision;
    _chat = GeneralChatController(
      scope: GeneralChatScope(
        endpoint: state.api.baseUrl,
        ownerId: registered.ownerUserId,
        deviceId: registered.deviceId,
      ),
      scopeKey: '${state.endpoint.baseUrl}:$identity',
      isCurrent: () =>
          state.identityRevision == identity &&
          state.phase == MobilePhase.ready,
      loadModels: state.api.chatModelCatalog,
      loadConfig: state.api.chatModelConfiguration,
      publish: state.api.syncAccountConversation,
      loadSource: state.api.accountConversationSource,
      loadMessages: (id, after) =>
          state.api.accountConversationMessages(id, after: after),
      onConversationSaved: (_) {
        if (mounted && state.identityRevision == identity) {
          unawaited(state.loadAccountConversations());
        }
      },
    )..addListener(_changed);
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final chat = _chat;
      if (!mounted || chat == null) return;
      await chat.initialize(
        conversationId: widget.conversation?.id ?? '',
        sourceSessionId: widget.sourceSessionId.isNotEmpty
            ? widget.sourceSessionId
            : widget.conversation?.sourceSessionId ?? '',
      );
      if (mounted &&
          _chat == chat &&
          widget.initialText.trim().isNotEmpty &&
          chat.conversationId.isEmpty &&
          chat.messages.isEmpty &&
          chat.recoverableSessions.isEmpty &&
          chat.canSend) {
        await _send();
      }
    });
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    if (_scroll.hasClients && _scroll.position.extentAfter < 180) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _scroll.hasClients) {
          _scroll.jumpTo(_scroll.position.maxScrollExtent);
        }
      });
    }
  }

  Future<void> _send() async {
    final chat = _chat;
    final text = _draft.text.trim();
    if (chat == null || text.isEmpty) return;
    final accepted = await chat.send(text);
    if (mounted && accepted) {
      if (!_initialAccepted) {
        _initialAccepted = true;
        widget.onInitialAccepted?.call();
      }
      if (_draft.text.trim() == text) _draft.clear();
    }
  }

  Future<void> _leave() async {
    if (_leaving) return;
    setState(() => _leaving = true);
    await _chat?.stop();
    if (!mounted) return;
    setState(() => _allowPop = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.of(context).pop();
    });
  }

  void _insert(String text) {
    final selection = _draft.selection;
    final start = selection.isValid ? selection.start : _draft.text.length;
    final end = selection.isValid ? selection.end : start;
    final next = _draft.text.replaceRange(start, end, text);
    _draft.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: start + text.length),
    );
    setState(() {});
  }

  Future<void> _models() async {
    final chat = _chat;
    if (chat == null) return;
    final identity = _identity;
    await showAnchoredPopover<void>(
      context,
      anchor: popoverAnchor(context, _chatModelAnchor),
      builder: (context) {
        final state = MobileScope.of(context);
        final current = _chat == chat && state.identityRevision == identity;
        final theme = context.soduWorkTheme;
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              fit: FlexFit.loose,
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.all(8),
                children: [
                  Padding(
                    padding: const EdgeInsets.only(left: 16),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            mobileText(context, '聊天模型'),
                            style: TextStyle(
                              color: theme.ink,
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                        IconButton(
                          tooltip: mobileText(context, '关闭'),
                          onPressed: () => Navigator.pop(context),
                          icon: const Icon(CupertinoIcons.xmark, size: 17),
                        ),
                      ],
                    ),
                  ),
                  if (!current)
                    Padding(
                      padding: EdgeInsets.all(16),
                      child: Text(mobileText(context, '账号已变化，请关闭后重新选择。')),
                    )
                  else ...[
                    for (final model in chat.models)
                      ListTile(
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                        ),
                        enabled: model.supported,
                        title: Text(
                          model.label,
                          style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        subtitle: Text(
                          model.supported
                              ? model.providerName
                              : model.unavailableReason,
                          style: TextStyle(color: theme.inkMuted, fontSize: 12),
                        ),
                        trailing: model.name == chat.selectedModel
                            ? Icon(
                                CupertinoIcons.check_mark,
                                size: 18,
                                color: theme.ink,
                              )
                            : null,
                        onTap: () {
                          if (_chat != chat || _identity != identity) return;
                          chat.selectModel(model.name);
                          Navigator.pop(context);
                        },
                      ),
                    Divider(
                      height: 12,
                      indent: 16,
                      endIndent: 16,
                      color: theme.line,
                    ),
                    ListTile(
                      leading: const Icon(
                        CupertinoIcons.slider_horizontal_3,
                        size: 20,
                      ),
                      title: Text(
                        mobileText(context, '模型设置与连接'),
                        style: TextStyle(fontSize: 13),
                      ),
                      onTap: () {
                        Navigator.pop(context);
                        _resources();
                      },
                    ),
                  ],
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Future<void> _resources() async {
    final theme = Theme.of(context);
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => Theme(data: theme, child: const AiResourcesScreen()),
      ),
    );
    if (mounted) await _chat?.refreshModels();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(_chat?.stop() ?? Future.value());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _chat?.removeListener(_changed);
    _chat?.dispose();
    _draft.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    final theme = context.soduWorkTheme;
    final chat = _chat;
    final selected = chat?.models
        .where((row) => row.name == chat.selectedModel)
        .firstOrNull;
    return PopScope(
      canPop: _allowPop || !(chat?.busy ?? false),
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_leave());
      },
      child: Scaffold(
        backgroundColor: theme.surface,
        appBar: AppBar(
          backgroundColor: theme.surface,
          title: Text(mobileText(context, '聊天')),
          actions: [
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 160),
              child: TextButton(
                key: _chatModelAnchor,
                onPressed:
                    chat == null ||
                        chat.busy ||
                        (chat.hasPending && !chat.syncUnavailable)
                    ? null
                    : _models,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Flexible(
                      child: Text(
                        selected?.label ?? mobileText(context, '选择模型'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: theme.inkSecondary,
                          fontSize: 12.5,
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    const Icon(CupertinoIcons.chevron_down, size: 12),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
          ],
        ),
        body: SafeArea(
          child: chat == null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(_closed),
                  ),
                )
              : Column(
                  children: [
                    if (chat.loading)
                      const LinearProgressIndicator(minHeight: 2),
                    if (chat.recoverableSessions.length > 1)
                      Expanded(
                        child: ListView(
                          padding: const EdgeInsets.all(20),
                          children: [
                            Text(
                              mobileText(context, '选择待同步的聊天'),
                              style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              mobileText(
                                context,
                                '以下记录保留在这台设备上。恢复会先同步记录，获取新回复仍由你确认。',
                              ),
                            ),
                            for (final id in chat.recoverableSessions)
                              ListTile(
                                leading: const Icon(CupertinoIcons.clock),
                                title: Text(
                                  chat.recoverableTitles[id] ??
                                      mobileText(context, '待同步聊天'),
                                ),
                                onTap: () =>
                                    chat.initialize(sourceSessionId: id),
                              ),
                          ],
                        ),
                      ),
                    if (chat.recoverableSessions.length <= 1)
                      Expanded(
                        child: chat.messages.isEmpty
                            ? Center(
                                child: Padding(
                                  padding: const EdgeInsets.all(28),
                                  child: Text(
                                    chat.loading
                                        ? mobileText(context, '正在准备聊天…')
                                        : mobileText(
                                            context,
                                            '提一个问题，或从一个想法开始。',
                                          ),
                                    style: TextStyle(color: theme.inkMuted),
                                  ),
                                ),
                              )
                            : ListView.builder(
                                controller: _scroll,
                                padding: const EdgeInsets.fromLTRB(
                                  20,
                                  24,
                                  20,
                                  20,
                                ),
                                itemCount:
                                    chat.messages.length +
                                    (chat.streaming &&
                                            (chat.messages.isEmpty ||
                                                chat.messages.last.role !=
                                                    'assistant')
                                        ? 1
                                        : 0),
                                itemBuilder: (context, index) {
                                  if (index == chat.messages.length) {
                                    return Padding(
                                      padding: const EdgeInsets.only(
                                        bottom: 24,
                                      ),
                                      child: Row(
                                        children: [
                                          SizedBox(
                                            width: 14,
                                            height: 14,
                                            child: CircularProgressIndicator(
                                              strokeWidth: 1.6,
                                              color: theme.inkMuted,
                                            ),
                                          ),
                                          const SizedBox(width: 10),
                                          Text(
                                            mobileText(context, '正在思考…'),
                                            style: TextStyle(
                                              color: theme.inkMuted,
                                              fontSize: 14,
                                            ),
                                          ),
                                        ],
                                      ),
                                    );
                                  }
                                  final message = chat.messages[index];
                                  final user = message.role == 'user';
                                  return Padding(
                                    padding: const EdgeInsets.only(bottom: 24),
                                    child: Align(
                                      alignment: user
                                          ? Alignment.centerRight
                                          : Alignment.centerLeft,
                                      child: Container(
                                        constraints: BoxConstraints(
                                          maxWidth:
                                              MediaQuery.sizeOf(context).width *
                                              (user ? .85 : 1),
                                        ),
                                        padding: user
                                            ? const EdgeInsets.symmetric(
                                                horizontal: 16,
                                                vertical: 12,
                                              )
                                            : EdgeInsets.zero,
                                        decoration: user
                                            ? BoxDecoration(
                                                color: theme.surfaceMuted,
                                                borderRadius:
                                                    BorderRadius.circular(20),
                                              )
                                            : null,
                                        child: message.text.isEmpty
                                            ? Text(
                                                chat.streaming
                                                    ? mobileText(
                                                        context,
                                                        '正在思考…',
                                                      )
                                                    : mobileText(
                                                        context,
                                                        '回复尚未生成',
                                                      ),
                                                style: TextStyle(
                                                  color: theme.inkMuted,
                                                ),
                                              )
                                            : user
                                            ? SelectableText(
                                                message.text,
                                                style: TextStyle(
                                                  fontSize: 15.5,
                                                  height: 1.6,
                                                  color: theme.ink,
                                                ),
                                              )
                                            : ConversationMarkdown(
                                                data: message.text,
                                              ),
                                      ),
                                    ),
                                  );
                                },
                              ),
                      ),
                    if (chat.error.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child:
                            chat.interrupted &&
                                !chat.hasPending &&
                                chat.modelError.isEmpty
                            ? Padding(
                                padding: const EdgeInsets.fromLTRB(
                                  20,
                                  0,
                                  20,
                                  12,
                                ),
                                child: Text(
                                  chat.error,
                                  style: TextStyle(
                                    color: theme.inkMuted,
                                    fontSize: 12.5,
                                    height: 1.5,
                                  ),
                                ),
                              )
                            : InlineError(
                                message: chat.error,
                                onRetry: chat.conflict
                                    ? null
                                    : chat.hasPending
                                    ? chat.retryPending
                                    : chat.modelError.isNotEmpty
                                    ? chat.refreshModels
                                    : () => chat.initialize(
                                        conversationId:
                                            widget.conversation?.id ?? '',
                                        sourceSessionId:
                                            widget
                                                .conversation
                                                ?.sourceSessionId ??
                                            '',
                                      ),
                              ),
                      ),
                    if (chat.canAnswer &&
                        chat.messages.isNotEmpty &&
                        chat.messages.last.role == 'user')
                      TextButton.icon(
                        onPressed: chat.answer,
                        icon: const Icon(
                          CupertinoIcons.arrow_clockwise,
                          size: 18,
                        ),
                        label: Text(mobileText(context, '获取回复')),
                      ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 6, 12, 8),
                      child: AdaptiveConversationInput(
                        controller: _draft,
                        focusNode: _focus,
                        voiceScopeKey: (_identity, chat.conversationId),
                        enabled: !chat.streaming && !chat.loading,
                        hint: '继续聊聊…',
                        onChanged: (_) => setState(() {}),
                        onTranscript: _insert,
                        send: IconButton.filled(
                          tooltip: chat.streaming
                              ? mobileText(context, '停止生成')
                              : mobileText(context, '发送'),
                          onPressed: chat.streaming
                              ? chat.stop
                              : chat.canSend && _draft.text.trim().isNotEmpty
                              ? _send
                              : null,
                          style: IconButton.styleFrom(
                            backgroundColor: mobileActionColor(context),
                            foregroundColor: theme.surface,
                            disabledBackgroundColor: theme.surfaceMuted,
                            disabledForegroundColor: theme.inkMuted,
                            minimumSize: const Size(44, 44),
                            maximumSize: const Size(44, 44),
                          ),
                          icon: Icon(
                            chat.streaming
                                ? CupertinoIcons.stop_fill
                                : CupertinoIcons.arrow_up,
                            size: 22,
                          ),
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        chat.hasPending
                            ? chat.syncUnavailable
                                  ? mobileText(
                                      context,
                                      '已保存在此设备 · 当前企业服务暂不支持双端同步',
                                    )
                                  : mobileText(context, '记录待同步，保留本次内容后可重试')
                            : mobileText(context, 'AI 回答仅供参考，请核对重要信息。'),
                        style: TextStyle(color: theme.inkMuted, fontSize: 11),
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

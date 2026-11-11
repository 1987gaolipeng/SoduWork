import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'adaptive_conversation_input.dart';

import '../models/conversation_models.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';

class CloudConversationHeader extends StatelessWidget
    implements PreferredSizeWidget {
  final String title;
  final String agentLabel;
  final String engineLabel;
  final String status;
  final bool running;
  final bool stopping;
  final VoidCallback? onStop;

  const CloudConversationHeader({
    super.key,
    required this.title,
    required this.agentLabel,
    required this.engineLabel,
    required this.status,
    required this.running,
    required this.stopping,
    required this.onStop,
  });

  String get _statusLabel {
    final label = conversationStateLabel(status);
    return label.isEmpty ? '同步中' : label;
  }

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final stateColor = _statusLabel == '已完成'
        ? theme.success
        : _statusLabel == '执行失败'
        ? theme.danger
        : theme.secondary;
    final metaLabel = engineLabel.isNotEmpty ? engineLabel : agentLabel;
    return AppBar(
      toolbarHeight: kToolbarHeight,
      backgroundColor: theme.surface,
      surfaceTintColor: Colors.transparent,
      titleSpacing: 0,
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: theme.ink,
                    fontSize: 16.5,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -.2,
                  ),
                ),
              ),
              if (onStop != null) ...[
                const SizedBox(width: 8),
                _StopButton(busy: stopping, onPressed: onStop!),
              ],
            ],
          ),
          const SizedBox(height: 2),
          Row(
            children: [
              StatusBeacon(size: 7, color: stateColor, pulse: running),
              const SizedBox(width: 6),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 240),
                child: Text(
                  mobileText(context, _statusLabel),
                  key: ValueKey(_statusLabel),
                  style: TextStyle(
                    color: stateColor,
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (metaLabel.isNotEmpty) ...[
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '· $metaLabel',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: theme.inkMuted, fontSize: 11),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
      shape: Border(bottom: BorderSide(color: theme.line)),
    );
  }
}

class _StopButton extends StatelessWidget {
  final bool busy;
  final VoidCallback onPressed;

  const _StopButton({required this.busy, required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Semantics(
      button: true,
      label: '叫停会话',
      child: Material(
        color: theme.surfaceMuted,
        borderRadius: BorderRadius.circular(999),
        child: InkWell(
          onTap: busy ? null : onPressed,
          borderRadius: BorderRadius.circular(999),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (busy)
                  SizedBox(
                    width: 11,
                    height: 11,
                    child: CircularProgressIndicator(
                      strokeWidth: 1.6,
                      color: theme.inkSecondary,
                    ),
                  )
                else
                  Icon(
                    Icons.stop_circle_outlined,
                    size: 14,
                    color: theme.danger,
                  ),
                const SizedBox(width: 5),
                Text(
                  busy
                      ? mobileText(context, '正在叫停')
                      : mobileText(context, '叫停'),
                  style: TextStyle(
                    color: theme.danger,
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Follow-up input
// ---------------------------------------------------------------------------

class CloudConversationComposer extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool enabled, busy, running;
  final String hint, modelLabel;
  final Object? scopeKey;
  final VoidCallback onSend;
  final VoidCallback? onOptions, onStop;
  const CloudConversationComposer({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.enabled,
    required this.busy,
    required this.hint,
    required this.onSend,
    this.modelLabel = '',
    this.scopeKey,
    this.running = false,
    this.onOptions,
    this.onStop,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        12,
        6,
        12,
        MediaQuery.paddingOf(context).bottom + 8,
      ),
      child: ValueListenableBuilder<TextEditingValue>(
        valueListenable: controller,
        builder: (context, value, _) => AdaptiveConversationInput(
          controller: controller,
          focusNode: focusNode,
          workMode: true,
          enabled: enabled && !busy,
          voiceScopeKey: scopeKey,
          inputKey: const Key('conversation-input'),
          hint: hint,
          onChanged: (_) {},
          onTranscript: (text) {
            final selection = controller.selection;
            final start = selection.isValid
                ? selection.start
                : controller.text.length;
            final end = selection.isValid ? selection.end : start;
            controller.value = TextEditingValue(
              text: controller.text.replaceRange(start, end, text),
              selection: TextSelection.collapsed(offset: start + text.length),
            );
          },
          add: onOptions == null
              ? null
              : IconButton(
                  tooltip: mobileText(context, '执行设置'),
                  onPressed: onOptions,
                  icon: const Icon(CupertinoIcons.plus, size: 23),
                ),
          model: modelLabel.isEmpty
              ? null
              : Text(
                  modelLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: theme.inkSecondary),
                ),
          send: IconButton.filled(
            tooltip: running && value.text.trim().isEmpty
                ? mobileText(context, '停止生成')
                : mobileText(context, '发送'),
            onPressed: busy || !enabled
                ? null
                : value.text.trim().isNotEmpty
                ? onSend
                : running
                ? onStop
                : null,
            style: IconButton.styleFrom(
              backgroundColor: theme.ink,
              foregroundColor: theme.surface,
              disabledBackgroundColor: theme.surfaceMuted,
              disabledForegroundColor: theme.inkMuted,
              minimumSize: const Size(40, 40),
              maximumSize: const Size(40, 40),
            ),
            icon: busy
                ? SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: theme.surface,
                    ),
                  )
                : Icon(
                    running && value.text.trim().isEmpty
                        ? CupertinoIcons.stop_fill
                        : CupertinoIcons.arrow_up,
                    size: 19,
                  ),
          ),
        ),
      ),
    );
  }
}

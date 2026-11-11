import 'package:flutter/material.dart';

import '../models/conversation_models.dart';
import '../sdk/soduwork_brand.dart';
import 'mobile_theme.dart';
import 'conversation_markdown.dart';

class _UserBubble extends StatelessWidget {
  final String text;
  final bool pending;

  const _UserBubble({required this.text, this.pending = false});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(left: 48),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          // ChatGPT-style light gray bubble; unsent drafts read slightly dimmer.
          color: pending
              ? theme.surfaceMuted.withValues(alpha: .6)
              : theme.surfaceMuted,
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(16),
            topRight: const Radius.circular(16),
            bottomLeft: const Radius.circular(16),
            bottomRight: Radius.circular(theme.radiusSmall),
          ),
        ),
        child: Text(
          text,
          style: TextStyle(color: theme.ink, fontSize: 16, height: 1.55),
        ),
      ),
    );
  }
}

class CloudConversationPendingBubble extends StatelessWidget {
  final String text;

  const CloudConversationPendingBubble({super.key, required this.text});

  @override
  Widget build(BuildContext context) {
    return _UserBubble(text: text, pending: true);
  }
}

class _AssistantBubble extends StatelessWidget {
  final String text;

  const _AssistantBubble({required this.text});

  @override
  Widget build(BuildContext context) {
    // Render the same safe assistant Markdown in every conversation source.
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.only(right: 0, top: 2, bottom: 2),
        child: ConversationMarkdown(data: text),
      ),
    );
  }
}

class CloudConversationEventTile extends StatelessWidget {
  final ConversationEvent event;

  const CloudConversationEventTile({super.key, required this.event});

  @override
  Widget build(BuildContext context) {
    if (event.isUser) return _UserBubble(text: event.displayText);
    if (event.isStep) return _StepTile(event: event);
    if (event.isThinking) return _ThinkingLine(text: event.displayText);
    if (event.isUsage) return _UsageLine(event: event);
    return _AssistantBubble(text: event.displayText);
  }
}

class _StepTile extends StatelessWidget {
  final ConversationEvent event;
  const _StepTile({required this.event});
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final tool = event.tool.toLowerCase();
    final command = RegExp('command|terminal|exec|shell|bash').hasMatch(tool);
    final files = RegExp('read|write|edit|patch|file').hasMatch(tool);
    final label = event.isError
        ? '执行遇到问题'
        : command
        ? '运行了命令'
        : files
        ? '处理了文件'
        : '执行了操作';
    final row = Row(
      children: [
        Icon(
          event.isError
              ? Icons.info_outline_rounded
              : command
              ? Icons.terminal_rounded
              : Icons.check_circle_outline_rounded,
          size: 16,
          color: theme.inkMuted,
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            label,
            style: TextStyle(color: theme.inkSecondary, fontSize: 13),
          ),
        ),
      ],
    );
    if (!event.isError) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: row,
      );
    }
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      title: row,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 24, bottom: 12),
          child: SelectableText(
            event.displayText,
            style: TextStyle(
              color: theme.inkSecondary,
              fontSize: 13,
              height: 1.6,
            ),
          ),
        ),
      ],
    );
  }
}

class _ThinkingLine extends StatelessWidget {
  final String text;

  const _ThinkingLine({required this.text});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Padding(
      padding: const EdgeInsets.only(right: 44),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.psychology_alt_outlined, size: 15, color: theme.inkMuted),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              text,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: theme.inkMuted,
                fontSize: 12.5,
                height: 1.5,
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _UsageLine extends StatelessWidget {
  final ConversationEvent event;

  const _UsageLine({required this.event});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final text = event.displayText;
    if (text.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: theme.inkMuted, fontSize: 10.5),
      ),
    );
  }
}

class CloudConversationThinkingIndicator extends StatefulWidget {
  const CloudConversationThinkingIndicator({super.key});

  @override
  State<CloudConversationThinkingIndicator> createState() =>
      _ThinkingIndicatorState();
}

class _ThinkingIndicatorState extends State<CloudConversationThinkingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    if (MediaQuery.disableAnimationsOf(context)) {
      return _bubble(theme, const [.5, .5, .5]);
    }
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = _controller.value;
        final levels = [0.0, 0.25, 0.5].map((offset) {
          final phase = (t + offset) % 1.0;
          return 0.25 + 0.75 * (1.0 - (phase * 2 - 1).abs());
        }).toList();
        return _bubble(theme, levels);
      },
    );
  }

  Widget _bubble(SoduWorkBrandTheme theme, List<double> levels) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: theme.surface,
          border: Border.all(color: theme.line),
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(theme.radiusSmall),
            topRight: const Radius.circular(16),
            bottomLeft: const Radius.circular(16),
            bottomRight: const Radius.circular(16),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var index = 0; index < 3; index++) ...[
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: theme.secondary.withValues(
                    alpha: levels[index].clamp(0, 1),
                  ),
                  shape: BoxShape.circle,
                ),
              ),
              if (index < 2) const SizedBox(width: 5),
            ],
          ],
        ),
      ),
    );
  }
}

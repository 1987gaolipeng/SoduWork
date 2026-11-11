import 'mobile_display_preferences.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/conversation_models.dart';
import 'cloud_conversation_messages.dart';
import 'mobile_theme.dart';

/// One chronological message surface for short and long running conversations.
class CloudConversationTimeline extends StatelessWidget {
  final ScrollController controller;
  final List<ConversationEvent> events;
  final List<String> pending;
  final bool thinking;
  const CloudConversationTimeline({
    super.key,
    required this.controller,
    required this.events,
    this.pending = const [],
    this.thinking = false,
  });

  bool _activity(ConversationEvent row) => row.isThinking || row.kind == 'step';

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < events.length; i++) {
      final event = events[i];
      if (event.isUsage) continue;
      if (_activity(event)) {
        final activity = <ConversationEvent>[event];
        while (i + 1 < events.length && _activity(events[i + 1])) {
          activity.add(events[++i]);
        }
        rows.add(
          _ReasoningGroup(
            key: ValueKey('reasoning-${event.seq}'),
            events: activity,
          ),
        );
      } else {
        rows.add(
          Padding(
            key: ValueKey('event-${event.seq}'),
            padding: EdgeInsets.only(
              top: event.isUser ? 18 : 10,
              bottom: event.isUser ? 14 : 6,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CloudConversationEventTile(event: event),
                if (event.isSay && event.displayText.isNotEmpty)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: IconButton(
                      tooltip: mobileText(context, '复制回答'),
                      onPressed: () async {
                        await Clipboard.setData(
                          ClipboardData(text: event.displayText),
                        );
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text(mobileText(context, '已复制'))),
                          );
                        }
                      },
                      icon: Icon(
                        CupertinoIcons.doc_on_doc,
                        size: 16,
                        color: context.soduWorkTheme.inkMuted,
                      ),
                      visualDensity: VisualDensity.compact,
                    ),
                  ),
              ],
            ),
          ),
        );
      }
    }
    for (var i = 0; i < pending.length; i++) {
      rows.add(
        Padding(
          key: ValueKey('pending-$i'),
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: CloudConversationPendingBubble(text: pending[i]),
        ),
      );
    }
    if (thinking) {
      rows.add(
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 12),
          child: CloudConversationThinkingIndicator(),
        ),
      );
    }
    return ListView(
      key: const Key('conversation-timeline'),
      controller: controller,
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      children: rows,
    );
  }
}

class _ReasoningGroup extends StatefulWidget {
  final List<ConversationEvent> events;
  const _ReasoningGroup({super.key, required this.events});
  @override
  State<_ReasoningGroup> createState() => _ReasoningGroupState();
}

class _ReasoningGroupState extends State<_ReasoningGroup> {
  bool _expanded = false;
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final thoughts = widget.events
        .where((event) => event.isThinking && event.displayText.isNotEmpty)
        .toList();
    if (thoughts.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          onPressed: () => setState(() => _expanded = !_expanded),
          icon: Icon(CupertinoIcons.sparkles, size: 15, color: theme.inkMuted),
          label: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                mobileText(context, '思考过程'),
                style: TextStyle(color: theme.inkSecondary, fontSize: 13),
              ),
              const SizedBox(width: 6),
              Icon(
                _expanded
                    ? CupertinoIcons.chevron_up
                    : CupertinoIcons.chevron_down,
                size: 11,
                color: theme.inkMuted,
              ),
            ],
          ),
          style: TextButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
            minimumSize: const Size(0, 40),
          ),
        ),
        if (_expanded)
          Container(
            margin: const EdgeInsets.only(left: 8, bottom: 10),
            padding: const EdgeInsets.only(left: 14, top: 4, bottom: 4),
            decoration: BoxDecoration(
              border: Border(
                left: BorderSide(color: theme.lineStrong, width: 2),
              ),
            ),
            child: SelectableText(
              thoughts.map((row) => row.displayText).join('\n\n'),
              style: TextStyle(
                color: theme.inkSecondary,
                fontSize: 14,
                height: 1.65,
              ),
            ),
          ),
      ],
    );
  }
}

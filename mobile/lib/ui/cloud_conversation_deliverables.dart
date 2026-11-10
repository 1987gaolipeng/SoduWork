import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../models/conversation_models.dart';
import '../sdk/soduwork_brand.dart';
import '../state/mobile_scope.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';

class CloudConversationDeliverables extends StatelessWidget {
  final List<ConversationAttachment> attachments;
  final ValueChanged<ConversationAttachment> onOpen;

  const CloudConversationDeliverables({
    super.key,
    required this.attachments,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final rows = attachments.where((item) => !item.isInput).toList();
    if (rows.isEmpty) return const SizedBox.shrink();
    return Container(
      decoration: BoxDecoration(
        color: theme.surface,
        border: Border(top: BorderSide(color: theme.line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 11, 16, 2),
            child: Row(
              children: [
                Icon(
                  Icons.inventory_2_outlined,
                  size: 15,
                  color: theme.success,
                ),
                const SizedBox(width: 7),
                Text(
                  mobileText(context, '交付成果'),
                  style: TextStyle(
                    color: theme.ink,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    letterSpacing: .3,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  mobileText(context, "{0} 个文件", values: [rows.length]),
                  style: TextStyle(color: theme.inkMuted, fontSize: 11.5),
                ),
              ],
            ),
          ),
          SizedBox(
            height: 82,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
              itemCount: rows.length,
              separatorBuilder: (_, _) => const SizedBox(width: 8),
              itemBuilder: (context, index) {
                final attachment = rows[index];
                return _DeliverableCard(
                  attachment: attachment,
                  onOpen: () => onOpen(attachment),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _DeliverableCard extends StatelessWidget {
  final ConversationAttachment attachment;
  final VoidCallback onOpen;

  const _DeliverableCard({required this.attachment, required this.onOpen});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final src = attachment.isImage && attachment.url.isNotEmpty
        ? MobileScope.read(context).api.absoluteUrl(attachment.url)
        : '';
    return Material(
      color: theme.surfaceMuted,
      borderRadius: BorderRadius.circular(theme.radiusMedium),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onOpen,
        child: SizedBox(
          width: 176,
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Row(
              children: [
                if (src.isNotEmpty)
                  ClipRRect(
                    borderRadius: BorderRadius.circular(theme.radiusSmall),
                    child: Image.network(
                      src,
                      width: 42,
                      height: 54,
                      fit: BoxFit.cover,
                      errorBuilder: (_, _, _) => _fileIcon(theme),
                    ),
                  )
                else
                  _fileIcon(theme),
                const SizedBox(width: 9),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        attachment.filename,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: theme.ink,
                          fontSize: 12.5,
                          fontWeight: FontWeight.w600,
                          height: 1.3,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        formatBytes(attachment.size),
                        style: TextStyle(color: theme.inkMuted, fontSize: 11),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _fileIcon(SoduWorkBrandTheme theme) => Container(
    width: 42,
    height: 54,
    decoration: BoxDecoration(
      color: theme.secondarySoft,
      borderRadius: BorderRadius.circular(theme.radiusSmall),
    ),
    child: Icon(
      Icons.insert_drive_file_outlined,
      size: 20,
      color: theme.secondary,
    ),
  );
}

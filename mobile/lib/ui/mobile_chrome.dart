import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../state/mobile_state.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';

class CommercialHeader extends StatelessWidget {
  final String title;
  final String subtitle;
  final int? notificationCount;
  final VoidCallback? onNotifications;
  final List<Widget> actions;
  final bool showBrand;

  const CommercialHeader({
    super.key,
    required this.title,
    this.subtitle = '',
    this.notificationCount = 0,
    this.onNotifications,
    this.actions = const [],
    this.showBrand = false,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 12, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (showBrand) ...[
            const SoduWorkMark(size: 34),
            const SizedBox(width: 11),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: context.soduWorkTheme.ink,
                    fontSize: 25,
                    height: 1.22,
                    fontWeight: FontWeight.w700,
                    letterSpacing: -.35,
                  ),
                ),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
          ...actions,
          if (onNotifications != null)
            NotificationBell(
              count: notificationCount,
              onPressed: onNotifications!,
            ),
        ],
      ),
    );
  }
}

class NotificationBell extends StatelessWidget {
  final int? count;
  final VoidCallback onPressed;

  const NotificationBell({
    super.key,
    required this.count,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: count == null
          ? mobileText(context, '通知，未读数量待同步')
          : count! > 0
          ? mobileText(context, '{0} 条未读消息', values: [count])
          : mobileText(context, '通知，没有未读消息'),
      child: Badge(
        isLabelVisible: (count ?? 0) > 0,
        label: Text((count ?? 0) > 99 ? '99+' : (count ?? 0).toString()),
        backgroundColor: context.soduWorkTheme.primary,
        child: IconButton(
          tooltip: mobileText(context, '通知'),
          onPressed: onPressed,
          icon: Icon(Icons.notifications_none_rounded),
        ),
      ),
    );
  }
}

class WorkSnapshot extends StatelessWidget {
  final MobileState state;

  const WorkSnapshot({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    final attention = state.attentionCount;
    final items = [
      (state.openTaskCount.toString(), '待推进', context.soduWorkTheme.secondary),
      (state.runningCount.toString(), 'AI / 人执行中', context.soduWorkTheme.warning),
      (attention.toString(), '待我处理', context.soduWorkTheme.primary),
    ];
    return Container(
      padding: const EdgeInsets.fromLTRB(15, 13, 15, 14),
      decoration: BoxDecoration(
        color: context.soduWorkTheme.surfaceRaised,
        border: Border.all(color: context.soduWorkTheme.line),
        borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusMedium),
      ),
      child: Column(
        children: [
          Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: attention > 0
                      ? context.soduWorkTheme.primary
                      : context.soduWorkTheme.success,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 7),
              Text(
                mobileText(context, '协同脉冲'),
                style: TextStyle(
                  color: context.soduWorkTheme.inkSecondary,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const Spacer(),
              Text(
                attention > 0
                    ? mobileText(context, "{0} 项等待行动", values: [attention])
                    : mobileText(context, '运行正常'),
                style: TextStyle(
                  color: attention > 0
                      ? context.soduWorkTheme.primary
                      : context.soduWorkTheme.success,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
          const SizedBox(height: 13),
          Row(
            children: [
              for (var index = 0; index < items.length; index++) ...[
                Expanded(child: _SnapshotMetric(item: items[index])),
                if (index < items.length - 1)
                  SizedBox(
                    height: 28,
                    child: VerticalDivider(color: context.soduWorkTheme.line),
                  ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

class _SnapshotMetric extends StatelessWidget {
  final (String, String, Color) item;

  const _SnapshotMetric({required this.item});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(color: item.$3, shape: BoxShape.circle),
        ),
        const SizedBox(width: 6),
        Text(
          item.$1,
          style: TextStyle(
            color: context.soduWorkTheme.ink,
            fontSize: 16,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            item.$2,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: context.soduWorkTheme.inkMuted, fontSize: 10.5),
          ),
        ),
      ],
    );
  }
}

class PrimaryWorkCard extends StatelessWidget {
  final String overline;
  final String title;
  final String description;
  final String actionLabel;
  final Color accent;
  final IconData icon;
  final VoidCallback onTap;

  const PrimaryWorkCard({
    super.key,
    required this.overline,
    required this.title,
    required this.description,
    required this.actionLabel,
    required this.accent,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: context.soduWorkTheme.surface,
      shape: RoundedRectangleBorder(
        side: BorderSide(color: context.soduWorkTheme.lineStrong),
        borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusLarge),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 14, 12, 14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: .10),
                  borderRadius: BorderRadius.circular(
                    context.soduWorkTheme.radiusSmall,
                  ),
                ),
                child: Icon(icon, size: 20, color: accent),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      overline,
                      style: TextStyle(
                        color: accent,
                        fontSize: 11.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 5),
                    Text(
                      description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      actionLabel,
                      style: TextStyle(
                        color: context.soduWorkTheme.inkSecondary,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Icon(
                  Icons.chevron_right_rounded,
                  size: 20,
                  color: context.soduWorkTheme.inkMuted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class SectionLabel extends StatelessWidget {
  final String title;
  final String? action;
  final VoidCallback? onTap;

  const SectionLabel({super.key, required this.title, this.action, this.onTap});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.titleMedium),
        ),
        if (action != null)
          TextButton(
            onPressed: onTap,
            style: TextButton.styleFrom(
              minimumSize: const Size(44, 40),
              padding: const EdgeInsets.symmetric(horizontal: 6),
            ),
            child: Text(action!),
          ),
      ],
    );
  }
}

class SoduWorkEmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String message;
  final String? action;
  final VoidCallback? onAction;

  const SoduWorkEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.action,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 22),
      child: Column(
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: context.soduWorkTheme.surfaceMuted,
              shape: BoxShape.circle,
            ),
            child: Icon(icon, color: context.soduWorkTheme.inkSecondary),
          ),
          SizedBox(height: 14),
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          SizedBox(height: 6),
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          if (action != null) ...[
            SizedBox(height: 14),
            TextButton(onPressed: onAction, child: Text(action!)),
          ],
        ],
      ),
    );
  }
}

import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../models/work_models.dart';
import '../sdk/soduwork_sdk_config.dart';
import 'mobile_theme.dart';

class SoduWorkMark extends StatelessWidget {
  final double size;

  const SoduWorkMark({super.key, this.size = 38});

  @override
  Widget build(BuildContext context) {
    final brand = context.soduWorkTheme;
    final customMark = SoduWorkSdkScope.maybeOf(context)?.assets.markBuilder;
    if (customMark != null) {
      return Semantics(
        label: brand.brandName,
        image: true,
        child: customMark(context, size),
      );
    }
    return Semantics(
      label: brand.brandName,
      image: true,
      child: Image.asset(
        'assets/brand/soduwork-mark.png',
        width: size,
        height: size,
        fit: BoxFit.contain,
        filterQuality: FilterQuality.high,
        excludeFromSemantics: true,
      ),
    );
  }
}

/// The app's signature status marker: a dot with a breathing halo.
/// Running work breathes in [color]; terminal work renders still.
class StatusBeacon extends StatefulWidget {
  final Color color;
  final bool pulse;
  final double size;

  const StatusBeacon({
    super.key,
    required this.color,
    this.pulse = false,
    this.size = 8,
  });

  @override
  State<StatusBeacon> createState() => _StatusBeaconState();
}

class _StatusBeaconState extends State<StatusBeacon>
    with SingleTickerProviderStateMixin {
  // Created lazily so a beacon that is disposed before its first build
  // (e.g. during tree finalization in tests) never touches TickerMode.
  AnimationController? _controller;

  AnimationController _ensureController() {
    return _controller ??= AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    );
  }

  @override
  void initState() {
    super.initState();
    if (widget.pulse) _ensureController().repeat();
  }

  @override
  void didUpdateWidget(StatusBeacon oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.pulse != oldWidget.pulse) {
      widget.pulse ? _ensureController().repeat() : _controller?.stop();
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.pulse || MediaQuery.disableAnimationsOf(context)) {
      return _dot(0);
    }
    return AnimatedBuilder(
      animation: _ensureController(),
      builder: (context, _) {
        final t = Curves.easeInOut.transform(_controller!.value);
        final halo = 1.0 + t * 1.05;
        final fade = (1.0 - t).clamp(0.0, 1.0);
        return Stack(
          alignment: Alignment.center,
          children: [
            Transform.scale(
              scale: halo,
              child: Container(
                width: widget.size,
                height: widget.size,
                decoration: BoxDecoration(
                  color: widget.color.withValues(alpha: .38 * fade),
                  shape: BoxShape.circle,
                ),
              ),
            ),
            _dot(0),
          ],
        );
      },
    );
  }

  Widget _dot(double _) => Container(
    width: widget.size,
    height: widget.size,
    decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
  );
}

class PageHeader extends StatelessWidget {
  final String eyebrow;
  final String title;
  final String subtitle;
  final Widget? trailing;

  const PageHeader({
    super.key,
    required this.eyebrow,
    required this.title,
    this.subtitle = '',
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  eyebrow.toUpperCase(),
                  style: TextStyle(
                    color: context.soduWorkTheme.primary,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.15,
                  ),
                ),
                const SizedBox(height: 5),
                Text(title, style: Theme.of(context).textTheme.headlineLarge),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(subtitle, style: Theme.of(context).textTheme.bodyMedium),
                ],
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 12), trailing!],
        ],
      ),
    );
  }
}

class WorkSurface extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final VoidCallback? onTap;

  const WorkSurface({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.color,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final shape = RoundedRectangleBorder(
      side: BorderSide(color: context.soduWorkTheme.line),
      borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusLarge),
    );
    return Material(
      color: color ?? context.soduWorkTheme.surface,
      shape: shape,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  final String title;
  final String? actionLabel;
  final VoidCallback? onAction;

  const SectionTitle({
    super.key,
    required this.title,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(title, style: Theme.of(context).textTheme.titleLarge),
        ),
        if (actionLabel != null)
          TextButton(onPressed: onAction, child: Text(actionLabel!)),
      ],
    );
  }
}

class StatePill extends StatelessWidget {
  final String label;
  final Color color;
  final Color background;
  final IconData? icon;

  const StatePill({
    super.key,
    required this.label,
    required this.color,
    required this.background,
    this.icon,
  });

  factory StatePill.task(BuildContext context, WorkTask task) {
    final meta = task.needsAttention
        ? (
            '\u9700\u8981\u5904\u7406',
            context.soduWorkTheme.primary,
            context.soduWorkTheme.primarySoft,
            Icons.error_outline_rounded,
          )
        : switch (task.status) {
            'doing' => (
              '\u8fdb\u884c\u4e2d',
              context.soduWorkTheme.warning,
              context.soduWorkTheme.warningSoft,
              Icons.play_arrow_rounded,
            ),
            'done' => (
              '\u5df2\u5b8c\u6210',
              context.soduWorkTheme.success,
              context.soduWorkTheme.successSoft,
              Icons.check_rounded,
            ),
            'cancel' => (
              '\u5df2\u53d6\u6d88',
              context.soduWorkTheme.inkMuted,
              context.soduWorkTheme.surfaceMuted,
              Icons.remove_rounded,
            ),
            _ => (
              '\u5f85\u529e',
              context.soduWorkTheme.secondary,
              context.soduWorkTheme.secondarySoft,
              Icons.schedule_rounded,
            ),
          };
    return StatePill(
      label: mobileText(context, meta.$1),
      color: meta.$2,
      background: meta.$3,
      icon: meta.$4,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 13, color: color),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class TaskRow extends StatelessWidget {
  final WorkTask task;
  final VoidCallback? onTap;
  final bool compact;
  final bool embedded;

  const TaskRow({
    super.key,
    required this.task,
    this.onTap,
    this.compact = false,
    this.embedded = false,
  });

  @override
  Widget build(BuildContext context) {
    final due = task.dueAt == null
        ? ''
        : formatShortDate(
            DateTime.fromMillisecondsSinceEpoch(task.dueAt!),
            context: context,
          );
    final content = Padding(
      padding: EdgeInsets.fromLTRB(embedded ? 15 : 14, 13, 11, 13),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: StatusBeacon(
              size: 8,
              pulse: task.isRunning,
              color: task.needsAttention
                  ? context.soduWorkTheme.primary
                  : task.isRunning
                  ? context.soduWorkTheme.warning
                  : task.status == 'done'
                  ? context.soduWorkTheme.success
                  : context.soduWorkTheme.secondary,
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  task.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: context.soduWorkTheme.ink,
                    fontSize: 14.5,
                    height: 1.36,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 7,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    StatePill.task(context, task),
                    if (task.isAi)
                      Text(
                        task.aiName.isEmpty
                            ? mobileText(context, 'AI 执行')
                            : task.aiName,
                        style: TextStyle(
                          color: context.soduWorkTheme.inkMuted,
                          fontSize: 11.5,
                        ),
                      ),
                    if (due.isNotEmpty)
                      Text(
                        mobileText(context, "截止 {0}", values: [due]),
                        style: TextStyle(
                          color: context.soduWorkTheme.inkMuted,
                          fontSize: 11.5,
                        ),
                      ),
                  ],
                ),
                if (!compact && task.latestProgress.isNotEmpty) ...[
                  const SizedBox(height: 7),
                  Text(
                    task.latestProgress,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: context.soduWorkTheme.inkSecondary,
                      fontSize: 12.5,
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 4),
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Icon(
              Icons.chevron_right_rounded,
              size: 19,
              color: context.soduWorkTheme.inkMuted,
            ),
          ),
        ],
      ),
    );
    return Semantics(
      button: true,
      label: task.title,
      child: embedded
          ? Material(
              color: Colors.transparent,
              child: InkWell(onTap: onTap, child: content),
            )
          : WorkSurface(onTap: onTap, padding: EdgeInsets.zero, child: content),
    );
  }
}

class ApprovalRow extends StatelessWidget {
  final ApprovalItem item;
  final VoidCallback? onTap;
  final bool embedded;

  const ApprovalRow({
    super.key,
    required this.item,
    this.onTap,
    this.embedded = false,
  });

  @override
  Widget build(BuildContext context) {
    final pending = item.status == 'pending';
    final content = Padding(
      padding: const EdgeInsets.fromLTRB(15, 13, 11, 13),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: pending
                  ? context.soduWorkTheme.primarySoft
                  : context.soduWorkTheme.successSoft,
              shape: BoxShape.circle,
            ),
            child: Icon(
              pending ? Icons.shield_outlined : Icons.task_alt_rounded,
              color: pending
                  ? context.soduWorkTheme.primary
                  : context.soduWorkTheme.success,
              size: 18,
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.task.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14.5,
                    height: 1.36,
                    fontWeight: FontWeight.w500,
                    color: context.soduWorkTheme.ink,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  item.hasGateContract
                      ? mobileText(
                          context,
                          "{0} · {1} 份证据",
                          values: [
                            mobileText(context, item.actionLabel),
                            item.evidenceCount,
                          ],
                        )
                      : mobileText(
                          context,
                          "{0} · 查看证据与影响范围",
                          values: [mobileText(context, item.actionLabel)],
                        ),
                  style: TextStyle(
                    color: context.soduWorkTheme.inkMuted,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Icon(
              Icons.chevron_right_rounded,
              size: 19,
              color: context.soduWorkTheme.inkMuted,
            ),
          ),
        ],
      ),
    );
    return Semantics(
      button: true,
      label: '${mobileText(context, item.actionLabel)}: ${item.task.title}',
      child: embedded
          ? Material(
              color: Colors.transparent,
              child: InkWell(onTap: onTap, child: content),
            )
          : WorkSurface(onTap: onTap, padding: EdgeInsets.zero, child: content),
    );
  }
}

class PulseLine extends StatelessWidget {
  final int pending;
  final int running;
  final int blocked;

  const PulseLine({
    super.key,
    required this.pending,
    required this.running,
    required this.blocked,
  });

  @override
  Widget build(BuildContext context) {
    final values = [pending, running, blocked];
    final maxValue = values.fold<int>(1, (a, b) => b > a ? b : a);
    return Semantics(
      label:
          '\u4eca\u65e5\u8fdb\u5c55\uff1a\u5f85\u529e $pending\uff0c\u6267\u884c\u4e2d $running\uff0c\u9700\u8981\u5904\u7406 $blocked',
      child: SizedBox(
        height: 36,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: List.generate(18, (index) {
            final group = index % 3;
            final ratio = values[group] / maxValue;
            final wave = (index % 5 + 2) / 7;
            return Expanded(
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 280),
                margin: const EdgeInsets.symmetric(horizontal: 1.5),
                height: 8 + 24 * ratio * wave,
                decoration: BoxDecoration(
                  color: [
                    context.soduWorkTheme.secondary,
                    context.soduWorkTheme.warning,
                    context.soduWorkTheme.primary,
                  ][group].withValues(alpha: 0.78),
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
}

class EmptyPane extends StatelessWidget {
  final IconData icon;
  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  const EmptyPane({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 44, horizontal: 24),
      child: Column(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: context.soduWorkTheme.surfaceMuted,
              borderRadius: BorderRadius.circular(
                (context.soduWorkTheme.radiusLarge - 1).clamp(0, 32).toDouble(),
              ),
            ),
            child: Icon(icon, color: context.soduWorkTheme.inkMuted),
          ),
          const SizedBox(height: 15),
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 6),
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          if (actionLabel != null) ...[
            const SizedBox(height: 16),
            FilledButton.tonal(onPressed: onAction, child: Text(actionLabel!)),
          ],
        ],
      ),
    );
  }
}

class LoadingPane extends StatelessWidget {
  final String label;

  const LoadingPane({
    super.key,
    this.label = '\u6b63\u5728\u540c\u6b65\u5de5\u4f5c\u4fe1\u606f\u2026',
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 56, horizontal: 20),
      child: SizedBox(
        width: double.infinity,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2.4),
            ),
            const SizedBox(height: 14),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 320),
              child: Text(
                label,
                textAlign: TextAlign.center,
                softWrap: true,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class InlineError extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;

  const InlineError({super.key, required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    if (message.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.fromLTRB(20, 0, 20, 12),
      padding: const EdgeInsets.fromLTRB(13, 11, 8, 11),
      decoration: BoxDecoration(
        color: context.soduWorkTheme.primarySoft,
        borderRadius: BorderRadius.circular(
          (context.soduWorkTheme.radiusMedium - 1).clamp(0, 32).toDouble(),
        ),
      ),
      child: Row(
        children: [
          Icon(
            Icons.info_outline_rounded,
            size: 18,
            color: context.soduWorkTheme.primary,
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              message,
              style: TextStyle(
                color: context.soduWorkTheme.inkSecondary,
                fontSize: 12.5,
              ),
            ),
          ),
          if (onRetry != null)
            TextButton(
              onPressed: onRetry,
              child: Text(mobileText(context, '\u91cd\u8bd5')),
            ),
        ],
      ),
    );
  }
}

// Compact activity timestamps use relative labels, clock times, or short dates.
String formatRelativeTime(DateTime date, {BuildContext? context}) {
  String label(String key, {List<Object?> values = const []}) => context == null
      ? values.asMap().entries.fold(
          key,
          (result, entry) =>
              result.replaceAll('{${entry.key}}', '${entry.value}'),
        )
      : mobileText(context, key, values: values);
  final now = DateTime.now();
  final diff = now.difference(date);
  if (diff.inMinutes < 1) return label('刚刚');
  if (diff.inHours < 1) return label('{0} 分钟前', values: [diff.inMinutes]);
  if (date.year == now.year && date.month == now.month && date.day == now.day) {
    String two(int value) => value.toString().padLeft(2, '0');
    return '${two(date.hour)}:${two(date.minute)}';
  }
  final yesterday = DateTime(now.year, now.month, now.day - 1);
  if (date.year == yesterday.year &&
      date.month == yesterday.month &&
      date.day == yesterday.day) {
    return label('昨天');
  }
  return label('{0}月{1}日', values: [date.month, date.day]);
}

/// 1.2 KB / 3.4 MB style size label.
String formatBytes(int bytes) {
  if (bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}

String formatShortDate(DateTime date, {BuildContext? context}) {
  final now = DateTime.now();
  if (date.year == now.year && date.month == now.month && date.day == now.day) {
    return context == null ? '今天' : mobileText(context, '今天');
  }
  return context == null
      ? '${date.month}月${date.day}日'
      : mobileText(context, '{0}月{1}日', values: [date.month, date.day]);
}

String formatDateTime(DateTime date, {BuildContext? context}) {
  String two(int value) => value.toString().padLeft(2, '0');
  final day = context == null
      ? '${date.month}月${date.day}日'
      : mobileText(context, '{0}月{1}日', values: [date.month, date.day]);
  return '$day ${two(date.hour)}:${two(date.minute)}';
}

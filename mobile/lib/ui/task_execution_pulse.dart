import 'package:flutter/material.dart';

import '../models/work_models.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';

class TaskExecutionPulse extends StatelessWidget {
  final WorkTask task;
  final AiExecutionStatus? status;

  const TaskExecutionPulse({
    super.key,
    required this.task,
    required this.status,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final error = task.aiError.isNotEmpty
        ? task.aiError
        : (status?.error ?? '');
    final attention =
        task.needsAttention || status?.stalled == true || error.isNotEmpty;
    final done = task.status == 'done' || status?.done == true;
    final running =
        !attention && !done && (task.isRunning || status?.running == true);
    final color = attention
        ? theme.warning
        : done
        ? theme.success
        : theme.primary;
    final background = attention
        ? theme.warningSoft
        : done
        ? theme.successSoft
        : theme.primarySoft;
    final title = attention
        ? 'AI \u6267\u884c\u9700\u8981\u5904\u7406'
        : done
        ? 'AI \u6267\u884c\u5df2\u7ed3\u675f'
        : running
        ? 'AI \u6b63\u5728\u6267\u884c'
        : '\u6b63\u5728\u8fde\u63a5\u6267\u884c\u673a';
    final meta = <String>{
      task.aiName,
      status?.cliName ?? '',
      status?.host ?? '',
    }.where((item) => item.trim().isNotEmpty).join(' \u00b7 ');
    final detail = error.isNotEmpty
        ? error
        : meta.isEmpty
        ? '\u72b6\u6001\u4e0e\u7ed3\u679c\u4f1a\u81ea\u52a8\u540c\u6b65\u5230\u624b\u673a'
        : '$meta \u00b7 \u72b6\u6001\u81ea\u52a8\u540c\u6b65';

    return WorkSurface(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(theme.radiusSmall + 1),
            ),
            alignment: Alignment.center,
            child: running
                ? SizedBox(
                    width: 17,
                    height: 17,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: color,
                    ),
                  )
                : Icon(
                    attention
                        ? Icons.error_outline_rounded
                        : done
                        ? Icons.check_rounded
                        : Icons.bolt_rounded,
                    size: 19,
                    color: color,
                  ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 2),
                Text(
                  detail,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

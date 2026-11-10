import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../models/work_models.dart';
import 'open_work_conversation.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';

class TaskDeliverySummary extends StatelessWidget {
  final Map<String, dynamic> delivery;
  final ValueChanged<Map<String, dynamic>>? onOpen;

  const TaskDeliverySummary({super.key, required this.delivery, this.onOpen});

  @override
  Widget build(BuildContext context) {
    final saved = jsonMap(delivery['delivery']);
    final url = (delivery['artifactUrl'] ?? '').toString().trim();
    final deliveryId = (saved['id'] ?? delivery['deliveryId'] ?? '')
        .toString()
        .trim();
    final downloadUrl = url.isNotEmpty
        ? url
        : deliveryId.isNotEmpty
        ? '/api/v1/deliveries/${Uri.encodeComponent(deliveryId)}/download'
        : '';
    final count = (saved['fileCount'] ?? jsonList(saved['files']).length)
        .toString();
    final label = saved.isNotEmpty
        ? mobileText(context, '已保存云端成果 · {0} 个文件', values: [count])
        : mobileText(context, '云端成果');
    final content = Row(
      children: [
        Icon(Icons.cloud_done_outlined, color: context.soduWorkTheme.secondary),
        const SizedBox(width: 10),
        Expanded(child: Text(label)),
        if (downloadUrl.isNotEmpty)
          Text(
            url.isNotEmpty
                ? mobileText(context, '\u5728\u7ebf')
                : mobileText(context, '预览'),
            style: TextStyle(color: context.soduWorkTheme.secondary),
          ),
        if (downloadUrl.isNotEmpty) ...[
          const SizedBox(width: 8),
          Icon(
            Icons.open_in_new_rounded,
            size: 17,
            color: context.soduWorkTheme.secondary,
          ),
        ],
      ],
    );
    return WorkSurface(
      padding: EdgeInsets.zero,
      child: downloadUrl.isNotEmpty && onOpen != null
          ? InkWell(
              borderRadius: BorderRadius.circular(
                context.soduWorkTheme.radiusMedium,
              ),
              onTap: () => onOpen!({
                'url': downloadUrl,
                'action': 'preview',
                'entryPath': saved['entryPath'],
                'filename': saved['filename'] ?? '成果包.zip',
              }),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 11,
                ),
                child: content,
              ),
            )
          : Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
              child: content,
            ),
    );
  }
}

class TaskDetailIdentity extends StatelessWidget {
  final WorkTask task;

  const TaskDetailIdentity({super.key, required this.task});

  @override
  Widget build(BuildContext context) {
    final due = task.dueAt == null
        ? ''
        : formatDateTime(
            DateTime.fromMillisecondsSinceEpoch(task.dueAt!),
            context: context,
          );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        StatePill(
          label: mobileText(
            context,
            const {
                  'intake': '收集箱',
                  'clarifying': '待补充',
                  'ready': '待开始',
                  'delivering': '进行中',
                  'reviewing': '待验收',
                  'delivered': '已完成',
                  'closed': '已归档',
                }[task.boardStage] ??
                task.boardStage,
          ),
          color: context.soduWorkTheme.secondary,
          background: context.soduWorkTheme.secondarySoft,
        ),
        const SizedBox(height: 14),
        SelectableText(
          task.title,
          style: Theme.of(context).textTheme.headlineMedium,
        ),
        const SizedBox(height: 11),
        Wrap(
          spacing: 8,
          runSpacing: 7,
          children: [
            _MetaChip(
              icon: Icons.flag_outlined,
              label: mobileText(context, _priorityLabel(task.priority)),
            ),
            if (due.isNotEmpty)
              _MetaChip(icon: Icons.event_outlined, label: due),
            if (task.source.isNotEmpty)
              _MetaChip(icon: Icons.link_rounded, label: task.source),
          ],
        ),
        if (task.assigneeName.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(mobileText(context, "负责人：{0}", values: [task.assigneeName])),
        ],
        if (task.acceptanceCriteria.isNotEmpty) ...[
          const SizedBox(height: 18),
          Text(
            mobileText(context, '完成标准'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 6),
          for (final criterion in task.acceptanceCriteria)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text('• $criterion'),
            ),
        ],
        if (task.note.isNotEmpty) ...[
          const SizedBox(height: 18),
          WorkSurface(
            padding: EdgeInsets.zero,
            child: ExpansionTile(
              key: ValueKey('requirement-description-${task.id}'),
              initiallyExpanded: task.note.length <= 240,
              shape: const Border(),
              collapsedShape: const Border(),
              title: Text(mobileText(context, '需求说明')),
              subtitle: task.note.length <= 240
                  ? null
                  : Text(
                      task.note,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
              childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              expandedCrossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: double.infinity,
                  child: SelectableText(
                    task.note,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class TaskDetailActionBar extends StatelessWidget {
  final WorkTask task;
  final bool busy;
  final ValueChanged<String> onStatus;
  final VoidCallback onProgress;
  final VoidCallback onHandoff;
  final VoidCallback onAi;
  final VoidCallback? onEdit;
  final VoidCallback? onReady;

  const TaskDetailActionBar({
    super.key,
    required this.task,
    required this.busy,
    required this.onStatus,
    required this.onProgress,
    required this.onHandoff,
    required this.onAi,
    this.onEdit,
    this.onReady,
  });

  @override
  Widget build(BuildContext context) {
    if (task.readOnly && task.canArrange) {
      return SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: FilledButton.icon(
            onPressed: busy ? null : onAi,
            icon: const Icon(Icons.assignment_ind_outlined),
            label: Text(mobileText(context, '接手并安排执行')),
          ),
        ),
      );
    }
    if (task.readOnly || task.canViewExecution == false || task.archived) {
      return SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.all(16),
          child: Text(
            mobileText(context, '当前为跟进视图，执行操作由承办设备处理。'),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    final running = task.isAi && task.isRunning;
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
        decoration: BoxDecoration(
          color: context.soduWorkTheme.surface,
          border: Border(top: BorderSide(color: context.soduWorkTheme.line)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (task.canTriage &&
                const {'intake', 'clarifying'}.contains(task.boardStage)) ...[
              Text(mobileText(context, '移至待开始后，可选择执行位置并安排执行。')),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: busy ? null : onReady,
                  icon: const Icon(Icons.arrow_forward_rounded),
                  label: Text(mobileText(context, '移至待开始')),
                ),
              ),
              if (onEdit != null)
                TextButton(
                  onPressed: busy ? null : onEdit,
                  child: Text(mobileText(context, '完善需求')),
                ),
              const SizedBox(height: 8),
            ],
            if (task.canArrange)
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: busy ? null : onHandoff,
                      icon: const Icon(Icons.person_outline_rounded),
                      label: Text(mobileText(context, '转给同事')),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.icon(
                      onPressed: busy ? null : onAi,
                      icon: const Icon(Icons.auto_awesome_outlined),
                      label: Text(mobileText(context, '安排 AI 执行')),
                    ),
                  ),
                ],
              ),
            if (task.canArrange) const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: busy ? null : onProgress,
                    icon: const Icon(Icons.edit_note_rounded),
                    label: Text(mobileText(context, '记录进展')),
                  ),
                ),
                if (running) ...[
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: null,
                      child: Text(mobileText(context, 'AI 执行中')),
                    ),
                  ),
                ] else if (task.canArrange ||
                    (task.status == 'doing' && !task.isAi)) ...[
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton.tonal(
                      onPressed: busy
                          ? null
                          : () => onStatus(
                              task.status == 'todo' ? 'doing' : 'done',
                            ),
                      child: Text(
                        task.status == 'todo'
                            ? mobileText(context, '我来处理')
                            : mobileText(context, '提交验收'),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class TaskProgressList extends StatelessWidget {
  final List<Map<String, dynamic>> progress;

  const TaskProgressList({super.key, required this.progress});

  @override
  Widget build(BuildContext context) {
    if (progress.isEmpty) {
      return WorkSurface(
        padding: const EdgeInsets.all(15),
        child: Row(
          children: [
            Icon(
              Icons.timeline_rounded,
              size: 20,
              color: context.soduWorkTheme.inkMuted,
            ),
            const SizedBox(width: 10),
            Text(
              mobileText(context, '还没有进展记录。'),
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      );
    }
    final rows = progress.reversed.toList(growable: false);
    return WorkSurface(
      padding: const EdgeInsets.fromLTRB(15, 4, 15, 4),
      child: Column(
        children: [
          for (var index = 0; index < rows.length; index++)
            _ProgressRow(item: rows[index], last: index == rows.length - 1),
        ],
      ),
    );
  }
}

class _ProgressRow extends StatelessWidget {
  final Map<String, dynamic> item;
  final bool last;

  const _ProgressRow({required this.item, required this.last});

  @override
  Widget build(BuildContext context) {
    final text = (item['text'] ?? item['content'] ?? item['note'] ?? '')
        .toString();
    final at = int.tryParse((item['at'] ?? 0).toString()) ?? 0;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 18,
          child: Column(
            children: [
              const SizedBox(height: 15),
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: context.soduWorkTheme.secondary,
                  shape: BoxShape.circle,
                ),
              ),
              if (!last)
                Container(
                  width: 1,
                  height: 58,
                  color: context.soduWorkTheme.lineStrong,
                ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SelectableText(
                  text,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                if (at > 0) ...[
                  const SizedBox(height: 5),
                  Text(
                    formatDateTime(
                      DateTime.fromMillisecondsSinceEpoch(at),
                      context: context,
                    ),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class TaskArtifactList extends StatelessWidget {
  final List<Map<String, dynamic>> artifacts;
  final ValueChanged<Map<String, dynamic>> onOpen;

  const TaskArtifactList({
    super.key,
    required this.artifacts,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    return WorkSurface(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (var index = 0; index < artifacts.length; index++) ...[
            Builder(
              builder: (context) {
                final item = artifacts[index];
                final name =
                    (item['name'] ?? item['filename'] ?? item['title'] ?? '成果')
                        .toString();
                final role = (item['displayRole'] ?? '').toString();
                return ListTile(
                  leading: Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: context.soduWorkTheme.secondarySoft,
                      borderRadius: BorderRadius.circular(
                        context.soduWorkTheme.radiusSmall + 1,
                      ),
                    ),
                    child: Icon(
                      Icons.description_outlined,
                      size: 19,
                      color: context.soduWorkTheme.secondary,
                    ),
                  ),
                  title: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: role == 'online'
                      ? Text(
                          mobileText(
                            context,
                            '\u5728\u7ebf\u6210\u679c \u00b7 \u70b9\u51fb\u6253\u5f00',
                          ),
                        )
                      : (role.isEmpty
                            ? null
                            : Text(
                                role == 'evidence'
                                    ? mobileText(
                                        context,
                                        '\u9a8c\u8bc1\u6750\u6599',
                                      )
                                    : mobileText(
                                        context,
                                        '\u4ea4\u4ed8\u6587\u4ef6',
                                      ),
                              )),
                  trailing: PopupMenuButton<String>(
                    onSelected: (value) => onOpen({
                      ...item,
                      if (value == 'save') 'libraryAction': 'save',
                    }),
                    itemBuilder: (_) => [
                      const PopupMenuItem(value: 'open', child: Text('打开成果')),
                      if (role != 'online')
                        const PopupMenuItem(
                          value: 'save',
                          child: Text('保存到资料库'),
                        ),
                    ],
                  ),
                  onTap: () => onOpen(item),
                );
              },
            ),
            if (index < artifacts.length - 1) Divider(),
          ],
        ],
      ),
    );
  }
}

class TaskDetailSectionLabel extends StatelessWidget {
  final String label;
  final String description;

  const TaskDetailSectionLabel({
    super.key,
    required this.label,
    this.description = '',
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(label, style: Theme.of(context).textTheme.titleMedium),
        ),
        if (description.isNotEmpty)
          Flexible(
            child: Text(
              description,
              textAlign: TextAlign.right,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
      ],
    );
  }
}

class _MetaChip extends StatelessWidget {
  final IconData icon;
  final String label;

  const _MetaChip({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: context.soduWorkTheme.surfaceMuted,
        borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusSmall),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: context.soduWorkTheme.inkMuted),
          const SizedBox(width: 5),
          Text(
            label,
            style: TextStyle(
              color: context.soduWorkTheme.inkSecondary,
              fontSize: 11.5,
            ),
          ),
        ],
      ),
    );
  }
}

String _priorityLabel(String value) => switch (value) {
  'low' => '低优先级',
  'high' => '高优先级',
  'critical' => '紧急',
  _ => '普通',
};

/// Opens an existing task transcript in the workspace conversation surface.
class TaskCloudConversationEntry extends StatelessWidget {
  final WorkTask task;

  const TaskCloudConversationEntry({super.key, required this.task});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final agent = task.aiName.isNotEmpty
        ? task.aiName
        : task.createdByName.isNotEmpty
        ? task.createdByName
        : '云端执行者';
    return Material(
      color: theme.secondarySoft,
      borderRadius: BorderRadius.circular(theme.radiusMedium),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => openWorkConversation(
          context,
          taskId: task.id,
          title: task.title,
          agentLabel: agent,
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Icon(Icons.forum_outlined, size: 18, color: theme.secondary),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      mobileText(
                        context,
                        task.origin == 'cloud-conversation'
                            ? '这个任务来自一次云端会话'
                            : '打开执行会话',
                      ),
                      style: TextStyle(
                        color: theme.ink,
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      mobileText(context, "查看与 {0} 的完整对话和成果", values: [agent]),
                      style: TextStyle(
                        color: theme.inkSecondary,
                        fontSize: 11.5,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(
                Icons.chevron_right_rounded,
                size: 20,
                color: theme.secondary,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

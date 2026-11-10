import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../models/work_models.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';
import 'requirement_capabilities.dart';

class TaskLifecyclePanel extends StatelessWidget {
  final WorkTask task;
  final Map<String, dynamic> trace;
  final ValueChanged<Map<String, dynamic>>? onOpenEvidence;

  const TaskLifecyclePanel({
    super.key,
    required this.task,
    required this.trace,
    this.onOpenEvidence,
  });

  bool get _isAutomated {
    final runs = jsonList(trace['runs']);
    final deployments = jsonList(trace['deployments']);
    final ai = jsonMap(trace['ai']);
    final execution = jsonMap(trace['execution']);
    final authority = (execution['authority'] ?? trace['authority'] ?? '')
        .toString();
    return task.isAi ||
        runs.isNotEmpty ||
        deployments.isNotEmpty ||
        ai.isNotEmpty ||
        (authority.isNotEmpty && authority != 'manual');
  }

  List<Map<String, dynamic>> get _phases {
    final raw = jsonList(trace['phases']);
    if (raw.isNotEmpty) {
      return raw.map(jsonMap).toList(growable: false);
    }
    return jsonList(trace['stages']).map(jsonMap).toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    if (!_isAutomated) {
      return WorkSurface(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              Icons.person_outline_rounded,
              color: context.soduWorkTheme.inkMuted,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    mobileText(context, '\u4eba\u5de5\u4efb\u52a1'),
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 5),
                  Text(
                    mobileText(
                      context,
                      '\u8fd9\u9879\u4efb\u52a1\u5c1a\u672a\u8fdb\u5165 AI \u6216\u81ea\u52a8\u5316\u5de5\u4f5c\u6d41\uff0c\u53ea\u5c55\u793a\u8d1f\u8d23\u4eba\u63d0\u4ea4\u7684\u8fdb\u5c55\u3002',
                    ),
                    style: TextStyle(
                      color: context.soduWorkTheme.inkMuted,
                      fontSize: 13,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    final phases = _phases;
    final completed = phases.where(_isDone).length;
    return WorkSurface(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  mobileText(context, '\u6267\u884c\u5168\u94fe\u8def'),
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              Text(
                phases.isEmpty ? '' : '$completed/${phases.length}',
                style: TextStyle(
                  color: context.soduWorkTheme.inkMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            mobileText(
              context,
              '\u70b9\u51fb\u9636\u6bb5\u67e5\u770b\u5bf9\u8bdd\u3001\u8bc1\u636e\u3001\u786e\u8ba4\u4e0e\u7ed3\u679c\u3002',
            ),
            style: TextStyle(color: context.soduWorkTheme.inkMuted, fontSize: 12.5),
          ),
          const SizedBox(height: 16),
          if (phases.isEmpty)
            Text(
              mobileText(
                context,
                '\u6b63\u5728\u7b49\u5f85\u6267\u884c\u9636\u6bb5\u56de\u6d41\u2026',
              ),
              style: TextStyle(color: context.soduWorkTheme.inkMuted, fontSize: 13),
            )
          else
            SizedBox(
              height: 96,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: phases.length,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (context, index) {
                  final phase = phases[index];
                  return _PhaseCard(
                    index: index,
                    phase: phase,
                    onTap: () => _showPhase(context, index, phase),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }

  bool _isDone(Map<String, dynamic> phase) {
    final status = (phase['status'] ?? phase['state'] ?? '').toString();
    return _successStates.contains(status);
  }

  List<Map<String, dynamic>> _stagesFor(Map<String, dynamic> phase) {
    // Hub phases contain counters; stage.category is their exact key.
    // Never associate rows using translated labels or missing categories.
    final key = phase['key'];
    if (key is! String || key.isEmpty) return const [];
    return jsonList(trace['stages'])
        .map(jsonMap)
        .where((stage) => stage['category'] == key)
        .toList(growable: false);
  }

  List<Map<String, dynamic>> _evidenceFor(
    Map<String, dynamic> phase,
    List<Map<String, dynamic>> stages,
  ) {
    final rows = <Map<String, dynamic>>[];
    final identities = <String>{};
    for (final source in [phase, ...stages]) {
      for (final raw in jsonList(
        source['evidence'] ?? source['artifacts'] ?? source['attachments'],
      )) {
        if (raw is! Map) continue;
        final row = jsonMap(raw);
        final id = row['attachmentId'] ?? row['id'];
        if (id is String &&
            id.isNotEmpty &&
            !identities.add("${row['kind'] ?? ''}:$id")) {
          continue;
        }
        rows.add(row);
      }
    }
    return rows;
  }

  void _showPhase(BuildContext context, int index, Map<String, dynamic> phase) {
    final title = _phaseTitle(phase, index);
    final detail = _firstText(phase, [
      'summary',
      'description',
      'result',
      'note',
      'message',
    ]);
    final stages = _stagesFor(phase);
    final evidence = _evidenceFor(phase, stages);
    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      showDragHandle: true,
      isScrollControlled: true,
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .85,
      ),
      builder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        child: ListView(
          shrinkWrap: true,
          children: [
            Text(title, style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 8),
            StatePill(
              label: mobileText(context, _statusLabel(phase)),
              color: _statusColor(context, phase),
              background: _statusColor(context, phase).withValues(alpha: 0.1),
            ),
            if (detail.isNotEmpty) ...[
              const SizedBox(height: 18),
              SelectableText(
                detail,
                style: TextStyle(
                  color: context.soduWorkTheme.inkSecondary,
                  fontSize: 14,
                  height: 1.6,
                ),
              ),
            ],
            if (stages.isNotEmpty) ...[
              const SizedBox(height: 20),
              Text(
                mobileText(context, '执行阶段'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
              for (var i = 0; i < stages.length; i++)
                _StageDetail(stage: stages[i], index: i),
            ],
            const SizedBox(height: 20),
            Text(
              mobileText(context, "证据与产出 {0}", values: [evidence.length]),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 9),
            if (evidence.isEmpty)
              Text(
                mobileText(
                  context,
                  '\u8fd9\u4e2a\u9636\u6bb5\u8fd8\u6ca1\u6709\u56de\u6d41\u8bc1\u636e\u3002',
                ),
                style: TextStyle(
                  color: context.soduWorkTheme.inkMuted,
                  fontSize: 13,
                ),
              )
            else
              ...evidence.map((item) {
                final map = jsonMap(item);
                final name = _firstText(map, [
                  'name',
                  'filename',
                  'title',
                  'type',
                ]);
                final artifact = phaseEvidenceArtifact(map);
                return ListTile(
                  onTap: artifact == null || onOpenEvidence == null
                      ? null
                      : () => onOpenEvidence!(artifact),
                  trailing: artifact == null || onOpenEvidence == null
                      ? null
                      : const Icon(Icons.open_in_new_rounded, size: 18),
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.attach_file_rounded),
                  title: Text(
                    name.isEmpty
                        ? mobileText(context, '\u9636\u6bb5\u8bc1\u636e')
                        : name,
                  ),
                  subtitle: _firstText(map, ['summary']).isEmpty
                      ? null
                      : Text(_firstText(map, ['summary'])),
                );
              }),
          ],
        ),
      ),
    );
  }
}

class _PhaseCard extends StatelessWidget {
  final int index;
  final Map<String, dynamic> phase;
  final VoidCallback onTap;

  const _PhaseCard({
    required this.index,
    required this.phase,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final status = (phase['status'] ?? phase['state'] ?? '').toString();
    final done = _successStates.contains(status);
    final active = {
      'doing',
      'running',
      'active',
      'pending_review',
      'waiting_human',
      'waiting_external',
      'queued',
      'dispatching',
    }.contains(status);
    final color = done
        ? context.soduWorkTheme.success
        : active
        ? context.soduWorkTheme.warning
        : context.soduWorkTheme.inkMuted;
    final title = _phaseTitle(phase, index);
    return Material(
      color: active
          ? context.soduWorkTheme.warningSoft
          : context.soduWorkTheme.surfaceMuted,
      borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusMedium),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusMedium),
        child: Container(
          width: 126,
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 23,
                height: 23,
                decoration: BoxDecoration(
                  color: done ? color : Colors.transparent,
                  shape: BoxShape.circle,
                  border: Border.all(color: color),
                ),
                child: Center(
                  child: done
                      ? Icon(
                          Icons.check_rounded,
                          size: 14,
                          color: SoduWorkTheme.readableOn(color),
                        )
                      : Text(
                          '${index + 1}',
                          style: TextStyle(
                            color: color,
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                ),
              ),
              const Spacer(),
              Text(
                title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: context.soduWorkTheme.ink,
                  fontSize: 12.5,
                  height: 1.25,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _phaseTitle(Map<String, dynamic> phase, int index) {
  final value = _firstText(phase, [
    'title',
    'name',
    'label',
    'stageName',
    'phaseName',
  ]);
  return value.isEmpty ? '\u9636\u6bb5 ${index + 1}' : value;
}

String _statusLabel(Map<String, dynamic> phase) {
  final status = (phase['status'] ?? phase['state'] ?? '').toString();
  return switch (status) {
    'done' ||
    'completed' ||
    'passed' ||
    'approved' ||
    'succeeded' => '\u5df2\u5b8c\u6210',
    'doing' || 'running' || 'active' => '\u6267\u884c\u4e2d',
    'failed' || 'blocked' || 'stuck' => '\u9700\u8981\u5904\u7406',
    'pending_review' || 'waiting_human' => '等待确认',
    'waiting_external' => '等待外部结果',
    'queued' || 'dispatching' => '等待执行',
    'cancelled' || 'canceled' => '已取消',
    'interrupted' => '已中断',
    'stopped' => '已停止',
    'rework' => '待返修',
    _ => '\u672a\u5f00\u59cb',
  };
}

Color _statusColor(BuildContext context, Map<String, dynamic> phase) {
  final status = (phase['status'] ?? phase['state'] ?? '').toString();
  if (_successStates.contains(status)) {
    return context.soduWorkTheme.success;
  }
  if ({
    'doing',
    'running',
    'active',
    'pending_review',
    'waiting_human',
    'waiting_external',
    'queued',
    'dispatching',
  }.contains(status)) {
    return context.soduWorkTheme.warning;
  }
  if ({'failed', 'blocked', 'stuck'}.contains(status)) {
    return context.soduWorkTheme.primary;
  }
  return context.soduWorkTheme.inkMuted;
}

String _firstText(Map<String, dynamic> source, List<String> keys) {
  for (final key in keys) {
    final value = source[key];
    if (value is String && value.trim().isNotEmpty) {
      return value.trim();
    }
  }
  return '';
}

const _successStates = {'done', 'completed', 'passed', 'approved', 'succeeded'};

class _StageDetail extends StatelessWidget {
  final Map<String, dynamic> stage;
  final int index;
  const _StageDetail({required this.stage, required this.index});

  @override
  Widget build(BuildContext context) {
    final summary = _firstText(stage, [
      'summary',
      'description',
      'error',
      'message',
    ]);
    final sessions = jsonList(stage['sessions']).map(jsonMap).toList();
    final decisions = jsonList(stage['decisions']).map(jsonMap).toList();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${_phaseTitle(stage, index)} · ${mobileText(context, _statusLabel(stage))}',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          if (summary.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: SelectableText(summary),
            ),
          for (final session in sessions)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                mobileText(
                  context,
                  "执行记录：{0}",
                  values: [
                    _firstText(session, [
                      'summary',
                      'assignee',
                      'name',
                      'ref',
                      'id',
                    ]),
                  ],
                ),
              ),
            ),
          for (final decision in decisions)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                mobileText(
                  context,
                  "确认记录：{0}",
                  values: [
                    _firstText(decision, [
                      'note',
                      'summary',
                      'decision',
                      'status',
                    ]),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

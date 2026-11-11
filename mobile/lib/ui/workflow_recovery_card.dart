import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import 'capability_widgets.dart';
import 'work_widgets.dart';

/// Use the same authoritative current-gate projection as the PC trace view.
class WorkflowRecoveryCard extends StatefulWidget {
  final WorkTask task;
  final Map<String, dynamic> trace;
  final Future<void> Function() onChanged;
  const WorkflowRecoveryCard({
    super.key,
    required this.task,
    required this.trace,
    required this.onChanged,
  });
  @override
  State<WorkflowRecoveryCard> createState() => _WorkflowRecoveryCardState();
}

class _WorkflowRecoveryCardState extends CapabilityState<WorkflowRecoveryCard> {
  bool _uncertain = false;
  Map<String, dynamic> get _card => jsonMap(widget.trace['card']);
  Map<String, dynamic> get _stage => jsonMap(_card['stage']);
  bool _eligible(Map<String, dynamic> card) {
    final stage = jsonMap(card['stage']);
    return card['taskId'] == widget.task.id &&
        card['canRetry'] == true &&
        card['readOnly'] != true &&
        (card['runId'] ?? '').toString().isNotEmpty &&
        (stage['key'] ?? '').toString().isNotEmpty &&
        {'failed', 'blocked', 'rework'}.contains(stage['state']) &&
        jsonMap(stage['diagnosis'])['retryable'] == true;
  }

  String _fingerprint(Map<String, dynamic> card) {
    final stage = jsonMap(card['stage']);
    return [
      card['taskId'],
      card['runId'],
      stage['key'],
      stage['attempt'],
      stage['state'],
      jsonMap(stage['diagnosis'])['actionKey'],
    ].join('|');
  }

  @override
  void didUpdateWidget(covariant WorkflowRecoveryCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_fingerprint(jsonMap(oldWidget.trace['card'])) != _fingerprint(_card)) {
      _uncertain = false;
      error = '';
      receipt = '';
    }
  }

  Future<void> _act(bool recover) async {
    if (!current ||
        busy ||
        _uncertain ||
        widget.task.readOnly ||
        !_eligible(_card)) {
      return;
    }
    final initial = Map<String, dynamic>.from(_card);
    final runId = initial['runId'].toString();
    final stage = jsonMap(initial['stage']);
    if (!await confirm(
      recover ? '检查并取回产出' : '重试当前关口',
      recover
          ? '将检查已结束的执行并尝试收集产出；恢复成功后工作流可能继续执行后续节点。'
          : '将重新执行当前失败关口，并保留已经通过的阶段与证据；不会代替人工审批。',
    )) {
      return;
    }
    if (_fingerprint(initial) != _fingerprint(_card)) return;
    var sent = false;
    await perform((api) async {
      try {
        final latest = jsonMap((await api.taskTrace(widget.task.id))['card']);
        if (!current) return;
        if (!_eligible(latest) ||
            _fingerprint(latest) != _fingerprint(initial)) {
          await widget.onChanged();
          throw const ApiFailure('运行、节点或权限已变化，请核对最新状态后再操作。');
        }
        sent = true;
        final result = recover
            ? await api.recoverWorkflowArtifacts(runId)
            : await api.retryWorkflowGate(
                runId,
                stage['key'].toString(),
                resumeRework:
                    jsonMap(stage['diagnosis'])['actionKey'] == 'resume-rework',
              );
        if (!current) return;
        if (result['ok'] != true || jsonMap(result['run'])['id'] != runId) {
          throw const ApiFailure('未收到匹配本次运行的确认回执。');
        }
        // Keep the action locked until the authoritative gate changes.
        _uncertain = true;
        receipt = '操作已受理，请查看更新后的执行状态。';
        await widget.onChanged();
      } catch (e) {
        if (e is ApiFailure && e.status >= 400 && e.status < 500) rethrow;
        if (sent && current) {
          _uncertain = true;
          throw const ApiFailure('操作结果未确认，请刷新核对运行记录，不要重复发起。');
        }
        rethrow;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    if (invalidated) return identityNotice;
    if (widget.task.readOnly || !_eligible(_card)) {
      return const SizedBox.shrink();
    }
    final kind = _stage['type'] ?? _stage['kind'];
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: WorkSurface(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            text('处理执行异常'),
            const SizedBox(height: 6),
            Text(
              (_stage['name'] ?? _stage['key']).toString(),
              style: Theme.of(context).textTheme.titleMedium,
            ),
            if ((_stage['error'] ?? '').toString().isNotEmpty)
              Text(
                _stage['error'].toString(),
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
              ),
            ...feedback,
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.tonal(
                  onPressed: busy || _uncertain ? null : () => _act(false),
                  child: text(
                    jsonMap(_stage['diagnosis'])['actionKey'] == 'resume-rework'
                        ? '按审查意见继续返修'
                        : '重试当前关口',
                  ),
                ),
                if (kind == 'ai' || kind == 'ai_review')
                  OutlinedButton(
                    onPressed: busy || _uncertain ? null : () => _act(true),
                    child: text('检查并取回产出'),
                  ),
                TextButton(
                  onPressed: busy
                      ? null
                      : () => perform((_) => widget.onChanged()),
                  child: text('刷新执行状态'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

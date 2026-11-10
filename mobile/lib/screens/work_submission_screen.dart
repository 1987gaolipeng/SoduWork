import '../ui/mobile_display_preferences.dart';
import 'dart:async';
import 'package:flutter/material.dart';

import '../core/soduwork_api.dart';
import '../core/work_submission_store.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/conversation_markdown.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';
import '../ui/open_work_conversation.dart';
import 'task_detail_screen.dart';

class WorkSubmissionScreen extends StatefulWidget {
  final WorkSubmission submission;
  final String scope;
  final int identity;
  final bool autoSubmit;
  const WorkSubmissionScreen({
    super.key,
    required this.submission,
    required this.scope,
    required this.identity,
    this.autoSubmit = false,
  });
  @override
  State<WorkSubmissionScreen> createState() => _WorkSubmissionScreenState();
}

class _WorkSubmissionScreenState extends State<WorkSubmissionScreen>
    with WidgetsBindingObserver {
  final _store = WorkSubmissionStore();
  bool _busy = false;
  bool _accepted = false;
  bool _registered = false;
  bool _foreground = true;
  bool _closed = false;
  String _error = '';
  String _status = '这笔工作尚待确认。';
  String _taskId = '';
  Map<String, dynamic>? _run;
  MobileState? _state;
  Timer? _timer;

  bool get _current =>
      mounted &&
      !_closed &&
      _state?.identityRevision == widget.identity &&
      _state?.phase == MobilePhase.ready;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state == null) {
      _state = state;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_current && widget.autoSubmit) unawaited(_submit());
      });
    }
    if (state.identityRevision != widget.identity ||
        state.phase != MobilePhase.ready) {
      _closed = true;
      _run = null;
      _timer?.cancel();
      _error = '';
      _status = '账号已变化，工作内容已隐藏。';
    }
  }

  Future<void> _submit() async {
    if (!_current || _busy || _accepted) return;
    setState(() {
      _busy = true;
      _error = '';
      _status = '正在确认这笔工作…';
    });
    try {
      final input = widget.submission;
      final result = input.kind == 'workflow'
          ? await _state!.api.submitMobileWork(input.id, input.payload)
          : await _state!.api.sendMateMessage(
              input.payload['recipientId'] as String,
              input.payload['text'] as String,
              input.id,
            );
      if (!_current) return;
      if (input.kind == 'workflow') {
        await _acceptWorkflow(result);
      } else {
        if (result['ok'] != true ||
            (result['messageId'] ?? '').toString().isEmpty) {
          throw const ApiFailure('留言回执尚未确认，请核对原请求。', isNetwork: true);
        }
        final inbox = await _state!.api.teamMessages(folder: 'sent');
        if (!_current) return;
        final rows = inbox['items'] is List
            ? (inbox['items'] as List).whereType<Map>()
            : const <Map>[];
        final confirmed = rows
            .where(
              (row) =>
                  row['id'] == result['messageId'] &&
                  row['messageId'] == input.id &&
                  row['recipientId'] == input.payload['recipientId'] &&
                  row['text'] == input.payload['text'],
            )
            .firstOrNull;
        if (confirmed == null) {
          throw const ApiFailure('留言已受理，发件记录尚未核对。请保留原请求后再确认。', isNetwork: true);
        }
        await _store.clear(widget.scope, input.id);
        if (!_current) return;
        setState(() {
          _accepted = true;
          _status = confirmed['status'] == 'read'
              ? '同事已读'
              : confirmed['status'] == 'delivered'
              ? '已送达同事'
              : '留言已保存，等待对方接收。';
        });
        unawaited(_state!.loadTeamMessages());
      }
    } on ApiFailure catch (failure) {
      if (_current) {
        setState(() {
          _error = failure.message;
          _status = '结果尚未确认，已保留原请求。';
        });
      }
    } catch (_) {
      if (_current) {
        setState(() {
          _error = '暂时无法确认结果，请核对原请求，避免重复执行。';
        });
      }
    } finally {
      if (_current) setState(() => _busy = false);
    }
  }

  Future<void> _acceptWorkflow(Map<String, dynamic> result) async {
    if (result['ok'] != true || result['requestId'] != widget.submission.id) {
      throw const ApiFailure('回执与本次工作不一致，请核对原请求。', isNetwork: true);
    }
    final taskId = (result['taskId'] ?? '').toString();
    if (taskId.isNotEmpty) {
      _taskId = taskId;
      _registered = true;
    }
    if (result['phase'] != 'started' ||
        (result['runId'] ?? '').toString().isEmpty) {
      setState(() => _status = '工作已登记，执行状态仍在确认。');
      _schedule();
      return;
    }
    await _store.clear(widget.scope, widget.submission.id);
    if (!_current) return;
    setState(() {
      _accepted = true;
      _run = result['run'] is Map
          ? Map<String, dynamic>.from(result['run'] as Map)
          : null;
      _status = _runStatus(_run?['state']?.toString() ?? 'running');
    });
    unawaited(_state!.refreshAll());
    _schedule();
  }

  Future<void> _check() async {
    if (!_current || _busy) return;
    if (widget.submission.kind != 'workflow') {
      await _submit();
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final value = await _state!.api.mobileWorkStatus(widget.submission.id);
      if (_current) await _acceptWorkflow(value);
    } on ApiFailure catch (failure) {
      if (_current) {
        setState(
          () => _error = failure.status == 404
              ? '尚未找到已登记结果。保留原请求，可由下方按钮再次确认提交。'
              : failure.message,
        );
      }
    } catch (_) {
      if (_current) setState(() => _error = '暂时无法读取执行状态，请稍后核对。');
    } finally {
      if (_current) {
        setState(() => _busy = false);
        _schedule();
      }
    }
  }

  void _schedule() {
    _timer?.cancel();
    if (_current &&
        _foreground &&
        widget.submission.kind == 'workflow' &&
        (_accepted || _registered) &&
        !{'succeeded', 'failed', 'cancelled'}.contains(_run?['state'])) {
      _timer = Timer(const Duration(seconds: 5), () => unawaited(_check()));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground) {
      _schedule();
    } else {
      _timer?.cancel();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    final theme = context.soduWorkTheme;
    final instruction =
        widget
            .submission
            .payload[widget.submission.kind == 'workflow'
                ? 'instruction'
                : 'text']
            ?.toString() ??
        '';
    final nodes = _run?['nodes'] is List
        ? (_run!['nodes'] as List).whereType<Map>().toList()
        : const <Map>[];
    final hasConversation = nodes.any(
      (node) =>
          node['executor'] is Map &&
          ((node['executor'] as Map)['ref'] ?? '').toString().isNotEmpty,
    );
    final output = _run?['output'];
    final text = output is String
        ? output
        : output is Map
        ? [
                output['text'],
                output['summary'],
                output['result'],
              ].whereType<String>().firstOrNull ??
              ''
        : '';
    return Scaffold(
      backgroundColor: theme.surface,
      appBar: AppBar(
        title: Text(
          _closed ? mobileText(context, '工作对话') : widget.submission.label,
        ),
      ),
      body: SafeArea(
        child: _closed
            ? Center(child: Text(_status))
            : Column(
                children: [
                  if (_busy) const LinearProgressIndicator(minHeight: 2),
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsets.all(20),
                      children: [
                        Align(
                          alignment: Alignment.centerRight,
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 16,
                              vertical: 12,
                            ),
                            constraints: BoxConstraints(
                              maxWidth: MediaQuery.sizeOf(context).width * .85,
                            ),
                            decoration: BoxDecoration(
                              color: theme.surfaceMuted,
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: SelectableText(
                              instruction,
                              style: TextStyle(
                                color: theme.ink,
                                fontSize: 15.5,
                                height: 1.6,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 26),
                        Row(
                          children: [
                            Icon(
                              widget.submission.kind == 'workflow'
                                  ? Icons.auto_awesome_outlined
                                  : Icons.alternate_email_rounded,
                              size: 20,
                              color: theme.inkSecondary,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                _status,
                                style: TextStyle(
                                  color: theme.ink,
                                  fontWeight: FontWeight.w500,
                                  height: 1.6,
                                ),
                              ),
                            ),
                          ],
                        ),
                        if (_error.isNotEmpty) ...[
                          const SizedBox(height: 16),
                          InlineError(message: mobileText(context, _error), onRetry: _check),
                        ],
                        if (nodes.isNotEmpty) ...[
                          const SizedBox(height: 20),
                          for (final node in nodes)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: Row(
                                children: [
                                  Icon(
                                    node['state'] == 'succeeded'
                                        ? Icons.check_circle_outline_rounded
                                        : Icons.radio_button_unchecked_rounded,
                                    size: 18,
                                    color: theme.inkMuted,
                                  ),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Text(
                                      (node['name'] ??
                                              node['label'] ??
                                              node['title'] ??
                                              node['key'] ??
                                              '执行步骤')
                                          .toString(),
                                      style: TextStyle(
                                        color: theme.inkSecondary,
                                      ),
                                    ),
                                  ),
                                  Text(
                                    _runStatus(
                                      (node['state'] ?? 'queued').toString(),
                                    ),
                                    style: TextStyle(
                                      color: theme.inkMuted,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                        ],
                        if ((_run?['error'] ?? '').toString().isNotEmpty) ...[
                          const SizedBox(height: 16),
                          Text(
                            mobileText(
                              context,
                              "执行说明：{0}",
                              values: [
                                _run!['error'].toString().characters.take(2000),
                              ],
                            ),
                            style: TextStyle(
                              color: theme.inkSecondary,
                              height: 1.6,
                            ),
                          ),
                        ],
                        if (text.isNotEmpty) ...[
                          const SizedBox(height: 20),
                          ConversationMarkdown(data: text),
                        ],
                      ],
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (!_accepted)
                          FilledButton(
                            onPressed: _busy ? null : _check,
                            style: FilledButton.styleFrom(
                              backgroundColor: theme.ink,
                              foregroundColor: theme.surface,
                            ),
                            child: Text(
                              widget.submission.kind == 'workflow'
                                  ? mobileText(context, '核对执行结果')
                                  : mobileText(context, '核对同一次留言'),
                            ),
                          ),
                        if (!_accepted && !_busy)
                          TextButton(
                            onPressed: _submit,
                            child: Text(mobileText(context, '用原请求确认提交')),
                          ),
                        if (_taskId.isNotEmpty)
                          OutlinedButton.icon(
                            onPressed: () {
                              if (hasConversation) {
                                openWorkConversation(
                                  context,
                                  taskId: _taskId,
                                  title: widget.submission.label,
                                );
                              } else {
                                Navigator.of(context).push(
                                  MaterialPageRoute(
                                    builder: (_) => Theme(
                                      data: Theme.of(context),
                                      child: TaskDetailScreen(taskId: _taskId),
                                    ),
                                  ),
                                );
                              }
                            },
                            icon: Icon(
                              hasConversation
                                  ? Icons.chat_bubble_outline_rounded
                                  : Icons.task_alt_rounded,
                              size: 18,
                            ),
                            label: Text(
                              hasConversation
                                  ? mobileText(context, '继续与执行者对话')
                                  : mobileText(context, '查看工作详情与待确认事项'),
                            ),
                          ),
                        const SizedBox(height: 6),
                        Text(
                          widget.submission.kind == 'workflow'
                              ? mobileText(context, '状态来自实际工作流，关闭页面不会停止已接单的工作。')
                              : mobileText(context, '送达与已读以团队消息回执为准。'),
                          style: TextStyle(
                            color: theme.inkMuted,
                            fontSize: 11.5,
                            height: 1.5,
                          ),
                          textAlign: TextAlign.center,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

String _runStatus(String state) => switch (state) {
  'succeeded' || 'done' => '已完成',
  'failed' => '执行失败',
  'cancelled' => '已取消',
  'waiting_human' => '等待人工确认',
  'waiting_external' => '等待外部结果',
  'queued' => '等待执行',
  _ => '正在执行',
};

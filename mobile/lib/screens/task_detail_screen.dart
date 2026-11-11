import '../ui/mobile_display_preferences.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import '../ui/library_actions.dart';
import '../ui/artifact_actions.dart';

import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../ui/requirement_assignment_sheet.dart';
import '../ui/task_forms.dart';
import '../ui/task_lifecycle.dart';
import '../ui/workflow_recovery_card.dart';
import '../ui/task_execution_pulse.dart';
import '../ui/work_widgets.dart';
import '../ui/task_detail_sections.dart';
import '../ui/requirement_capabilities.dart';
import '../ui/requirement_acceptance_card.dart';
import '../ui/requirement_review_conversation_button.dart';

class TaskDetailScreen extends StatefulWidget {
  final String taskId;

  const TaskDetailScreen({super.key, required this.taskId});

  @override
  State<TaskDetailScreen> createState() => _TaskDetailScreenState();
}

class _TaskDetailScreenState extends State<TaskDetailScreen>
    with WidgetsBindingObserver {
  WorkTask? _task;
  Map<String, dynamic> _trace = const {};
  Map<String, dynamic> _delivery = const {};
  bool _loading = true;
  bool _busy = false;
  String _error = '';
  AiExecutionStatus? _execution;
  Timer? _poller;
  bool _refreshing = false;
  bool _appActive = true;
  DateTime? _lastDeepSync;
  String _statusToken = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    Future.microtask(() => _load());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final active = state == AppLifecycleState.resumed;
    if (_appActive == active) return;
    _appActive = active;
    if (active) {
      _load(silent: true, forceDeep: true);
    } else {
      _poller?.cancel();
      _poller = null;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poller?.cancel();
    super.dispose();
  }

  void _syncPolling() {
    final task = _task;
    final shouldPoll =
        _appActive &&
        task != null &&
        task.isAi &&
        task.isOpen &&
        _execution?.done != true &&
        _execution?.stalled != true;
    if (!shouldPoll) {
      _poller?.cancel();
      _poller = null;
      return;
    }
    if (_poller?.isActive == true) return;
    _poller = Timer.periodic(
      const Duration(seconds: 5),
      (_) => _load(silent: true),
    );
  }

  Future<void> _load({bool silent = false, bool forceDeep = false}) async {
    if (_refreshing) return;
    _refreshing = true;
    if (!silent) {
      setState(() {
        _loading = true;
        _error = '';
      });
    }
    final state = MobileScope.read(context);
    try {
      Future<Map<String, dynamic>> loadDelivery(bool enabled) async {
        if (!enabled) return const {};
        try {
          return await state.api.taskDelivery(widget.taskId);
        } catch (_) {
          // A missing/temporarily unreachable delivery endpoint must never
          // prevent the task and its trace from rendering on mobile.
          return const {};
        }
      }

      AiExecutionStatus? status;
      final previousTask = _task;
      if (silent && previousTask?.isAi == true && !forceDeep) {
        status = await state.loadAiStatus(widget.taskId);
        if (!mounted) return;
        final now = DateTime.now();
        final statusChanged = status.refreshToken != _statusToken;
        final deepSyncDue =
            _lastDeepSync == null ||
            now.difference(_lastDeepSync!) >= const Duration(seconds: 15);
        final reachedBoundary = status.done || status.stalled;
        if (!statusChanged && !deepSyncDue && !reachedBoundary) {
          setState(() => _execution = status);
          _syncPolling();
          return;
        }
      }

      late WorkTask task;
      late Map<String, dynamic> trace;
      if (previousTask == null) {
        task = await state.loadTask(widget.taskId);
        final details = await Future.wait<dynamic>([
          state.loadTaskTrace(widget.taskId),
          task.isAi
              ? state.loadAiStatus(widget.taskId)
              : Future<AiExecutionStatus?>.value(null),
          loadDelivery(task.isAi),
        ]);
        trace = details[0] as Map<String, dynamic>;
        status = details[1] as AiExecutionStatus?;
        _delivery = details[2] as Map<String, dynamic>;
      } else {
        final details = await Future.wait<dynamic>([
          state.loadTask(widget.taskId),
          state.loadTaskTrace(widget.taskId),
          previousTask.isAi && status == null
              ? state.loadAiStatus(widget.taskId)
              : Future<AiExecutionStatus?>.value(status),
          loadDelivery(previousTask.isAi),
        ]);
        task = details[0] as WorkTask;
        trace = details[1] as Map<String, dynamic>;
        status = details[2] as AiExecutionStatus?;
        _delivery = details[3] as Map<String, dynamic>;
        if (task.isAi && status == null) {
          status = await state.loadAiStatus(widget.taskId);
        }
      }
      if (!mounted) return;
      setState(() {
        _task = task;
        _trace = trace;
        _execution = status;
        _lastDeepSync = DateTime.now();
        _statusToken = status?.refreshToken ?? '';
        if (!silent) _error = '';
      });
      _syncPolling();
    } on ApiFailure catch (error) {
      if (mounted && (!silent || _task == null)) {
        setState(() => _error = error.message);
      }
    } finally {
      _refreshing = false;
      if (mounted && !silent) setState(() => _loading = false);
    }
  }

  Future<void> _setStatus(String status) async {
    final task = _task;
    if (task == null) return;
    setState(() => _busy = true);
    try {
      final state = MobileScope.read(context);
      if (status == 'done') {
        await state.api.submitTaskReview(task.id, '');
        await state.refreshAll();
      } else {
        await state.setTaskStatus(task, status);
      }
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) _toast(error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addProgress() async {
    final task = _task;
    if (task == null) return;
    final state = MobileScope.read(context);
    final controller = TextEditingController();
    final value = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) {
        final bottom = MediaQuery.viewInsetsOf(context).bottom;
        return Padding(
          padding: EdgeInsets.fromLTRB(20, 4, 20, 20 + bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                mobileText(context, '\u8bb0\u5f55\u8fdb\u5c55'),
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 14),
              TextField(
                controller: controller,
                autofocus: true,
                minLines: 3,
                maxLines: 6,
                decoration: InputDecoration(
                  hintText: mobileText(
                    context,
                    '\u4eca\u5929\u63a8\u8fdb\u4e86\u4ec0\u4e48\uff0c\u8fd8\u6709\u4ec0\u4e48\u963b\u585e\u2026',
                  ),
                ),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () =>
                      Navigator.of(context).pop(controller.text.trim()),
                  child: Text(mobileText(context, '\u4fdd\u5b58\u8fdb\u5c55')),
                ),
              ),
            ],
          ),
        );
      },
    );
    controller.dispose();
    if (value == null || value.isEmpty) return;
    setState(() => _busy = true);
    try {
      await state.addProgress(task, value);
      await _load();
    } on ApiFailure catch (error) {
      if (mounted) _toast(error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _arrange({bool teammate = false}) async {
    final task = _task;
    if (task == null || !task.canArrange || _busy) return;
    final accepted = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) =>
          RequirementAssignmentSheet(task: task, teammateFirst: teammate),
    );
    if (!mounted) return;
    await _load(forceDeep: true);
    if (mounted && accepted == true) {
      _toast(teammate ? '需求已转交' : '需求已安排，进展会自动更新');
    }
  }

  Future<void> _moveToReady() async {
    final task = _task;
    if (task == null ||
        _busy ||
        !task.canTriage ||
        !const {'intake', 'clarifying'}.contains(task.boardStage)) {
      return;
    }
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    bool current() => mounted && state.identityRevision == identity;
    setState(() => _busy = true);
    try {
      await state.api.patchTask(task.id, {
        'requirementVersion': task.requirementVersion,
        'triageStage': 'ready',
      });
      if (!current()) return;
      await _load(forceDeep: true);
    } on ApiFailure catch (error) {
      if (current()) {
        _toast(
          error.isNetwork || error.status >= 500
              ? '更新结果尚未确认，请刷新需求核对。'
              : error.message,
        );
      }
    } finally {
      if (current()) setState(() => _busy = false);
    }
  }

  Future<void> _edit() async {
    final task = _task;
    if (task == null || !task.canEditRequirement || _busy) return;
    final changed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => RequirementEditSheet(task: task),
    );
    if (changed == true && mounted) await _load(forceDeep: true);
  }

  Future<void> _maintain() async {
    final task = _task;
    if (task == null || _busy) return;
    final restore = task.boardStage == 'closed';
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    bool current() =>
        mounted &&
        state.identityRevision == identity &&
        widget.taskId == task.id;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          restore ? mobileText(context, '恢复需求？') : mobileText(context, '归档需求？'),
        ),
        content: Text(
          restore
              ? mobileText(context, '恢复后回到需求池；已取消的需求回到待开始。')
              : mobileText(context, '归档后保留记录和成果，可以随时恢复。'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(mobileText(context, '取消')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(
              restore ? mobileText(context, '恢复') : mobileText(context, '归档'),
            ),
          ),
        ],
      ),
    );
    if (confirmed != true || !current()) return;
    setState(() => _busy = true);
    try {
      final raw = await state.api.taskData(task.id);
      if (!current()) return;
      final latest = WorkTask.fromJson(raw);
      final permission = requirementMaintenance(latest, raw);
      if (!permission.enabled || (latest.boardStage == 'closed') != restore) {
        throw ApiFailure(
          permission.reason.isNotEmpty ? permission.reason : '需求状态已变化，请刷新后重试。',
        );
      }
      await state.api.patchTask(task.id, {
        'archivedAt': restore ? null : DateTime.now().millisecondsSinceEpoch,
        if (restore && latest.status == 'cancel') 'status': 'todo',
        'requirementVersion': latest.requirementVersion,
      });
      if (!current()) return;
      await state.refreshAll();
      if (!current()) return;
      await _load(forceDeep: true);
      if (current()) _toast(restore ? '需求已恢复' : '需求已归档');
    } on ApiFailure catch (e) {
      if (current()) _toast(e.message);
    } finally {
      if (current()) {
        setState(() => _busy = false);
      }
    }
  }

  void _toast(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  bool get _isAutomated {
    final execution = jsonMap(_trace['execution']);
    final authority = (execution['authority'] ?? _trace['authority'] ?? '')
        .toString();
    return _task?.isAi == true ||
        jsonList(_trace['runs']).isNotEmpty ||
        jsonList(_trace['deployments']).isNotEmpty ||
        jsonMap(_trace['ai']).isNotEmpty ||
        (authority.isNotEmpty && authority != 'manual');
  }

  @override
  Widget build(BuildContext context) {
    final task = _task;
    return Scaffold(
      appBar: AppBar(
        title: Text(mobileText(context, '需求详情')),
        actions: [
          if (task != null && requirementMaintenance(task, const {}).visible)
            IconButton(
              tooltip: task.boardStage == 'closed'
                  ? mobileText(context, '恢复需求')
                  : mobileText(context, '归档需求'),
              onPressed:
                  _busy || !requirementMaintenance(task, const {}).enabled
                  ? null
                  : _maintain,
              icon: Icon(
                task.boardStage == 'closed'
                    ? Icons.unarchive_outlined
                    : Icons.archive_outlined,
              ),
            ),
          if (task?.canEditRequirement == true)
            IconButton(
              tooltip: mobileText(context, '编辑需求'),
              onPressed: _busy ? null : _edit,
              icon: const Icon(Icons.edit_outlined),
            ),
          IconButton(
            tooltip: mobileText(context, '刷新'),
            onPressed: _loading ? null : _load,
            icon: Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _loading && task == null
          ? const LoadingPane()
          : _error.isNotEmpty && task == null
          ? EmptyPane(
              icon: Icons.error_outline_rounded,
              title: '任务加载失败',
              message: mobileText(context, _error),
              actionLabel: '重试',
              onAction: _load,
            )
          : task == null
          ? const SizedBox.shrink()
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
                children: [
                  TaskDetailIdentity(task: task),
                  if (task.readOnly && !task.canClaimExecution)
                    Padding(
                      padding: EdgeInsets.only(top: 12),
                      child: Text(
                        mobileText(
                          context,
                          '此需求由另一台设备承办。这里可跟进进展；安排执行需在原承办设备操作。',
                        ),
                      ),
                    ),
                  if (task.canViewExecution != false &&
                      (task.origin == 'cloud-conversation' ||
                          task.aiState.isNotEmpty ||
                          _execution?.dispatched == true)) ...[
                    const SizedBox(height: 10),
                    TaskCloudConversationEntry(task: task),
                  ],
                  if (_delivery.isNotEmpty &&
                      (_delivery['delivery'] != null ||
                          (_delivery['artifactUrl'] ?? '')
                              .toString()
                              .isNotEmpty)) ...[
                    const SizedBox(height: 10),
                    TaskDeliverySummary(
                      delivery: _delivery,
                      onOpen: _openArtifact,
                    ),
                  ],
                  if (task.isAi) ...[
                    const SizedBox(height: 14),
                    TaskExecutionPulse(task: task, status: _execution),
                  ],
                  if (task.boardStage == 'reviewing' &&
                      task.canReview &&
                      task.canViewExecution != false) ...[
                    const SizedBox(height: 14),
                    RequirementReviewConversationButton(taskId: task.id),
                  ],
                  if (_isAutomated) ...[
                    const SizedBox(height: 24),
                    TaskLifecyclePanel(
                      task: task,
                      trace: _trace,
                      onOpenEvidence: _openArtifact,
                    ),
                    WorkflowRecoveryCard(
                      task: task,
                      trace: _trace,
                      onChanged: () => _load(forceDeep: true),
                    ),
                  ],
                  if ((task.boardStage == 'reviewing' ||
                          task.status == 'done') &&
                      !task.reviewed &&
                      !task.archived &&
                      task.canViewExecution != false) ...[
                    const SizedBox(height: 20),
                    RequirementAcceptanceCard(
                      task: task,
                      onChanged: () => _load(forceDeep: true),
                      onOpen: _openArtifact,
                    ),
                  ],
                  const SizedBox(height: 26),
                  TaskDetailSectionLabel(
                    label: '进展记录',
                    description: task.progress.isEmpty
                        ? '完成一步就留下一条可追溯记录'
                        : '共 ${task.progress.length} 条',
                  ),
                  const SizedBox(height: 9),
                  TaskProgressList(progress: task.progress),
                  if (_artifacts.isNotEmpty) ...[
                    const SizedBox(height: 26),
                    TaskDetailSectionLabel(
                      label: '成果与证据',
                      description: '${_artifacts.length} 项',
                    ),
                    const SizedBox(height: 9),
                    TaskArtifactList(
                      artifacts: _artifacts,
                      onOpen: _openArtifact,
                    ),
                  ],
                ],
              ),
            ),
      bottomNavigationBar: task == null
          ? null
          : TaskDetailActionBar(
              task: task,
              busy: _busy,
              onStatus: _setStatus,
              onProgress: _addProgress,
              onHandoff: () => _arrange(teammate: true),
              onAi: _arrange,
              onEdit: _edit,
              onReady: _moveToReady,
            ),
    );
  }

  List<Map<String, dynamic>> get _artifacts {
    final rows = <Map<String, dynamic>>[];
    final seen = <String>{};
    for (final key in ['artifacts', 'attachments']) {
      for (final item in jsonList(_trace[key]).map(jsonMap)) {
        final role = (item['role'] ?? 'output').toString().toLowerCase();
        if (key == 'attachments' &&
            !{'output', 'supporting', 'evidence'}.contains(role)) {
          continue;
        }
        final identity =
            (item['id'] ??
                    item['url'] ??
                    item['filename'] ??
                    item['name'] ??
                    '')
                .toString();
        if (identity.isEmpty || !seen.add(identity)) continue;
        rows.add({
          ...item,
          if (key == 'attachments') 'attachmentId': item['id'],
          'displayRole': role,
        });
      }
    }
    final task = jsonMap(_trace['task']);
    final artifactUrl =
        (_task?.artifactUrl ??
                task['artifactUrl'] ??
                _trace['artifactUrl'] ??
                _delivery['artifactUrl'] ??
                '')
            .toString()
            .trim();
    if (artifactUrl.isNotEmpty && seen.add('url:$artifactUrl')) {
      rows.add({
        'id': 'artifact-url',
        'name': '\u5728\u7ebf\u6210\u679c',
        'filename': '\u5728\u7ebf\u6210\u679c',
        'url': artifactUrl,
        'contentType': 'text/uri-list',
        'displayRole': 'online',
      });
    }
    return rows;
  }

  Future<void> _openArtifact(Map<String, dynamic> item) async {
    if (_busy) return;
    final value = (item['url'] ?? item['downloadUrl'] ?? item['href'] ?? '')
        .toString();
    final rawId = (item['attachmentId'] ?? '').toString();
    final id = rawId == 'artifact-url' ? '' : rawId;
    if (value.isEmpty && id.isEmpty) {
      _toast('这份产出尚无可打开链接');
      return;
    }
    setState(() => _busy = true);
    try {
      if (item['libraryAction'] == 'save') {
        await saveArtifactToLibrary(
          context,
          MobileScope.read(context).api,
          item,
          source: {'type': 'conversation', 'sessionId': widget.taskId},
        );
        return;
      }
      await openMobileArtifact(
        context,
        MobileScope.read(context).api,
        id: id,
        url: value,
        previewDelivery: item['action'] == 'preview',
        entry: item['entryPath']?.toString(),
        filename: (item['filename'] ?? item['name'] ?? '成果').toString(),
        contentType: (item['contentType'] ?? 'application/octet-stream')
            .toString(),
      );
    } catch (error) {
      if (mounted) _toast(error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

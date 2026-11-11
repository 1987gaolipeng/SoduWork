import '../ui/mobile_display_preferences.dart';
import '../ui/requirement_review_conversation_button.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../ui/gate_decision.dart';
import '../ui/rework_materials.dart';
import '../ui/requirement_decision_sheet.dart';
import '../ui/mobile_theme.dart';
import '../ui/task_lifecycle.dart';
import '../ui/work_widgets.dart';

class ApprovalDetailScreen extends StatefulWidget {
  final String approvalId;
  final Future<List<XFile>> Function()? filePicker;

  const ApprovalDetailScreen({
    super.key,
    required this.approvalId,
    this.filePicker,
  });

  @override
  State<ApprovalDetailScreen> createState() => _ApprovalDetailScreenState();
}

class _ApprovalDetailScreenState extends State<ApprovalDetailScreen> {
  ApprovalItem? _item;
  WorkTask? _task;
  Map<String, dynamic> _detail = const {};
  Map<String, dynamic> _trace = const {};
  Map<String, String> _imageHeaders = const {};
  bool _loading = true;
  bool _busy = false;
  String _error = '';
  int _generation = 0;
  final _materials = ReworkMaterialsController();

  @override
  void initState() {
    super.initState();
    Future.microtask(_load);
  }

  @override
  void dispose() {
    _materials.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant ApprovalDetailScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.approvalId != widget.approvalId) {
      _materials.clear();
      _item = null;
      _detail = {};
      _busy = false;
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    final state = MobileScope.read(context);
    final identity = state.identityRevision, generation = ++_generation;
    final approvalId = widget.approvalId;
    bool current() =>
        mounted &&
        state.identityRevision == identity &&
        generation == _generation &&
        widget.approvalId == approvalId;
    final known = [...state.pendingApprovals, ...state.doneApprovals];
    ApprovalItem? item;
    for (final candidate in known) {
      if (candidate.id == widget.approvalId) {
        item = candidate;
        break;
      }
    }
    try {
      final detail = await state.loadApprovalDetail(approvalId);
      final detailedItem = jsonMap(
        detail['approval'] ?? detail['item'] ?? detail,
      );
      if (detailedItem.isNotEmpty) {
        item = ApprovalItem.fromJson(detailedItem);
      }
      final resolvedItem = item;
      if (resolvedItem == null) {
        throw const ApiFailure('审批详情缺少审批对象，请刷新后重试。');
      }
      final taskId = resolvedItem.task.id;
      final embeddedTrace = jsonMap(detail['trace']);
      final trace = embeddedTrace.isNotEmpty || taskId.isEmpty
          ? embeddedTrace
          : await state.loadTaskTrace(taskId);
      if (!current()) return;
      // Reuse the authenticated detail packet before falling back to a separate
      // task read. Summary-only tasks omit the lifecycle state and handler.
      bool hasLifecycleData(Map<String, dynamic> data) =>
          data['id'] == taskId &&
          data['status'] is String &&
          (data['status'] as String).isNotEmpty &&
          data['handler'] is String &&
          (data['handler'] as String).isNotEmpty;
      final traceTask = jsonMap(trace['task']);
      final detailTask = jsonMap(detailedItem['task']);
      final task = taskId.isEmpty
          ? resolvedItem.task
          : hasLifecycleData(traceTask)
          ? WorkTask.fromJson(traceTask)
          : hasLifecycleData(detailTask)
          ? WorkTask.fromJson(detailTask)
          : await state.loadTask(taskId);
      final headers = await state.api.authorizationHeaders();
      if (!current()) return;
      if (_item != null &&
          _item!.artifact['id'] != resolvedItem.artifact['id']) {
        _materials.clear();
      }
      setState(() {
        _item = resolvedItem;
        _task = task;
        _detail = detail;
        _trace = trace;
        _imageHeaders = headers;
      });
    } on ApiFailure catch (error) {
      if (current()) setState(() => _error = error.message);
    } finally {
      if (current()) setState(() => _loading = false);
    }
  }

  Future<void> _pickEvidence() async {
    final state = MobileScope.read(context);
    final item = _item;
    if (item == null) return;
    final source = await showModalBottomSheet<ImageSource>(
      context: context,
      useSafeArea: true,
      builder: (context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(Icons.photo_camera_outlined),
              title: Text(mobileText(context, '\u62cd\u7167\u53d6\u8bc1')),
              onTap: () => Navigator.of(context).pop(ImageSource.camera),
            ),
            ListTile(
              leading: Icon(Icons.photo_library_outlined),
              title: Text(
                mobileText(context, '\u4ece\u76f8\u518c\u9009\u62e9'),
              ),
              onTap: () => Navigator.of(context).pop(ImageSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (source == null) return;
    final file = await ImagePicker().pickImage(
      source: source,
      imageQuality: 86,
      maxWidth: 2200,
    );
    if (file == null) return;
    setState(() => _busy = true);
    try {
      await state.uploadEvidence(item, file);
      await _load();
      if (mounted) _toast('\u8bc1\u636e\u5df2\u4e0a\u4f20');
    } on ApiFailure catch (error) {
      if (mounted) _toast(error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _decide(String decision) async {
    final item = _item;
    if (item == null || _busy) return;
    final state = MobileScope.read(context);
    final identity = state.identityRevision, generation = _generation;
    final approvalId = widget.approvalId;
    bool current() =>
        mounted &&
        state.identityRevision == identity &&
        generation == _generation &&
        widget.approvalId == approvalId;
    setState(() => _busy = true);
    try {
      final note = await _decisionSheet(decision);
      if (note == null || !current()) return;
      if (decision == 'reject' &&
          item.action == 'review' &&
          !_materials.isEmpty) {
        final version = item.artifact['id'];
        Future<void> verify() async {
          final raw = await state.loadApprovalDetail(approvalId);
          if (!current()) throw const ApiFailure('账号或审批已变化，请重新打开。');
          final latest = jsonMap(raw['item'] ?? raw['approval'] ?? raw);
          if (version == null ||
              latest['id'] != approvalId ||
              latest['status'] != 'pending' ||
              latest['action'] != 'review' ||
              jsonMap(latest['myDecision']).isNotEmpty ||
              jsonMap(latest['artifact'])['id'] != version) {
            throw const ApiFailure('验收单或交付版本已变化，请刷新后重试。');
          }
        }

        await verify();
        final ids = await _materials.upload(
          sourceRef: 'approval-rework:$approvalId',
          send: (file) =>
              state.api.uploadApprovalReworkMaterial(approvalId, file),
          check: () {
            if (!current()) throw const ApiFailure('账号或审批已变化，请重新打开。');
          },
        );
        await verify();
        final result = await state.api.decideApproval(
          approvalId,
          decision: decision,
          note: note,
          reworkAttachmentIds: ids,
        );
        if (!current()) return;
        if (result['ok'] == false) {
          throw ApiFailure((result['reason'] ?? '退回未完成，请刷新后核对。').toString());
        }
        await state.refreshAll();
      } else {
        await state.decideApproval(item, decision: decision, note: note);
      }
      if (!current() || !mounted) return;
      _toast(decision == 'approve' ? '验收意见已提交' : '退回意见已提交');
      Navigator.of(context).pop();
    } on ApiFailure catch (error) {
      if (current()) _toast(error.message);
    } finally {
      if (current()) setState(() => _busy = false);
    }
  }

  Future<String?> _decisionSheet(String decision) =>
      showModalBottomSheet<String>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        showDragHandle: true,
        builder: (_) => RequirementDecisionSheet(decision: decision),
      );

  void _toast(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final item = _item;
    return Scaffold(
      appBar: AppBar(
        title: Text(mobileText(context, '\u95e8\u7981\u8be6\u60c5')),
        actions: [
          IconButton(
            tooltip: mobileText(context, '\u5237\u65b0'),
            onPressed: _loading || _busy ? null : _load,
            icon: Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: _loading && item == null
          ? const LoadingPane()
          : _error.isNotEmpty && item == null
          ? EmptyPane(
              icon: Icons.error_outline_rounded,
              title: '\u95e8\u7981\u52a0\u8f7d\u5931\u8d25',
              message: mobileText(context, _error),
              actionLabel: '\u91cd\u8bd5',
              onAction: _load,
            )
          : item == null
          ? const SizedBox.shrink()
          : ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 118),
              children: [
                WorkSurface(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      StatePill(
                        label: item.actionLabel,
                        color: item.status == 'pending'
                            ? context.soduWorkTheme.primary
                            : context.soduWorkTheme.success,
                        background: item.status == 'pending'
                            ? context.soduWorkTheme.primarySoft
                            : context.soduWorkTheme.successSoft,
                        icon: item.status == 'pending'
                            ? Icons.verified_user_outlined
                            : Icons.task_alt_rounded,
                      ),
                      const SizedBox(height: 13),
                      SelectableText(
                        item.task.title,
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        mobileText(
                          context,
                          '\u8fd9\u6b21\u51b3\u5b9a\u4f1a\u8bb0\u5165\u4efb\u52a1\u5168\u94fe\u8def\uff0c\u5e76\u9a71\u52a8\u4e0b\u4e00\u6b65\u3002',
                        ),
                        style: TextStyle(
                          color: context.soduWorkTheme.inkMuted,
                          fontSize: 12.5,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                GateDecisionSummary(item: item),
                if (item.action == 'review' &&
                    item.status == 'pending' &&
                    item.myDecision.isEmpty) ...[
                  const SizedBox(height: 12),
                  RequirementReviewConversationButton(taskId: item.task.id),
                ],
                const SizedBox(height: 20),
                const _SectionLabel(label: '\u5b8c\u6210\u6807\u51c6'),
                const SizedBox(height: 9),
                _Criteria(detail: _detail, item: item),
                const SizedBox(height: 20),
                Row(
                  children: [
                    const Expanded(child: _SectionLabel(label: '\u8bc1\u636e')),
                    TextButton.icon(
                      onPressed: _busy ? null : _pickEvidence,
                      icon: Icon(Icons.add_a_photo_outlined, size: 18),
                      label: Text(
                        mobileText(context, '\u8865\u5145\u8bc1\u636e'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 5),
                GateEvidenceList(
                  evidence: _evidence(item),
                  headers: _imageHeaders,
                  absoluteUrl: MobileScope.read(context).api.absoluteUrl,
                ),
                const SizedBox(height: 20),
                const _SectionLabel(label: '\u4efb\u52a1\u5168\u94fe\u8def'),
                const SizedBox(height: 9),
                TaskLifecyclePanel(task: _task ?? item.task, trace: _trace),
                if (item.action == 'review' &&
                    item.status == 'pending' &&
                    item.myDecision.isEmpty) ...[
                  const SizedBox(height: 20),
                  ReworkMaterialsPicker(
                    controller: _materials,
                    busy: _busy,
                    filePicker: widget.filePicker,
                  ),
                ],
              ],
            ),
      bottomNavigationBar: item != null && item.status == 'pending'
          ? SafeArea(
              child: Container(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 12),
                decoration: BoxDecoration(
                  color: context.soduWorkTheme.surface,
                  border: Border(
                    top: BorderSide(color: context.soduWorkTheme.line),
                  ),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _busy ? null : () => _decide('reject'),
                        child: Text(mobileText(context, '\u9a73\u56de')),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      flex: 2,
                      child: FilledButton(
                        onPressed: _busy || !item.canApprove
                            ? null
                            : () => _decide('approve'),
                        child: Text(
                          _busy
                              ? mobileText(
                                  context,
                                  '\u6b63\u5728\u5904\u7406\u2026',
                                )
                              : item.canApprove
                              ? mobileText(
                                  context,
                                  '\u901a\u8fc7\u5e76\u7ee7\u7eed',
                                )
                              : mobileText(context, '\u8bc1\u636e\u672a\u9f50'),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            )
          : null,
    );
  }

  List<dynamic> _evidence(ApprovalItem item) {
    final detailGate = jsonMap(_detail['gate']);
    final packet = jsonMap(detailGate['packet']);
    final rows = jsonList(detailGate['evidence']);
    if (rows.isNotEmpty) return rows;
    final packetRows = jsonList(packet['evidence']);
    if (packetRows.isNotEmpty) return packetRows;
    final itemRows = jsonList(item.gate['evidence']);
    if (itemRows.isNotEmpty) return itemRows;
    return jsonList(jsonMap(item.gate['packet'])['evidence']);
  }
}

class _Criteria extends StatelessWidget {
  final Map<String, dynamic> detail;
  final ApprovalItem item;

  const _Criteria({required this.detail, required this.item});

  @override
  Widget build(BuildContext context) {
    final gate = jsonMap(detail['gate']).isNotEmpty
        ? jsonMap(detail['gate'])
        : item.gate;
    final packet = jsonMap(gate['packet']);
    final raw = jsonList(
      gate['criteria'] ?? packet['criteria'] ?? packet['acceptanceCriteria'],
    );
    if (raw.isEmpty) {
      final summary = (gate['summary'] ?? packet['summary'] ?? '')
          .toString()
          .trim();
      return WorkSurface(
        child: SelectableText(
          summary.isEmpty
              ? mobileText(
                  context,
                  '\u8bf7\u6838\u5bf9\u6210\u679c\u3001\u8bc1\u636e\u548c\u5b9e\u9645\u9a8c\u6536\u60c5\u51b5\u3002',
                )
              : summary,
          style: TextStyle(
            color: context.soduWorkTheme.inkSecondary,
            fontSize: 13.5,
            height: 1.55,
          ),
        ),
      );
    }
    return WorkSurface(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 7),
      child: Column(
        children: raw
            .asMap()
            .entries
            .map((entry) {
              final map = jsonMap(entry.value);
              final text = map.isEmpty
                  ? entry.value.toString()
                  : (map['text'] ??
                            map['label'] ??
                            map['title'] ??
                            map['description'] ??
                            '')
                        .toString();
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 22,
                      height: 22,
                      decoration: BoxDecoration(
                        color: context.soduWorkTheme.surfaceMuted,
                        shape: BoxShape.circle,
                      ),
                      child: Center(
                        child: Text(
                          '${entry.key + 1}',
                          style: TextStyle(
                            color: context.soduWorkTheme.inkSecondary,
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: SelectableText(
                        text,
                        style: TextStyle(
                          color: context.soduWorkTheme.inkSecondary,
                          fontSize: 13.5,
                          height: 1.5,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            })
            .toList(growable: false),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String label;

  const _SectionLabel({required this.label});

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: TextStyle(
        color: context.soduWorkTheme.inkMuted,
        fontSize: 12,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}

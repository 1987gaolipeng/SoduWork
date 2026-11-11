import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'rework_materials.dart';

import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import 'work_widgets.dart';

/// Inline formal and creator review, guarded by the Hub acceptance context.
class RequirementAcceptanceCard extends StatefulWidget {
  final WorkTask task;
  final Future<void> Function() onChanged;
  final ValueChanged<Map<String, dynamic>> onOpen;
  final Future<List<XFile>> Function()? filePicker;
  const RequirementAcceptanceCard({
    super.key,
    required this.task,
    required this.onChanged,
    required this.onOpen,
    this.filePicker,
  });
  @override
  State<RequirementAcceptanceCard> createState() =>
      _RequirementAcceptanceCardState();
}

class _RequirementAcceptanceCardState extends State<RequirementAcceptanceCard> {
  Map<String, dynamic>? _context;
  bool _loading = true, _busy = false, _toAi = true;
  String _error = '';
  int _generation = 0;
  final _note = TextEditingController();
  final _materials = ReworkMaterialsController();
  @override
  void initState() {
    super.initState();
    Future.microtask(_load);
  }

  @override
  void dispose() {
    _note.dispose();
    _materials.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant RequirementAcceptanceCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.task.id != widget.task.id ||
        oldWidget.task.requirementVersion != widget.task.requirementVersion) {
      _busy = false;
      _note.clear();
      _materials.clear();
      _load();
    }
  }

  Future<void> _load() async {
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    final generation = ++_generation;
    final taskId = widget.task.id;
    bool current() =>
        mounted &&
        state.identityRevision == identity &&
        generation == _generation &&
        widget.task.id == taskId;
    setState(() {
      _context = null;
      _loading = true;
      _error = '';
    });
    try {
      final result = await state.api.taskAcceptanceContext(taskId);
      if (current()) {
        setState(() => _context = result);
      }
    } on ApiFailure catch (e) {
      if (current()) {
        setState(() {
          _context = null;
          _error = e.message;
        });
      }
    } finally {
      if (current()) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _decide(bool approve) async {
    if (_busy || _context?['canDecide'] != true) return;
    if (!approve && _note.text.trim().isEmpty) {
      setState(() => _error = '请写清楚需要修改的地方。');
      return;
    }
    final state = MobileScope.read(context), initial = _context!;
    final identity = state.identityRevision;
    final generation = _generation;
    final taskId = widget.task.id;
    final note = _note.text.trim();
    final toAi = _toAi;
    final onChanged = widget.onChanged;
    bool current() =>
        mounted &&
        state.identityRevision == identity &&
        generation == _generation &&
        widget.task.id == taskId;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final latest = await state.api.taskAcceptanceContext(taskId);
      if (!current()) return;
      if (latest['canDecide'] != true ||
          latest['approvalId'] != initial['approvalId'] ||
          latest['artifactVersionId'] != initial['artifactVersionId'] ||
          latest['requirementVersion'] != initial['requirementVersion']) {
        _materials.clear();
        setState(() => _context = latest);
        throw const ApiFailure('交付版本或验收权限已变化，请重新核对后操作。');
      }
      final approvalId = latest['approvalId'].toString();
      final direct = approvalId == 'direct:$taskId';
      if (approve && jsonMap(latest['readiness'])['canApprove'] == false) {
        throw const ApiFailure('验收证据尚未齐备，请核对完成标准。');
      }
      final attachmentIds = approve
          ? <String>[]
          : await _materials.upload(
              sourceRef: direct
                  ? 'task-rework:$taskId'
                  : 'approval-rework:$approvalId',
              send: (file) => direct
                  ? state.api.uploadTaskReworkMaterial(taskId, file)
                  : state.api.uploadApprovalReworkMaterial(approvalId, file),
              check: () {
                if (!current()) throw const ApiFailure('任务或账号已变化，请重新打开。');
              },
            );
      if (!current()) return;
      if (attachmentIds.isNotEmpty) {
        final afterUpload = await state.api.taskAcceptanceContext(taskId);
        if (!current()) return;
        if (afterUpload['canDecide'] != true ||
            afterUpload['approvalId'] != initial['approvalId'] ||
            afterUpload['artifactVersionId'] != initial['artifactVersionId'] ||
            afterUpload['requirementVersion'] !=
                initial['requirementVersion']) {
          _materials.clear();
          setState(() => _context = afterUpload);
          throw const ApiFailure('上传期间交付或权限已变化，请重新核对后操作。');
        }
      }
      final result = !direct
          ? await state.api.decideApproval(
              approvalId,
              decision: approve ? 'approve' : 'reject',
              note: note,
              reworkAttachmentIds: attachmentIds,
            )
          : approve
          ? await state.api.reviewTaskArtifact(taskId, note)
          : await state.api.rejectTaskArtifact(
              taskId,
              note,
              toAi: toAi,
              reworkAttachmentIds: attachmentIds,
            );
      if (!current()) return;
      if (result['ok'] == false) {
        throw ApiFailure((result['reason'] ?? '操作未完成，请刷新后核对。').toString());
      }
      final blocked = jsonMap(result['taskBlocked']);
      final message = approve
          ? blocked.isNotEmpty
                ? "验收意见已提交：${blocked['reason'] ?? '等待后续流程'}"
                : '验收意见已提交'
          : '退回意见已提交，请查看最新执行状态';
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
      await state.refreshAll();
      if (current()) {
        await onChanged();
      }
    } on ApiFailure catch (e) {
      if (current()) {
        setState(() => _error = e.message);
      }
    } finally {
      if (current()) {
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final packet = _context;
    final approval = (packet?['approvalId'] ?? '').toString();
    final direct = approval == 'direct:${widget.task.id}';
    final canDecide = packet?['canDecide'] == true;
    final criteria = jsonList(packet?['criteria']).map(jsonMap);
    final attachments = jsonList(packet?['attachments']).map(jsonMap);
    return WorkSurface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            mobileText(context, '交付验收'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          if (_loading)
            const LinearProgressIndicator()
          else if (packet == null)
            TextButton.icon(
              onPressed: _load,
              icon: const Icon(Icons.refresh),
              label: Text(mobileText(context, '重新读取验收信息')),
            )
          else ...[
            Text(
              canDecide
                  ? mobileText(context, '核对本轮成果与完成标准后提交意见。')
                  : mobileText(context, '等待指定验收人确认，你可以查看本轮交付。'),
            ),
            if (criteria.isNotEmpty) ...[
              const SizedBox(height: 10),
              for (final item in criteria)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text("• ${item['label'] ?? ''}"),
                ),
            ],
            for (final file in attachments)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.attach_file),
                title: Text(
                  (file['filename'] ?? file['name'] ?? '验收材料').toString(),
                ),
                trailing: const Icon(Icons.open_in_new, size: 18),
                onTap: _busy
                    ? null
                    : () =>
                          widget.onOpen({...file, 'attachmentId': file['id']}),
              ),
            if (canDecide && approval.isNotEmpty) ...[
              const SizedBox(height: 10),
              TextField(
                controller: _note,
                enabled: !_busy,
                minLines: 2,
                maxLines: 4,
                maxLength: 1000,
                decoration: InputDecoration(
                  labelText: mobileText(context, '验收意见'),
                  hintText: mobileText(context, '通过可不填；退回请说明需要修改的地方'),
                ),
              ),
              ReworkMaterialsPicker(
                controller: _materials,
                busy: _busy,
                filePicker: widget.filePicker,
              ),
              if (direct)
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  title: Text(mobileText(context, '退回后由 AI 继续修改')),
                  subtitle: Text(mobileText(context, '关闭后退给承办人安排处理')),
                  value: _toAi,
                  onChanged: _busy
                      ? null
                      : (value) => setState(() => _toAi = value),
                ),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy ? null : () => _decide(false),
                      child: Text(mobileText(context, '退回修改')),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: _busy ? null : () => _decide(true),
                      child: _busy
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text(mobileText(context, '确认验收')),
                    ),
                  ),
                ],
              ),
            ],
          ],
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(mobileText(context, _error)),
            ),
        ],
      ),
    );
  }
}

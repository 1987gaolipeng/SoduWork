import 'dart:convert';
import 'package:image_picker/image_picker.dart';
import '../models/work_models.dart';
import '../state/mobile_state.dart';
import '../state/work_conversation_navigation.dart';
import 'requirement_review_conversation.dart';
import 'requirement_review_history.dart';
import 'soduwork_api.dart';

/// Decisions use the Hub's current approval and fixed delivery, never a chat ID.
class ConversationAcceptance {
  final MobileState state;
  final void Function() check;
  final _shown = <String, Map<String, dynamic>>{};
  final _uploads = <String, Set<String>>{};
  bool _busy = false;
  ConversationAcceptance(this.state, this.check);

  String _version(Map<String, dynamic> value) => jsonEncode([
    value['approvalId'],
    value['artifactVersionId'],
    value['requirementVersion'],
  ]);

  Future<Map<String, dynamic>> _validate(String id, Object? version) async {
    check();
    final shown = _shown[id];
    final latest = await state.api.taskAcceptanceContext(id);
    check();
    if (shown == null ||
        version != _version(shown) ||
        latest['canDecide'] != true ||
        _version(shown) != _version(latest)) {
      throw const ApiFailure('交付版本或验收权限已变化，请刷新验收卡后重新核对。', status: 409);
    }
    return latest;
  }

  Future<Object?> call(String id, Map<String, dynamic> args) async {
    check();
    final action = args['action'] ?? 'load';
    if (action == 'load') {
      final raw = await state.api.taskData(id);
      check();
      final task = WorkTask.fromJson(jsonMap(raw['task'] ?? raw));
      if (task.boardStage != 'reviewing' || task.reviewed || task.archived) {
        _shown.remove(id);
        return {'available': false};
      }
      final packet = await state.api.taskAcceptanceContext(id);
      check();
      _shown[id] = packet;
      return {'available': true, ...packet, 'version': _version(packet)};
    }
    if (_busy) throw const ApiFailure('验收操作正在处理，请勿重复提交。');
    _busy = true;
    try {
      final packet = await _validate(id, args['version']);
      final approval = packet['approvalId'].toString();
      final direct = approval == 'direct:$id';
      if (action == 'analyze' || action == 'auto') {
        final review = RequirementReviewConversation.fromPacket(
          id,
          packet,
          automatic: action == 'auto',
        );
        final navigation = state.workConversationNavigation;
        var existing = review.automatic ? '' : navigation.taskForReview(review);
        if (existing.isEmpty) {
          existing = await findReviewHistory(
            state.api,
            review,
            state.enrollment?.ownerUserId ?? '',
            check,
          );
          check();
          if (existing.isNotEmpty) navigation.bindReview(existing, review);
        }
        if (!navigation.open(
          WorkConversationDestination(
            taskId: existing,
            title: '${review.label} · ${review.title}',
            identity: state.identityRevision,
            review: review,
          ),
        )) {
          throw const ApiFailure('请从需求池重新打开验收分析。');
        }
        return {'ok': true};
      }
      if (action == 'upload') {
        final row = jsonMap(args['file']);
        final name = (row['name'] ?? '').toString();
        final encoded = (row['data'] ?? '').toString();
        if (name.isEmpty ||
            name.length > 255 ||
            encoded.length > 14 * 1024 * 1024) {
          throw const ApiFailure('请选择不超过 10 MB 的返修资料。');
        }
        final bytes = base64Decode(encoded);
        if (bytes.length > 10 * 1024 * 1024) {
          throw const ApiFailure('返修资料不能超过 10 MB。');
        }
        final file = XFile.fromData(
          bytes,
          name: name,
          mimeType: (row['type'] ?? 'application/octet-stream').toString(),
        );
        final result = direct
            ? await state.api.uploadTaskReworkMaterial(id, file)
            : await state.api.uploadApprovalReworkMaterial(approval, file);
        check();
        await _validate(id, args['version']);
        final attachment = jsonMap(result['attachment']);
        final uploadId =
            (result['attachmentId'] ?? attachment['id'] ?? result['id'] ?? '')
                .toString();
        if (uploadId.isEmpty) throw const ApiFailure('返修资料上传未返回编号。');
        (_uploads[_version(packet)] ??= {}).add(uploadId);
        return {'id': uploadId};
      }
      if (action != 'approve' && action != 'reject') {
        throw const ApiFailure('不支持的验收操作。');
      }
      final note = (args['note'] ?? '').toString().trim();
      if (note.length > 2000 || (action == 'reject' && note.isEmpty)) {
        throw const ApiFailure('退回时请说明需要修改的地方，意见不超过 2000 字。');
      }
      if (action == 'approve' &&
          jsonMap(packet['readiness'])['canApprove'] == false) {
        throw const ApiFailure('验收证据尚未齐备，请核对完成标准。');
      }
      final ids = jsonList(
        args['attachmentIds'],
      ).map((e) => e.toString()).toList();
      if (ids.any(
        (value) => !(_uploads[_version(packet)] ?? {}).contains(value),
      )) {
        throw const ApiFailure('返修资料不属于当前验收版本。', status: 403);
      }
      final result = !direct
          ? await state.api.decideApproval(
              approval,
              decision: action,
              note: note,
              reworkAttachmentIds: action == 'reject' ? ids : [],
            )
          : action == 'approve'
          ? await state.api.reviewTaskArtifact(id, note)
          : await state.api.rejectTaskArtifact(
              id,
              note,
              reworkAttachmentIds: ids,
            );
      check();
      if (result['ok'] == false) {
        throw ApiFailure((result['reason'] ?? '操作未完成，请刷新后核对。').toString());
      }
      _shown.remove(id);
      await state.refreshAll();
      check();
      return {'ok': true};
    } finally {
      _busy = false;
    }
  }
}

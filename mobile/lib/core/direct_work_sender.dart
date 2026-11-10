import 'package:image_picker/image_picker.dart';
import 'package:flutter/foundation.dart';
import '../state/mobile_state.dart';
import 'cloud_conversation_request.dart';
import 'soduwork_api.dart';
import 'execution_target.dart';

/// Reuses the same immutable request and server receipt as the old composer.
/// The user's send gesture is the submission action; no second form is needed.
Future<Map<String, dynamic>> sendWorkDirectly(
  MobileState state, {
  required String text,
  String? userText,
  String model = '',
  String agentId = '',
  String targetRunnerId = '',
  String targetRunnerKind = '',
  List<XFile> files = const [],
  List<String> skills = const [],
  Map<String, dynamic>? acceptance,
}) async {
  final identity = state.identityRevision;
  void check() {
    if (state.identityRevision != identity) {
      throw const ApiFailure('账号已切换，本次工作尚未发送。', status: 409);
    }
  }

  await state.restorePendingBranch();
  check();
  var request = state.pendingCloudRequest;
  if (request?.receiptOnly == true) {
    throw const ApiFailure('上一笔发送结果待核对，请先点击“核对发送结果”，避免重复执行。');
  }
  if (request != null) {
    if (request.isAccountBranch ||
        !mapEquals(request.options['acceptance'] as Map?, acceptance) ||
        request.options['text'] != text.trim() ||
        request.options['userText'] != userText?.trim() ||
        model.isNotEmpty && request.options['model'] != model ||
        agentId.isNotEmpty && request.options['agentId'] != agentId ||
        targetRunnerId.isNotEmpty &&
            request.options['targetRunnerId'] != targetRunnerId ||
        targetRunnerKind.isNotEmpty &&
            request.options['targetRunnerKind'] != targetRunnerKind) {
      throw const ApiFailure('上一笔发送尚未确认，请保留原内容核对后重试，避免重复执行。');
    }
    final expectedSkills =
        (request.options['requiredSkills'] as List?)?.cast<String>() ??
        const <String>[];
    // Request preparation treats skills as a normalized set. Retry comparison
    // must use the same representation, regardless of picker selection order.
    final selectedSkills = skills.map((item) => item.trim()).toSet().toList()
      ..sort();
    if (!listEquals(expectedSkills, selectedSkills) ||
        files.length != request.files.length) {
      throw const ApiFailure('上一笔发送的材料或能力不同，请先核对原请求，避免重复执行。');
    }
    for (var i = 0; i < files.length; i++) {
      final bytes = await files[i].readAsBytes();
      check();
      if (files[i].name != request.files[i].name ||
          !listEquals(bytes, request.files[i].bytes)) {
        throw const ApiFailure('上一笔发送的材料不同，请先核对原请求，避免重复执行。');
      }
    }
  } else {
    final catalog = await state.cloudConversationTargets();
    check();
    final targets = (catalog['targets'] as List? ?? const [])
        .whereType<Map>()
        .map(normalizeExecutionTarget)
        .where(
          (row) =>
              isUsableExecutionTarget(row) &&
              (agentId.isEmpty || row['agentId'] == agentId) &&
              (targetRunnerId.isEmpty || row['runnerId'] == targetRunnerId) &&
              (targetRunnerKind.isEmpty ||
                  row['runnerKind'] == targetRunnerKind) &&
              (model.isEmpty || row['modelPick'] == true),
        )
        .toList();
    if (targets.isEmpty) {
      throw const ApiFailure('当前没有可用的执行环境，草稿已保留。检查云端环境的连接、底座和模型后即可发送。');
    }
    if (targetRunnerId.isEmpty &&
        targets.map((row) => row['runnerId']).toSet().length > 1) {
      throw const ApiFailure('有多个执行位置，请先选择云端执行机或本人在线 PC，草稿已保留。');
    }
    final target = targets.first;
    request = await CloudConversationRequest.prepare(
      text: text.trim(),
      userText: userText,
      agentId: target['agentId'] as String,
      targetRunnerId: target['runnerId'] as String,
      targetRunnerKind: target['runnerKind'] as String,
      model: model.isEmpty ? (target['model'] as String? ?? '') : model,
      title: String.fromCharCodes((userText ?? text).trim().runes.take(24)),
      files: files,
      requiredSkills: skills,
      acceptance: acceptance,
    );
    check();
    await state.rememberCloudRequest(request);
    check();
  }
  try {
    final receipt = await state.startCloudConversation(
      text: request.options['text'] as String,
      request: request,
    );
    check();
    return receipt;
  } on ApiFailure catch (error) {
    if (state.identityRevision == identity &&
        !error.isNetwork &&
        error.status > 0 &&
        error.status < 500 &&
        error.status != 408) {
      await state.forgetCloudRequest(request.id);
    }
    rethrow;
  }
}

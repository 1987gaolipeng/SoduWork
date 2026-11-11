import 'dart:math';
import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';

String mobileRequestId() {
  final random = Random.secure();
  final suffix = List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
  return 'm$suffix';
}

/// One immutable submission, retained until its server receipt is known.
class CloudConversationRequest {
  final String id;
  final Map<String, dynamic> options;
  final List<CloudConversationFile> files;

  /// Restored ordinary submissions retain identity only, never replayable payloads.
  final bool receiptOnly;

  CloudConversationRequest._(
    this.id,
    this.options,
    this.files, {
    this.receiptOnly = false,
  });

  bool get isAccountBranch => options.containsKey('accountConversationId');
  Map<String, dynamic> branchCheckpoint() => {'id': id, 'options': options};

  /// Keep the existing branch format, but ordinary submissions save no draft or
  /// attachment contents. Their original receipt is the only recovery path.
  Map<String, dynamic> checkpoint() => isAccountBranch
      ? branchCheckpoint()
      : {
          'kind': 'cloud-receipt',
          'version': 1,
          'id': id,
          'sessionId': options['sessionId'],
          'agentId': options['agentId'],
        };

  static CloudConversationRequest restoreCheckpoint(
    Map<String, dynamic> value,
  ) {
    if (!value.containsKey('kind')) return restoreBranch(value);
    final id = value['id'];
    final agent = value['agentId'];
    if (value['kind'] != 'cloud-receipt' ||
        value['version'] != 1 ||
        id is! String ||
        !RegExp(r'^[A-Za-z0-9-]{1,80}$').hasMatch(id) ||
        value['sessionId'] != 'mobile:$id' ||
        agent is! String ||
        agent.trim().isEmpty ||
        agent.length > 160 ||
        agent.contains(':') ||
        value.keys.any(
          (key) => !const [
            'kind',
            'version',
            'id',
            'sessionId',
            'agentId',
          ].contains(key),
        )) {
      throw const FormatException('待核对发送记录无法识别，请保留原记录并重试核对。');
    }
    return CloudConversationRequest._(
      id,
      Map.unmodifiable({'sessionId': value['sessionId'], 'agentId': agent}),
      const [],
      receiptOnly: true,
    );
  }

  static CloudConversationRequest restoreBranch(Map<String, dynamic> value) {
    final id = value['id'];
    final options = value['options'];
    if (id is! String ||
        !RegExp(r'^[A-Za-z0-9-]{1,80}$').hasMatch(id) ||
        options is! Map<String, dynamic> ||
        options['accountConversationId'] is! String ||
        options['expectedRevision'] is! int ||
        options['text'] is! String ||
        options['agentId'] is! String ||
        options.keys.any(
          (key) => !const [
            'accountConversationId',
            'expectedRevision',
            'text',
            'agentId',
            'model',
            'targetRunnerId',
            'targetRunnerKind',
          ].contains(key),
        )) {
      throw const FormatException('待确认续聊记录无法识别，请联系管理员核对，避免重复派发。');
    }
    accountBranch(
      conversationId: options['accountConversationId'] as String,
      revision: options['expectedRevision'] as int,
      text: options['text'] as String,
      agentId: options['agentId'] as String,
      model: options['model'] as String? ?? '',
      targetRunnerId: options['targetRunnerId'] as String? ?? '',
      targetRunnerKind: options['targetRunnerKind'] as String? ?? '',
    );
    return CloudConversationRequest._(id, Map.unmodifiable(options), const []);
  }

  static CloudConversationRequest accountBranch({
    required String conversationId,
    required int revision,
    required String text,
    required String agentId,
    String model = '',
    String targetRunnerId = '',
    String targetRunnerKind = '',
  }) {
    if (conversationId.isEmpty ||
        revision < 1 ||
        text.trim().isEmpty ||
        agentId.trim().isEmpty ||
        agentId.contains(':')) {
      throw const FormatException('请更新聊天记录，填写要求并选择执行底座。');
    }
    return CloudConversationRequest._(
      mobileRequestId(),
      Map.unmodifiable({
        'accountConversationId': conversationId,
        'expectedRevision': revision,
        'text': text.trim(),
        'agentId': agentId.trim(),
        if (model.isNotEmpty) 'model': model,
        if (targetRunnerId.trim().isNotEmpty)
          'targetRunnerId': targetRunnerId.trim(),
        if (targetRunnerKind.trim().isNotEmpty)
          'targetRunnerKind': _runnerKind(targetRunnerKind),
      }),
      const [],
    );
  }

  static Future<CloudConversationRequest> prepare({
    required String text,
    String? userText,
    required String agentId,
    String targetRunnerId = '',
    String targetRunnerKind = '',
    String model = '',
    String title = '',
    List<XFile> files = const [],
    List<String> requiredSkills = const [],
    Map<String, dynamic>? acceptance,
  }) async {
    if (text.trim().isEmpty ||
        agentId.trim().isEmpty ||
        agentId.trim().length > 160 ||
        agentId.contains(':')) {
      throw const FormatException('请填写需求并选择可用的执行底座。');
    }
    if (requiredSkills.length > 100 ||
        requiredSkills.any(
          (item) => item.trim().isEmpty || item.length > 160,
        )) {
      throw const FormatException('本次技能选择无效，请重新选择。');
    }
    if (files.length > 20) {
      throw const FormatException('最多附加 20 个文件。');
    }
    final prepared = <CloudConversationFile>[];
    final names = <String>{};
    var total = 0;
    for (final file in files) {
      final name = file.name.split(RegExp(r'[/\\]')).last;
      if (name.isEmpty || !names.add(name.toLowerCase())) {
        throw const FormatException('附件名称为空或重复，请重新选择。');
      }
      final length = await file.length();
      if (length <= 0 || total + length > 96 * 1024 * 1024) {
        throw const FormatException('附件不能为空，合计不能超过 96MB。');
      }
      final bytes = await file.readAsBytes();
      total += bytes.length;
      if (bytes.isEmpty || total > 96 * 1024 * 1024) {
        throw const FormatException('附件不能为空，合计不能超过 96MB。');
      }
      prepared.add(
        CloudConversationFile(
          name,
          Uint8List.fromList(bytes).asUnmodifiableView(),
        ),
      );
    }
    final id = mobileRequestId();
    return CloudConversationRequest._(
      id,
      Map.unmodifiable({
        'sessionId': 'mobile:$id',
        if (acceptance != null)
          'acceptance': Map<String, dynamic>.unmodifiable(acceptance),
        'text': text.trim(),
        if (userText != null) 'userText': userText.trim(),
        'agentId': agentId.trim(),
        if (targetRunnerId.trim().isNotEmpty)
          'targetRunnerId': targetRunnerId.trim(),
        if (targetRunnerKind.trim().isNotEmpty)
          'targetRunnerKind': _runnerKind(targetRunnerKind),
        if (model.isNotEmpty) 'model': model,
        if (title.trim().isNotEmpty) 'title': title.trim(),
        'requiredSkills': List<String>.unmodifiable(
          requiredSkills.map((item) => item.trim()).toSet().toList()..sort(),
        ),
      }),
      List.unmodifiable(prepared),
    );
  }
}

String _runnerKind(String value) {
  final kind = value.trim();
  if (kind != 'work-computer' && kind != 'cloud') {
    throw const FormatException('Invalid runner kind');
  }
  return kind;
}

class CloudConversationFile {
  final String name;
  final Uint8List bytes;

  const CloudConversationFile(this.name, this.bytes);
}

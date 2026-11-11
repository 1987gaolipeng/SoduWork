import 'dart:convert';
import 'soduwork_api.dart';

/// Desktop @ controls use this boundary; directory, file authority and receipts
/// remain server-owned. No message is sent while loading or drafting.
class SharedConversationTeam {
  final void Function() check;
  final Future<Map<String, dynamic>> Function() loadMates;
  final Future<List<Map<String, dynamic>>> Function(String) loadAttachments;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic>)
  draftMessage;
  final Future<Map<String, dynamic>> Function(String, Map<String, dynamic>)
  sendMessage;
  final Future<void> Function(List<Map<String, dynamic>>)? validateUploads;
  final Set<String> allowedTaskIds;
  final _fingerprints = <String, String>{};
  final _receipts = <String, (String, Future<Map<String, dynamic>>)>{};
  static const _fileLimit = 20 * 1024 * 1024;
  static const _totalLimit = 24 * 1024 * 1024;

  SharedConversationTeam({
    required this.check,
    required this.loadMates,
    required this.loadAttachments,
    required this.draftMessage,
    required this.sendMessage,
    required this.allowedTaskIds,
    this.validateUploads,
  });

  Future<Map<String, dynamic>> mates() async {
    check();
    final result = await loadMates();
    check();
    final raw = result['mates'];
    if (raw is! List) throw const ApiFailure('同事目录暂时不可用。');
    final rows = <Map<String, dynamic>>[];
    for (final row in raw.whereType<Map>()) {
      if (row['id'] is! String || row['name'] is! String) continue;
      final canReceive =
          row['canReceive'] == true ||
          (!row.containsKey('canReceive') && row['hasBox'] == true);
      rows.add({
        'id': row['id'],
        'name': row['name'],
        'org': row['org'] is String ? row['org'] : '',
        'hasBox': canReceive,
        'canReceive': canReceive,
      });
    }
    return {
      'mates': rows,
      'reason': result['reason'] is String ? result['reason'] : '',
    };
  }

  Future<Map<String, dynamic>> draft(Map<String, dynamic> args) async {
    check();
    final rawMessages = args['messages'];
    final rawOutputs = args['outputs'];
    if (rawMessages is! List ||
        rawMessages.length > 80 ||
        rawOutputs is! List ||
        rawOutputs.length > 20) {
      throw const ApiFailure('会话小结内容过长或格式无效。');
    }
    var length = 0;
    final messages = <Map<String, dynamic>>[];
    for (final row in rawMessages) {
      if (row is! Map ||
          !const {'user', 'assistant'}.contains(row['role']) ||
          row['text'] is! String ||
          (row['text'] as String).length > 4000) {
        throw const ApiFailure('仅能总结当前会话的正文。');
      }
      length += (row['text'] as String).length;
      if (length > 24000) throw const ApiFailure('会话过长，请整理后再总结。');
      messages.add({'role': row['role'], 'text': row['text']});
    }
    if (rawOutputs.any((name) => name is! String || name.length > 180)) {
      throw const ApiFailure('成果清单无效。');
    }
    final result = await draftMessage({
      'messages': messages,
      'outputs': List<String>.from(rawOutputs),
      'topic': _string(args['topic'] ?? '', 180),
      'state': _string(args['state'] ?? '', 40),
      'omittedMessages': args['omittedMessages'] is int
          ? (args['omittedMessages'] as int).clamp(0, 100000)
          : 0,
    });
    check();
    if (result['text'] is! String ||
        (result['text'] as String).trim().isEmpty ||
        (result['text'] as String).length > 500 ||
        !const {'model', 'empty'}.contains(result['source'])) {
      throw const ApiFailure('工作小结未能生成，请重试或手动填写。');
    }
    return {
      'text': result['text'],
      'source': result['source'],
      if (result['omittedMessages'] is int)
        'omittedMessages': result['omittedMessages'],
    };
  }

  Future<Map<String, dynamic>> send(Map<String, dynamic> args) async {
    check();
    final recipient = _string(args['recipientId'], 180);
    final text = _string(args['text'], 500).trim();
    final id = _string(args['messageId'], 64);
    if (recipient.isEmpty ||
        text.isEmpty ||
        !RegExp(
          r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        ).hasMatch(id)) {
      throw const ApiFailure('通知内容或发送标识无效，请重新选择同事。');
    }
    final conversation = _string(args['conversationId'] ?? '', 180);
    final rawFiles = args['files'] ?? const [];
    if (rawFiles is! List ||
        rawFiles.length > 20 ||
        rawFiles.isNotEmpty && conversation.isEmpty) {
      throw const ApiFailure('一次最多发送20份成果，请从会话中重新选择。');
    }
    // Snapshot user input before asynchronous preflight; a mutable caller cannot
    // replace approved content while directory or attachment requests are pending.
    final payload = <String, dynamic>{
      'text': text,
      'messageId': id,
      'conversationId': conversation,
      'files': _snapshotFiles(rawFiles),
    };
    final fingerprint = jsonEncode([recipient, payload]);
    if (_fingerprints.containsKey(id) && _fingerprints[id] != fingerprint) {
      throw const ApiFailure('相同发送标识不能用于不同通知。', status: 409);
    }
    _fingerprints[id] = fingerprint;
    final previous = _receipts[id];
    if (previous != null) {
      if (previous.$1 != fingerprint) {
        throw const ApiFailure('相同发送标识不能用于不同通知。', status: 409);
      }
      final result = await previous.$2;
      check();
      return result;
    }
    final operation = _send(recipient, payload);
    _receipts[id] = (fingerprint, operation);
    try {
      return await operation;
    } catch (_) {
      // Preserve original fingerprint on uncertain receipt, allow only same-ID
      // same-content retry through the server's idempotency contract.
      _receipts.remove(id);
      rethrow;
    }
  }

  List<Map<String, dynamic>> _snapshotFiles(List raw) => raw
      .map((item) {
        if (item is! Map) throw const ApiFailure('通知附件格式无效。');
        if (item['attachmentId'] != null) {
          if (item.keys.any((key) => key != 'attachmentId')) {
            throw const ApiFailure('通知附件不能同时引用文件和上传内容。');
          }
          return <String, dynamic>{
            'attachmentId': _string(item['attachmentId'], 180),
          };
        }
        if (item.keys.any((key) => key != 'name' && key != 'data')) {
          throw const ApiFailure('通知附件格式无效。');
        }
        return <String, dynamic>{
          'name': _string(item['name'], 200),
          'data': _string(item['data'], ((_fileLimit + 2) ~/ 3) * 4),
        };
      })
      .toList(growable: false);

  Future<Map<String, dynamic>> _send(
    String recipient,
    Map<String, dynamic> payload,
  ) async {
    final directory = await mates();
    final available = (directory['mates'] as List).whereType<Map>().any(
      (row) => row['id'] == recipient && row['canReceive'] == true,
    );
    if (!available) throw const ApiFailure('这位同事当前不能接收通知，请重新选择。');
    final files = (payload['files'] as List).cast<Map<String, dynamic>>();
    final references = files
        .where((row) => row.containsKey('attachmentId'))
        .toList();
    final authorized = <String, Map<String, dynamic>>{};
    if (references.isNotEmpty) {
      for (final taskId in Set<String>.of(allowedTaskIds)) {
        final rows = await loadAttachments(taskId);
        check();
        for (final row in rows) {
          if (row['id'] is String &&
              const {
                'output',
                'supporting',
                'evidence',
                'verification',
              }.contains(row['role'])) {
            authorized[row['id'] as String] = row;
          }
        }
      }
    }
    var total = 0;
    for (final file in files) {
      int size;
      if (file.containsKey('attachmentId')) {
        final row = authorized[file['attachmentId']];
        if (row == null || row['size'] is! int) {
          throw const ApiFailure('附件不属于当前会话，或已经不可用。', status: 403);
        }
        size = row['size'] as int;
      } else {
        final name = file['name'] as String;
        if (name.isEmpty ||
            name == '.' ||
            name == '..' ||
            name.runes.any((c) => c < 32 || c == 92 || c == 47)) {
          throw const ApiFailure('附件名称无效。');
        }
        final data = file['data'] as String;
        if (data.isEmpty ||
            data.length % 4 != 0 ||
            !RegExp(r'^[A-Za-z0-9+/]*={0,2}$').hasMatch(data)) {
          throw const ApiFailure('附件内容无效，请重新选择。');
        }
        try {
          size = base64Decode(data).length;
        } on FormatException {
          throw const ApiFailure('附件内容无效，请重新选择。');
        }
      }
      total += size;
      if (size <= 0 || size > _fileLimit || total > _totalLimit) {
        throw const ApiFailure('单份成果最多20MB，合计最多24MB，且不能为空。');
      }
    }
    check();
    await validateUploads?.call(files);
    check();
    final result = await sendMessage(recipient, payload);
    check();
    if (result['ok'] != true ||
        result['messageId'] is! String ||
        (result['messageId'] as String).isEmpty ||
        !const {'accepted', 'delivered', 'read'}.contains(result['status'])) {
      throw const ApiFailure('通知回执尚未确认，请保留原内容后重试。');
    }
    return {
      'ok': true,
      'messageId': result['messageId'],
      'status': result['status'],
      'delivered': result['delivered'] == true,
    };
  }

  static String _string(dynamic value, int max) {
    if (value is! String ||
        value.length > max ||
        value.contains(String.fromCharCode(0))) {
      throw const ApiFailure('通知内容格式不正确或超过长度限制。');
    }
    return value;
  }
}

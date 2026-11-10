import 'dart:convert';

import 'shared_conversation_artifacts.dart';
import 'soduwork_api.dart';

/// Keeps authorized, immutable share snapshots for the current conversation.
/// Raw uploads remain uploads; only files prepared from task results are tracked.
class SharedConversationShareGuard {
  final SoduWorkApi api;
  final void Function() check;
  final List<_ShareSnapshot> _snapshots = [];
  static const maxFiles = 32;
  static const maxBytes = 24 * 1024 * 1024;
  int _bytes = 0;

  SharedConversationShareGuard(this.api, this.check);

  Future<void> recordArtifact(
    String taskId,
    String attachmentId,
    Map<String, dynamic> result,
  ) async {
    check();
    final row = await _artifact(taskId, attachmentId);
    _record(taskId, attachmentId, false, row, result);
  }

  Future<void> recordDelivery(
    String taskId,
    String deliveryId,
    Map<String, dynamic> result,
  ) async {
    check();
    final row = await _delivery(taskId, deliveryId);
    _record(taskId, deliveryId, true, row, result);
  }

  void _record(
    String taskId,
    String id,
    bool delivery,
    Map<String, dynamic> row,
    Map<String, dynamic> result,
  ) {
    check();
    final name = result['name'], data = result['data'], size = result['size'];
    if (result['ok'] != true ||
        name is! String ||
        data is! String ||
        size is! int ||
        size <= 0 ||
        size > 20 * 1024 * 1024 ||
        (delivery
                ? row['filename']
                : (row['filename'] as String? ?? '')
                      .replaceAll('\\', '/')
                      .split('/')
                      .last) !=
            name ||
        row['size'] != size ||
        _timestamp(row['createdAt']) != result['at'] ||
        data.length != ((size + 2) ~/ 3) * 4) {
      throw const ApiFailure('分享成果与授权版本不一致，请重新打开分享卡。');
    }
    try {
      if (base64Decode(data).length != size) {
        throw const FormatException('Incorrect file length');
      }
    } on FormatException {
      throw const ApiFailure('分享成果内容不完整，请重新打开分享卡。');
    }
    final duplicate = _snapshots.indexWhere(
      (item) => item.name == name && item.data == data,
    );
    final oldSize = duplicate < 0 ? 0 : _snapshots[duplicate].size;
    if (_bytes - oldSize + size > maxBytes ||
        duplicate < 0 && _snapshots.length >= maxFiles) {
      throw const ApiFailure('本次准备分享的成果较多，请重新打开会话后选择所需文件。');
    }
    final snapshot = _ShareSnapshot(
      taskId,
      id,
      delivery,
      name,
      data,
      size,
      _canonical(row),
    );
    if (duplicate < 0) {
      _snapshots.add(snapshot);
    } else {
      _snapshots[duplicate] = snapshot;
    }
    _bytes += size - oldSize;
  }

  Future<void> validateUploads(List<Map<String, dynamic>> files) async {
    check();
    // Capture the selection before awaiting; another prepared share must not
    // replace the provenance of an already sending message.
    final selected = _snapshots
        .where(
          (item) => files.any(
            (file) => file['name'] == item.name && file['data'] == item.data,
          ),
        )
        .toList(growable: false);
    for (final item in selected) {
      final row = item.delivery
          ? await _delivery(item.taskId, item.id)
          : await _artifact(item.taskId, item.id);
      check();
      if (_canonical(row) != item.metadata) {
        throw const ApiFailure('分享成果已更新或权限已变化，请重新打开分享卡。');
      }
    }
    check();
  }

  Future<Map<String, dynamic>> _artifact(String taskId, String id) async {
    final rows = await SharedConversationArtifacts(
      api,
      check,
      null,
    ).list(taskId);
    check();
    final matches = rows.where(
      (row) =>
          row['id'] == id &&
          const {
            'output',
            'supporting',
            'evidence',
            'verification',
          }.contains(row['role']),
    );
    if (matches.length != 1) {
      throw const ApiFailure('分享成果已移除或不再可访问。', status: 403);
    }
    return matches.single;
  }

  Future<Map<String, dynamic>> _delivery(String taskId, String id) async {
    final response = await api.taskDelivery(taskId);
    check();
    final row = response['delivery'];
    if (response['state'] != 'synced' ||
        row is! Map ||
        row['id'] != id ||
        row['kind'] != 'bundle') {
      throw const ApiFailure('完整成果包已变化或不再可访问。', status: 403);
    }
    return Map<String, dynamic>.from(row);
  }

  static num _timestamp(dynamic value) => value is num
      ? value
      : num.tryParse(value?.toString() ?? '') ??
            DateTime.tryParse(
              value?.toString() ?? '',
            )?.millisecondsSinceEpoch ??
            0;

  static String _canonical(Map<String, dynamic> value) {
    dynamic ordered(dynamic item) {
      if (item is Map) {
        final keys = item.keys.cast<String>().toList()..sort();
        return {for (final key in keys) key: ordered(item[key])};
      }
      if (item is List) return item.map(ordered).toList(growable: false);
      return item;
    }

    return jsonEncode(ordered(value));
  }
}

class _ShareSnapshot {
  final String taskId, id, name, data, metadata;
  final bool delivery;
  final int size;
  const _ShareSnapshot(
    this.taskId,
    this.id,
    this.delivery,
    this.name,
    this.data,
    this.size,
    this.metadata,
  );
}

import 'dart:convert';
import 'artifact_download.dart';
import 'soduwork_api.dart';

/// Read remote files through the task's authorized index, never model paths.
class SharedConversationArtifacts {
  final SoduWorkApi api;
  final void Function() check;
  final Future<void> Function(Map<String, dynamic>)? open;
  SharedConversationArtifacts(this.api, this.check, this.open);

  Future<List<Map<String, dynamic>>> list(String taskId) async {
    final rows = await api.taskAttachments(taskId);
    check();
    return rows
        .map(
          (row) => <String, dynamic>{
            for (final key in const {
              'id',
              'taskId',
              'filename',
              'contentType',
              'size',
              'createdAt',
              'role',
              'sourceRef',
              'evidenceMeta',
              'primary',
              'category',
            })
              if (row.containsKey(key)) key: row[key],
          },
        )
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> action(
    String taskId,
    String id,
    String action,
  ) async {
    check();
    if (!const {
      'open',
      'preview',
      'read',
      'share',
      'saveLibrary',
    }.contains(action)) {
      throw const ApiFailure('手机暂不支持此文件操作。');
    }
    final rows = await list(taskId);
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
      throw const ApiFailure('这份成果已不可用，请刷新会话。', status: 404);
    }
    final row = matches.single;
    final filename = row['filename'] as String? ?? '成果';
    final contentType =
        row['contentType'] as String? ?? 'application/octet-stream';
    if (action == 'open' || action == 'saveLibrary') {
      if (open == null) throw const ApiFailure('当前设备暂不支持打开文件。');
      check();
      await open!({
        ...row,
        'action': action,
        'url': '/api/v1/attachments/${Uri.encodeComponent(id)}',
      });
      check();
      return {'ok': true};
    }
    if (action == 'share') return _share(taskId, id, row);
    final image = RegExp(
      r'^image/(png|jpeg|gif|webp|bmp|avif|x-icon)$',
    ).hasMatch(contentType);
    final text =
        contentType.startsWith('text/') ||
        const {'application/json', 'application/xml'}.contains(contentType);
    if (action == 'preview' && !image || action == 'read' && !text) {
      throw const ApiFailure('此文件请使用打开成果查看。');
    }
    final result = await ArtifactDownloader(api).downloadAttachment(
      id,
      filename: filename,
      contentType: contentType,
      byteLimit: action == 'read' ? 2 * 1024 * 1024 : 16 * 1024 * 1024,
    );
    check();
    return {
      'ok': true,
      'mimeType': contentType,
      if (action == 'read')
        'text': utf8.decode(result.bytes, allowMalformed: true)
      else
        'data': base64Encode(result.bytes),
    };
  }

  Future<Map<String, dynamic>> _share(
    String taskId,
    String id,
    Map<String, dynamic> row,
  ) async {
    const byteLimit = 20 * 1024 * 1024;
    final size = row['size'];
    final sourceName = row['filename'];
    final name = sourceName is String
        ? sourceName.replaceAll('\\', '/').split('/').last
        : '';
    if (size is! int ||
        size <= 0 ||
        size > byteLimit ||
        sourceName is! String ||
        name.isEmpty ||
        name == '.' ||
        name == '..' ||
        name.length > 200 ||
        RegExp(r'[\\/\x00-\x1f]').hasMatch(name)) {
      throw const ApiFailure('成果为空、名称无效或超过20MB，不能分享。');
    }
    final expected = jsonEncode(row);
    final at = row['createdAt'];
    final file = await ArtifactDownloader(api).downloadAttachment(
      id,
      filename: name,
      contentType: row['contentType'] as String? ?? 'application/octet-stream',
      byteLimit: byteLimit,
    );
    check();
    final latest = (await list(taskId)).where((item) => item['id'] == id);
    if (latest.length != 1 ||
        jsonEncode(latest.single) != expected ||
        file.bytes.length != size) {
      throw const ApiFailure('成果已变化或不再可用，请重新打开分享卡。');
    }
    return {
      'ok': true,
      'name': name,
      'size': file.bytes.length,
      'at': at is num
          ? at
          : num.tryParse(at?.toString() ?? '') ??
                DateTime.tryParse(
                  at?.toString() ?? '',
                )?.millisecondsSinceEpoch ??
                0,
      'data': base64Encode(file.bytes),
    };
  }
}

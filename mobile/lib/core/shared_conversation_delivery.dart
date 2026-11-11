import 'dart:convert';

import 'artifact_download.dart';
import 'soduwork_api.dart';

/// Load a complete, authorized delivery. Model text is never a file index.
class SharedConversationDelivery {
  final SoduWorkApi api;
  final void Function() check;
  SharedConversationDelivery(this.api, this.check);

  static const byteLimit = 24 * 1024 * 1024;

  static const shareByteLimit = 20 * 1024 * 1024;
  Future<DownloadedArtifact> download(String taskId, String id) async {
    check();
    final result = await api.taskDelivery(taskId);
    check();
    final row = result['delivery'];
    if (result['state'] != 'synced' || row is! Map || row['id'] != id) {
      throw const ApiFailure('成果已变化，请刷新后保存');
    }
    final expected = jsonEncode(row);
    final file = await ArtifactDownloader(api).download(
      '/api/v1/deliveries/${Uri.encodeComponent(id)}/download',
      filename: row['filename']?.toString() ?? '成果包',
      byteLimit: 32 * 1024 * 1024,
    );
    check();
    final latest = await api.taskDelivery(taskId);
    check();
    if (latest['state'] != 'synced' ||
        jsonEncode(latest['delivery']) != expected ||
        file.bytes.length != row['size']) {
      throw const ApiFailure('成果正在更新，请重新保存');
    }
    return file;
  }

  /// Share the server's complete archive, never an HTML entry without assets.
  Future<Map<String, dynamic>> share(String taskId, String id) async {
    check();
    final result = await api.taskDelivery(taskId);
    check();
    final delivery = result['delivery'];
    if (result['state'] != 'synced' ||
        delivery is! Map ||
        delivery['id'] != id) {
      throw const ApiFailure('成果已变化，请刷新会话后重新分享。');
    }
    final name = delivery['filename'];
    final size = delivery['size'];
    if (delivery['kind'] != 'bundle' ||
        name is! String ||
        !_validName(name) ||
        !name.toLowerCase().endsWith('.zip') ||
        size is! int ||
        size <= 0 ||
        size > shareByteLimit) {
      throw const ApiFailure('完整成果包暂不可分享；文件须为不超过20MB的ZIP成果包。');
    }
    // Preserve a value snapshot while the archive is being downloaded.
    final expected = jsonEncode(delivery);
    final at = delivery['createdAt'];
    final file = await ArtifactDownloader(api).download(
      '/api/v1/deliveries/${Uri.encodeComponent(id)}/download',
      filename: name,
      contentType: 'application/zip',
      byteLimit: shareByteLimit,
    );
    check();
    final latest = await api.taskDelivery(taskId);
    check();
    if (latest['state'] != 'synced' ||
        jsonEncode(latest['delivery']) != expected ||
        file.bytes.length != size) {
      throw const ApiFailure('成果正在更新，请重新打开分享卡后再发送。');
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

  /// Read only the unique plugin draft declared by the authorized delivery.
  Future<Map<String, dynamic>> pluginDraft(String taskId, String id) async {
    check();
    final result = await api.taskDelivery(taskId);
    check();
    final delivery = result['delivery'];
    if (result['state'] != 'synced' ||
        delivery is! Map ||
        delivery['id'] != id) {
      throw const ApiFailure('成果已变化，请刷新会话后重新检查草稿。');
    }
    final manifest = jsonEncode(delivery);
    final rows = delivery['files'];
    if (rows is! List) throw const ApiFailure('交付包没有文件目录。');
    final drafts = rows
        .whereType<Map>()
        .where(
          (row) =>
              _validPath(row['path']) &&
              'soduwork-plugin-draft.json' ==
                  (row['path'] as String).split('/').last.toLowerCase(),
        )
        .toList();
    if (drafts.length != 1) {
      throw const ApiFailure('交付包必须包含唯一的插件草稿，请在对话中确认后重新生成。');
    }
    final row = drafts.single;
    final size = row['size'];
    if (size is! int || size <= 0 || size > 2 * 1024 * 1024) {
      throw const ApiFailure('插件草稿为空或超过2MB，请精简后重试。');
    }
    final path = (row['path'] as String)
        .split('/')
        .map(Uri.encodeComponent)
        .join('/');
    final file = await ArtifactDownloader(api).download(
      '/api/v1/deliveries/${Uri.encodeComponent(id)}/files/$path',
      filename: 'soduwork-plugin-draft.json',
      contentType: 'application/json',
      byteLimit: 2 * 1024 * 1024,
    );
    check();
    final latest = await api.taskDelivery(taskId);
    check();
    if (file.bytes.length != size ||
        latest['state'] != 'synced' ||
        jsonEncode(latest['delivery']) != manifest) {
      throw const ApiFailure('插件草稿正在更新，请重新打开后检查。');
    }
    final decoded = jsonDecode(utf8.decode(file.bytes));
    if (decoded is! Map<String, dynamic>) throw const ApiFailure('插件草稿格式无效。');
    return decoded;
  }

  static bool _validName(String value) =>
      value.isNotEmpty &&
      value.length <= 200 &&
      !RegExp(r'[\\/\x00-\x1f]').hasMatch(value);

  Future<Map<String, dynamic>> preview(String taskId, String id) async {
    final result = await api.taskDelivery(taskId);
    check();
    final delivery = result['delivery'];
    if (delivery is! Map ||
        delivery['id'] != id ||
        result['state'] != 'synced') {
      throw const ApiFailure('成果已变化，请刷新会话后重试。');
    }
    final rows = delivery['files'];
    final entry = delivery['entryPath'];
    if (rows is! List ||
        rows.isEmpty ||
        rows.length > 100 ||
        entry is! String ||
        !RegExp(r'\.html?$', caseSensitive: false).hasMatch(entry)) {
      throw const ApiFailure('此成果不支持网页预览，请下载完整成果包。');
    }
    final paths = <String>{};
    var declared = 0;
    for (final row in rows) {
      if (row is! Map ||
          !_validPath(row['path']) ||
          !paths.add(row['path'] as String) ||
          row['size'] is! int ||
          (row['size'] as int) < 0) {
        throw const ApiFailure('成果目录不完整，请重新同步。');
      }
      declared += row['size'] as int;
    }
    if (!paths.contains(entry)) throw const ApiFailure('网页入口文件缺失，请重新同步。');
    if (declared > byteLimit) throw const ApiFailure('网页成果较大，请下载完整成果包查看。');
    final files = <Map<String, dynamic>>[];
    var consumed = 0;
    for (final raw in rows) {
      check();
      final row = raw as Map;
      final path = row['path'] as String;
      final encoded = path.split('/').map(Uri.encodeComponent).join('/');
      final file = await ArtifactDownloader(api).download(
        '/api/v1/deliveries/${Uri.encodeComponent(id)}/files/$encoded',
        filename: path.split('/').last,
        byteLimit: byteLimit - consumed,
      );
      check();
      consumed += file.bytes.length;
      if (file.bytes.length != row['size']) {
        throw const ApiFailure('成果文件已变化，请重新同步后预览。');
      }
      files.add({
        'path': path,
        'contentType': row['contentType'],
        'data': base64Encode(file.bytes),
      });
    }
    final latest = await api.taskDelivery(taskId);
    check();
    if (jsonEncode(latest['delivery']) != jsonEncode(delivery)) {
      throw const ApiFailure('成果正在更新，请稍后重新打开。');
    }
    return {'title': delivery['title'], 'entryPath': entry, 'files': files};
  }

  static bool _validPath(dynamic value) =>
      value is String &&
      value.isNotEmpty &&
      !RegExp(r'[\\\x00-\x1f:#?%]').hasMatch(value) &&
      value
          .split('/')
          .every((part) => part.isNotEmpty && part != '.' && part != '..');
}

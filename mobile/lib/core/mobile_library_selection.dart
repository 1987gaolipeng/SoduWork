part of 'mobile_library.dart';

extension MobileLibrarySelection on MobileLibrary {
  Future<bool> copyToRemote(
    Map<String, dynamic> item,
    LibraryLocation destination, {
    bool reuse = false,
  }) async {
    if (!location.desktop ||
        !const {'nfs', 'minio'}.contains(destination.storage) ||
        item['deliverySnapshot'] == true) {
      throw const ApiFailure('不能复制该资料到远程存储');
    }
    final file = await read(item);
    check();
    final remote = MobileLibrary(api, destination, checkOwner: check);
    final prior = item['remoteCopy'];
    if (reuse &&
        prior is Map &&
        prior['storage'] == destination.storage &&
        (prior['folderId'] ?? '') == '' &&
        prior['id'] is String) {
      try {
        final saved = await remote.read({
          'id': prior['id'],
          'filename': file.filename,
        });
        if (saved.filename == file.filename &&
            sha256.convert(saved.bytes) == sha256.convert(file.bytes)) {
          return true;
        }
      } on ApiFailure catch (e) {
        if (e.status != 404) rethrow;
      }
    }
    final source = {
      'type': item['sourceType'],
      'sessionId': item['sessionId'],
      'conversationTitle': item['conversationTitle'],
    };
    check();
    final result = file.bytes.isEmpty
        ? await remote.call(
            'createItem',
            body: {
              'kind': 'file',
              'title': file.filename,
              'filename': file.filename,
              'content': '',
              'contentType': file.contentType,
              'rejectDuplicateName': true,
              'sourceType': source['type'],
              'sessionId': source['sessionId'],
              'conversationTitle': source['conversationTitle'],
            },
          )
        : await remote.upload(file, source: source);
    final remoteRow = result['item'];
    if (result['ok'] != true ||
        remoteRow is! Map ||
        remoteRow['id'] is! String) {
      throw const ApiFailure('远程副本未确认，请先核对目标存储');
    }
    try {
      await call(
        'recordRemoteCopy',
        id: item['id'].toString(),
        body: {'remoteId': remoteRow['id'], 'storage': destination.storage},
      );
      return true;
    } on ApiFailure {
      check();
      return false;
    }
  }

  Future<Map<String, dynamic>> trashSelection(
    List<Map<String, dynamic>> items,
  ) {
    final ids = items.map((i) => i['id'].toString()).toSet().toList();
    if (ids.isEmpty || ids.length > 100) {
      throw const ApiFailure('一次可选择 1 至 100 份资料');
    }
    return call('deleteItems', body: {'ids': ids});
  }

  Future<Map<String, dynamic>> shareSelection(
    List<Map<String, dynamic>> items,
    List<Map<String, dynamic>> folders,
    List<String> users,
    String note,
    String request,
  ) async {
    check();
    if (items.length == 1 && folders.isEmpty) {
      return share(items.single, users, note, request);
    }
    final files = <Map<String, dynamic>>[],
        seen = <String>{},
        dirs = <String>{};
    var total = 0;
    Future<void> add(Map item, String prefix) async {
      if (!seen.add(item['id'].toString())) return;
      if (seen.length > 20) throw const ApiFailure('一次最多分享 20 份资料');
      final file = await read(
        Map<String, dynamic>.from(item),
        limit: 24 * 1024 * 1024,
      );
      total += file.bytes.length;
      if (file.bytes.isEmpty || total > 24 * 1024 * 1024) {
        throw const ApiFailure('分享文件合计须在 24 MB 以内');
      }
      files.add({
        'localItemId': item['id'],
        'filename': '$prefix${file.filename}',
        'contentType': file.contentType,
        'data': base64Encode(file.bytes),
      });
    }

    if (location.desktop) {
      for (final item in items) {
        await add(item, '');
      }
      final pending = [for (final f in folders) (f['id'].toString(), '')];
      for (var i = 0; i < pending.length; i++) {
        final (id, path) = pending[i];
        if (!dirs.add(id)) continue;
        if (dirs.length > 1000) throw const ApiFailure('目录过多，请缩小分享范围');
        final rows = await list(scope: 'all', folderId: id);
        if ((rows['folders'] as List).length >= 500 ||
            (rows['items'] as List).length >= 500) {
          throw const ApiFailure('目录较大，请分批选择资料');
        }
        for (final f in rows['folders'] as List) {
          pending.add((f['id'].toString(), '$path${f['name']}/'));
        }
        for (final item in rows['items'] as List) {
          await add(item, path);
        }
      }
      if (files.isEmpty) throw const ApiFailure('文件夹内没有可分享的资料');
    }
    check();
    final result = await api.libraryRemoteAction(
      'shareSelection',
      body: {
        'itemIds': location.desktop ? [] : [for (final i in items) i['id']],
        'folderIds': location.desktop ? [] : [for (final f in folders) f['id']],
        if (files.isNotEmpty) 'localFiles': files,
        'forcePackage': folders.isNotEmpty,
        'recipientUserIds': users,
        'note': note,
        'requestId': request,
      },
    );
    check();
    return result;
  }
}

String libraryDisplayName(Map<String, dynamic> item) {
  final name = item['filename']?.toString() ?? '',
      title = item['title']?.toString().trim() ?? '';
  if (title.isEmpty) return name;
  final suffix = RegExp(r'(\.[^./\\]+)$').firstMatch(name)?.group(1) ?? '';
  return title.toLowerCase().endsWith(suffix.toLowerCase())
      ? title
      : '$title$suffix';
}

String librarySourceLabel(Map<String, dynamic> item) {
  final id = item['sessionId']?.toString() ?? '';
  if (id.isNotEmpty &&
      const {
        'conversation',
        'cloud_conversation',
      }.contains(item['sourceType'])) {
    final title = item['conversationTitle']?.toString() ?? '';
    return '来自会话：${title.isEmpty ? id.substring(0, min(12, id.length)) : title}';
  }
  return '上传';
}

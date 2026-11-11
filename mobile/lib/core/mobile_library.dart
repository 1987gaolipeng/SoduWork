import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'artifact_download.dart';
import 'cloud_conversation_request.dart';
import 'soduwork_api.dart';

part 'mobile_library_selection.dart';

class LibraryLocation {
  final String clientId, storage, label;
  const LibraryLocation({
    this.clientId = '',
    this.storage = '',
    this.label = '服务器资料',
  });
  bool get desktop => clientId.isNotEmpty;
  Map<String, dynamic> toJson() => {
    'clientId': clientId,
    'storage': storage,
    'label': label,
  };
  factory LibraryLocation.fromJson(Map<String, dynamic> data) =>
      LibraryLocation(
        clientId: data['clientId']?.toString() ?? '',
        storage: data['storage']?.toString() ?? '',
        label: data['label']?.toString() ?? '资料库',
      );
}

/// One immutable destination and identity per operation/editor. Never fall back to another storage.
class MobileLibrary {
  final SoduWorkApi api;
  final LibraryLocation location;
  final void Function()? checkOwner;
  late final int _revision = api.authRevision;
  late final Object _endpoint = api.endpoint;
  final _pending = <String, String>{};
  MobileLibrary(this.api, this.location, {this.checkOwner}) {
    _revision;
    _endpoint;
  }
  static String requestId() => 'library-${mobileRequestId()}';
  void check() {
    checkOwner?.call();
    if (api.authRevision != _revision || api.endpoint != _endpoint) {
      throw const ApiFailure('账号或服务已切换，请重新打开资料库');
    }
  }

  Future<Map<String, dynamic>> call(
    String action, {
    String id = '',
    Map<String, dynamic> body = const {},
    String? receiptId,
  }) async {
    check();
    if (location.storage == 'local' &&
        !location.desktop &&
        const {
          'createItem',
          'createFolder',
          'updateFolder',
          'deleteFolder',
        }.contains(action)) {
      throw const ApiFailure('历史目录仅供浏览，请返回远程根目录保存新资料');
    }
    Map<String, dynamic> result;
    if (location.desktop) {
      final args = {'action': action, 'id': id, 'body': body};
      final read = const {
        'list',
        'status',
        'readContent',
        'readChunk',
      }.contains(action);
      final key = jsonEncode(args);
      final request =
          receiptId ??
          (read ? requestId() : _pending.putIfAbsent(key, requestId));
      result = await api.desktopCapabilityRequest(
        location.clientId,
        'library.call',
        args,
        request,
      );
      check();
      if (result['ok'] != true) throw const ApiFailure('电脑未确认资料操作，请刷新核对');
      _pending.remove(key);
    } else {
      final scoped = {
        ...body,
        if (location.storage.isNotEmpty &&
            const {'createItem', 'createFolder', 'emptyTrash'}.contains(action))
          'storage': location.storage,
      };
      result = switch (action) {
        'list' => await api.library(
          scope: body['scope']?.toString() ?? 'recommended',
          query: body['query']?.toString() ?? '',
          folderId: body['folderId']?.toString() ?? '',
          storage: location.storage,
        ),
        'readContent' => await api.libraryContent(id),
        'status' => await api.libraryStorage(),
        _ => await api.libraryRemoteAction(action, id: id, body: scoped),
      };
      check();
      if (result['ok'] == false) throw const ApiFailure('资料操作未完成，请刷新核对');
    }
    return result;
  }

  Future<Map<String, dynamic>> list({
    String scope = 'recommended',
    String query = '',
    String folderId = '',
  }) async {
    final items = <dynamic>[], folders = <dynamic>[];
    int? offset = 0;
    Map<String, dynamic> result;
    do {
      result = await call(
        'list',
        body: {
          'scope': scope,
          'query': query,
          'folderId': folderId,
          if (location.desktop) 'offset': offset,
        },
      );
      items.addAll(result['items'] as List? ?? []);
      folders.addAll(result['folders'] as List? ?? []);
      final next = result['nextOffset'];
      if (next != null && (next is! int || next <= offset!)) {
        throw const ApiFailure('资料分页无效，请刷新');
      }
      offset = location.desktop ? next as int? : null;
    } while (offset != null);
    return {...result, 'items': items, 'folders': folders};
  }

  Future<DownloadedArtifact> read(
    Map<String, dynamic> item, {
    int limit = 32 * 1024 * 1024,
  }) async {
    check();
    final id = item['id'].toString();
    if (!location.desktop) {
      final file = await ArtifactDownloader(api).downloadLibrary(
        id,
        filename: item['filename']?.toString() ?? '资料',
        byteLimit: limit,
      );
      check();
      return file;
    }
    final bytes = BytesBuilder(copy: false);
    String revision = '', checksum = '', name = '', mime = '';
    int size = -1;
    do {
      final row = await call(
        'readChunk',
        id: id,
        body: {
          'offset': bytes.length,
          if (revision.isNotEmpty) 'revision': revision,
        },
      );
      final total = row['size'];
      if (total is! int ||
          total < 0 ||
          total > limit ||
          row['offset'] != bytes.length ||
          size >= 0 && total != size) {
        throw const ApiFailure('资料大小不符或超过手机读取限制');
      }
      size = total;
      if (revision.isNotEmpty &&
          (row['revision'] != revision || row['sha256'] != checksum)) {
        throw const ApiFailure('资料已变化，请重新读取');
      }
      revision = row['revision'].toString();
      checksum = row['sha256'].toString();
      name = row['name']?.toString() ?? '资料';
      mime = row['contentType']?.toString() ?? 'application/octet-stream';
      final chunk = base64Decode(row['data'] as String);
      if (chunk.length > 192 * 1024 ||
          chunk.isEmpty && bytes.length < size ||
          bytes.length + chunk.length > size) {
        throw const ApiFailure('资料传输不完整');
      }
      bytes.add(chunk);
    } while (bytes.length < size);
    final data = bytes.takeBytes();
    if (sha256.convert(data).toString() != checksum) {
      throw const ApiFailure('资料校验失败，请重新下载');
    }
    check();
    return DownloadedArtifact(bytes: data, filename: name, contentType: mime);
  }

  Future<Map<String, dynamic>> upload(
    DownloadedArtifact file, {
    String folderId = '',
    String? transferId,
    Map<String, dynamic> source = const {},
  }) async {
    check();
    if (!location.desktop && location.storage == 'local') {
      throw const ApiFailure('不能上传到历史服务器目录');
    }
    if (file.bytes.isEmpty || file.bytes.length > 32 * 1024 * 1024) {
      throw const ApiFailure('手机上传支持非空且不超过 32 MB 的文件');
    }
    if (!location.desktop) {
      final result = await api.uploadLibraryItem(
        LibraryMaterialFile(file),
        folderId: folderId,
        storage: location.storage,
        source: source,
      );
      check();
      return result;
    }
    final transfer = transferId ?? requestId(), size = file.bytes.length;
    for (var offset = 0; offset < size; offset += 192 * 1024) {
      await call(
        'uploadChunk',
        body: {
          'transfer': transfer,
          'size': size,
          'offset': offset,
          'data': base64Encode(
            file.bytes.sublist(offset, min(offset + 192 * 1024, size)),
          ),
        },
      );
    }
    return call(
      'uploadFinish',
      receiptId: transfer,
      body: {
        'transfer': transfer,
        'size': size,
        'name': file.filename,
        'contentType': file.contentType,
        'folderId': folderId,
        'sha256': sha256.convert(file.bytes).toString(),
        'source': source,
      },
    );
  }

  Future<Map<String, dynamic>> share(
    Map<String, dynamic> item,
    List<String> users,
    String note,
    String request,
  ) async {
    if (!location.desktop) {
      return call(
        'share',
        id: item['id'].toString(),
        body: {'recipientUserIds': users, 'note': note},
      );
    }
    final file = await read(item, limit: 24 * 1024 * 1024);
    check();
    final result = await api.libraryRemoteAction(
      'shareLocal',
      body: {
        'requestId': request,
        'localItemId': item['id'],
        'filename': file.filename,
        'contentType': file.contentType,
        'data': base64Encode(file.bytes),
        'recipientUserIds': users,
        'note': note,
      },
    );
    check();
    return result;
  }
}

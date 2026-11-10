import 'package:image_picker/image_picker.dart' show XFile;
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'soduwork_api.dart';

class DownloadedArtifact {
  final Uint8List bytes;
  final String filename;
  final String contentType;

  const DownloadedArtifact({
    required this.bytes,
    required this.filename,
    required this.contentType,
  });
}

/// Keep the display name with in-memory material on both IO and web platforms.
class LibraryMaterialFile extends XFile {
  @override
  final String name;
  LibraryMaterialFile(DownloadedArtifact file)
    : name = file.filename,
      super.fromData(
        file.bytes,
        name: file.filename,
        mimeType: file.contentType,
      );
}

class ArtifactSizeLimit extends ApiFailure {
  const ArtifactSizeLimit() : super('成果文件超过设备读取上限。');
}

/// Device credentials stay on the configured Hub and never follow redirects.
class ArtifactDownloader {
  static const maxBytes = 96 * 1024 * 1024;
  final SoduWorkApi api;

  ArtifactDownloader(this.api);

  bool isPrivateDeliveryUrl(String url) =>
      Uri.tryParse(
        api.absoluteUrl(url),
      )?.path.startsWith('/api/v1/deliveries/') ??
      false;

  Future<DownloadedArtifact> download(
    String url, {
    String filename = '成果',
    String contentType = 'application/octet-stream',
    int byteLimit = maxBytes,
  }) async {
    final endpoint = api.endpoint;
    final revision = api.authRevision;
    final uri = _sameOrigin(api.absoluteUrl(url), endpoint.baseUrl);
    final segments = uri.pathSegments;
    if (segments.length < 5 ||
        segments[0] != 'api' ||
        segments[1] != 'v1' ||
        segments[2] != 'deliveries' ||
        !_validId(segments[3]) ||
        !((segments.length == 5 && segments[4] == 'download') ||
            (segments.length > 5 &&
                segments[4] == 'files' &&
                segments.skip(5).every(_validSegment)))) {
      throw const ApiFailure('这不是受支持的成果下载地址。');
    }
    final result = await _request('GET', uri, endpoint, revision, byteLimit);
    return DownloadedArtifact(
      bytes: result.bytes,
      filename: _filename(result.headers['content-disposition'], filename),
      contentType: result.headers['content-type'] ?? contentType,
    );
  }

  Future<DownloadedArtifact> downloadLibrary(
    String id, {
    required String filename,
    int byteLimit = maxBytes,
  }) async {
    if (!_validId(id)) throw const ApiFailure('资料编号无效。');
    return _downloadOwned(
      '/api/v1/library/items/${Uri.encodeComponent(id)}/download',
      filename,
      byteLimit,
    );
  }

  Future<DownloadedArtifact> downloadSkill(
    String name,
    String checksum,
    String path,
  ) async {
    if (name.isEmpty || checksum.isEmpty || path.isEmpty) {
      throw const ApiFailure('技能版本或文件无效。');
    }
    final query = Uri(
      queryParameters: {'checksum': checksum, 'path': path},
    ).query;
    return _downloadOwned(
      '/api/v1/skills/${Uri.encodeComponent(name)}/download?$query',
      path,
      10 * 1024 * 1024,
    );
  }

  Future<DownloadedArtifact> downloadLibraryMember(
    String id,
    String member,
  ) async {
    if (!_validId(id) ||
        member.isEmpty ||
        member.length > 1024 ||
        RegExp(r'[\\\x00-\x1f:]').hasMatch(member) ||
        member
            .split('/')
            .any((part) => part.isEmpty || part == '.' || part == '..')) {
      throw const ApiFailure('压缩包文件路径无效');
    }
    final query = Uri(queryParameters: {'path': member}).query;
    return _downloadOwned(
      '/api/v1/library/items/${Uri.encodeComponent(id)}/archive/file?$query',
      member.split('/').last,
      32 * 1024 * 1024,
    );
  }

  Future<DownloadedArtifact> _downloadOwned(
    String path,
    String filename,
    int limit,
  ) async {
    final endpoint = api.endpoint;
    final revision = api.authRevision;
    final uri = _sameOrigin('${endpoint.baseUrl}$path', endpoint.baseUrl);
    final result = await _request('GET', uri, endpoint, revision, limit);
    return DownloadedArtifact(
      bytes: result.bytes,
      filename: _filename(result.headers['content-disposition'], filename),
      contentType: result.headers['content-type'] ?? 'application/octet-stream',
    );
  }

  Future<DownloadedArtifact> downloadAttachment(
    String id, {
    required String filename,
    String contentType = 'application/octet-stream',
    int byteLimit = maxBytes,
  }) async {
    final endpoint = api.endpoint;
    final revision = api.authRevision;
    final uri = await attachmentAccess(id);
    _checkEndpoint(endpoint, revision);
    final result = await _request('GET', uri, endpoint, revision, byteLimit);
    return DownloadedArtifact(
      bytes: result.bytes,
      filename: _filename(result.headers['content-disposition'], filename),
      contentType: result.headers['content-type'] ?? contentType,
    );
  }

  Future<Uri> attachmentAccess(String id) async {
    if (!_validId(id)) throw const ApiFailure('附件编号无效。');
    final endpoint = api.endpoint;
    final revision = api.authRevision;
    final path = '/api/v1/attachments/${Uri.encodeComponent(id)}';
    final uri = _sameOrigin(
      '${endpoint.baseUrl}$path/access',
      endpoint.baseUrl,
    );
    final result = await _request('POST', uri, endpoint, revision, 256 * 1024);
    dynamic decoded;
    try {
      decoded = jsonDecode(utf8.decode(result.bytes));
    } on FormatException {
      throw const ApiFailure('服务返回了无法识别的附件地址。');
    }
    final raw = decoded is Map ? decoded['url']?.toString() ?? '' : '';
    final target = _sameOrigin(api.absoluteUrl(raw), endpoint.baseUrl);
    if (raw.isEmpty ||
        target.path != path ||
        (target.queryParameters['ticket'] ?? '').isEmpty) {
      throw const ApiFailure('服务返回了无效的附件访问凭证。');
    }
    _checkEndpoint(endpoint, revision);
    return target;
  }

  /// Team-message files are recipient-bound snapshots, not task attachments.
  /// The server rechecks the current sender/recipient and company membership.
  Future<Uri> messageAttachmentAccess(String id) async {
    if (!_validId(id)) throw const ApiFailure('附件编号无效。');
    final endpoint = api.endpoint;
    final revision = api.authRevision;
    final path = '/api/v1/attachments/${Uri.encodeComponent(id)}';
    final request = _sameOrigin(
      '${endpoint.baseUrl}/api/v1/team/message-files/${Uri.encodeComponent(id)}',
      endpoint.baseUrl,
    );
    final result = await _request(
      'GET',
      request,
      endpoint,
      revision,
      256 * 1024,
    );
    dynamic decoded;
    try {
      decoded = jsonDecode(utf8.decode(result.bytes));
    } on FormatException {
      throw const ApiFailure('消息附件地址无法识别，请重试。');
    }
    if (decoded is! Map || decoded['id'] != id) {
      throw const ApiFailure('消息附件已变化，请刷新后重试。');
    }
    final raw = decoded['url'] is String ? decoded['url'] as String : '';
    final target = _sameOrigin(api.absoluteUrl(raw), endpoint.baseUrl);
    if (raw.isEmpty ||
        target.path != path ||
        (target.queryParameters['ticket'] ?? '').isEmpty) {
      throw const ApiFailure('消息附件访问凭证无效，请重试。');
    }
    _checkEndpoint(endpoint, revision);
    return target;
  }

  Future<_ArtifactResponse> _request(
    String method,
    Uri uri,
    Object endpoint,
    int revision,
    int byteLimit,
  ) async {
    try {
      for (var attempt = 0; attempt < 2; attempt++) {
        _checkEndpoint(endpoint, revision);
        final headers = await api.authorizationHeaders();
        _checkEndpoint(endpoint, revision);
        final request = http.Request(method, uri)
          ..followRedirects = false
          ..headers.addAll(headers);
        final response = await api.client
            .send(request)
            .timeout(const Duration(seconds: 30));
        var consumed = false;
        try {
          _checkEndpoint(endpoint, revision);
          if (response.statusCode == 401 && attempt == 0) {
            await response.stream.listen((_) {}).cancel();
            consumed = true;
            final enrollment = await api.enroll();
            _checkEndpoint(endpoint, revision);
            if (!enrollment.active) {
              throw const ApiFailure('登录状态已失效，请重新连接。', status: 401);
            }
            continue;
          }
          if (response.statusCode >= 300 && response.statusCode < 400) {
            throw const ApiFailure('成果地址发生跳转，请刷新后重试。');
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw ApiFailure(
              response.statusCode == 401
                  ? '登录状态已失效，请重新连接。'
                  : '无法获取成果（${response.statusCode}），请刷新后重试。',
              status: response.statusCode,
            );
          }
          if ((response.contentLength ?? 0) > byteLimit) {
            throw const ArtifactSizeLimit();
          }
        } catch (_) {
          if (!consumed) await response.stream.listen((_) {}).cancel();
          rethrow;
        }
        final bytes = BytesBuilder(copy: false);
        await for (final chunk in response.stream.timeout(
          const Duration(seconds: 45),
        )) {
          _checkEndpoint(endpoint, revision);
          if (bytes.length + chunk.length > byteLimit) {
            throw const ArtifactSizeLimit();
          }
          bytes.add(chunk);
        }
        _checkEndpoint(endpoint, revision);
        return _ArtifactResponse(bytes.takeBytes(), response.headers);
      }
    } on TimeoutException {
      throw const ApiFailure('下载超时，请稍后重试。', isNetwork: true);
    } on http.ClientException {
      throw const ApiFailure('网络不可用，请检查连接后重试。', isNetwork: true);
    }
    throw const ApiFailure('登录状态已失效，请重新连接。', status: 401);
  }

  void _checkEndpoint(Object original, int revision) {
    if (revision != api.authRevision) {
      throw const ApiFailure('账号已切换，旧账号成果未打开。', status: 409);
    }
    if (!identical(api.endpoint, original)) {
      throw const ApiFailure('服务地址已切换，请在当前环境重新打开成果。');
    }
  }

  static Uri _sameOrigin(String value, String baseUrl) {
    final uri = Uri.tryParse(value);
    final base = Uri.tryParse(baseUrl);
    if (uri == null ||
        base == null ||
        !{'http', 'https'}.contains(uri.scheme) ||
        uri.scheme != base.scheme ||
        uri.host != base.host ||
        uri.port != base.port ||
        uri.userInfo.isNotEmpty ||
        uri.fragment.isNotEmpty) {
      throw const ApiFailure('成果地址不属于当前企业服务。');
    }
    return uri;
  }

  static bool _validId(String value) =>
      RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(value) &&
      value != '.' &&
      value != '..';

  static bool _validSegment(String value) =>
      value.isNotEmpty &&
      value != '.' &&
      value != '..' &&
      !value.contains('/') &&
      !value.contains(String.fromCharCode(92));

  static String _filename(String? disposition, String fallback) {
    var name = fallback;
    if (disposition != null) {
      final encoded = RegExp(
        r"filename\*=UTF-8''([^;]+)",
        caseSensitive: false,
      ).firstMatch(disposition)?.group(1);
      final plain = RegExp(
        r'filename="([^"]+)"',
      ).firstMatch(disposition)?.group(1);
      if (encoded != null) {
        try {
          name = Uri.decodeComponent(encoded);
        } on FormatException {
          name = fallback;
        }
      } else if (plain != null) {
        name = plain;
      }
    }
    name = name
        .split(RegExp(r'[/\\]'))
        .last
        .replaceAll(RegExp(r'[\x00-\x1f<>:"|?*]'), '_')
        .trim();
    return name.isEmpty || name == '.' || name == '..' ? '成果' : name;
  }
}

class _ArtifactResponse {
  final Uint8List bytes;
  final Map<String, String> headers;

  const _ArtifactResponse(this.bytes, this.headers);
}

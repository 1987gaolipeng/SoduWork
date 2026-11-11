import 'memory_device_auth.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/artifact_download.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

void main() {
  test(
    'library archive member download stays authenticated and rejects path traversal',
    () async {
      var calls = 0;
      final api = _api(
        MockClient((r) async {
          calls++;
          expect(r.headers['Authorization'], 'Device original-session');
          expect(r.url.path, '/api/v1/library/items/file-one/archive/file');
          expect(r.url.queryParameters['path'], 'folder/proof.txt');
          return http.Response('proof', 200);
        }),
      );
      addTearDown(api.client.close);
      final downloader = ArtifactDownloader(api);
      expect(
        (await downloader.downloadLibraryMember(
          'file-one',
          'folder/proof.txt',
        )).filename,
        'proof.txt',
      );
      for (final path in [
        '../secret',
        '/secret',
        'folder/../secret',
        r'folder\secret',
      ]) {
        await expectLater(
          downloader.downloadLibraryMember('file-one', path),
          throwsA(isA<ApiFailure>()),
        );
      }
      expect(calls, 1);
    },
  );
  test(
    'message attachment access reauthorizes recipient-bound snapshot before opening',
    () async {
      final api = _api(
        MockClient((request) async {
          expect(request.method, 'GET');
          expect(request.url.path, '/api/v1/team/message-files/message-file');
          expect(request.headers['Authorization'], 'Device original-session');
          expect(request.followRedirects, false);
          return _json({
            'id': 'message-file',
            'url': '/api/v1/attachments/message-file?ticket=fresh',
          });
        }),
      );
      addTearDown(api.client.close);
      final uri = await ArtifactDownloader(
        api,
      ).messageAttachmentAccess('message-file');
      expect(
        uri.toString(),
        'https://hub.test/api/v1/attachments/message-file?ticket=fresh',
      );
    },
  );

  test(
    'message access rejects wrong identity, foreign origins, unsigned and mismatched URLs',
    () async {
      for (final body in [
        {'id': 'other', 'url': '/api/v1/attachments/message-file?ticket=fresh'},
        {
          'id': 'message-file',
          'url':
              'https://other.test/api/v1/attachments/message-file?ticket=fresh',
        },
        {'id': 'message-file', 'url': '/api/v1/attachments/other?ticket=fresh'},
        {'id': 'message-file', 'url': '/api/v1/attachments/message-file'},
        {
          'id': 'message-file',
          'url': '/api/v1/attachments/message-file?ticket=',
        },
      ]) {
        final api = _api(MockClient((request) async => _json(body)));
        addTearDown(api.client.close);
        await expectLater(
          ArtifactDownloader(api).messageAttachmentAccess('message-file'),
          throwsA(isA<ApiFailure>()),
        );
      }
    },
  );

  test(
    'message attachment denial, redirect and invalid identifiers cannot open files',
    () async {
      for (final status in [302, 403, 404]) {
        var calls = 0;
        final api = _api(
          MockClient((request) async {
            calls++;
            return http.Response(
              '',
              status,
              headers: {'location': 'https://other.test'},
            );
          }),
        );
        addTearDown(api.client.close);
        await expectLater(
          ArtifactDownloader(api).messageAttachmentAccess('message-file'),
          throwsA(isA<ApiFailure>()),
        );
        expect(calls, 1);
        await expectLater(
          ArtifactDownloader(api).messageAttachmentAccess('../other'),
          throwsA(isA<ApiFailure>()),
        );
        expect(calls, 1);
      }
    },
  );

  test(
    'message attachment ticket is discarded after account changes during authorization',
    () async {
      final requested = Completer<void>(),
          response = Completer<http.Response>();
      final api = _api(
        MockClient((request) async {
          requested.complete();
          return response.future;
        }),
      );
      addTearDown(api.client.close);
      final operation = ArtifactDownloader(
        api,
      ).messageAttachmentAccess('message-file');
      final rejected = expectLater(operation, throwsA(isA<ApiFailure>()));
      await requested.future;
      api.invalidateAuthentication();
      response.complete(
        _json({
          'id': 'message-file',
          'url': '/api/v1/attachments/message-file?ticket=stale',
        }),
      );
      await rejected;
    },
  );

  test(
    'attachment preview requests a fresh ticket and bounds the returned bytes',
    () async {
      var tickets = 0;
      final api = _api(
        MockClient((request) async {
          if (request.url.path.endsWith('/access')) {
            tickets++;
            expect(request.method, 'POST');
            return _json({
              'url': '/api/v1/attachments/result?ticket=short-lived',
            });
          }
          expect(request.url.queryParameters['ticket'], 'short-lived');
          expect(request.followRedirects, false);
          return http.Response.bytes([1, 2, 3], 200);
        }),
      );
      addTearDown(api.client.close);
      await expectLater(
        ArtifactDownloader(
          api,
        ).downloadAttachment('result', filename: 'preview.png', byteLimit: 2),
        throwsA(isA<ApiFailure>()),
      );
      expect(tickets, 1);
    },
  );

  test(
    'downloads exact binary bytes with Device identity and no redirects',
    () async {
      final api = _api(
        MockClient((request) async {
          expect(request.method, 'GET');
          expect(
            request.url.toString(),
            'https://hub.test/api/v1/deliveries/result-1/download',
          );
          expect(request.headers['Authorization'], 'Device original-session');
          expect(request.followRedirects, isFalse);
          return http.Response.bytes(
            [0, 255, 128, 1],
            200,
            headers: {
              'content-type': 'application/zip',
              'content-disposition':
                  "attachment; filename*=UTF-8''%E6%88%90%E6%9E%9C.zip",
            },
          );
        }),
      );
      addTearDown(api.client.close);
      final result = await ArtifactDownloader(
        api,
      ).download('/api/v1/deliveries/result-1/download');
      expect(result.bytes, [0, 255, 128, 1]);
      expect(result.filename, '成果.zip');
      expect(result.contentType, 'application/zip');
    },
  );

  test('accepts a nested delivery file and safe fallback filename', () async {
    final api = _api(
      MockClient((request) async {
        expect(
          request.url.path,
          '/api/v1/deliveries/result-1/files/docs/report.md',
        );
        return http.Response.bytes([35, 32, 65], 200);
      }),
    );
    addTearDown(api.client.close);
    final result = await ArtifactDownloader(api).download(
      '/api/v1/deliveries/result-1/files/docs/report.md',
      filename: '../report.md',
      contentType: 'text/markdown',
    );
    expect(result.filename, 'report.md');
    expect(result.contentType, 'text/markdown');
  });

  test('renews once after 401 and uses the refreshed session', () async {
    var downloads = 0;
    var enrollments = 0;
    final api = _api(
      MockClient((request) async {
        if (request.url.path == '/api/v1/clients/enroll') {
          enrollments++;
          return _json({'session': 'renewed-session', 'authState': 'active'});
        }
        downloads++;
        expect(
          request.headers['Authorization'],
          downloads == 1 ? 'Device original-session' : 'Device renewed-session',
        );
        return downloads == 1
            ? http.Response('', 401)
            : http.Response.bytes([255], 200);
      }),
    );
    addTearDown(api.client.close);
    expect(
      (await ArtifactDownloader(
        api,
      ).download('/api/v1/deliveries/d/download')).bytes,
      [255],
    );
    expect(downloads, 2);
    expect(enrollments, 1);
  });

  test('stops after a second 401 instead of retrying indefinitely', () async {
    var downloads = 0;
    var enrollments = 0;
    final api = _api(
      MockClient((request) async {
        if (request.url.path == '/api/v1/clients/enroll') {
          enrollments++;
          return _json({'session': 'renewed-session', 'authState': 'active'});
        }
        downloads++;
        return http.Response('', 401);
      }),
    );
    addTearDown(api.client.close);
    await expectLater(
      ArtifactDownloader(api).download('/api/v1/deliveries/d/download'),
      throwsA(isA<ApiFailure>().having((error) => error.status, 'status', 401)),
    );
    expect(downloads, 2);
    expect(enrollments, 1);
  });

  test(
    'rejects foreign origins and non-download paths before sending credentials',
    () async {
      var calls = 0;
      final api = _api(
        MockClient((request) async {
          calls++;
          return http.Response('', 200);
        }),
      );
      addTearDown(api.client.close);
      final downloader = ArtifactDownloader(api);
      for (final url in [
        'https://other.test/api/v1/deliveries/d/download',
        'http://hub.test/api/v1/deliveries/d/download',
        'https://hub.test:444/api/v1/deliveries/d/download',
        'https://user@hub.test/api/v1/deliveries/d/download',
        '/api/v1/clients/enroll',
        '/api/v1/deliveries/d',
        '/api/v1/deliveries/d/files/a%2Fb',
        '/api/v1/deliveries/d/files/%5Csecret',
      ]) {
        await expectLater(
          downloader.download(url),
          throwsA(isA<ApiFailure>()),
          reason: url,
        );
      }
      expect(calls, 0);
    },
  );

  test('rejects redirects without making a second request', () async {
    var calls = 0;
    final api = _api(
      MockClient((request) async {
        calls++;
        expect(request.followRedirects, isFalse);
        return http.Response(
          '',
          302,
          headers: {'location': 'https://other.test/stolen'},
        );
      }),
    );
    addTearDown(api.client.close);
    await expectLater(
      ArtifactDownloader(api).download('/api/v1/deliveries/d/download'),
      throwsA(isA<ApiFailure>()),
    );
    expect(calls, 1);
  });

  test(
    'refreshes the exact attachment ticket with authenticated POST',
    () async {
      final api = _api(
        MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, '/api/v1/attachments/att-1/access');
          expect(request.headers['Authorization'], 'Device original-session');
          expect(request.followRedirects, isFalse);
          return _json({
            'ok': true,
            'url': '/api/v1/attachments/att-1?ticket=fresh',
          });
        }),
      );
      addTearDown(api.client.close);
      final uri = await ArtifactDownloader(api).attachmentAccess('att-1');
      expect(
        uri.toString(),
        'https://hub.test/api/v1/attachments/att-1?ticket=fresh',
      );
    },
  );

  test('rejects foreign, mismatched or unsigned attachment URLs', () async {
    for (final url in [
      'https://other.test/api/v1/attachments/att-1?ticket=fresh',
      '/api/v1/attachments/att-2?ticket=fresh',
      '/api/v1/attachments/att-1',
    ]) {
      final api = _api(MockClient((request) async => _json({'url': url})));
      addTearDown(api.client.close);
      await expectLater(
        ArtifactDownloader(api).attachmentAccess('att-1'),
        throwsA(isA<ApiFailure>()),
      );
    }
  });

  test('discards completed bytes after an environment switch', () async {
    final requested = Completer<void>();
    final response = Completer<http.Response>();
    final api = _api(
      MockClient((request) async {
        requested.complete();
        return response.future;
      }),
    );
    addTearDown(api.client.close);
    final pending = ArtifactDownloader(
      api,
    ).download('/api/v1/deliveries/d/download');
    final rejected = expectLater(pending, throwsA(isA<ApiFailure>()));
    await requested.future;
    api.setEndpoint(
      const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://other.test',
      ),
    );
    response.complete(http.Response.bytes([255], 200));
    await rejected;
  });

  test(
    'rejects oversized responses from headers before reading the body',
    () async {
      final api = _api(_OversizeClient());
      addTearDown(api.client.close);
      await expectLater(
        ArtifactDownloader(api).download('/api/v1/deliveries/d/download'),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test('enforces the byte limit on streams without Content-Length', () async {
    final api = _api(_LargeChunksClient());
    addTearDown(api.client.close);
    await expectLater(
      ArtifactDownloader(api).download('/api/v1/deliveries/d/download'),
      throwsA(isA<ApiFailure>()),
    );
  });
}

http.Response _json(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json'},
);

SoduWorkApi _api(http.Client client) => SoduWorkApi(
  store: _SessionStore(),
  endpoint: const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'https://hub.test',
  ),
  client: client,
);

class _SessionStore extends DeviceStore with MemoryDeviceAuthentication {
  String session = 'original-session';

  @override
  Future<String?> readSession(String endpoint) async => session;

  @override
  Future<void> writeSession(String endpoint, String value) async {
    session = value;
  }

  @override
  Future<void> clearSession(String endpoint) async {
    session = '';
  }

  @override
  Future<DeviceCredentials> credentials(String endpoint) async =>
      const DeviceCredentials(
        id: 'artifact-test-device',
        secret: 'artifact-test-only-key',
        name: 'Artifact Test',
        platform: 'Android',
      );
}

class _OversizeClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async =>
      http.StreamedResponse(
        const Stream<List<int>>.empty(),
        200,
        contentLength: ArtifactDownloader.maxBytes + 1,
      );
}

class _LargeChunksClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async =>
      http.StreamedResponse(
        Stream<List<int>>.fromIterable(
          List<List<int>>.filled(97, Uint8List(1024 * 1024)),
        ),
        200,
      );
}

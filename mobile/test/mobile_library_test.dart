import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/core/mobile_library.dart';
import 'package:soduwork_mobile/core/artifact_download.dart';
import 'memory_device_auth.dart';

class Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'session';
}

SoduWorkApi apiFor(Future<http.Response> Function(http.Request) handle) =>
    SoduWorkApi(
      store: Store(),
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://hub.test',
      ),
      client: MockClient(handle),
    );
http.Response reply(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

void main() {
  test(
    'historical remote directory blocks new writes and directory mutations before transport',
    () async {
      final api = apiFor(
        (r) async => fail('Unexpected request: ${r.url.path}'),
      );
      final library = MobileLibrary(
        api,
        const LibraryLocation(storage: 'local'),
      );
      for (final action in [
        'createItem',
        'createFolder',
        'deleteFolder',
        'updateFolder',
      ]) {
        await expectLater(library.call(action), throwsA(isA<ApiFailure>()));
      }
      await expectLater(
        library.upload(
          DownloadedArtifact(
            bytes: Uint8List(1),
            filename: 'a.txt',
            contentType: 'text/plain',
          ),
        ),
        throwsA(isA<ApiFailure>()),
      );
    },
  );

  test(
    'remote batch share sends only owned selection references and one request identifier',
    () async {
      final api = apiFor((r) async {
        expect(r.url.path, '/api/v1/library/items/batch-share');
        final body = jsonDecode(r.body);
        expect(body['folderIds'], ['folder-one']);
        expect(body['itemIds'], ['file-one']);
        expect(body['forcePackage'], true);
        expect(body['requestId'], 'request-one');
        expect(body.containsKey('localFiles'), false);
        return reply({'ok': true});
      });
      final library = MobileLibrary(api, const LibraryLocation(storage: 'nfs'));
      await library.shareSelection(
        [
          {'id': 'file-one'},
        ],
        [
          {'id': 'folder-one'},
        ],
        ['colleague'],
        'note',
        'request-one',
      );
    },
  );
  test(
    'selected PC file uploads in bounded chunks and a lost finish receipt retries the same operation',
    () async {
      final requests = <Map<String, dynamic>>[], chunks = <int, Uint8List>{};
      bool lost = true;
      final api = apiFor((r) async {
        expect(r.url.path, '/api/v1/desktop-capabilities/pc-one/requests');
        final request = jsonDecode(r.body) as Map<String, dynamic>;
        requests.add(request);
        expect(request['operation'], 'library.call');
        final args = request['args'] as Map, body = args['body'] as Map;
        if (args['action'] == 'uploadChunk') {
          final bytes = base64Decode(body['data']);
          expect(bytes.length, lessThanOrEqualTo(192 * 1024));
          chunks[body['offset']] = bytes;
        } else if (lost) {
          lost = false;
          return reply({'detail': 'receipt timeout'}, 504);
        }
        return reply({
          'ok': true,
          'item': {'id': 'local-one'},
        });
      });
      addTearDown(api.client.close);
      final library = MobileLibrary(
        api,
        const LibraryLocation(clientId: 'pc-one'),
      );
      final bytes = Uint8List.fromList(
        List.generate(192 * 1024 + 15, (i) => i % 251),
      );
      final file = DownloadedArtifact(
        bytes: bytes,
        filename: 'proof.bin',
        contentType: 'application/octet-stream',
      );
      await expectLater(
        library.upload(
          file,
          folderId: 'folder-one',
          transferId: 'transfer-one',
        ),
        throwsA(isA<ApiFailure>()),
      );
      await library.upload(
        file,
        folderId: 'folder-one',
        transferId: 'transfer-one',
      );
      final finishes = requests
          .where((r) => r['args']['action'] == 'uploadFinish')
          .toList();
      expect(finishes.map((r) => r['requestId']).toSet(), {'transfer-one'});
      expect(finishes.last['args']['body']['folderId'], 'folder-one');
      expect(
        finishes.last['args']['body']['sha256'],
        sha256.convert(bytes).toString(),
      );
      expect([...chunks[0]!, ...chunks[192 * 1024]!], bytes);
    },
  );
  test(
    'PC download checks all chunks, size, version and checksum before releasing bytes',
    () async {
      final bytes = Uint8List.fromList(
        List.generate(192 * 1024 + 3, (i) => i % 253),
      );
      bool changed = false;
      final api = apiFor((r) async {
        final body = jsonDecode(r.body)['args']['body'] as Map;
        final offset = body['offset'] as int;
        return reply({
          'ok': true,
          'offset': offset,
          'size': bytes.length,
          'revision': changed && offset > 0 ? 'changed' : 'one',
          'sha256': sha256.convert(bytes).toString(),
          'name': 'proof.bin',
          'contentType': 'application/octet-stream',
          'data': base64Encode(
            bytes.sublist(offset, offset == 0 ? 192 * 1024 : bytes.length),
          ),
        });
      });
      addTearDown(api.client.close);
      final library = MobileLibrary(
        api,
        const LibraryLocation(clientId: 'pc-one'),
      );
      expect((await library.read({'id': 'local-one'})).bytes, bytes);
      changed = true;
      await expectLater(
        library.read({'id': 'local-one'}),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'account change during list or upload stops the result and never switches destination',
    () async {
      var valid = true, calls = 0;
      final api = apiFor((r) async {
        calls++;
        valid = false;
        return reply({
          'ok': true,
          'items': [
            {'id': 'private'},
          ],
          'folders': [],
        });
      });
      addTearDown(api.client.close);
      final library = MobileLibrary(
        api,
        const LibraryLocation(clientId: 'pc-one'),
        checkOwner: () {
          if (!valid) throw const ApiFailure('changed');
        },
      );
      await expectLater(library.list(), throwsA(isA<ApiFailure>()));
      await expectLater(
        library.upload(
          DownloadedArtifact(
            bytes: Uint8List.fromList([1]),
            filename: 'x',
            contentType: 'text/plain',
          ),
        ),
        throwsA(isA<ApiFailure>()),
      );
      expect(calls, 1);
    },
  );
  test(
    'native share reads a private snapshot then uses existing team snapshot API without importing remotely',
    () async {
      final routes = <String>[];
      final api = apiFor((r) async {
        routes.add(r.url.path);
        if (r.url.path.endsWith('/requests')) {
          return reply({
            'ok': true,
            'offset': 0,
            'size': 3,
            'revision': 'one',
            'sha256': sha256.convert([65, 66, 67]).toString(),
            'name': 'proof.txt',
            'contentType': 'text/plain',
            'data': 'QUJD',
          });
        }
        final body = jsonDecode(r.body);
        expect(body['recipientUserIds'], ['colleague']);
        expect(body['data'], 'QUJD');
        expect(body['requestId'], '0123456789abcdef0123456789abcdef');
        return reply({'ok': true});
      });
      addTearDown(api.client.close);
      await MobileLibrary(api, const LibraryLocation(clientId: 'pc-one')).share(
        {'id': 'local-one'},
        ['colleague'],
        'proof',
        '0123456789abcdef0123456789abcdef',
      );
      expect(routes, [
        '/api/v1/desktop-capabilities/pc-one/requests',
        '/api/v1/library/share-local',
      ]);
    },
  );
}

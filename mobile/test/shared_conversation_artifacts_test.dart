import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/shared_conversation_artifacts.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

void main() {
  test('open revalidates the remote index and ignores caller URLs', () async {
    final api = _Api();
    Map<String, dynamic>? opened;
    final host = SharedConversationArtifacts(api, () {}, (row) async {
      opened = row;
    });
    await host.action('task', 'out', 'open');
    expect(opened!['url'], '/api/v1/attachments/out');
    expect(opened!['filename'], 'report.txt');
    expect(opened!.containsKey('secret'), false);
    api.rows.clear();
    await expectLater(
      host.action('task', 'out', 'open'),
      throwsA(isA<ApiFailure>()),
    );
  });
  test(
    'input materials and unimplemented file actions cannot masquerade as results',
    () async {
      final api = _Api();
      var calls = 0;
      final host = SharedConversationArtifacts(api, () {}, (_) async {
        calls++;
      });
      await expectLater(
        host.action('task', 'input', 'open'),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        host.action('task', 'out', 'write'),
        throwsA(isA<ApiFailure>()),
      );
      expect(calls, 0);
    },
  );
  test(
    'account switch during index load cannot open an old account file',
    () async {
      final api = _Api()..pending = Completer<List<Map<String, dynamic>>>();
      var current = true, opened = false;
      final host = SharedConversationArtifacts(
        api,
        () {
          if (!current) throw const ApiFailure('账号已切换');
        },
        (_) async {
          opened = true;
        },
      );
      final operation = host.action('task', 'out', 'open');
      current = false;
      api.pending!.complete(api.rows);
      await expectLater(operation, throwsA(isA<ApiFailure>()));
      expect(opened, false);
    },
  );
  test('file opener failures stay visible to the shared card', () async {
    final host = SharedConversationArtifacts(_Api(), () {}, (_) async {
      throw const ApiFailure('无法打开');
    });
    await expectLater(
      host.action('task', 'out', 'open'),
      throwsA(isA<ApiFailure>()),
    );
  });
  test(
    'share returns an authorized bounded snapshot with the desktop contract',
    () async {
      final paths = <String>[];
      final api = _Api(
        handler: (request) async {
          paths.add(request.url.path);
          if (request.url.path.endsWith('/access')) {
            return http.Response(
              jsonEncode({'url': '/api/v1/attachments/out?ticket=fixture'}),
              200,
            );
          }
          return http.Response('abc', 200);
        },
      );
      final result = await SharedConversationArtifacts(
        api,
        () {},
        null,
      ).action('task', 'out', 'share');
      expect(result, {
        'ok': true,
        'name': 'report.txt',
        'size': 3,
        'at': DateTime.parse('2026-10-27T01:00:00Z').millisecondsSinceEpoch,
        'data': base64Encode(utf8.encode('abc')),
      });
      expect(paths, [
        '/api/v1/attachments/out/access',
        '/api/v1/attachments/out',
      ]);
      api.rows[0]['filename'] = 'reports/report.txt';
      final nested = await SharedConversationArtifacts(
        api,
        () {},
        null,
      ).action('task', 'out', 'share');
      expect(nested['name'], 'report.txt');
      expect(paths.last, '/api/v1/attachments/out');
    },
  );
  test(
    'share rejects input materials, unknown IDs and invalid sizes before download',
    () async {
      var requests = 0;
      final api = _Api(
        handler: (_) async {
          requests++;
          return http.Response('abc', 200);
        },
      );
      final reader = SharedConversationArtifacts(api, () {}, null);
      for (final id in ['input', 'missing']) {
        await expectLater(
          reader.action('task', id, 'share'),
          throwsA(isA<ApiFailure>()),
        );
      }
      for (final size in [0, -1, 20 * 1024 * 1024 + 1]) {
        api.rows[0]['size'] = size;
        await expectLater(
          reader.action('task', 'out', 'share'),
          throwsA(isA<ApiFailure>()),
        );
      }
      expect(requests, 0);
    },
  );
  test(
    'share discards a changed or revoked file and mismatched bytes',
    () async {
      for (final mutation in [
        'removed',
        'role',
        'createdAt',
        'sourceRef',
        'size',
        'account',
      ]) {
        var current = true;
        late _Api api;
        api = _Api(
          handler: (request) async {
            if (request.url.path.endsWith('/access')) {
              return http.Response(
                jsonEncode({'url': '/api/v1/attachments/out?ticket=fixture'}),
                200,
              );
            }
            if (mutation == 'removed') api.rows.clear();
            if (mutation == 'role') api.rows[0]['role'] = 'input';
            if (mutation == 'createdAt') api.rows[0]['createdAt'] = 'changed';
            if (mutation == 'sourceRef') {
              api.rows[0]['sourceRef'] = 'other-turn';
            }
            if (mutation == 'account') current = false;
            return http.Response(mutation == 'size' ? 'ab' : 'abc', 200);
          },
        );
        await expectLater(
          SharedConversationArtifacts(api, () {
            if (!current) throw const ApiFailure('账号已切换');
          }, null).action('task', 'out', 'share'),
          throwsA(isA<ApiFailure>()),
        );
      }
    },
  );
}

class _Api extends SoduWorkApi {
  _Api({MockClientHandler? handler})
    : super(
        store: DeviceStore(),
        client: handler == null ? null : MockClient(handler),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  Completer<List<Map<String, dynamic>>>? pending;
  final rows = <Map<String, dynamic>>[
    {
      'id': 'out',
      'taskId': 'task',
      'filename': 'report.txt',
      'role': 'output',
      'size': 3,
      'createdAt': '2026-10-27T01:00:00Z',
      'contentType': 'text/plain',
      'secret': 'never-expose',
    },
    {'id': 'input', 'filename': 'input.txt', 'role': 'input'},
  ];
  @override
  Future<Map<String, String>> authorizationHeaders() async => {
    'Authorization': 'fixture',
  };
  @override
  Future<List<Map<String, dynamic>>> taskAttachments(String id) async =>
      pending?.future ?? rows;
}

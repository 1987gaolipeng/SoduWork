import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/shared_conversation_delivery.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

void main() {
  test(
    'library save uses the full authorized delivery and rejects changes during download',
    () async {
      final api = _Api((r) async {
        expect(r.url.path, '/api/v1/deliveries/delivery/download');
        return http.Response('zip', 200);
      });
      addTearDown(api.client.close);
      final file = await SharedConversationDelivery(
        api,
        () {},
      ).download('task', 'delivery');
      expect(file.filename, 'website.zip');
      expect(utf8.decode(file.bytes), 'zip');
      late _Api changing;
      changing = _Api((_) async {
        changing.revision = 'changed';
        return http.Response('zip', 200);
      });
      addTearDown(changing.client.close);
      await expectLater(
        SharedConversationDelivery(
          changing,
          () {},
        ).download('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'delivery plugin draft uses the authorized manifest and rechecks its revision',
    () async {
      const text = '{"name":"check","template":"method"}';
      final paths = <String>[];
      final api = _Api((request) async {
        paths.add(request.url.path);
        return http.Response(text, 200);
      });
      api.files = [
        {
          'path': 'bundle/soduwork-plugin-draft.json',
          'size': utf8.encode(text).length,
        },
      ];
      final result = await SharedConversationDelivery(
        api,
        () {},
      ).pluginDraft('task', 'delivery');
      expect(result['name'], 'check');
      expect(paths, [
        '/api/v1/deliveries/delivery/files/bundle/soduwork-plugin-draft.json',
      ]);
      late _Api changing;
      changing = _Api((_) async {
        changing.revision = 'new';
        return http.Response(text, 200);
      });
      changing.files = api.files;
      await expectLater(
        SharedConversationDelivery(
          changing,
          () {},
        ).pluginDraft('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'ambiguous, oversized and untrusted plugin paths never download',
    () async {
      var reads = 0;
      final api = _Api((_) async {
        reads++;
        return http.Response('{}', 200);
      });
      final reader = SharedConversationDelivery(api, () {});
      for (final rows in <List<Map<String, dynamic>>>[
        [
          {'path': '../soduwork-plugin-draft.json', 'size': 2},
        ],
        [
          {'path': 'soduwork-plugin-draft.json', 'size': 3000000},
        ],
        [
          {'path': 'soduwork-plugin-draft.json', 'size': 2},
          {'path': 'other/soduwork-plugin-draft.json', 'size': 2},
        ],
      ]) {
        api.files = rows;
        await expectLater(
          reader.pluginDraft('task', 'delivery'),
          throwsA(isA<ApiFailure>()),
        );
      }
      expect(reads, 0);
    },
  );
  test(
    'loads every declared file using authenticated delivery paths',
    () async {
      final requests = <String>[];
      final api = _Api((request) async {
        requests.add(request.url.path);
        return http.Response('abc', 200);
      });
      final bundle = await SharedConversationDelivery(
        api,
        () {},
      ).preview('task', 'delivery');
      expect(bundle['entryPath'], 'index.html');
      expect(
        (bundle['files'] as List).single['data'],
        base64Encode(utf8.encode('abc')),
      );
      expect(requests, ['/api/v1/deliveries/delivery/files/index.html']);
    },
  );
  test(
    'another delivery and untrusted manifest paths cannot be fetched',
    () async {
      var requests = 0;
      final api = _Api((_) async {
        requests++;
        return http.Response('abc', 200);
      });
      final reader = SharedConversationDelivery(api, () {});
      await expectLater(
        reader.preview('task', 'other'),
        throwsA(isA<ApiFailure>()),
      );
      for (final path in [
        '../secret',
        '/absolute',
        'C:/secret',
        'a\\b',
        '%2e%2e/x',
      ]) {
        api.files = [
          {'path': path, 'size': 3},
        ];
        await expectLater(
          reader.preview('task', 'delivery'),
          throwsA(isA<ApiFailure>()),
        );
      }
      expect(requests, 0);
    },
  );
  test('missing, duplicate and oversized files fail before download', () async {
    var requests = 0;
    final api = _Api((_) async {
      requests++;
      return http.Response('abc', 200);
    });
    final reader = SharedConversationDelivery(api, () {});
    for (final files in [
      [
        {'path': 'styles.css', 'size': 3},
      ],
      [
        {'path': 'index.html', 'size': 3},
        {'path': 'index.html', 'size': 3},
      ],
      [
        {
          'path': 'index.html',
          'size': SharedConversationDelivery.byteLimit + 1,
        },
      ],
    ]) {
      api.files = files;
      await expectLater(
        reader.preview('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
    }
    expect(requests, 0);
  });
  test(
    'changed content, changed revision and account switch discard preview',
    () async {
      final wrongSize = _Api((_) async => http.Response('ab', 200));
      await expectLater(
        SharedConversationDelivery(
          wrongSize,
          () {},
        ).preview('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
      late _Api changed;
      changed = _Api((_) async {
        changed.revision = 'new';
        return http.Response('abc', 200);
      });
      await expectLater(
        SharedConversationDelivery(changed, () {}).preview('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
      var current = true;
      final switched = _Api((_) async {
        current = false;
        return http.Response('abc', 200);
      });
      await expectLater(
        SharedConversationDelivery(switched, () {
          if (!current) throw const ApiFailure('账号已切换');
        }).preview('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'share downloads the authorized complete archive and preserves version',
    () async {
      final paths = <String>[];
      final api = _Api((request) async {
        paths.add(request.url.path);
        return http.Response('zip', 200);
      });
      final result = await SharedConversationDelivery(
        api,
        () {},
      ).share('task', 'delivery');
      expect(result, {
        'ok': true,
        'name': 'website.zip',
        'size': 3,
        'at': DateTime.parse('2026-10-27T01:00:00Z').millisecondsSinceEpoch,
        'data': base64Encode(utf8.encode('zip')),
      });
      expect(paths, ['/api/v1/deliveries/delivery/download']);
    },
  );
  test(
    'share refuses missing, unsynced, non-bundle and oversized deliveries',
    () async {
      var requests = 0;
      final api = _Api((_) async {
        requests++;
        return http.Response('zip', 200);
      });
      final reader = SharedConversationDelivery(api, () {});
      await expectLater(
        reader.share('task', 'other'),
        throwsA(isA<ApiFailure>()),
      );
      api.state = 'pending';
      await expectLater(
        reader.share('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
      api.state = 'synced';
      api.kind = 'file';
      await expectLater(
        reader.share('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
      api.kind = 'bundle';
      api.size = SharedConversationDelivery.shareByteLimit + 1;
      await expectLater(
        reader.share('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
      api.size = 0;
      await expectLater(
        reader.share('task', 'delivery'),
        throwsA(isA<ApiFailure>()),
      );
      expect(requests, 0);
    },
  );
  test(
    'share discards bytes on revocation, changed revision, size or account',
    () async {
      for (final mutation in [
        'revoke',
        'revision',
        'state',
        'size',
        'account',
      ]) {
        var current = true;
        late _Api api;
        api = _Api((_) async {
          if (mutation == 'revoke') api.revoked = true;
          if (mutation == 'revision') api.revision = 'changed';
          if (mutation == 'state') api.state = 'pending';
          if (mutation == 'account') current = false;
          return http.Response(mutation == 'size' ? 'z' : 'zip', 200);
        });
        await expectLater(
          SharedConversationDelivery(api, () {
            if (!current) throw const ApiFailure('账号已切换');
          }).share('task', 'delivery'),
          throwsA(isA<ApiFailure>()),
        );
      }
    },
  );
}

class _Api extends SoduWorkApi {
  _Api(MockClientHandler handler)
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
        client: MockClient(handler),
      );
  String revision = 'original';
  String state = 'synced', kind = 'bundle';
  int size = 3;
  bool revoked = false;
  List<Map<String, dynamic>> files = [
    {'path': 'index.html', 'size': 3, 'contentType': 'text/html'},
  ];
  @override
  Future<Map<String, String>> authorizationHeaders() async => {
    'Authorization': 'fixture',
  };
  @override
  Future<Map<String, dynamic>> taskDelivery(String taskId) async {
    if (revoked) throw const ApiFailure('Access revoked', status: 403);
    return {
      'state': state,
      'delivery': {
        'id': 'delivery',
        'title': '网页',
        'filename': 'website.zip',
        'size': size,
        'kind': kind,
        'createdAt': '2026-10-27T01:00:00Z',
        'entryPath': 'index.html',
        'files': files,
        'revision': revision,
      },
    };
  }
}

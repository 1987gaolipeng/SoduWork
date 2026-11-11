import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/shared_conversation_share_guard.dart';
import 'package:soduwork_mobile/core/shared_conversation_team.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

const _at = '2026-10-27T01:00:00Z';
Map<String, dynamic> _result({
  String name = 'result.txt',
  String text = 'abc',
}) => {
  'ok': true,
  'name': name,
  'size': utf8.encode(text).length,
  'at': DateTime.parse(_at).millisecondsSinceEpoch,
  'data': base64Encode(utf8.encode(text)),
};
List<Map<String, dynamic>> _files(Map<String, dynamic> result) => [
  {'name': result['name'], 'data': result['data']},
];

void main() {
  test(
    'prepared artifacts and bundles revalidate without downloading bytes again',
    () async {
      final api = _Api();
      final guard = SharedConversationShareGuard(api, () {});
      final file = _result(), bundle = _result(name: 'website.zip');
      await guard.recordArtifact('task', 'file', file);
      await guard.recordDelivery('task', 'delivery', bundle);
      await guard.validateUploads([..._files(file), ..._files(bundle)]);
      expect(api.artifactReads, 2);
      expect(api.deliveryReads, 2);
    },
  );
  test(
    'unrelated personal uploads do not acquire fake task references',
    () async {
      final api = _Api();
      final guard = SharedConversationShareGuard(api, () {});
      await guard.recordArtifact('task', 'file', _result());
      await guard.validateUploads(_files(_result(name: 'personal.txt')));
      expect(api.artifactReads, 1);
    },
  );
  test('record rejects unknown, input and mismatched snapshots', () async {
    final api = _Api();
    final guard = SharedConversationShareGuard(api, () {});
    await expectLater(
      guard.recordArtifact('task', 'other', _result()),
      throwsA(isA<ApiFailure>()),
    );
    api.row['role'] = 'input';
    await expectLater(
      guard.recordArtifact('task', 'file', _result()),
      throwsA(isA<ApiFailure>()),
    );
    api.row['role'] = 'output';
    for (final changed in [
      {..._result(), 'size': 4},
      {..._result(), 'at': 0},
      {..._result(), 'name': 'other.txt'},
      {..._result(), 'data': 'bad'},
    ]) {
      await expectLater(
        guard.recordArtifact('task', 'file', changed),
        throwsA(isA<ApiFailure>()),
      );
    }
    await expectLater(
      guard.recordDelivery('task', 'other', _result(name: 'website.zip')),
      throwsA(isA<ApiFailure>()),
    );
  });
  test(
    'removed and changed artifacts cannot be sent from an old share card',
    () async {
      for (final change in [
        'removed',
        'role',
        'createdAt',
        'sourceRef',
        'revoked',
      ]) {
        final api = _Api();
        final guard = SharedConversationShareGuard(api, () {});
        final result = _result();
        await guard.recordArtifact('task', 'file', result);
        if (change == 'removed') api.missing = true;
        if (change == 'role') api.row['role'] = 'input';
        if (change == 'createdAt') api.row['createdAt'] = 'changed';
        if (change == 'sourceRef') api.row['sourceRef'] = 'other';
        if (change == 'revoked') api.revoked = true;
        await expectLater(
          guard.validateUploads(_files(result)),
          throwsA(isA<ApiFailure>()),
        );
      }
    },
  );
  test(
    'bundle revision, contents, permission and state are checked before send',
    () async {
      for (final change in ['revision', 'files', 'state', 'revoked']) {
        final api = _Api();
        final guard = SharedConversationShareGuard(api, () {});
        final result = _result(name: 'website.zip');
        await guard.recordDelivery('task', 'delivery', result);
        if (change == 'revision') api.delivery['revision'] = 'new';
        if (change == 'files') {
          (api.delivery['files'] as List).add({'path': 'new.js'});
        }
        if (change == 'state') api.state = 'pending';
        if (change == 'revoked') api.revoked = true;
        await expectLater(
          guard.validateUploads(_files(result)),
          throwsA(isA<ApiFailure>()),
        );
      }
    },
  );
  test(
    'account change and mutable nested metadata cannot bypass snapshot checks',
    () async {
      final api = _Api();
      var current = true;
      final guard = SharedConversationShareGuard(api, () {
        if (!current) throw const ApiFailure('账号已切换');
      });
      final result = _result();
      await guard.recordArtifact('task', 'file', result);
      (api.row['evidenceMeta'] as Map)['round'] = 2;
      await expectLater(
        guard.validateUploads(_files(result)),
        throwsA(isA<ApiFailure>()),
      );
      current = false;
      await expectLater(guard.validateUploads([]), throwsA(isA<ApiFailure>()));
    },
  );
  test(
    'bounded cache refuses new snapshots instead of forgetting old authorization',
    () async {
      final api = _Api();
      final guard = SharedConversationShareGuard(api, () {});
      for (var i = 0; i < SharedConversationShareGuard.maxFiles; i++) {
        final text = i.toString().padLeft(3, '0');
        await guard.recordArtifact('task', 'file', _result(text: text));
      }
      await expectLater(
        guard.recordArtifact('task', 'file', _result(text: 'new')),
        throwsA(isA<ApiFailure>()),
      );
      api.revoked = true;
      await expectLater(
        guard.validateUploads(_files(_result(text: '000'))),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'metadata property order does not falsely invalidate a share snapshot',
    () async {
      final api = _Api();
      final guard = SharedConversationShareGuard(api, () {});
      final result = _result(name: 'website.zip');
      await guard.recordDelivery('task', 'delivery', result);
      api.delivery = Map.fromEntries(api.delivery.entries.toList().reversed);
      await guard.validateUploads(_files(result));
    },
  );
  test(
    'team blocks failed snapshot validation and retries with the same id',
    () async {
      var checks = 0, sends = 0, allow = false;
      final team = SharedConversationTeam(
        check: () {},
        allowedTaskIds: {},
        loadMates: () async => {
          'mates': [
            {'id': 'mate', 'name': '同事', 'canReceive': true},
          ],
        },
        loadAttachments: (_) async => [],
        draftMessage: (_) async => {},
        validateUploads: (_) async {
          checks++;
          if (!allow) throw const ApiFailure('成果已变化');
        },
        sendMessage: (_, body) async {
          sends++;
          return {
            'ok': true,
            'messageId': body['messageId'],
            'status': 'accepted',
          };
        },
      );
      final request = <String, dynamic>{
        'recipientId': 'mate',
        'text': '测试快照',
        'messageId': '00000000-0000-4000-8000-000000000001',
        'conversationId': 'task',
        'files': _files(_result()),
      };
      await expectLater(team.send(request), throwsA(isA<ApiFailure>()));
      expect(sends, 0);
      allow = true;
      await team.send(request);
      await team.send(request);
      expect(checks, 2);
      expect(sends, 1);
    },
  );
}

class _Api extends SoduWorkApi {
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  bool revoked = false, missing = false;
  int artifactReads = 0, deliveryReads = 0;
  String state = 'synced';
  final row = <String, dynamic>{
    'id': 'file',
    'taskId': 'task',
    'filename': 'result.txt',
    'role': 'output',
    'size': 3,
    'createdAt': _at,
    'sourceRef': 'turn',
    'evidenceMeta': {'round': 1},
  };
  Map<String, dynamic> delivery = {
    'id': 'delivery',
    'filename': 'website.zip',
    'kind': 'bundle',
    'size': 3,
    'createdAt': _at,
    'revision': 'original',
    'files': [
      {'path': 'index.html', 'size': 3},
    ],
  };
  @override
  Future<List<Map<String, dynamic>>> taskAttachments(String taskId) async {
    artifactReads++;
    if (revoked) throw const ApiFailure('Revoked', status: 403);
    return missing ? [] : [row];
  }

  @override
  Future<Map<String, dynamic>> taskDelivery(String taskId) async {
    deliveryReads++;
    if (revoked) throw const ApiFailure('Revoked', status: 403);
    return {'state': state, 'delivery': delivery};
  }
}

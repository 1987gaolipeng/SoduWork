import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/shared_conversation_host.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/account_conversation.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'account_conversation_sync_test.dart' as data;
import 'personal_relay_sheet_test.dart' show RelayStore, reply;

class Fixture {
  final store = RelayStore();
  late MobileState state;
  bool online = true, loseReceipt = false;
  String phase = 'prepared';
  final posts = <Map<String, dynamic>>[];
  final ids = <String>[];
  final messages = [
    {...data.message('q', 0, 1, 'original question'), 'role': 'user'},
    data.message('a', 1, 2, 'original reply'),
  ];
  Future<void> init() async {
    state = MobileState(store: store);
    await state.init(connectNow: false);
    state.api.client.close();
    state.phase = MobilePhase.ready;
    state.enrollment = const EnrollmentState(
      active: true,
      deviceId: 'phone',
      deviceName: 'Phone',
      authState: 'active',
      ownerUserId: 'u1',
    );
    state.api = SoduWorkApi(
      store: store,
      endpoint: state.endpoint,
      client: MockClient((request) async {
        if (request.url.path.endsWith('/messages')) {
          final after = int.parse(request.url.queryParameters['after']!);
          return reply({
            ...data.page(
              messages.where((m) => (m['revision'] as int) > after).toList(),
              messages.last['revision'] as int,
            ),
            'conversation': data.row('conversation-1', 8),
          });
        }
        if (request.url.path.contains('/targets/')) {
          return reply({
            'available': online,
            'targetClientId': 'pc-test',
            'revision': 8,
            'reason': online ? '' : '电脑离线',
          });
        }
        final id = request.url.path.split('/').last;
        if (request.method == 'POST') {
          posts.add(jsonDecode(request.body) as Map<String, dynamic>);
          ids.add(id);
          if (loseReceipt) throw Exception('connection lost after admission');
        }
        if (!ids.contains(id)) return reply({'detail': 'missing'}, 404);
        return reply({
          'phase': phase,
          'conversationId': 'conversation-1',
          'requestId': id,
        });
      }),
    );
  }

  SharedConversationHost host() => SharedConversationHost(
    state: state,
    accountConversation: AccountConversation.fromJson(
      data.row('conversation-1', 8),
    ),
    onDraft: (_) {},
    onCreated: (_) => fail('must not create a new task'),
    onResource: (_) async {},
    onExternal: (_) async {},
  );
  Future<Map> poll(SharedConversationHost host) async =>
      await host.call('poll', {'taskId': 'conversation-1'}) as Map;
  Future<Object?> send(
    SharedConversationHost host, [
    String text = 'next turn',
  ]) => host.call('say', {
    'taskId': 'conversation-1',
    'text': text,
    'files': [],
    'skills': [],
  });
}

void main() {
  test(
    'personal chat remount returns its own latest draft without sending',
    () async {
      final fixture = Fixture();
      await fixture.init();
      addTearDown(fixture.state.dispose);
      final host = fixture.host();
      expect(
        (await host.call('ready', {}) as Map).containsKey('initialDraft'),
        false,
      );
      await host.call('draft', {'text': '1'});
      expect((await host.call('ready', {}) as Map)['initialDraft'], '1');
      fixture.online = false;
      await fixture.poll(host);
      fixture.online = true;
      await fixture.poll(host);
      expect((await host.call('ready', {}) as Map)['initialDraft'], '1');
      expect(
        (await fixture.host().call('ready', {}) as Map).containsKey(
          'initialDraft',
        ),
        false,
      );
      await host.call('draft', {'text': ''});
      expect((await host.call('ready', {}) as Map)['initialDraft'], '');
      expect(fixture.posts, isEmpty);
    },
  );

  test(
    'native requirement history resolves acceptance by source ID, not title',
    () async {
      final fixture = Fixture();
      await fixture.init();
      addTearDown(fixture.state.dispose);
      fixture.state.tasks = [
        WorkTask.fromJson({
          'id': 'requirement-1',
          'kind': 'requirement',
          'status': 'doing',
          'requirementStage': 'reviewing',
        }),
      ];
      final reads = <String>[];
      fixture.state.api.client.close();
      fixture.state.api = SoduWorkApi(
        store: fixture.store,
        endpoint: fixture.state.endpoint,
        client: MockClient((request) async {
          expect(request.method, 'GET');
          reads.add(request.url.path);
          return reply(
            request.url.path.endsWith('/acceptance-context')
                ? {
                    'approvalId': 'a',
                    'artifactVersionId': 'v',
                    'requirementVersion': 1,
                    'canDecide': true,
                  }
                : {
                    'id': 'requirement-1',
                    'kind': 'requirement',
                    'status': 'doing',
                    'requirementStage': 'reviewing',
                  },
          );
        }),
      );
      final host = SharedConversationHost(
        state: fixture.state,
        accountConversation: AccountConversation.fromJson({
          ...data.row('conversation-1', 8),
          'sourceSessionId': 'requirement-requirement-1',
        }),
        onDraft: (_) {},
        onCreated: (_) => fail('must not create'),
        onResource: (_) async {},
        onExternal: (_) async {},
      );
      final result =
          await host.call('acceptance', {
                'taskId': 'conversation-1',
                'action': 'load',
              })
              as Map;
      expect(result['available'], true);
      expect(reads, [
        '/api/v1/tasks/requirement-1',
        '/api/v1/tasks/requirement-1/acceptance-context',
      ]);
      await expectLater(
        host.call('acceptance', {'taskId': 'another', 'action': 'load'}),
        throwsA(isA<ApiFailure>()),
      );
      expect(reads.length, 2);
    },
  );
  late Fixture f;
  setUp(() async {
    f = Fixture();
    await f.init();
  });
  tearDown(() => f.state.dispose());

  test(
    'personal chat work-card protection stays local without relaxing chat scope',
    () async {
      bool? dirty;
      List<Map<String, dynamic>>? history;
      final host = SharedConversationHost(
        state: f.state,
        accountConversation: AccountConversation.fromJson(
          data.row('conversation-1', 8),
        ),
        onDraft: (_) {},
        onCreated: (_) => fail('must not create work'),
        onResource: (_) async {},
        onExternal: (_) async {},
        onWorkCardDraft: (value, busy) => dirty = value,
        onWorkCardHistory: (value) => history = value,
      );
      await host.call('workCardDraft', {'dirty': true, 'busy': false});
      await host.call('workCardHistory', {'entries': []});
      expect(dirty, true);
      expect(history, isEmpty);
      expect(f.posts, isEmpty);
      await expectLater(
        host.call('acceptance', {'taskId': 'another'}),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        host.call('say', {'taskId': 'another', 'text': 'hello'}),
        throwsA(isA<ApiFailure>()),
      );
    },
  );

  test(
    'shared main conversation reads and sends to the original PC without creating work',
    () async {
      final host = f.host();
      final ready = await host.call('ready', {}) as Map;
      expect(ready['personalConversation'], true);
      expect(ready['taskId'], 'conversation-1');
      final first = await f.poll(host);
      expect((first['items'] as List).map((m) => m['text']), [
        'original question',
        'original reply',
      ]);
      expect(first['canSend'], true);
      await f.send(host);
      expect(f.posts.single, {
        'conversationId': 'conversation-1',
        'targetClientId': 'pc-test',
        'expectedRevision': 8,
        'instruction': 'next turn',
      });
      expect((await f.poll(host))['canSend'], false);
      f.phase = 'accepted';
      expect((await f.poll(host))['canSend'], false);
      f.messages.addAll([
        {...data.message('q2', 2, 3, 'next turn'), 'role': 'user'},
        data.message('a2', 3, 4, 'new reply'),
      ]);
      final synced = await f.poll(host);
      expect(synced['canSend'], true);
      expect((synced['items'] as List).length, 4);
      expect(f.store.pending, isNull);
      expect(f.posts.length, 1);
    },
  );

  test(
    'lost response and remount recover the receipt without resubmitting',
    () async {
      f.loseReceipt = true;
      await expectLater(f.send(f.host()), throwsA(anything));
      expect(f.store.pending, isNotNull);
      final remounted = f.host();
      final page = await f.poll(remounted);
      expect(page['canSend'], false);
      expect(f.posts.length, 1);
      await expectLater(
        f.send(remounted, 'different request'),
        throwsA(isA<ApiFailure>()),
      );
      expect(f.posts.length, 1);
    },
  );

  test(
    'offline history remains readable and never falls back to cloud',
    () async {
      f.online = false;
      final host = f.host(), page = await f.poll(f.host());
      expect((page['items'] as List).length, 2);
      expect(page['canSend'], false);
      expect(page['readOnlyReason'], '电脑离线');
      await expectLater(f.send(host), throwsA(isA<ApiFailure>()));
      expect(f.posts, isEmpty);
    },
  );

  test(
    'account scope, other chat IDs and unsupported attachments are rejected',
    () async {
      final host = f.host();
      await expectLater(
        host.call('poll', {'taskId': 'another'}),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        host.call('say', {
          'taskId': 'conversation-1',
          'text': 'read',
          'files': [
            {'name': 'a.txt'},
          ],
        }),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        host.call('send', {'text': 'new task'}),
        throwsA(isA<ApiFailure>()),
      );
      f.state.phase = MobilePhase.connecting;
      await expectLater(f.poll(host), throwsA(isA<ApiFailure>()));
      expect(f.posts, isEmpty);
    },
  );

  test(
    'message edits and tombstones replace the projection rather than duplicating it',
    () async {
      final host = f.host();
      await f.poll(host);
      f.messages.add(data.message('a', 1, 3, 'edited reply'));
      final edited = await f.poll(host);
      expect((edited['items'] as List).map((m) => m['text']), [
        'original question',
        'edited reply',
      ]);
      f.messages.add(data.message('a', 1, 4, '', deleted: true));
      expect(((await f.poll(host))['items'] as List).length, 1);
    },
  );
}

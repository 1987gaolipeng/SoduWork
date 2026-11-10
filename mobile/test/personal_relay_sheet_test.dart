import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/account_conversation.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/screens/account_conversation_screen.dart';
import 'package:soduwork_mobile/ui/personal_relay_sheet.dart';
import 'account_conversation_screen_test.dart' as screen;
import 'account_conversation_sync_test.dart' as data;

class RelayStore extends screen.TestStore {
  String? pending;
  @override
  Future<String?> readPersonalRelay(
    String endpoint,
    String owner,
    String deviceId,
  ) async => pending;
  @override
  Future<void> writePersonalRelay(
    String endpoint,
    String owner,
    String deviceId,
    String? value,
  ) async {
    pending = value;
  }
}

http.Response reply(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Future<MobileState> mount(
  WidgetTester tester,
  RelayStore store,
  MockClient client,
) async {
  tester.view.physicalSize = const Size(900, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final state = MobileState(store: store);
  await state.init(connectNow: false);
  state.api.client.close();
  state.api = SoduWorkApi(
    store: store,
    endpoint: state.endpoint,
    client: client,
  );
  state.phase = MobilePhase.ready;
  state.enrollment = const EnrollmentState(
    active: true,
    deviceId: 'phone',
    deviceName: 'Phone',
    authState: 'active',
    ownerUserId: 'u1',
  );
  addTearDown(state.dispose);
  await tester.pumpWidget(
    screen.harness(
      state,
      Scaffold(
        body: PersonalRelaySheet(
          source: AccountConversation.fromJson(data.row('conversation-1', 8)),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return state;
}

const target = {
  'available': true,
  'targetClientId': 'pc',
  'name': 'My PC',
  'revision': 8,
};
Map<String, dynamic> pending([String cid = 'conversation-1']) => {
  'id': 'original-request',
  'body': {
    'conversationId': cid,
    'targetClientId': 'pc',
    'expectedRevision': 8,
    'instruction': 'original instruction',
  },
};

void main() {
  testWidgets(
    'the transcript button opens the native relay sheet in a nested workspace navigator',
    (tester) async {
      final state = await mount(
        tester,
        RelayStore(),
        MockClient((request) async {
          if (request.url.path.contains('/targets/')) return reply(target);
          return reply({
            ...data.page([data.message('reply', 0, 1, 'Original reply')], 1),
            'conversation': data.row('conversation-1', 8),
          });
        }),
      );
      await tester.pumpWidget(
        screen.harness(
          state,
          Navigator(
            onGenerateRoute: (_) => MaterialPageRoute<void>(
              builder: (_) => AccountConversationScreen(
                conversation: AccountConversation.fromJson(
                  data.row('conversation-1', 8),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('在本人 PC 原会话继续'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byType(PersonalRelaySheet), findsOneWidget);
      expect(find.widgetWithText(TextField, '接下来做什么'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
  testWidgets(
    'corrupt saved receipt stays preserved and cannot enable a new send',
    (tester) async {
      final store = RelayStore()..pending = '{"id":"old","body":123}';
      var calls = 0;
      await mount(
        tester,
        store,
        MockClient((_) async {
          calls++;
          return reply(target);
        }),
      );
      expect(find.textContaining('待核对接力记录损坏'), findsOneWidget);
      expect(tester.takeException(), isNull);
      expect(store.pending, '{"id":"old","body":123}');
      expect(calls, 0);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, '发送到本人 PC 原会话'),
            )
            .onPressed,
        isNull,
      );
    },
  );
  testWidgets(
    'native admission uses exact PC and immutable request, without creating a cloud task',
    (tester) async {
      final store = RelayStore();
      final posts = <http.Request>[];
      var exists = false;
      await mount(
        tester,
        store,
        MockClient((request) async {
          expect(request.headers['Authorization'], 'Device test-session');
          expect(
            request.url.path,
            startsWith('/api/v1/personal-conversation-relay/'),
          );
          if (request.url.path.contains('/targets/')) return reply(target);
          if (request.method == 'POST') {
            expect(store.pending, isNotNull);
            posts.add(request);
            exists = true;
          }
          return exists
              ? reply({'phase': 'accepted'})
              : reply({'detail': 'not found'}, 404);
        }),
      );
      await tester.enterText(
        find.byType(TextField),
        'continue in my original PC',
      );
      await tester.pump();
      await tester.tap(find.text('发送到本人 PC 原会话'));
      await tester.pumpAndSettle();
      expect(posts, hasLength(1));
      expect(jsonDecode(posts.single.body), {
        'conversationId': 'conversation-1',
        'targetClientId': 'pc',
        'expectedRevision': 8,
        'instruction': 'continue in my original PC',
      });
      expect(store.pending, isNull);
      expect(find.textContaining('本人 PC 已接收'), findsOneWidget);
    },
  );

  testWidgets(
    'lost response is reconciled after reopening without a second POST',
    (tester) async {
      final store = RelayStore();
      var sent = 0, exists = false;
      final state = await mount(
        tester,
        store,
        MockClient((request) async {
          if (request.url.path.contains('/targets/')) return reply(target);
          if (request.method == 'POST') {
            sent++;
            exists = true;
            throw http.ClientException('connection lost');
          }
          return exists
              ? reply({'phase': 'accepted'})
              : reply({'detail': 'not found'}, 404);
        }),
      );
      await tester.enterText(find.byType(TextField), 'once');
      await tester.pump();
      await tester.tap(find.text('发送到本人 PC 原会话'));
      await tester.pumpAndSettle();
      expect(store.pending, isNotNull);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(
        screen.harness(
          state,
          Scaffold(
            body: PersonalRelaySheet(
              source: AccountConversation.fromJson(
                data.row('conversation-1', 8),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(sent, 1);
      expect(store.pending, isNull);
      expect(find.textContaining('本人 PC 已接收'), findsOneWidget);
    },
  );

  testWidgets('offline source cannot send or silently fall back to cloud', (
    tester,
  ) async {
    var writes = 0;
    await mount(
      tester,
      RelayStore(),
      MockClient((request) async {
        if (request.method != 'GET') writes++;
        return reply({...target, 'available': false, 'reason': 'PC offline'});
      }),
    );
    await tester.enterText(find.byType(TextField), 'wait');
    final button = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, '发送到本人 PC 原会话'),
    );
    expect(button.onPressed, isNull);
    expect(find.text('PC offline'), findsOneWidget);
    expect(writes, 0);
  });

  testWidgets(
    'a pending request from another conversation cannot be resent here',
    (tester) async {
      final store = RelayStore()
        ..pending = jsonEncode(pending('other-conversation'));
      var writes = 0;
      await mount(
        tester,
        store,
        MockClient((request) async {
          if (request.method != 'GET') writes++;
          return reply({'detail': 'not found'}, 404);
        }),
      );
      expect(find.textContaining('另一条聊天还有接力待核对'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '核对原请求'))
            .onPressed,
        isNull,
      );
      expect(writes, 0);
    },
  );

  testWidgets(
    'uncertain receipt requires explicit PC inspection and never resends',
    (tester) async {
      final store = RelayStore()..pending = jsonEncode(pending());
      var resolved = false, writes = 0;
      await mount(
        tester,
        store,
        MockClient((request) async {
          if (request.method == 'POST') {
            expect(request.url.path, endsWith('/original-request/resolve'));
            expect(jsonDecode(request.body), {'checkedOnSourcePC': true});
            writes++;
            resolved = true;
          }
          return reply({'phase': resolved ? 'closed' : 'uncertain'});
        }),
      );
      final close = find.widgetWithText(TextButton, '关闭待核对回执（不重发、不停止执行）');
      expect(tester.widget<TextButton>(close).onPressed, isNull);
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pump();
      await tester.tap(close);
      await tester.pumpAndSettle();
      expect(writes, 1);
      expect(store.pending, isNull);
      expect(find.textContaining('回执已关闭'), findsOneWidget);
    },
  );

  testWidgets('logout disables an already open native composer', (
    tester,
  ) async {
    var writes = 0;
    final state = await mount(
      tester,
      RelayStore(),
      MockClient((request) async {
        if (request.method != 'GET') writes++;
        return reply(target);
      }),
    );
    await tester.enterText(find.byType(TextField), 'draft');
    state.phase = MobilePhase.pendingActivation;
    state.notifyListeners();
    await tester.pump();
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, '发送到本人 PC 原会话'),
          )
          .onPressed,
      isNull,
    );
    expect(writes, 0);
  });
}

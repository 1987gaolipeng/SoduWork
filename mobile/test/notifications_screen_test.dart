import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/notifications_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/state/team_message_inbox.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets(
    'message attachments use fresh recipient authorization and open the returned signed URL',
    (tester) async {
      final launched = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/url_launcher'),
        (call) async {
          if (call.method == 'launch') {
            launched.add((call.arguments as Map)['url'] as String);
          }
          return true;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/url_launcher'),
          null,
        ),
      );
      var requests = 0;
      final api = _AttachmentApi(
        MockClient((request) async {
          requests++;
          expect(request.url.path, '/api/v1/team/message-files/snapshot');
          return http.Response(
            jsonEncode({
              'id': 'snapshot',
              'url': '/api/v1/attachments/snapshot?ticket=fresh',
            }),
            200,
          );
        }),
      );
      addTearDown(api.client.close);
      await _showAttachment(tester, api);
      expect(find.text('附件内容请在电脑端查看。'), findsNothing);
      await tester.runAsync(() async {
        await tester.tap(find.text('报告.pdf'));
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pumpAndSettle();
      expect(requests, 1);
      expect(launched, [
        'https://hub.test/api/v1/attachments/snapshot?ticket=fresh',
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'attachment requests show loading, prevent duplicate taps and allow retry after denial',
    (tester) async {
      final response = Completer<http.Response>();
      var calls = 0;
      final api = _AttachmentApi(
        MockClient((request) async {
          calls++;
          return response.future;
        }),
      );
      addTearDown(api.client.close);
      await _showAttachment(tester, api);
      await tester.runAsync(() async {
        await tester.tap(find.text('报告.pdf'));
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pump();
      expect(find.text('正在打开…'), findsOneWidget);
      await tester.runAsync(() async {
        await tester.tap(find.text('报告.pdf'));
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pump();
      expect(calls, 1);
      await tester.runAsync(() async {
        response.complete(http.Response('', 404));
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pumpAndSettle();
      expect(find.text('正在打开…'), findsNothing);
      expect(find.textContaining('无法获取成果（404）'), findsOneWidget);
      await tester.runAsync(() async {
        await tester.tap(find.text('报告.pdf'));
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pumpAndSettle();
      expect(calls, 2);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'switching accounts while opening a message attachment suppresses the old URL',
    (tester) async {
      final response = Completer<http.Response>();
      var launches = 0;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/url_launcher'),
        (call) async {
          launches++;
          return true;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/url_launcher'),
          null,
        ),
      );
      final api = _AttachmentApi(
        MockClient((request) async => response.future),
      );
      addTearDown(api.client.close);
      final state = await _showAttachment(tester, api);
      await tester.runAsync(() async {
        await tester.tap(find.text('报告.pdf'));
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pump();
      state.switchIdentity();
      await tester.pump();
      await tester.runAsync(() async {
        response.complete(
          http.Response(
            jsonEncode({
              'id': 'snapshot',
              'url': '/api/v1/attachments/snapshot?ticket=old',
            }),
            200,
          ),
        );
        await Future<void>.delayed(Duration.zero);
      });
      await tester.pumpAndSettle();
      expect(launches, 0);
      expect(find.text('报告.pdf'), findsNothing);
      expect(find.text('消息已关闭，请返回后刷新。'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'notification and detail sheets close to the same draft without marking unseen messages read',
    (tester) async {
      var reads = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async => {
          'ok': true,
          'folder': folder,
          'nextCursor': '',
          'unreadCount': 1,
          'items': [
            {
              'id': 'sheet-message',
              'senderName': '同事乙',
              'text': '浮层消息验收',
              'status': 'accepted',
            },
          ],
        },
        read: (id) async {
          reads++;
          return {
            'ok': true,
            'messageId': id,
            'status': 'read',
            'readAt': 1800000001000,
          };
        },
      );
      final state = _InboxState(inbox),
          draft = TextEditingController(text: '保持会话草稿');
      addTearDown(state.dispose);
      addTearDown(draft.dispose);
      await inbox.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: MobileScope(
            state: state,
            child: Builder(
              builder: (context) => Scaffold(
                body: Column(
                  children: [
                    TextField(controller: draft),
                    TextButton(
                      onPressed: () => NotificationsScreen.show(context),
                      child: const Text('open notifications'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open notifications'));
      await tester.pumpAndSettle();
      expect(find.byType(BackButton), findsNothing);
      expect(reads, 0);
      await tester.tap(find.text('浮层消息验收'));
      await tester.pumpAndSettle();
      expect(reads, 1);
      expect(find.text('已读，电脑端将同步此状态'), findsOneWidget);
      expect(find.byType(BackButton), findsNothing);
      expect(find.byType(BottomSheet), findsOneWidget);
      await tester.tap(find.byTooltip('返回'));
      await tester.pumpAndSettle();
      expect(find.byType(NotificationsScreen), findsOneWidget);
      await tester.tap(find.byTooltip('关闭').last);
      await tester.pumpAndSettle();
      expect(find.byType(NotificationsScreen), findsNothing);
      expect(draft.text, '保持会话草稿');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'an open message sheet clears private content on account change',
    (tester) async {
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async => {
          'ok': true,
          'nextCursor': '',
          'items': [
            {'id': 'private-message', 'senderName': '之前的同事', 'text': '旧账号私人消息'},
          ],
        },
        read: (id) async => {
          'ok': true,
          'messageId': id,
          'status': 'read',
          'readAt': 1800000001000,
        },
      );
      final state = _InboxState(inbox);
      addTearDown(state.dispose);
      await inbox.refresh();
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: const NotificationsScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('旧账号私人消息'));
      await tester.pumpAndSettle();
      state.switchIdentity();
      await tester.pumpAndSettle();
      expect(find.text('旧账号私人消息'), findsNothing);
      expect(find.text('消息已关闭，请返回后刷新。'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'inbox waits for a deliberate view and shows confirmed read state',
    (tester) async {
      var reads = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async => {
          'ok': true,
          'folder': folder,
          'nextCursor': '',
          'unreadCount': 1,
          'items': [
            if (folder == 'received')
              {
                'id': 'server-id',
                'messageId': 'local-id',
                'senderName': '同事甲',
                'text': '请核对发布清单',
                'createdAt': 1800000000000,
                'status': 'accepted',
              },
          ],
        },
        read: (id) async {
          reads++;
          expect(id, 'server-id');
          return {
            'ok': true,
            'messageId': id,
            'status': 'read',
            'readAt': 1800000001000,
          };
        },
      );
      final state = _InboxState(inbox);
      addTearDown(state.dispose);
      await inbox.refresh();
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: const NotificationsScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(reads, 0);
      expect(find.text('1 条未读 · 与电脑同步'), findsOneWidget);
      await tester.tap(find.text('请核对发布清单'));
      await tester.pumpAndSettle();
      expect(reads, 1);
      expect(find.text('已读，电脑端将同步此状态'), findsOneWidget);
      expect(inbox.unreadCount, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('missing server count with more pages never claims a total', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final inbox = TeamMessageInbox(
      load: ({required folder, required before}) async => {
        'ok': true,
        'nextCursor': 'server-id',
        'items': [
          {
            'id': 'server-id',
            'senderName': '很长的同事姓名和团队成员名称' * 5,
            'text': '未读消息',
            'createdAt': 1800000000000,
          },
        ],
      },
      read: (_) async => throw const ApiFailure('网络中断'),
    );
    final state = _InboxState(inbox);
    addTearDown(state.dispose);
    await inbox.refresh();
    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(
          theme: SoduWorkTheme.light(),
          home: const NotificationsScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('与电脑同步你的私有收件箱'), findsOneWidget);
    expect(find.text('加载更早消息'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('未读消息'));
    await tester.pumpAndSettle();
    expect(find.text('网络中断'), findsOneWidget);
    expect(find.text('已读状态尚未确认'), findsOneWidget);
    expect(inbox.received.find('server-id')!.isUnread, isTrue);
  });
}

class _InboxState extends MobileState {
  final TeamMessageInbox _inbox;
  int revision = 0;
  @override
  int get identityRevision => revision;
  void switchIdentity() {
    revision++;
    _inbox.clear();
    notifyListeners();
  }

  _InboxState(this._inbox) {
    phase = MobilePhase.ready;
    _inbox.addListener(notifyListeners);
  }
  @override
  TeamMessageInbox get teamMessages => _inbox;
  @override
  Future<void> loadTeamMessages() async {}
}

Future<_InboxState> _showAttachment(WidgetTester tester, SoduWorkApi api) async {
  final inbox = TeamMessageInbox(
    load: ({required folder, required before}) async => {
      'ok': true,
      'nextCursor': '',
      'items': [
        {
          'id': 'file-message',
          'senderName': '同事',
          'text': '附件消息',
          'attachments': [
            {
              'id': 'snapshot',
              'name': '报告.pdf',
              'url': 'https://untrusted.test/never-open',
            },
          ],
        },
      ],
    },
    read: (id) async => {
      'ok': true,
      'messageId': id,
      'status': 'read',
      'readAt': 1800000001000,
    },
  );
  final state = _InboxState(inbox)..api = api;
  addTearDown(state.dispose);
  await inbox.refresh();
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(),
        home: const NotificationsScreen(),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('附件消息'));
  await tester.pumpAndSettle();
  return state;
}

class _AttachmentApi extends SoduWorkApi {
  _AttachmentApi(http.Client client)
    : super(
        store: DeviceStore(),
        client: client,
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://hub.test',
        ),
      );
  @override
  Future<Map<String, String>> authorizationHeaders() async => {
    'Authorization': 'Device fixture',
  };
}

import 'package:soduwork_mobile/core/conversation_projects.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/conversation_drawer.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  testWidgets(
    'task projections share the canonical execution row without merging namesakes',
    (tester) async {
      tester.view.physicalSize = const Size(393, 1400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final state = MobileState();
      state.api = _ProjectsApi(state);
      addTearDown(state.dispose);
      state.enrollment = const EnrollmentState(
        active: true,
        deviceId: 'phone',
        deviceName: 'Phone',
        authState: 'active',
        ownerUserId: 'alice',
      );
      state.tasks = [
        WorkTask.fromJson({
          'id': 'requirement',
          'title': '交付验收',
          'origin': 'local',
          'createdBy': 'alice',
          'hasExecutionHistory': true,
          'canViewExecution': true,
          'workRouting': {
            'executionContext': {
              'runner': {'clientId': 'pc'},
            },
          },
        }),
      ];
      await state.accountConversations.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async => {
          'items': [
            {
              'id': 'projection',
              'sourceSessionId': 'native-task',
              'taskProjectionId': 'requirement',
              'title': '投影',
              'messageCount': 0,
              'state': 'idle',
              'revision': 1,
            },
            {
              'id': 'empty',
              'sourceSessionId': 'native-empty',
              'title': '空占位',
              'messageCount': 0,
              'state': 'idle',
              'revision': 2,
            },
            {
              'id': 'namesake',
              'sourceSessionId': 'native-chat',
              'title': '交付验收',
              'messageCount': 2,
              'revision': 3,
            },
            {'id': 'unknown', 'title': '旧版本记录', 'state': 'idle', 'revision': 4},
            {
              'id': 'running',
              'title': '仍在生成',
              'messageCount': 0,
              'state': 'responding',
              'revision': 5,
            },
          ],
          'cursor': 5,
          'hasMore': false,
        },
      );
      final store = ConversationProjects(state.endpoint.baseUrl, 'alice');
      await store.save('交付项目');
      await store.assign((await store.read()).single.id, [
        'account:projection',
      ]);
      String opened = '';
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: Scaffold(
            body: ConversationDrawer(
              state: state,
              dark: false,
              onNew: () {},
              onTheme: () {},
              onDestination: (_) {},
              onEntry: (entry) => opened = entry.task.id,
              onAccountEntry: (entry) => opened = entry.id,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('投影'), findsNothing);
      expect(find.text('空占位'), findsNothing);
      expect(find.text('交付验收'), findsNWidgets(2));
      expect(find.text('旧版本记录'), findsOneWidget);
      expect(find.text('仍在生成'), findsOneWidget);
      await tester.tap(find.text('交付验收').first);
      expect(opened, 'requirement');
      await tester.tap(find.text('交付验收').last);
      expect(opened, 'namesake');
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'projects expand exact conversations without duplicate recent rows and update live',
    (tester) async {
      tester.view.physicalSize = const Size(320, 1100);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final state = MobileState();
      state.api = _ProjectsApi(state);
      addTearDown(state.dispose);
      state.enrollment = const EnrollmentState(
        active: true,
        deviceId: 'phone',
        deviceName: 'Phone',
        authState: 'active',
        ownerUserId: 'alice',
      );
      state.tasks = [
        WorkTask.fromJson({
          'id': 'one',
          'title': '项目里的对话',
          'origin': 'cloud-conversation',
          'createdBy': 'alice',
          'createdAt': 100,
        }),
      ];
      final store = ConversationProjects(state.endpoint.baseUrl, 'alice');
      await store.save('项目一');
      final project = (await store.read()).single;
      await store.assign(project.id, ['account:mirror']);
      await state.accountConversations.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async => {
          'items': [
            {
              'id': 'mirror',
              'sourceSessionId': 'cloud-task:one',
              'title': '重复投影',
              'revision': 1,
            },
          ],
          'cursor': 1,
          'hasMore': false,
        },
      );
      String opened = '';
      Widget drawer() => MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: ConversationDrawer(
            state: state,
            dark: false,
            onNew: () {},
            onTheme: () {},
            onDestination: (_) {},
            onResource: (_) {},
            onEntry: (entry) => opened = entry.task.id,
            workCards: const [
              {
                'id': 'receipt',
                'title': '保存的需求',
                'saved': true,
                'updatedAt': 200,
              },
            ],
          ),
        ),
      );
      await tester.pumpWidget(drawer());
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('项目一'));
      expect(find.text('项目里的对话'), findsOneWidget);
      expect(find.text('重复投影'), findsNothing);
      expect(find.text('本机工作记录'), findsNothing);
      await tester.tap(find.text('项目里的对话'));
      expect(opened, 'one');
      await tester.tap(find.text('项目一'));
      await tester.pumpAndSettle();
      expect(find.text('项目里的对话'), findsNothing);
      await tester.tap(find.text('项目一'));
      await tester.pumpAndSettle();
      expect(find.text('项目里的对话'), findsOneWidget);
      await store.assign(project.id, []);
      await tester.pumpAndSettle();
      expect(find.text('保存的需求'), findsNothing);
      await tester.ensureVisible(find.text('项目里的对话'));
      expect(find.text('项目里的对话'), findsOneWidget);
      expect(tester.takeException(), isNull);
      state.enrollment = const EnrollmentState(
        active: true,
        deviceId: 'other',
        deviceName: 'Other',
        authState: 'active',
        ownerUserId: 'bob',
      );
      state.tasks = [];
      await tester.pumpWidget(drawer());
      await tester.pumpAndSettle();
      expect(find.text('项目一'), findsNothing);
    },
  );

  testWidgets(
    'history keeps distinct namesakes and opens the live cloud entry',
    (tester) async {
      tester.view.physicalSize = const Size(393, 852);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final state = MobileState();
      state.api = _ProjectsApi(state);
      addTearDown(state.dispose);
      state.enrollment = EnrollmentState(
        active: true,
        deviceId: 'phone',
        deviceName: 'Phone',
        authState: 'active',
        ownerUserId: 'alice',
      );
      state.tasks = [
        WorkTask.fromJson({
          'id': 'one',
          'title': '验收会话。完整指令',
          'origin': 'cloud-conversation',
          'createdBy': 'alice',
          'workRouting': {
            'cloudConversation': {'sessionId': 'cloud-pc-one'},
          },
        }),
      ];
      await state.accountConversations.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async => {
          'items': [
            {
              'id': 'mirror',
              'sourceSessionId': 'cloud-task:one',
              'title': '重复投影',
              'revision': 1,
            },
            {
              'id': 'other',
              'sourceSessionId': 'another-session',
              'title': '验收会话。完整指令',
              'sourceDeviceName': '测试电脑',
              'revision': 2,
            },
            {
              'id': 'pc-mirror',
              'sourceSessionId': 'cloud-pc-one',
              'title': 'PC mirror',
              'revision': 3,
            },
          ],
          'cursor': 3,
          'hasMore': false,
        },
      );
      String opened = '';
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: Scaffold(
            body: ConversationDrawer(
              state: state,
              dark: false,
              onNew: () {},
              onDestination: (_) {},
              onTheme: () {},
              onEntry: (entry) => opened = entry.task.id,
              onAccountEntry: (entry) => opened = entry.id,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('重复投影'), findsNothing);
      expect(find.text('PC mirror'), findsNothing);
      expect(find.text('验收会话'), findsNWidgets(2));
      await tester.tap(find.text('验收会话').first);
      expect(opened, 'one');
      await tester.tap(find.text('验收会话').last);
      expect(opened, 'other');
      expect(find.text('测试电脑'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'personal sidebar never uses visible team tasks as chat history and changes with account',
    (tester) async {
      final state = MobileState();
      state.api = _ProjectsApi(state);
      addTearDown(state.dispose);
      state.tasks = [
        WorkTask.fromJson({
          'id': 'alice-chat',
          'title': 'Alice个人工作会话',
          'origin': 'cloud-conversation',
          'createdBy': 'alice',
          'ownerClientId': 'alice-pc',
        }),
        WorkTask.fromJson({
          'id': 'bob-chat',
          'title': 'Bob私有工作会话',
          'origin': 'cloud-conversation',
          'createdBy': 'bob',
          'ownerClientId': 'bob-pc',
        }),
        WorkTask.fromJson({
          'id': 'public',
          'title': '组织公开的工作需求',
          'origin': 'team-inbox',
          'createdBy': 'alice',
        }),
        WorkTask.fromJson({
          'id': 'unknown',
          'title': '无归属的旧会话',
          'origin': 'cloud-conversation',
        }),
      ];
      Future<void> show(String owner) async {
        state.enrollment = EnrollmentState(
          active: true,
          deviceId: 'phone',
          deviceName: 'Phone',
          authState: 'active',
          ownerUserId: owner,
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: SoduWorkTheme.light(),
            home: Scaffold(
              body: ConversationDrawer(
                state: state,
                dark: false,
                onNew: () {},
                onDestination: (_) {},
                onEntry: (_) {},
                onTheme: () {},
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await show('alice');
      expect(find.text('Alice个人工作会话'), findsOneWidget);
      expect(find.text('Bob私有工作会话'), findsNothing);
      expect(find.text('组织公开的工作需求'), findsNothing);
      expect(find.text('无归属的旧会话'), findsNothing);
      await show('bob');
      expect(find.text('Alice个人工作会话'), findsNothing);
      expect(find.text('Bob私有工作会话'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

class _ProjectsApi extends SoduWorkApi {
  final MobileState state;
  _ProjectsApi(this.state)
    : super(store: DeviceStore(), endpoint: state.endpoint);
  @override
  Future<Map<String, dynamic>> conversationProjects() async => {
    'items': [
      for (final row in await ConversationProjects(
        state.endpoint.baseUrl,
        state.enrollment?.ownerUserId ?? '',
      ).read())
        {...row.toJson(), 'revision': 1},
    ],
  };
}

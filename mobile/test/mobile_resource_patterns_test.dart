import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/conversation_projects.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/app_shell.dart';
import 'package:soduwork_mobile/screens/memories_screen.dart';
import 'package:soduwork_mobile/screens/projects_screen.dart';
import 'package:soduwork_mobile/screens/settings_sheet.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/conversation_drawer.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/workspace_resource_pane.dart';
import 'memory_device_auth.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  test(
    'projects serialize updates, isolate hub and owner, and assign one group per conversation',
    () async {
      final a = ConversationProjects('https://a.invalid', 'alice');
      final second = ConversationProjects('https://a.invalid', 'alice');
      await Future.wait([a.save('设计'), second.save('发布')]);
      final rows = await a.read();
      expect(rows.length, 2);
      await a.assign(rows[0].id, ['account:one', 'account:two']);
      await second.assign(rows[1].id, ['account:one']);
      expect((await a.read())[0].chatIds, ['account:two']);
      expect((await a.read())[1].chatIds, ['account:one']);
      expect(
        await ConversationProjects('https://a.invalid', 'bob').read(),
        isEmpty,
      );
      expect(
        await ConversationProjects('https://b.invalid', 'alice').read(),
        isEmpty,
      );
      await expectLater(a.save('设计'), throwsFormatException);
      await a.remove(rows[1].id);
      expect((await a.read()).single.name, '设计');
    },
  );
  test('damaged project metadata is not overwritten by a new save', () async {
    final store = ConversationProjects('https://a.invalid', 'alice');
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(store.storageKey, 'broken fixture');
    await expectLater(store.save('新项目'), throwsFormatException);
    expect(prefs.getString(store.storageKey), 'broken fixture');
  });
  testWidgets('projects can create and persist from the mobile sheet', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _harness(
        state,
        ProjectsScreen(preview: true, onAccount: (_) {}, onEntry: (_) {}),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('新建项目'), findsOneWidget);
    await tester.tap(find.text('新建项目'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '移动端项目');
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
    expect(find.text('移动端项目'), findsOneWidget);
    expect(
      (await ConversationProjects(
        'http://fixture.test',
        'offline-preview',
      ).read()).single.name,
      '移动端项目',
    );
  });
  testWidgets(
    'more expands inside drawer and recent heading has readable type',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      String? resource;
      await tester.pumpWidget(
        _harness(
          state,
          Scaffold(
            body: ConversationDrawer(
              state: state,
              dark: false,
              preview: true,
              onNew: () {},
              onDestination: (_) {},
              onEntry: (_) {},
              onTheme: () {},
              onResource: (value) => resource = value,
            ),
          ),
        ),
      );
      await tester.scrollUntilVisible(
        find.text('最近会话'),
        180,
        scrollable: find
            .descendant(
              of: find.byType(ConversationDrawer),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(
        tester.widget<Text>(find.text('最近会话')).style!.fontSize,
        greaterThanOrEqualTo(15),
      );
      await tester.scrollUntilVisible(
        find.text('更多'),
        -180,
        scrollable: find
            .descendant(
              of: find.byType(ConversationDrawer),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(find.text('简报'), findsNothing);
      await tester.tap(find.text('更多'));
      await tester.pumpAndSettle();
      expect(find.text('简报'), findsNothing);
      expect(find.text('云端环境'), findsOneWidget);
      expect(find.byType(Dialog), findsNothing);
      expect(resource, isNull);
      await tester.scrollUntilVisible(
        find.text('云端环境'),
        180,
        scrollable: find
            .descendant(
              of: find.byType(ConversationDrawer),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.ensureVisible(find.text('云端环境'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('云端环境'));
      expect(resource, 'cloud');
      expect(find.text('管理记忆'), findsNothing);
      expect(find.text('远程'), findsNothing);
    },
  );
  testWidgets(
    'sidebar destination fills main surface while settings opens same resource as sheet',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final state = _State();
      addTearDown(state.dispose);
      await tester.pumpWidget(_harness(state, const AppShell(preview: true)));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('打开侧栏'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('自动化'));
      await tester.pumpAndSettle();
      expect(find.byType(WorkspaceResourcePane), findsOneWidget);
      expect(find.byType(Dialog), findsNothing);
      expect(find.byTooltip('打开侧栏'), findsOneWidget);
      await tester.tap(find.byTooltip('打开侧栏'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('设置'));
      await tester.pumpAndSettle();
      expect(find.text('管理记忆'), findsNothing);
      expect(find.text('远程'), findsNothing);
      final remote = find.descendant(
        of: find.byType(SettingsSheet),
        matching: find.text('自动化'),
      );
      await tester.scrollUntilVisible(
        remote,
        200,
        scrollable: find
            .descendant(
              of: find.byType(SettingsSheet),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.tap(remote);
      await tester.pumpAndSettle();
      // Settings subpages share one modal surface and retain the parent page.
      expect(find.byType(WorkspaceResourcePane), findsNWidgets(2));
      expect(find.byType(BottomSheet), findsOneWidget);
      await tester.tap(find.byTooltip('返回'));
      await tester.pumpAndSettle();
      expect(find.byType(SettingsSheet), findsOneWidget);
    },
  );
  testWidgets(
    'memory detail saves all fields and original revision, with conflict remaining editable',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      await tester.pumpWidget(_harness(state, const MemoriesScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('虚构记忆'));
      await tester.pumpAndSettle();
      final summary = find.byWidgetPredicate(
        (w) => w is TextField && w.decoration?.labelText == '记忆内容',
      );
      await tester.enterText(summary, '已核对的新摘要');
      final save = find.text('确认并保存');
      await tester.scrollUntilVisible(
        save,
        200,
        scrollable: find
            .descendant(
              of: find.byType(BottomSheet),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      state.fake.conflict = true;
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(state.fake.saved?['revision'], 4);
      expect(state.fake.saved?['confirmed'], true);
      expect(state.fake.saved?['fields'], {
        'summary': '已核对的新摘要',
        'decisions': '必须保留的决策',
      });
      expect(find.textContaining('记忆已在其他设备更新'), findsOneWidget);
      expect(find.byType(TextField), findsWidgets);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('late memory list and open detail clear on account switch', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    final wait = Completer<Map<String, dynamic>>();
    state.fake.pending = wait.future;
    await tester.pumpWidget(_harness(state, const MemoriesScreen()));
    await tester.pump();
    state.change();
    state.fake.pending = null;
    state.notifyListeners();
    await tester.pump();
    wait.complete({
      'items': [
        {'id': 'old', 'title': '旧账号私人记录'},
      ],
    });
    await tester.pumpAndSettle();
    expect(find.text('旧账号私人记录'), findsNothing);
    await tester.tap(find.text('虚构记忆'));
    await tester.pumpAndSettle();
    expect(find.text('必须保留的决策'), findsOneWidget);
    state.change();
    await tester.pumpAndSettle();
    expect(find.text('必须保留的决策'), findsNothing);
    expect(find.text('账号已切换，请关闭后重新打开记忆。'), findsOneWidget);
  });
  test(
    'memory API carries revision, query encoding, and explicit archive/delete methods',
    () async {
      final requests = <http.Request>[];
      final api = SoduWorkApi(
        store: _Store(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
        client: MockClient((r) async {
          requests.add(r);
          return http.Response('{}', 200);
        }),
      );
      addTearDown(api.client.close);
      await api.memoryRecords(
        scope: 'project',
        search: '预算 & 人员',
        archived: true,
        offset: 50,
      );
      await api.saveMemoryRecord('memory-one', {
        'title': 'fixture',
        'revision': 7,
        'confirmed': true,
        'fields': {'summary': 'fixture'},
      });
      await api.memoryRecordAction('memory-one', 'archive');
      await api.memoryRecordAction('memory-one', 'delete');
      expect(requests[0].url.queryParameters, {
        'scope': 'project',
        'search': '预算 & 人员',
        'archived': 'true',
        'offset': '50',
      });
      expect(requests[1].method, 'PUT');
      expect(jsonDecode(requests[1].body)['revision'], 7);
      expect(requests[2].url.path, '/api/v1/memories/memory-one/archive');
      expect(requests[2].method, 'POST');
      expect(requests[3].method, 'DELETE');
      await expectLater(
        api.memoryRecordAction('memory-one', 'other'),
        throwsA(isA<ApiFailure>()),
      );
      expect(requests.length, 4);
    },
  );
}

Widget _harness(MobileState state, Widget child) => MaterialApp(
  theme: SoduWorkTheme.light(),
  home: MobileScope(
    state: state,
    child: Scaffold(body: child),
  ),
);

class _State extends MobileState {
  final fake = _Api();
  int revision = 1;
  _State() {
    api = fake;
    endpoint = fake.endpoint;
    phase = MobilePhase.ready;
    enrollment = const EnrollmentState(
      active: true,
      deviceId: 'phone',
      deviceName: 'fixture',
      authState: 'active',
      ownerUserId: 'alice',
    );
  }
  @override
  int get identityRevision => revision;
  void change() {
    revision++;
    notifyListeners();
  }
}

class _Api extends SoduWorkApi {
  Future<Map<String, dynamic>>? pending;
  Map<String, dynamic>? saved;
  bool conflict = false;
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  @override
  Future<Map<String, dynamic>> memoryRecords({
    String scope = '',
    String search = '',
    bool archived = false,
    int offset = 0,
  }) async => pending != null
      ? await pending!
      : {
          'items': [
            {
              'id': 'memory-one',
              'title': '虚构记忆',
              'scope': 'session',
              'summary': '原摘要',
            },
          ],
        };
  @override
  Future<Map<String, dynamic>> memoryRecord(String id) async => {
    'item': {
      'id': id,
      'title': '虚构记忆',
      'scope': 'session',
      'key': 'opaque-key',
      'revision': 4,
      'fields': {'summary': '原摘要', 'decisions': '必须保留的决策'},
    },
  };
  @override
  Future<Map<String, dynamic>> saveMemoryRecord(
    String? id,
    Map<String, dynamic> body,
  ) async {
    saved = body;
    if (conflict) throw const ApiFailure('conflict', status: 409);
    return {'ok': true};
  }
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
}

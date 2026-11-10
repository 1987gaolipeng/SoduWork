import 'package:flutter/material.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/models/conversation_models.dart';
import 'package:soduwork_mobile/screens/app_shell.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/workspace_resource_pane.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/core/workspace_location_store.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  testWidgets(
    'shell restores the section after reload and home navigation replaces it',
    (tester) async {
      final state = _State();
      final store = WorkspaceLocationStore(state.endpoint.baseUrl, 'alice');
      addTearDown(state.dispose);
      await store.save('resource:projects');
      Widget app() => MaterialApp(
        home: MobileScope(state: state, child: const AppShell()),
      );
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<WorkspaceResourcePane>(find.byType(WorkspaceResourcePane))
            .resource,
        'projects',
      );
      await tester.tap(find.byTooltip('打开侧栏'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('主页'));
      await tester.pumpAndSettle();
      expect(await store.read(), 'tab:0');
      expect(find.byType(WorkspaceResourcePane), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await store.save('tab:3');
      await tester.pumpWidget(app());
      await tester.pumpAndSettle();
      expect(state.tabIndex, 3);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    },
  );

  test(
    'workspace location survives reload and ordered navigation without leaking across accounts or hubs',
    () async {
      final store = WorkspaceLocationStore('https://a.invalid', 'alice');
      await Future.wait([store.save('tab:0'), store.save('tab:3')]);
      expect(
        await WorkspaceLocationStore('https://a.invalid', 'alice').read(),
        'tab:3',
      );
      expect(
        await WorkspaceLocationStore('https://a.invalid', 'bob').read(),
        isNull,
      );
      expect(
        await WorkspaceLocationStore('https://b.invalid', 'alice').read(),
        isNull,
      );
      await store.save('resource:projects');
      expect(await store.read(), 'resource:projects');
      final anonymous = WorkspaceLocationStore('https://a.invalid', '');
      await anonymous.save('tab:3');
      expect(await anonymous.read(), isNull);
    },
  );
}

class _State extends MobileState {
  _State() {
    api = _ProjectsApi(endpoint);
    phase = MobilePhase.ready;
    enrollment = const EnrollmentState(
      active: true,
      deviceId: 'phone',
      deviceName: 'Phone',
      authState: 'active',
      ownerUserId: 'alice',
    );
  }
  @override
  Future<void> refreshAll() async {}
  @override
  Future<void> loadTeamMessages() async {}
  @override
  Future<void> loadAccountConversations() async {}
  @override
  Future<List<CloudConversation>> loadConversations() async => [];
}

class _ProjectsApi extends SoduWorkApi {
  _ProjectsApi(EndpointSettings endpoint)
    : super(store: DeviceStore(), endpoint: endpoint);
  @override
  Future<Map<String, dynamic>> conversationProjects() async => {'items': []};
}

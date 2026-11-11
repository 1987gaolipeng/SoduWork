import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/core/work_submission_store.dart';
import 'package:soduwork_mobile/screens/work_submission_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
    await SharedPreferences.getInstance();
  });
  Future<void> show(
    WidgetTester tester,
    _State state, {
    bool auto = true,
    String kind = 'workflow',
  }) async {
    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(
          theme: SoduWorkTheme.light(),
          home: WorkSubmissionScreen(
            identity: 1,
            scope: 'unit:owner:device',
            autoSubmit: auto,
            submission: WorkSubmission(
              id: 'request-one',
              kind: kind,
              label: '私有能力名称',
              payload: kind == 'workflow'
                  ? {
                      'bindingId': 'binding-one',
                      'inputs': {},
                      'instruction': '核对项目材料',
                    }
                  : {'recipientId': 'recipient', 'text': '一条工作留言'},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
    'restored work checks original request without starting another execution',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      await show(tester, state, auto: false);
      expect(state.work.posts, 0);
      expect(state.work.gets, 0);
      await tester.tap(find.text('核对执行结果'));
      await tester.pumpAndSettle();
      expect(state.work.posts, 0);
      expect(state.work.gets, 1);
      expect(find.text('整理材料'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'work polling survives one network failure and hides prior identity',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      await show(tester, state);
      expect(state.work.posts, 1);
      expect(find.text('整理材料'), findsOneWidget);
      state.work.failNext = true;
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(find.text('隔离网络中断'), findsOneWidget);
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      expect(state.work.gets, 2);
      expect(find.text('隔离网络中断'), findsNothing);
      state.switchIdentity();
      await tester.pumpAndSettle();
      expect(find.text('私有能力名称'), findsNothing);
      expect(find.text('核对项目材料'), findsNothing);
      expect(find.text('账号已变化，工作内容已隐藏。'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'mismatched sent receipt preserves teammate outbox and exact original id',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      final store = WorkSubmissionStore();
      final submission = WorkSubmission(
        id: 'request-one',
        kind: 'teammate',
        label: '私有能力名称',
        payload: {'recipientId': 'recipient', 'text': '一条工作留言'},
      );
      await store.save('unit:owner:device', submission);
      await show(tester, state, kind: 'teammate');
      expect(state.work.messageIds, ['request-one']);
      expect((await store.load('unit:owner:device'))!.id, 'request-one');
      expect(find.textContaining('发件记录尚未核对'), findsOneWidget);
      state.work.matchMessage = true;
      await tester.tap(find.text('核对同一次留言'));
      await tester.pumpAndSettle();
      expect(state.work.messageIds, ['request-one', 'request-one']);
      expect(await store.load('unit:owner:device'), isNull);
      expect(find.text('留言已保存，等待对方接收。'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

class _Api extends SoduWorkApi {
  int posts = 0, gets = 0;
  bool failNext = false, matchMessage = false;
  final messageIds = <String>[];
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://unit.test',
        ),
      );
  Map<String, dynamic> receipt() => {
    'ok': true,
    'requestId': 'request-one',
    'phase': 'started',
    'taskId': 'task-one',
    'runId': 'run-one',
    'run': {
      'state': 'running',
      'nodes': [
        {'name': '整理材料', 'state': 'running'},
      ],
    },
  };
  @override
  Future<Map<String, dynamic>> submitMobileWork(
    String id,
    Map<String, dynamic> body,
  ) async {
    posts++;
    expect(id, 'request-one');
    return receipt();
  }

  @override
  Future<Map<String, dynamic>> mobileWorkStatus(String id) async {
    gets++;
    expect(id, 'request-one');
    if (failNext) {
      failNext = false;
      throw const ApiFailure('隔离网络中断', isNetwork: true);
    }
    return receipt();
  }

  @override
  Future<Map<String, dynamic>> sendMateMessage(
    String id,
    String text,
    String messageId,
  ) async {
    messageIds.add(messageId);
    return {'ok': true, 'messageId': 'server-id', 'status': 'accepted'};
  }

  @override
  Future<Map<String, dynamic>> teamMessages({
    String folder = 'received',
    String before = '',
    int limit = 100,
  }) async => {
    'items': [
      {
        'id': 'server-id',
        'messageId': matchMessage ? 'request-one' : 'different-request',
        'recipientId': 'recipient',
        'text': '一条工作留言',
        'status': 'accepted',
      },
    ],
  };
}

class _State extends MobileState {
  final work = _Api();
  int revision = 1;
  _State() {
    api = work;
    phase = MobilePhase.ready;
  }
  @override
  int get identityRevision => revision;
  void switchIdentity() {
    revision++;
    notifyListeners();
  }

  @override
  Future<void> refreshAll() async {}
  @override
  Future<void> loadTeamMessages({bool more = false}) async {}
}

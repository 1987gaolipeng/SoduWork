import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/conversation_handoff_sheet.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/task_forms.dart';

void main() {
  testWidgets('oversized seeded title must be corrected before creation', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    final title = List.filled(201, '题').join();
    await _open(tester, state, title: title);
    await _tap(tester, '继续填写');
    expect(
      tester
          .widgetList<TextField>(find.byType(TextField))
          .first
          .controller!
          .text,
      title,
    );
    await _tap(tester, '创建需求');
    expect(state.fake.created, isEmpty);
    expect(find.byType(CreateTaskSheet), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, '修正后的需求');
    await _tap(tester, '创建需求');
    expect(state.fake.created.single['title'], '修正后的需求');
    expect(tester.takeException(), isNull);
  });
  testWidgets(
    'source and creation use one sheet and cancellation creates nothing',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      await _open(tester, state);
      expect(find.byType(BottomSheet), findsOneWidget);
      await _tap(tester, '继续填写');
      expect(find.byType(CreateTaskSheet), findsOneWidget);
      expect(find.byType(BottomSheet), findsOneWidget);
      expect(find.byTooltip('返回'), findsOneWidget);
      expect(state.fake.created, isEmpty);
      await _tap(tester, '取消');
      expect(find.text('选择成果'), findsOneWidget);
      expect(find.byType(CreateTaskSheet), findsNothing);
      expect(state.fake.created, isEmpty);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(state.fake.created, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('back and changed source selection discard the unused handoff', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    Map<String, dynamic>? result;
    await _open(tester, state, onResult: (value) => result = value);
    await _tap(tester, 'report.txt');
    await _tap(tester, '继续填写');
    await tester.tap(find.byTooltip('返回'));
    await tester.pumpAndSettle();
    await _tap(tester, 'report.txt');
    expect(
      tester
          .widget<CheckboxListTile>(find.byType(CheckboxListTile).first)
          .value,
      isFalse,
    );
    await _tap(tester, '继续填写');
    await _tap(tester, '创建需求');
    expect(state.fake.created, hasLength(1));
    expect(state.fake.attachmentReads, 0);
    expect(result?['id'], 'new-task');
    expect(result?['partial'], isFalse);
    expect(find.byType(BottomSheet), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'automation disables binary attachments and keeps text selectable',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      await _open(tester, state, kind: 'automation');
      final tiles = tester
          .widgetList<CheckboxListTile>(find.byType(CheckboxListTile))
          .toList();
      expect(tiles, hasLength(2));
      expect(tiles.first.onChanged, isNotNull);
      expect(tiles.last.onChanged, isNull);
      expect(tiles.last.value, isFalse);
      await _tap(tester, 'report.txt');
      expect(
        tester
            .widget<CheckboxListTile>(find.byType(CheckboxListTile).first)
            .value,
        isTrue,
      );
      expect(state.fake.created, isEmpty);
      expect(state.fake.attachmentReads, 0);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'reference text beyond the old editor limit reaches creation unchanged',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      final source = '${List.filled(12000, '文').join()}最后一行不可丢';
      final expected = conversationHandoffNote('完成验收', source, const []);
      await _open(tester, state, contextText: source);
      await _tap(tester, '继续填写');
      final note = tester.widgetList<TextField>(find.byType(TextField)).last;
      expect(note.controller!.text, expected);
      expect(note.maxLength, greaterThanOrEqualTo(expected.length));
      await _tap(tester, '创建需求');
      expect(state.fake.created.single['note'], expected);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'oversized reference is explicitly rejected without a form or write',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      await _open(tester, state, contextText: List.filled(50000, '文').join());
      await _tap(tester, '继续填写');
      expect(find.text('参考材料超过 50000 字，请减少选中的成果或对话内容。'), findsOneWidget);
      expect(find.byType(CreateTaskSheet), findsNothing);
      expect(state.fake.created, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('account switch invalidates source controls', (tester) async {
    final state = _State();
    addTearDown(state.dispose);
    await _open(tester, state);
    state.changeIdentity();
    await tester.pumpAndSettle();
    expect(find.text('账号已变化，请关闭后重新打开。'), findsOneWidget);
    expect(find.text('继续填写'), findsNothing);
    expect(state.fake.created, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'account switch from creation cannot create for the next account',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      await _open(tester, state);
      await _tap(tester, '继续填写');
      state.changeIdentity();
      await tester.pumpAndSettle();
      await _tap(tester, '创建需求');
      expect(state.fake.created, isEmpty);
      expect(find.text('账号或会话已变化，请关闭后重新打开。'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}

Future<void> _tap(WidgetTester tester, String text) async {
  if (find.text(text).evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      find.text(text),
      200,
      scrollable: find
          .descendant(
            of: find.byType(ListView).last,
            matching: find.byType(Scrollable),
          )
          .first,
    );
  }
  await tester.ensureVisible(find.text(text));
  await tester.tap(find.text(text));
  await tester.pumpAndSettle();
}

Future<void> _open(
  WidgetTester tester,
  _State state, {
  String kind = 'requirement',
  String title = '验收需求',
  String contextText = '用户：整理当前交付。助手：已生成报告。',
  ValueChanged<Map<String, dynamic>?>? onResult,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                final result = await showConversationHandoff(
                  context,
                  kind: kind,
                  seed: {
                    'title': title,
                    'instruction': '完成验收',
                    'contextText': contextText,
                    'taskId': 'source-task',
                    'attachments': [
                      {
                        'id': 'text-file',
                        'filename': 'report.txt',
                        'role': 'output',
                        'size': 12,
                        'contentType': 'text/plain',
                        'createdAt': 123,
                      },
                      {
                        'id': 'binary-file',
                        'filename': 'image.png',
                        'role': 'output',
                        'size': 24,
                        'contentType': 'image/png',
                        'createdAt': 123,
                      },
                    ],
                  },
                  check: () {},
                );
                onResult?.call(result);
              },
              child: const Text('打开来源'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('打开来源'));
  await tester.pumpAndSettle();
}

class _State extends MobileState {
  final fake = _Api();
  int revision = 1;
  _State() {
    api = fake;
    endpoint = fake.endpoint;
    phase = MobilePhase.ready;
  }
  @override
  int get identityRevision => revision;
  void changeIdentity() {
    revision++;
    notifyListeners();
  }

  @override
  Future<void> refreshAll() async {}
}

class _Api extends SoduWorkApi {
  final created = <Map<String, dynamic>>[];
  int attachmentReads = 0;
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://unit.invalid',
        ),
      );
  @override
  Future<WorkTask> createTask(Map<String, dynamic> payload) async {
    created.add(Map<String, dynamic>.from(payload));
    return WorkTask.fromJson({...payload, 'id': 'new-task'});
  }

  @override
  Future<List<Map<String, dynamic>>> taskAttachments(String taskId) async {
    attachmentReads++;
    throw const ApiFailure('未选中的附件不得读取');
  }
}

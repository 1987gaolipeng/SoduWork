import 'dart:async';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/general_chat.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/work_model_picker.dart';
import 'package:soduwork_mobile/ui/conversation_landing.dart';
import 'package:soduwork_mobile/ui/mobile_appearance.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';

void main() {
  for (final width in [320.0, 390.0]) {
    for (final keyboard in [0.0, 300.0]) {
      testWidgets(
        'empty composer keeps its size and editing connection while choosing models at $width keyboard=$keyboard',
        (tester) async {
          tester.view.physicalSize = Size(width, 844);
          tester.view.devicePixelRatio = 1;
          tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
          addTearDown(tester.view.resetViewInsets);
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final state = _State();
          addTearDown(state.dispose);
          await tester.pumpWidget(
            MobileScope(
              state: state,
              child: MaterialApp(
                theme: SoduWorkTheme.light(),
                home: Builder(
                  builder: (context) => Scaffold(
                    body: ConversationLanding(
                      workMode: true,
                      modelLabel: '选择模型',
                      onWork: () {},
                      onSend: (_) async => false,
                      onPickModel: () async {
                        state.selected = await showWorkModelPicker(context);
                      },
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          final input = find.byKey(const Key('home-composer'));
          await tester.tap(input);
          await tester.pumpAndSettle();
          final editable = tester.element(find.byType(EditableText));
          final expanded = tester.getRect(input);
          for (var i = 0; i < 3; i++) {
            final model = find.widgetWithText(TextButton, '选择模型');
            final gesture = await tester.startGesture(
              tester.getCenter(model),
              kind: PointerDeviceKind.mouse,
            );
            await tester.pump();
            expect(
              tester.getRect(input),
              expanded,
              reason: 'pointer down must not collapse the composer',
            );
            await gesture.up();
            await tester.pumpAndSettle();
            expect(
              tester.getRect(
                find.byKey(const Key('home-composer'), skipOffstage: false),
              ),
              expanded,
            );
            expect(
              tester.element(find.byType(EditableText, skipOffstage: false)),
              same(editable),
            );
            expect(
              tester
                  .widget<TextField>(
                    find.byKey(const Key('home-composer'), skipOffstage: false),
                  )
                  .focusNode!
                  .hasFocus,
              isTrue,
              reason: 'the menu must not close the input connection',
            );
            if (i == 1) {
              await tester.tap(find.byTooltip('关闭'));
            } else {
              await tester.tap(find.text('精确模型'));
            }
            await tester.pumpAndSettle();
            expect(tester.getRect(input), expanded);
            expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
            expect(tester.widget<TextField>(input).controller!.text, isEmpty);
          }
          expect(state.selected!.name, '精确模型');
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
  testWidgets('model popover stays inside an embedded workspace navigator', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: MobileScope(
          state: state,
          child: Navigator(
            onGenerateRoute: (_) => MaterialPageRoute(
              builder: (context) => Scaffold(
                body: TextButton(
                  onPressed: () async {
                    state.selected = await showWorkModelPicker(context);
                  },
                  child: const Text('嵌入工作空间模型'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('嵌入工作空间模型'));
    await tester.pumpAndSettle();
    expect(find.text('精确模型'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('精确模型'));
    await tester.pumpAndSettle();
    expect(state.selected!.name, '精确模型');
    expect(state.reads, 1);
  });
  testWidgets(
    'work model selection uses authorized catalog even without an execution environment',
    (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      await _show(tester, state);
      await tester.pumpAndSettle();
      expect(state.reads, 1);
      expect(find.text('精确模型'), findsOneWidget);
      expect(find.text('仅本机模型'), findsNothing);
      await tester.tap(find.text('精确模型'));
      await tester.pumpAndSettle();
      expect(state.selected!.name, '精确模型');
      expect(state.selected!.providerName, '企业代理');
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('late work model response is hidden after account changes', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    final pending = Completer<Map<String, dynamic>>();
    state.pending = pending.future;
    await _show(tester, state);
    await tester.pump();
    state.changeIdentity();
    await tester.pump();
    pending.complete(_catalog());
    await tester.pumpAndSettle();
    expect(find.text('精确模型'), findsNothing);
    expect(find.text('账号已切换，请关闭后重新选择。'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  for (final width in [320.0, 390.0]) {
    for (final dark in [false, true]) {
      testWidgets(
        'right model popover stays above keyboard at $width dark=$dark',
        (tester) async {
          tester.view.physicalSize = Size(width, 844);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final state = _State();
          addTearDown(state.dispose);
          state.pending = Future.value({
            'usable': [
              for (var i = 0; i < 36; i++)
                {
                  'id': 'remote-$i',
                  'cli': 'pi',
                  'remote': true,
                  'name': '工作模型$i',
                },
            ],
          });
          final anchor = Rect.fromLTWH(width - 140, 480, 124, 44);
          await _show(
            tester,
            state,
            anchor: anchor,
            dark: dark,
            keyboard: 300,
            scale: 1.8,
          );
          await tester.pumpAndSettle();
          final panel = find.byKey(const Key('anchored-popover-panel'));
          final before = tester.getRect(panel);
          expect(before.right, closeTo(anchor.right, .1));
          expect(before.left, greaterThanOrEqualTo(12));
          expect(before.top, greaterThanOrEqualTo(12));
          expect(before.bottom, closeTo(anchor.top - 10, .1));
          await tester.drag(find.byType(ListView), const Offset(0, -300));
          await tester.pumpAndSettle();
          expect(tester.getRect(panel), before);
          expect(tester.takeException(), isNull);
          await tester.tapAt(const Offset(2, 200));
          await tester.pumpAndSettle();
          expect(panel, findsNothing);
          expect(state.selected, isNull);
          expect(state.reads, 1);
        },
      );
    }
  }
  testWidgets('empty model directory uses a compact retry state and rereads', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    state.pending = Future.value({'usable': []});
    await _show(tester, state);
    await tester.pumpAndSettle();
    expect(find.textContaining('当前账号没有获准使用的模型'), findsOneWidget);
    final panel = tester.getRect(
      find.byKey(const Key('anchored-popover-panel')),
    );
    expect(panel.height, lessThan(260));
    state.pending = null;
    await tester.tap(find.text('重新读取'));
    await tester.pumpAndSettle();
    expect(state.reads, 2);
    expect(find.text('精确模型'), findsOneWidget);
    await tester.tap(find.text('精确模型'));
    await tester.pumpAndSettle();
    expect(state.selected!.name, '精确模型');
    expect(tester.takeException(), isNull);
  });
}

Future<void> _show(
  WidgetTester tester,
  _State state, {
  Rect? anchor,
  bool dark = false,
  double keyboard = 0,
  double scale = 1,
}) async {
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(
          mobileAppearance(
            const SoduWorkBrandTheme(),
            dark ? Brightness.dark : Brightness.light,
          ),
        ),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            viewInsets: EdgeInsets.only(bottom: keyboard),
            textScaler: TextScaler.linear(scale),
          ),
          child: child!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                state.selected = await showWorkModelPicker(
                  context,
                  anchor: anchor,
                );
              },
              child: const Text('选择模型'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('选择模型'));
}

Map<String, dynamic> _catalog() => {
  'usable': [
    {'name': '快速模型', 'providerName': '企业代理', 'kind': 'openai'},
    {'name': '精确模型', 'providerName': '企业代理', 'kind': 'openai'},
  ],
  'denied': [
    {'name': '仅本机模型'},
  ],
};

class _State extends MobileState {
  final fake = _Api();
  int revision = 1;
  GeneralChatModel? selected;
  int get reads => fake.reads;
  set pending(Future<Map<String, dynamic>>? value) => fake.pending = value;
  _State() {
    phase = MobilePhase.ready;
    api = fake;
    endpoint = fake.endpoint;
  }
  @override
  int get identityRevision => revision;
  void changeIdentity() {
    revision++;
    notifyListeners();
  }
}

class _Api extends SoduWorkApi {
  int reads = 0;
  Future<Map<String, dynamic>>? pending;
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  @override
  Future<Map<String, dynamic>> chatModelCatalog() async {
    reads++;
    return pending == null ? _catalog() : await pending!;
  }
}

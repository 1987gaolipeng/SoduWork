import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/voice_input.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/voice_input_control.dart';

import 'voice_input_test_engine.dart';

void main() {
  testWidgets(
    'microphone tap starts recognition directly and commits only confirmed text',
    (tester) async {
      final engine = TestVoiceInputEngine();
      final drafts = <String>[];
      await tester.pumpWidget(_app(engine, drafts.add));
      expect(engine.starts, 0);
      await _start(tester);
      expect(engine.starts, 1);
      expect(find.byType(AlertDialog), findsNothing);
      engine.started!();
      engine.transcript!('测试中的中间文字');
      await tester.pump();
      expect(find.text('测试中的中间文字'), findsOneWidget);
      expect(drafts, isEmpty);
      await tester.tap(find.byKey(const Key('voice-input-toggle')));
      engine.transcript!('已确认的测试文字');
      engine.ended!();
      await tester.pump();
      expect(drafts, ['已确认的测试文字']);
      expect(find.textContaining('确认草稿后发送'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      expect(engine.disposals, 1);
    },
  );

  testWidgets(
    'scope change aborts capture and discards late results from the old account',
    (tester) async {
      final engine = TestVoiceInputEngine();
      final drafts = <String>[];
      await tester.pumpWidget(
        _app(engine, drafts.add, scope: 'hub-a:account-1'),
      );
      await _start(tester);
      engine.started!();
      engine.transcript!('旧账号文字');
      await tester.pump();
      await tester.pumpWidget(
        _app(engine, drafts.add, scope: 'hub-a:account-2'),
      );
      engine.transcript!('迟到结果');
      engine.ended!();
      await tester.pump();
      expect(engine.aborts, 1);
      expect(drafts, isEmpty);
      expect(find.text('旧账号文字'), findsNothing);
      expect(find.textContaining('会话或账号已切换'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('disabled, backgrounded and unfocused input release capture', (
    tester,
  ) async {
    final engine = TestVoiceInputEngine();
    final focus = FocusNode();
    addTearDown(focus.dispose);
    await tester.pumpWidget(
      _app(engine, (_) => fail('must not commit'), focus: focus),
    );
    await _start(tester);
    engine.started!();
    focus.requestFocus();
    await tester.pump();
    focus.unfocus();
    await tester.pump();
    expect(engine.aborts, 1);
    await tester.tap(find.byKey(const Key('voice-input-toggle')));
    engine.started!();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    expect(engine.aborts, 2);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.tap(find.byKey(const Key('voice-input-toggle')));
    engine.started!();
    await tester.pumpWidget(
      _app(
        engine,
        (_) => fail('must not commit'),
        focus: focus,
        enabled: false,
      ),
    );
    expect(engine.aborts, 3);
    final button = tester.widget<IconButton>(
      find.byKey(const Key('voice-input-toggle')),
    );
    expect(button.onPressed, isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'switching identity during microphone startup cancels the old permission result',
    (tester) async {
      final engine = TestVoiceInputEngine();
      final drafts = <String>[];
      await tester.pumpWidget(_app(engine, drafts.add, scope: 'old'));
      await _start(tester);
      final lateStarted = engine.started!,
          lateTranscript = engine.transcript!,
          lateEnded = engine.ended!;
      await tester.pumpWidget(_app(engine, drafts.add, scope: 'new'));
      lateStarted();
      lateTranscript('stale account text');
      lateEnded();
      await tester.pumpAndSettle();
      expect(engine.starts, 1);
      expect(engine.aborts, 1);
      expect(drafts, isEmpty);
      expect(find.text('stale account text'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'unsupported browser offers honest keyboard fallback without permission prompt',
    (tester) async {
      final engine = TestVoiceInputEngine()..supported = false;
      await tester.pumpWidget(_app(engine, (_) => fail('must not commit')));
      await tester.tap(find.byKey(const Key('voice-input-toggle')));
      await tester.pumpAndSettle();
      expect(engine.starts, 0);
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.textContaining('系统键盘听写'), findsOneWidget);
    },
  );

  testWidgets(
    '320px dark layout shows permission errors without horizontal overflow',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final engine = TestVoiceInputEngine();
      await tester.pumpWidget(
        _app(engine, (_) => fail('must not commit'), dark: true),
      );
      await _start(tester);
      engine.error!(const VoiceInputFailure('not-allowed'));
      await tester.pumpAndSettle();
      expect(find.textContaining('权限未获允许'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'compact idle toolbar aligns 44px attachment microphone and send targets',
    (tester) async {
      final engine = TestVoiceInputEngine();
      var additions = 0;
      var sends = 0;
      await tester.pumpWidget(
        _app(
          engine,
          (_) {},
          compact: true,
          leading: IconButton(
            key: const Key('fixture-add'),
            onPressed: () => additions++,
            icon: const Icon(Icons.add_rounded),
          ),
          trailing: IconButton(
            key: const Key('fixture-send'),
            onPressed: () => sends++,
            icon: const Icon(Icons.arrow_upward_rounded),
          ),
        ),
      );
      expect(find.text('说话转文字'), findsNothing);
      expect(find.byKey(const Key('voice-input-feedback')), findsNothing);
      expect(tester.getSize(find.byType(VoiceInputControl)).height, 44);
      final targets = [
        find.byKey(const Key('fixture-add')),
        find.byKey(const Key('voice-input-toggle')),
        find.byKey(const Key('fixture-send')),
      ];
      final baseline = tester.getCenter(targets.first).dy;
      for (final target in targets) {
        expect(tester.getSize(target), const Size.square(44));
        expect(tester.getCenter(target).dy, baseline);
      }
      await tester.tap(targets.first);
      await tester.tap(targets.last);
      expect(additions, 1);
      expect(sends, 1);
      expect(engine.starts, 0);
      final microphone = tester.widget<IconButton>(targets[1]);
      expect(
        microphone.style!.foregroundColor!.resolve({WidgetState.focused}),
        isNot(SoduWorkPalette.red),
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'compact recognition expands feedback above toolbar and collapses only after completion',
    (tester) async {
      final engine = TestVoiceInputEngine();
      final drafts = <String>[];
      await tester.pumpWidget(
        _app(
          engine,
          drafts.add,
          compact: true,
          trailing: IconButton(
            onPressed: () {},
            icon: const Icon(Icons.arrow_upward_rounded),
          ),
        ),
      );
      await _start(tester);
      engine.started!();
      engine.transcript!('仅预览的测试转写');
      await tester.pump();
      final feedback = find.byKey(const Key('voice-input-feedback'));
      final toolbar = find.byKey(const Key('voice-input-toolbar'));
      expect(feedback, findsOneWidget);
      expect(
        tester.getBottomLeft(feedback).dy,
        lessThanOrEqualTo(tester.getTopLeft(toolbar).dy),
      );
      expect(find.text('仅预览的测试转写'), findsOneWidget);
      expect(drafts, isEmpty);
      expect(
        tester.getSize(find.byKey(const Key('voice-input-cancel'))).height,
        greaterThanOrEqualTo(44),
      );
      await tester.tap(find.byKey(const Key('voice-input-toggle')));
      await tester.pump();
      expect(find.text('正在完成识别…'), findsOneWidget);
      expect(
        tester
            .widget<IconButton>(find.byKey(const Key('voice-input-toggle')))
            .onPressed,
        isNull,
      );
      engine.ended!();
      await tester.pump();
      expect(drafts, ['仅预览的测试转写']);
      expect(feedback, findsNothing);
      expect(tester.getSize(find.byType(VoiceInputControl)).height, 44);
    },
  );

  testWidgets(
    'compact cancellation preserves draft and compact scope change rejects stale results',
    (tester) async {
      final engine = TestVoiceInputEngine();
      final drafts = <String>[];
      await tester.pumpWidget(
        _app(engine, drafts.add, compact: true, scope: 'old'),
      );
      await _start(tester);
      engine.started!();
      engine.transcript!('不要加入草稿');
      await tester.pump();
      await tester.tap(find.byKey(const Key('voice-input-cancel')));
      engine.ended!();
      await tester.pump();
      expect(drafts, isEmpty);
      expect(find.byKey(const Key('voice-input-feedback')), findsNothing);
      await tester.tap(find.byKey(const Key('voice-input-toggle')));
      engine.started!();
      await tester.pumpWidget(
        _app(engine, drafts.add, compact: true, scope: 'new'),
      );
      engine.transcript!('旧账号结果');
      engine.ended!();
      await tester.pump();
      expect(drafts, isEmpty);
      expect(tester.getSize(find.byType(VoiceInputControl)).height, 44);
      expect(engine.aborts, 2);
    },
  );

  testWidgets(
    'compact 320px dark errors remain visible and can be dismissed without microphone access',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final engine = TestVoiceInputEngine()..supported = false;
      await tester.pumpWidget(
        _app(
          engine,
          (_) => fail('must not commit'),
          compact: true,
          dark: true,
          leading: IconButton(onPressed: () {}, icon: const Icon(Icons.add)),
          trailing: IconButton(
            onPressed: () {},
            icon: const Icon(Icons.arrow_upward),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('voice-input-toggle')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('voice-input-feedback')), findsOneWidget);
      expect(find.textContaining('系统键盘听写'), findsOneWidget);
      expect(engine.starts, 0);
      await tester.tap(find.byTooltip('收起语音提示'));
      await tester.pump();
      expect(find.byKey(const Key('voice-input-feedback')), findsNothing);
      expect(tester.getSize(find.byType(VoiceInputControl)).height, 44);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'compact focus stays within draft and stop controls but leaving both aborts',
    (tester) async {
      final engine = TestVoiceInputEngine();
      final input = FocusNode();
      final outside = FocusNode();
      addTearDown(input.dispose);
      addTearDown(outside.dispose);
      final drafts = <String>[];
      await tester.pumpWidget(
        _app(
          engine,
          drafts.add,
          compact: true,
          focus: input,
          outside: TextButton(
            focusNode: outside,
            onPressed: () {},
            child: const Text('外部操作'),
          ),
        ),
      );
      final microphone = tester.element(
        find.byKey(const Key('voice-input-toggle')),
      );
      final toolbar = tester.element(
        find.byKey(const Key('voice-input-toolbar')),
      );
      await _start(tester);
      engine.started!();
      engine.transcript!('测试转写');
      await tester.pump();
      expect(
        identical(
          microphone,
          tester.element(find.byKey(const Key('voice-input-toggle'))),
        ),
        isTrue,
      );
      expect(
        identical(
          toolbar,
          tester.element(find.byKey(const Key('voice-input-toolbar'))),
        ),
        isTrue,
      );
      input.requestFocus();
      await tester.pump();
      expect(input.hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      expect(input.hasFocus, isFalse);
      expect(
        Focus.of(
          tester.element(find.byKey(const Key('voice-input-toggle'))),
        ).hasFocus,
        isTrue,
      );
      expect(engine.aborts, 0);
      expect(find.text('测试转写'), findsOneWidget);
      await tester.tap(find.byKey(const Key('voice-input-toggle')));
      await tester.pump();
      expect(engine.stops, 1);
      expect(engine.aborts, 0);
      expect(find.text('正在完成识别…'), findsOneWidget);
      outside.requestFocus();
      await tester.pump();
      expect(engine.aborts, 1);
      engine.ended!();
      await tester.pump();
      expect(drafts, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

Future<void> _start(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('voice-input-toggle')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

Widget _app(
  TestVoiceInputEngine engine,
  ValueChanged<String> onTranscript, {
  Object scope = 'https://fixture.test:account-1',
  FocusNode? focus,
  bool enabled = true,
  bool dark = false,
  bool compact = false,
  Widget? leading,
  Widget? trailing,
  Widget? outside,
}) => MaterialApp(
  theme: SoduWorkTheme.light(
    SoduWorkBrandTheme(brightness: dark ? Brightness.dark : Brightness.light),
  ),
  home: Scaffold(
    body: SafeArea(
      child: Column(
        children: [
          if (focus != null) TextField(focusNode: focus),
          VoiceInputControl(
            engine: engine,
            scopeKey: scope,
            onTranscript: onTranscript,
            inputFocus: focus,
            enabled: enabled,
            compact: compact,
            leading: leading,
            trailing: trailing,
          ),
          ?outside,
        ],
      ),
    ),
  ),
);

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_layer_surface.dart';
import 'package:soduwork_mobile/ui/mobile_sheet.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets(
    'mouse header drag resizes and closes while preserving the underlying draft',
    (tester) async {
      _phone(tester);
      final state = _State(), draft = TextEditingController(text: '未发送的草稿');
      addTearDown(state.dispose);
      addTearDown(draft.dispose);
      await tester.pumpWidget(_harness(state, draft: draft));
      final root = find.byKey(const Key('mobile-main-layer'));
      final original = tester.getRect(root);
      await tester.tap(find.text('打开面板'));
      await tester.pumpAndSettle();
      expect(tester.getRect(root).width, lessThan(original.width));
      final handle = find.byKey(const Key('mobile-sheet-drag-region'));
      final top = tester.getTopLeft(handle).dy;
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.down(tester.getCenter(handle));
      for (var step = 1; step <= 6; step++) {
        await mouse.moveBy(
          const Offset(0, 40),
          timeStamp: Duration(milliseconds: step * 200),
        );
        await tester.pump(const Duration(milliseconds: 200));
      }
      await mouse.up(timeStamp: const Duration(milliseconds: 1400));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsOneWidget);
      expect(tester.getTopLeft(handle).dy, greaterThan(top + 50));
      await tester.dragFrom(
        tester.getCenter(handle),
        const Offset(0, 650),
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(tester.getRect(root), original);
      expect(draft.text, '未发送的草稿');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'sheet subpages reuse one surface and back restores the parent scroll',
    (tester) async {
      _phone(tester);
      final state = _State();
      addTearDown(state.dispose);
      ScrollController? outer;
      await tester.pumpWidget(_harness(state, onScroll: (c) => outer = c));
      await tester.tap(find.text('打开面板'));
      await tester.pumpAndSettle();
      await tester.drag(
        find.byKey(const Key('outer-list')),
        const Offset(0, -280),
      );
      await tester.pumpAndSettle();
      // First upward gesture expands the sheet; the next scrolls its list.
      await tester.drag(
        find.byKey(const Key('outer-list')),
        const Offset(0, -220),
      );
      await tester.pumpAndSettle();
      final saved = outer!.offset;
      expect(saved, greaterThan(0));
      final rect = tester.getRect(find.byKey(const Key('outer-list')));
      await tester.tap(find.text('打开第二层'));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsOneWidget);
      expect(find.text('第二层内容'), findsOneWidget);
      expect(find.text('打开第二层'), findsNothing);
      await tester.tap(find.byTooltip('返回'));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsOneWidget);
      expect(find.text('打开第二层'), findsOneWidget);
      expect(outer!.offset, closeTo(saved, .1));
      expect(tester.getRect(find.byKey(const Key('outer-list'))), rect);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'reduced motion and disposing an open workspace leave no orphan visual layer',
    (tester) async {
      _phone(tester);
      final state = _State();
      addTearDown(state.dispose);
      await tester.pumpWidget(_harness(state, reducedMotion: true));
      await tester.tap(find.text('打开面板'));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsOneWidget);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      expect(
        tester.getRect(find.byKey(const Key('mobile-main-layer'))).width,
        390,
      );
      await tester.tap(find.text('打开面板'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: Text('已退出工作空间'))),
      );
      await tester.pumpAndSettle();
      expect(find.text('已退出工作空间'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('independent workspace hosts do not retreat each other', (
    tester,
  ) async {
    _phone(tester);
    final state = _State();
    addTearDown(state.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: MobileScope(
          state: state,
          child: Row(
            children: [
              for (final name in ['left', 'right'])
                Expanded(
                  child: MobileLayerHost(
                    key: ValueKey(name),
                    background: Colors.black,
                    child: Scaffold(
                      body: Builder(
                        builder: (context) => TextButton(
                          onPressed: () => showMobileSheet<void>(
                            context,
                            title: name,
                            builder: (_, scroll) => ListView(
                              controller: scroll,
                              children: const [Text('内容')],
                            ),
                          ),
                          child: Text(name),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
    final left = find.descendant(
      of: find.byKey(const ValueKey('left')),
      matching: find.byKey(const Key('mobile-main-layer')),
    );
    final right = find.descendant(
      of: find.byKey(const ValueKey('right')),
      matching: find.byKey(const Key('mobile-main-layer')),
    );
    final lw = tester.getRect(left).width, rw = tester.getRect(right).width;
    await tester.tap(find.text('left'));
    await tester.pumpAndSettle();
    expect(tester.getRect(left).width, lessThan(lw));
    expect(tester.getRect(right).width, rw);
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
    expect(tester.getRect(left).width, lw);
    expect(tester.takeException(), isNull);
  });
}

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Widget _harness(
  _State state, {
  TextEditingController? draft,
  ValueChanged<ScrollController>? onScroll,
  bool reducedMotion = false,
}) => MaterialApp(
  theme: SoduWorkTheme.light(),
  home: MediaQuery(
    data: MediaQueryData(
      size: const Size(390, 844),
      disableAnimations: reducedMotion,
    ),
    child: MobileScope(
      state: state,
      child: MobileLayerHost(
        background: Colors.black,
        child: Scaffold(
          body: Builder(
            builder: (context) => Column(
              children: [
                if (draft != null) TextField(controller: draft),
                TextButton(
                  onPressed: () => showMobileSheet<void>(
                    context,
                    title: '设置',
                    builder: (context, scroll) {
                      onScroll?.call(scroll);
                      return Column(
                        children: [
                          Expanded(
                            child: ListView(
                              key: const Key('outer-list'),
                              controller: scroll,
                              children: [
                                for (var i = 0; i < 40; i++)
                                  ListTile(title: Text('条目$i')),
                              ],
                            ),
                          ),
                          TextButton(
                            onPressed: () => showMobileSheet<void>(
                              context,
                              title: '第二层',
                              builder: (_, inner) => ListView(
                                controller: inner,
                                children: const [Text('第二层内容')],
                              ),
                            ),
                            child: const Text('打开第二层'),
                          ),
                        ],
                      );
                    },
                  ),
                  child: const Text('打开面板'),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  ),
);

class _State extends MobileState {
  _State() {
    endpoint = const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'http://fixture.test',
    );
    api = SoduWorkApi(store: store, endpoint: endpoint);
  }
}

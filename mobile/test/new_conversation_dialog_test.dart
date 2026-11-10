import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/screens/app_shell.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

class _IdentityState extends MobileState {
  int revision = 0;
  @override
  int get identityRevision => revision;
}

class _RouteLog extends NavigatorObserver {
  final pushed = <Route<dynamic>>[];
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    pushed.add(route);
  }
}

void main() {
  Future<({_IdentityState state, _RouteLog outer, _RouteLog inner})> mount(
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final state = _IdentityState()..phase = MobilePhase.ready;
    final outer = _RouteLog(), inner = _RouteLog();
    addTearDown(state.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        navigatorObservers: [outer],
        home: MobileScope(
          state: state,
          child: Navigator(
            observers: [inner],
            onGenerateRoute: (_) => MaterialPageRoute<void>(
              builder: (_) => const AppShell(preview: true),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (state: state, outer: outer, inner: inner);
  }

  Finder input() => find.byKey(const Key('home-composer'));

  testWidgets(
    'new conversation dialog covers the actual conversation route and confirm clears draft',
    (tester) async {
      final f = await mount(tester);
      await tester.enterText(input(), '/自动化 尚未发送的工作要求');
      await tester.tap(find.byTooltip('新对话'));
      await tester.pumpAndSettle();
      expect(find.text('开始新对话？'), findsOneWidget);
      expect(f.inner.pushed.last, isA<DialogRoute<bool>>());
      expect(f.inner.pushed.first.isCurrent, isFalse);
      expect(f.outer.pushed, hasLength(1));
      await tester.tap(find.text('新建对话'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(f.inner.pushed.first.isCurrent, isTrue);
      expect(tester.widget<TextField>(input()).controller!.text, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'keep draft preserves text and repeated new actions do not stack dialogs',
    (tester) async {
      final f = await mount(tester);
      await tester.enterText(input(), '保留完整草稿');
      final button = tester.widget<IconButton>(
        find.byWidgetPredicate(
          (widget) => widget is IconButton && widget.tooltip == '新对话',
        ),
      );
      button.onPressed!();
      button.onPressed!();
      await tester.pumpAndSettle();
      expect(f.inner.pushed.whereType<DialogRoute<bool>>(), hasLength(1));
      await tester.tap(find.text('保留草稿'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(input()).controller!.text, '保留完整草稿');
      expect(f.inner.pushed.first.isCurrent, isTrue);
      await tester.tap(find.byTooltip('新对话'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.text('新建对话'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(input()).controller!.text, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets('a late confirmation does not clear another identity draft', (
    tester,
  ) async {
    final f = await mount(tester);
    await tester.enterText(input(), '身份切换前草稿');
    await tester.tap(find.byTooltip('新对话'));
    await tester.pumpAndSettle();
    f.state.revision++;
    await tester.tap(find.text('新建对话'));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(tester.widget<TextField>(input()).controller!.text, '身份切换前草稿');
    expect(f.inner.pushed.first.isCurrent, isTrue);
    expect(tester.takeException(), isNull);
  });
}

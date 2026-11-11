import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/preview_main.dart';
import 'package:soduwork_mobile/models/work_capability.dart';
import 'package:soduwork_mobile/ui/conversation_landing.dart';
import 'package:soduwork_mobile/ui/mobile_appearance.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  testWidgets(
    'work model selector stays on the composer action row at 320 and 390',
    (tester) async {
      for (final width in [320.0, 390.0]) {
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        var modelClicks = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: SoduWorkTheme.light(),
            home: Scaffold(
              body: ConversationLanding(
                workMode: true,
                modelLabel: '一个很长的模型名称用于布局验收',
                onPickModel: () {
                  modelClicks++;
                },
                voiceScopeKey: 'test-model-toolbar',
                onWork: () {},
                onAdd: () {},
                onSend: (_) async => false,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.widgetWithText(TextButton, '一个很长的模型名称用于布局验收'),
          findsNothing,
        );
        final idle = tester.getRect(find.byKey(const Key('home-composer')));
        final idleSend = tester.getRect(find.byKey(const Key('home-send')));
        expect(idle.center.dy, closeTo(idleSend.center.dy, 2));
        await tester.tap(find.byKey(const Key('home-composer')));
        await tester.pumpAndSettle();
        final model = find.widgetWithText(TextButton, '一个很长的模型名称用于布局验收');
        final a = tester.getRect(model),
            b = tester.getRect(find.byKey(const Key('home-send')));
        expect(a.center.dy, closeTo(b.center.dy, .1));
        final add = tester.getRect(find.byTooltip('添加材料与执行方式'));
        expect(a.left, greaterThan(add.right + 16));
        expect(a.center.dx, greaterThan(width / 2));
        expect(a.right, lessThan(b.left));
        await tester.tap(model);
        await tester.pump();
        expect(modelClicks, 1);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      }
    },
  );
  testWidgets(
    'attachment menu is compact and dismissing preserves the work draft',
    (tester) async {
      await tester.pumpWidget(const MobilePreview());
      await tester.pumpAndSettle();
      expect(find.text('工作'), findsNothing);
      expect(find.byTooltip('新对话'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('home-composer')), '保留工作草稿');
      await tester.pump();
      await tester.tap(find.byTooltip('添加材料与执行方式'));
      await tester.pumpAndSettle();
      expect(find.byType(PopupMenuItem<String>), findsNWidgets(4));
      for (final label in ['相机', '照片', '文件', '插件与工具']) {
        expect(find.text(label), findsOneWidget);
      }
      final menu = tester.getRect(find.byType(PopupMenuItem<String>).first);
      expect(menu.width, lessThan(280));
      await tester.tapAt(const Offset(370, 80));
      await tester.pumpAndSettle();
      expect(find.text('开始一项工作'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('home-composer')))
            .controller!
            .text,
        '保留工作草稿',
      );
      expect(tester.takeException(), isNull);
    },
  );

  test(
    'selected capability text remains readable in light and dark themes',
    () {
      for (final brightness in [Brightness.light, Brightness.dark]) {
        final brand = mobileAppearance(const SoduWorkBrandTheme(), brightness);
        final theme = SoduWorkTheme.light(brand);
        final foreground = theme.chipTheme.labelStyle!.color!;
        final a = foreground.computeLuminance(),
            b = brand.surface.computeLuminance();
        final contrast = ((a > b ? a : b) + 0.05) / ((a < b ? a : b) + 0.05);
        expect(contrast, greaterThanOrEqualTo(4.5));
      }
    },
  );

  testWidgets(
    'work shortcuts select structured capabilities without dispatch and preserve cancelled text',
    (tester) async {
      final calls = <String>[];
      var accepted = true;
      await tester.pumpWidget(
        MaterialApp(
          theme: SoduWorkTheme.light(),
          home: Scaffold(
            body: ConversationLanding(
              workMode: true,
              onWork: () {},
              onSend: (_) async => false,
              onPickCapability: (prefix) async {
                calls.add(prefix);
                return accepted;
              },
              capabilities: [
                WorkCapability(
                  kind: WorkCapabilityKind.skill,
                  id: 'writer',
                  label: '写作技能',
                  description: '',
                  enabled: true,
                  reason: '',
                  metadata: const {},
                ),
              ],
              attachmentNames: const ['报告.pdf'],
            ),
          ),
        ),
      );
      expect(find.text('写作技能'), findsOneWidget);
      expect(find.text('报告.pdf'), findsOneWidget);
      for (final prefix in ['/', '@', '#']) {
        await tester.enterText(
          find.byKey(const Key('home-composer')),
          '请处理 $prefix',
        );
        await tester.pumpAndSettle();
        expect(calls.last, prefix);
        expect(
          tester
              .widget<TextField>(find.byKey(const Key('home-composer')))
              .controller!
              .text,
          '请处理 ',
        );
      }
      accepted = false;
      await tester.enterText(find.byKey(const Key('home-composer')), '保留 /');
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('home-composer')))
            .controller!
            .text,
        '保留 /',
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'single work home preserves its draft through settings and resource navigation',
    (tester) async {
      await tester.pumpWidget(const MobilePreview());
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('workspace-tab-0')), findsNothing);
      expect(find.byKey(const Key('workspace-tab-1')), findsNothing);
      expect(find.text('解释一个概念'), findsNothing);
      expect(find.text('开始一项工作'), findsOneWidget);
      expect(find.text('待推进'), findsNothing);
      await tester.enterText(find.byKey(const Key('home-composer')), '工作草稿');
      await tester.pump();
      await tester.tap(find.byKey(const Key('open-sidebar')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('设置'));
      await tester.pumpAndSettle();
      expect(find.text('账户信息'), findsOneWidget);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('home-composer')))
            .controller!
            .text,
        '工作草稿',
      );
      await tester.tap(find.byKey(const Key('open-sidebar')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('项目'));
      await tester.pumpAndSettle();
      expect(find.text('新建项目'), findsOneWidget);
      await tester.tap(find.byKey(const Key('open-sidebar')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('主页'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('home-composer')))
            .controller!
            .text,
        '工作草稿',
      );
      await tester.tap(find.byTooltip('添加材料与执行方式'));
      await tester.pumpAndSettle();
      for (final label in ['相机', '照片', '文件', '插件与工具']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'home attachment, voice and send share a 44px action row on narrow screens',
    (tester) async {
      for (final width in [320.0, 390.0]) {
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        await tester.pumpWidget(
          MaterialApp(
            theme: SoduWorkTheme.light(),
            home: Scaffold(
              body: ConversationLanding(
                voiceScopeKey: 'fixture-identity',
                onWork: () {},
                onSend: (_) async => false,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final attachment = tester.getRect(find.byTooltip('添加材料与执行方式'));
        final voice = tester.getRect(
          find.byKey(const Key('voice-input-toggle')),
        );
        final send = tester.getRect(find.byKey(const Key('home-send')));
        expect(attachment.center.dy, closeTo(send.center.dy, .1));
        expect(voice.center.dy, closeTo(send.center.dy, .1));
        expect(voice.right, lessThanOrEqualTo(send.left + 1));
        expect(voice.height, greaterThanOrEqualTo(44));
        expect(send.height, greaterThanOrEqualTo(44));
        expect(find.text('说话转文字'), findsNothing);
        expect(tester.takeException(), isNull);
      }
    },
  );

  setUp(() {
    final view = TestWidgetsFlutterBinding.ensureInitialized()
        .platformDispatcher
        .views
        .first;
    view
      ..physicalSize = const Size(390, 844)
      ..devicePixelRatio = 1;
  });

  tearDown(() {
    final view = TestWidgetsFlutterBinding.ensureInitialized()
        .platformDispatcher
        .views
        .first;
    view
      ..resetPhysicalSize()
      ..resetDevicePixelRatio();
  });

  testWidgets('suggestions only fill a draft and rejected sends preserve it', (
    tester,
  ) async {
    var sends = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: SafeArea(
            child: ConversationLanding(
              onWork: () {},
              onSend: (text) async {
                sends += 1;
                return false;
              },
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('解释一个概念'));
    await tester.pump();
    final input = tester.widget<TextField>(
      find.byKey(const Key('home-composer')),
    );
    expect(input.controller!.text, contains('通俗'));
    expect(sends, 0);
    await tester.pump();
    await tester.tap(find.byKey(const Key('home-send')));
    await tester.pumpAndSettle();
    expect(sends, 1);
    expect(input.controller!.text, contains('通俗'));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'offline preview supports transcript, artifact and return without auth',
    (tester) async {
      await tester.pumpWidget(const MobilePreview());
      await tester.pumpAndSettle();
      expect(find.text('界面预览 · 未连接企业服务'), findsOneWidget);
      expect(
        tester.widget<IconButton>(find.byKey(const Key('home-send'))).onPressed,
        isNull,
      );
      await tester.enterText(find.byKey(const Key('home-composer')), '整理项目成果');
      await tester.pump();
      await tester.tap(find.byKey(const Key('home-send')));
      await tester.pumpAndSettle();
      expect(find.text('整理项目成果'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('预览示例文档'),
        180,
        scrollable: find
            .descendant(
              of: find.byKey(const Key('preview-transcript')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.tap(find.text('预览示例文档'));
      await tester.pumpAndSettle();
      expect(find.textContaining('没有生成或下载真实文件'), findsOneWidget);
      await tester.tap(find.text('关闭预览'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新对话'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('home-composer')))
            .controller!
            .text,
        '',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'drawer filters history and appearance survives workspace navigation',
    (tester) async {
      await tester.pumpWidget(const MobilePreview());
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('open-sidebar')));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('搜索会话'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('conversation-search-input')),
        '交付',
      );
      await tester.pump();
      expect(find.text('整理项目交付材料'), findsOneWidget);
      expect(find.text('梳理本周团队工作'), findsNothing);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      await _darkSettings(tester);
      await tester.tap(find.byKey(const Key('open-sidebar')));
      await tester.pumpAndSettle();
      expect(find.byTooltip('关闭侧栏'), findsNothing);
      expect(
        Theme.of(tester.element(find.byType(Drawer))).brightness,
        Brightness.dark,
      );
      await tester.tap(find.text('需求池'));
      await tester.pumpAndSettle();
      expect(find.text('需求池'), findsWidgets);
      expect(
        Theme.of(tester.element(find.text('需求池').first)).brightness,
        Brightness.dark,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'compact preview remains usable when a keyboard reduces the viewport',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpWidget(const MobilePreview());
      await tester.pumpAndSettle();
      tester.view.viewInsets = const FakeViewPadding(bottom: 280);
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('home-composer')), '手机键盘测试');
      await tester.pump();
      expect(find.byKey(const Key('home-send')), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('explicit new conversation asks before discarding a draft', (
    tester,
  ) async {
    await tester.pumpWidget(const MobilePreview());
    await tester.pumpAndSettle();
    await _darkSettings(tester);
    await tester.enterText(find.byKey(const Key('home-composer')), '保留这份草稿');
    await tester.pump();
    await tester.tap(find.byTooltip('新对话'));
    await tester.pumpAndSettle();
    expect(find.text('开始新对话？'), findsOneWidget);
    expect(
      Theme.of(tester.element(find.byType(AlertDialog))).brightness,
      Brightness.dark,
    );
    await tester.tap(find.text('保留草稿'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('home-composer')))
          .controller!
          .text,
      '保留这份草稿',
    );
    await tester.tap(find.byTooltip('新对话'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('新建对话'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('home-composer')))
          .controller!
          .text,
      isEmpty,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('attachment entry opens configuration without requiring text', (
    tester,
  ) async {
    String? received;
    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: ConversationLanding(
            onWork: () {},
            onSend: (text) async {
              received = text;
              return false;
            },
          ),
        ),
      ),
    );
    await tester.tap(find.byTooltip('添加材料与执行方式'));
    await tester.pumpAndSettle();
    expect(received, '');
    expect(tester.takeException(), isNull);
  });

  test('typography keeps the bundled Chinese family after style overrides', () {
    final theme = SoduWorkTheme.light();
    final text = theme.textTheme;
    for (final style in [
      text.headlineLarge,
      text.headlineMedium,
      text.titleLarge,
      text.titleMedium,
      text.bodyLarge,
      text.bodyMedium,
      text.bodySmall,
      text.labelLarge,
    ]) {
      expect(style!.fontFamily, 'Noto Sans SC');
    }
  });

  test('appearance keeps enterprise identity, accents and shape', () {
    const brand = SoduWorkBrandTheme(
      brandName: 'Northwind',
      primary: Color(0xFF2457D6),
      radiusLarge: 0,
    );
    final dark = mobileAppearance(brand, Brightness.dark);
    expect(dark.brandName, brand.brandName);
    expect(dark.primary, brand.primary);
    expect(dark.radiusLarge, 0);
    expect(dark.brightness, Brightness.dark);
    expect(mobileAppearance(brand, Brightness.light), same(brand));
  });
}

Future<void> _darkSettings(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('open-sidebar')));
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('设置'));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.text('外观'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('外观'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('深色'));
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('关闭'));
  await tester.pumpAndSettle();
}

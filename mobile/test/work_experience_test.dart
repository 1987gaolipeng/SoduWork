import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/automations_screen.dart';
import 'package:soduwork_mobile/screens/plugin_builder_screen.dart';
import 'package:soduwork_mobile/screens/plugin_catalog_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/mobile_appearance.dart';
import 'package:soduwork_mobile/ui/task_detail_sections.dart';

class _Api extends SoduWorkApi {
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://fixture.test',
        ),
      );
  @override
  Future<List<Map<String, dynamic>>> automationTemplates() async => [];
  @override
  Future<List<AutomationSchedule>> automations() async => [
    AutomationSchedule.fromJson({
      'id': 'paused',
      'title': '暂停的报告',
      'enabled': false,
      'note': '整理资料',
      'timeZone': 'Asia/Shanghai',
      'nextRunLocal': '2030-11-01 09:00',
    }),
    AutomationSchedule.fromJson({
      'id': 'active',
      'title': '每日总结',
      'enabled': true,
      'note': '摘要',
      'timeZone': 'Asia/Shanghai',
    }),
  ];
  @override
  Future<Map<String, dynamic>> pluginCatalog() async => {
    'items': [
      {
        'id': 'one',
        'name': '报告模板',
        'description': '整理报告',
        'version': '1.2.3',
        'installed': false,
      },
    ],
    'submissions': [],
  };
}

Future<void> show(
  WidgetTester tester,
  Widget child, {
  double width = 390,
  double scale = 1,
  bool dark = false,
}) async {
  tester.view.physicalSize = Size(width, 852);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final state = MobileState()
    ..api = _Api()
    ..phase = MobilePhase.ready;
  addTearDown(state.dispose);
  final captureKey = GlobalKey();
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
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: RepaintBoundary(
          key: captureKey,
          child: Scaffold(body: child),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  final output = Platform.environment['MOBILE_EXPERIENCE_SHOTS'];
  if (output != null) {
    await tester.runAsync(() async {
      final boundary =
          captureKey.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 2);
      try {
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(output).create(recursive: true);
        await File(
          '$output/${child.runtimeType}-$width-$scale-$dark.png',
        ).writeAsBytes(data!.buffer.asUint8List());
      } finally {
        image.dispose();
      }
    });
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    final loader = FontLoader('Noto Sans SC')
      ..addFont(rootBundle.load('assets/fonts/NotoSansSC-Variable.ttf'));
    await loader.load();
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
    final cupertino = FontLoader('packages/cupertino_icons/CupertinoIcons')
      ..addFont(
        rootBundle.load('packages/cupertino_icons/assets/CupertinoIcons.ttf'),
      );
    await cupertino.load();
  });
  testWidgets(
    'automation filters and search are reversible and paused plans do not promise a run',
    (tester) async {
      await show(tester, const AutomationsScreen());
      expect(find.text('已启用 1'), findsOneWidget);
      expect(find.text('运行中'), findsNothing);
      expect(find.text('已暂停，启用后安排'), findsOneWidget);
      expect(find.textContaining('11/01'), findsNothing);
      await tester.tap(find.widgetWithText(ChoiceChip, '已启用'));
      await tester.pumpAndSettle();
      expect(find.text('每日总结'), findsOneWidget);
      expect(find.text('暂停的报告'), findsNothing);
      await tester.enterText(find.byType(TextField), '不存在');
      await tester.pumpAndSettle();
      expect(find.text('没有匹配的计划'), findsOneWidget);
      await tester.tap(find.byTooltip('清空搜索'));
      await tester.tap(find.widgetWithText(ChoiceChip, '全部'));
      await tester.pumpAndSettle();
      expect(find.text('暂停的报告'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final dark in [false, true]) {
    testWidgets(
      'plugin types and actions remain reachable at 320 with large text dark=$dark',
      (tester) async {
        await show(
          tester,
          const PluginBuilderScreen(),
          width: 320,
          scale: 1.6,
          dark: dark,
        );
        await tester.scrollUntilVisible(
          find.text('自动化流程'),
          180,
          scrollable: find.byType(Scrollable).first,
        );
        await tester.tap(find.text('自动化流程'));
        await tester.pumpAndSettle();
        await tester.scrollUntilVisible(
          find.text('编辑流程节点'),
          300,
          scrollable: find.byType(Scrollable).first,
        );
        // Reveal the whole control after the larger fields have shifted it.
        final editWorkflow = find.byKey(const ValueKey('edit-plugin-workflow'));
        await tester.ensureVisible(editWorkflow);
        await tester.pumpAndSettle();
        await tester.tap(editWorkflow);
        await tester.pumpAndSettle();
        expect(find.text('流程节点'), findsOneWidget);
        expect(find.text('添加节点'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'plugin version search can be cleared without leaving the catalog',
    (tester) async {
      await show(
        tester,
        const PluginCatalogScreen(),
        width: 320,
        scale: 1.4,
        dark: true,
      );
      await tester.enterText(find.byType(TextField), '9.9.9');
      await tester.pumpAndSettle();
      expect(find.text('没有匹配的插件'), findsOneWidget);
      await tester.tap(find.byTooltip('清空搜索'));
      await tester.enterText(find.byType(TextField), '1.2.3');
      await tester.pumpAndSettle();
      expect(find.text('报告模板'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'long requirement text can expand without losing title or acceptance criteria',
    (tester) async {
      final note = List.filled(30, '完整需求说明，不应丢失。').join();
      await show(
        tester,
        SingleChildScrollView(
          child: TaskDetailIdentity(
            task: WorkTask.fromJson({
              'id': 'requirement',
              'title': '确认后的需求标题',
              'status': 'todo',
              'note': note,
              'acceptanceCriteria': ['成果可下载'],
            }),
          ),
        ),
        width: 320,
        scale: 1.4,
      );
      expect(find.text('确认后的需求标题'), findsOneWidget);
      expect(find.text('• 成果可下载'), findsOneWidget);
      expect(find.byType(SelectableText), findsOneWidget);
      await tester.tap(find.text('需求说明'));
      await tester.pumpAndSettle();
      expect(find.byType(SelectableText), findsNWidgets(2));
      expect(tester.takeException(), isNull);
    },
  );
}

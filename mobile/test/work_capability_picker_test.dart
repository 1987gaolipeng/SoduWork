import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_capability.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_appearance.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/work_capability_picker.dart';

void main() {
  testWidgets('private inspected drafts are read-only and disappear on account change', (tester) async {
    final state = _PickerState();
    state.catalog.privateMode = true;
    addTearDown(state.dispose);
    await tester.pumpWidget(MobileScope(state: state, child: MaterialApp(
      theme: SoduWorkTheme.light(const SoduWorkBrandTheme()),
      home: const Scaffold(body: WorkCapabilityPicker(embedded: true, workflowOnly: true)))));
    await tester.pumpAndSettle();
    expect(find.text('本人检查草稿'), findsOneWidget);
    expect(find.textContaining('仅本人'), findsOneWidget);
    await tester.tap(find.text('本人检查草稿'));
    await tester.pumpAndSettle();
    expect(state.selected, isNull);
    expect(tester.widget<ListTile>(find.byType(ListTile)).onTap, isNull);
    state.changeIdentity();
    await tester.pumpAndSettle();
    expect(find.text('本人检查草稿'), findsNothing);
    expect(find.text('账号已切换，请关闭后重新选择。'), findsOneWidget);
  });

  testWidgets(
    'workflow catalog is searched locally and disabled reasons remain visible',
    (tester) async {
      final state = _PickerState();
      addTearDown(state.dispose);
      await _show(tester, state);
      expect(state.catalog.pluginReads, 1);
      expect(find.text('此插件没有可执行工作流'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '报告');
      await tester.pumpAndSettle();
      expect(find.text('整理报告'), findsOneWidget);
      expect(find.text('仅对话插件'), findsNothing);
      expect(state.catalog.pluginReads, 1);
      await tester.tap(find.text('整理报告'));
      await tester.pumpAndSettle();
      expect(state.selected?.id, 'binding-report');
      expect(state.selected?.kind, WorkCapabilityKind.workflow);
    },
  );

  testWidgets(
    'a visible skill with default enabled false can be explicitly selected',
    (tester) async {
      final state = _PickerState();
      addTearDown(state.dispose);
      await _show(tester, state, prefix: '#');
      expect(state.catalog.skillReads, 1);
      expect(find.text('此技能需要本机桌面，暂不能从移动端采用'), findsOneWidget);
      await tester.tap(find.text('report'));
      await tester.pumpAndSettle();
      expect(state.selected?.id, 'report');
      expect(state.selected?.metadata['enabled'], isFalse);
    },
  );

  testWidgets('teammate selection never returns a non-receiving colleague', (
    tester,
  ) async {
    final state = _PickerState();
    addTearDown(state.dispose);
    await _show(tester, state, prefix: '@');
    await tester.tap(find.text('离线同事'));
    await tester.pumpAndSettle();
    expect(state.selected, isNull);
    expect(find.byType(WorkCapabilityPicker), findsOneWidget);
    await tester.tap(find.text('可接收同事'));
    await tester.pumpAndSettle();
    expect(state.selected?.id, 'user-ready');
  });

  testWidgets(
    'read errors have an explicit retry without making any execution request',
    (tester) async {
      final state = _PickerState()..catalog.failPlugins = true;
      addTearDown(state.dispose);
      await _show(tester, state);
      expect(find.text('重新读取'), findsOneWidget);
      state.catalog.failPlugins = false;
      await tester.tap(find.text('重新读取'));
      await tester.pumpAndSettle();
      expect(state.catalog.pluginReads, 2);
      expect(find.text('整理报告'), findsOneWidget);
    },
  );

  testWidgets('late catalog results cannot reappear after an identity change', (
    tester,
  ) async {
    final state = _PickerState();
    final pending = Completer<Map<String, dynamic>>();
    state.catalog.pendingPlugins = pending.future;
    addTearDown(state.dispose);
    await _show(tester, state, settle: false);
    state.changeIdentity();
    await tester.pump();
    pending.complete({
      'items': [_workflow('旧账号私有工作流')],
    });
    await tester.pumpAndSettle();
    expect(find.text('旧账号私有工作流'), findsNothing);
    expect(find.text('账号已切换，请关闭后重新选择。'), findsOneWidget);
  });

  testWidgets(
    'teammates use initials and departments with a single search hint',
    (tester) async {
      final state = _PickerState();
      addTearDown(state.dispose);
      await _show(tester, state, prefix: '@');
      expect(find.text('可'), findsOneWidget);
      expect(find.text('离'), findsOneWidget);
      expect(find.text('产品组'), findsOneWidget);
      expect(find.text('设计组'), findsOneWidget);
      final search = tester.widget<TextField>(
        find.byKey(const Key('work-capability-search')),
      );
      expect(search.decoration?.labelText, isNull);
      expect(search.decoration?.hintText, '搜索同事或部门');
      expect(
        tester.getSize(find.byKey(const Key('work-capability-close'))).height,
        greaterThanOrEqualTo(44),
      );
      final avatar = tester.widget<CircleAvatar>(
        find.byKey(const Key('work-capability-avatar:user-ready')),
      );
      expect(
        avatar.backgroundColor,
        tester
            .element(find.byType(WorkCapabilityPicker))
            .soduWorkTheme
            .surfaceMuted,
      );
      await tester.enterText(find.byType(TextField), '产品');
      await tester.pumpAndSettle();
      expect(find.text('可接收同事'), findsOneWidget);
      expect(find.text('离线同事'), findsNothing);
      await tester.tap(find.byTooltip('清空搜索'));
      await tester.pumpAndSettle();
      expect(find.text('离线同事'), findsOneWidget);
    },
  );

  for (final width in [320.0, 390.0]) {
    for (final dark in [false, true]) {
      testWidgets(
        'only the directory scrolls at $width, dark=$dark with large text and keyboard',
        (tester) async {
          tester.view.physicalSize = Size(width, 568);
          tester.view.devicePixelRatio = 1;
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final state = _PickerState();
          state.catalog.teammateRows = List.generate(
            40,
            (index) => {
              'id': 'colleague-$index',
              'name': '同事${index.toString().padLeft(2, '0')}',
              'org': '产品研发部',
              'canReceive': true,
            },
          );
          addTearDown(state.dispose);
          await _show(
            tester,
            state,
            prefix: '@',
            dark: dark,
            scale: 1.8,
            keyboard: 200,
          );
          final search = find.byKey(const Key('work-capability-search'));
          final category = find.byKey(
            const Key('work-capability-kind-teammate'),
          );
          final directory = find.byKey(const Key('work-capability-results'));
          final titlePosition = tester.getTopLeft(find.text('选择工作能力'));
          final searchPosition = tester.getTopLeft(search);
          final categoryPosition = tester.getTopLeft(category);
          expect(find.byType(CustomScrollView), findsNothing);
          expect(tester.getSize(directory).height, greaterThan(0));
          await tester.drag(directory, const Offset(0, -260));
          await tester.pumpAndSettle();
          expect(tester.getTopLeft(find.text('选择工作能力')), titlePosition);
          expect(tester.getTopLeft(search), searchPosition);
          expect(tester.getTopLeft(category), categoryPosition);
          final scroll = tester.state<ScrollableState>(
            find.descendant(of: directory, matching: find.byType(Scrollable)),
          );
          expect(scroll.position.pixels, greaterThan(0));
          expect(
            tester.widget<BottomSheet>(find.byType(BottomSheet)).showDragHandle,
            isTrue,
          );
          expect(tester.takeException(), isNull);
        },
      );
    }
  }

  for (final width in [320.0, 390.0]) {
    testWidgets('dark large-text picker stays scrollable at $width', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final state = _PickerState();
      addTearDown(state.dispose);
      await _show(tester, state, dark: true, scale: 1.8);
      expect(
        tester.widget<BottomSheet>(find.byType(BottomSheet)).showDragHandle,
        isTrue,
      );
      await tester.ensureVisible(find.text('仅对话插件'));
      expect(tester.takeException(), isNull);
    });
  }
}

Map<String, dynamic> _workflow(String name) => {
  'bindingId': 'binding-report',
  'pluginId': 'plugin',
  'version': '1',
  'name': name,
  'runnable': true,
  'capabilities': {'hasWorkflow': true},
  'inputs': <dynamic>[],
};

class _CatalogApi extends SoduWorkApi {
  int pluginReads = 0, skillReads = 0;
  bool failPlugins = false;
  bool privateMode = false;
  @override
  bool get isLocalDevelopment => privateMode;
  @override
  Future<List<Map<String, dynamic>>> localPluginInspections() async => [
    {'name': '本人检查草稿', 'version': '1.0', 'resourceCount': 4,
      'issues': ['尚未安装到执行器'], 'state': 'inspected'}];

  List<Map<String, dynamic>>? teammateRows;
  Future<Map<String, dynamic>>? pendingPlugins;
  _CatalogApi()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://unit.test',
        ),
      );
  @override
  Future<Map<String, dynamic>> workPluginBindings() async {
    pluginReads++;
    if (privateMode) return {'items': []};
    if (failPlugins) throw const ApiFailure('隔离目录读取失败');
    if (pendingPlugins != null) return pendingPlugins!;
    return {
      'items': [
        _workflow('整理报告'),
        {
          ..._workflow('仅对话插件'),
          'bindingId': 'conversation-only',
          'capabilities': {'hasWorkflow': false},
        },
      ],
    };
  }

  @override
  Future<Map<String, dynamic>> workSkillCatalog() async {
    skillReads++;
    return {
      'skills': [
        {'name': 'report', 'enabled': false},
        {'name': 'computer-use', 'enabled': true},
      ],
    };
  }

  @override
  Future<List<Map<String, dynamic>>> teammates() async =>
      teammateRows ??
      [
        {
          'id': 'user-offline',
          'name': '离线同事',
          'org': '设计组',
          'canReceive': false,
        },
        {'id': 'user-ready', 'name': '可接收同事', 'org': '产品组', 'canReceive': true},
      ];
}

class _PickerState extends MobileState {
  final catalog = _CatalogApi();
  WorkCapability? selected;
  int _revision = 0;
  _PickerState() {
    api = catalog;
    phase = MobilePhase.ready;
  }
  @override
  int get identityRevision => _revision;
  void changeIdentity() {
    _revision++;
    notifyListeners();
  }

  @override
  void dispose() {
    catalog.client.close();
    super.dispose();
  }
}

Future<void> _show(
  WidgetTester tester,
  _PickerState state, {
  String prefix = '/',
  bool settle = true,
  bool dark = false,
  double scale = 1,
  double keyboard = 0,
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
            textScaler: TextScaler.linear(scale),
            viewInsets: EdgeInsets.only(bottom: keyboard),
          ),
          child: child!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                state.selected = await showWorkCapabilityPicker(
                  context,
                  prefix: prefix,
                );
              },
              child: const Text('选择能力'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('选择能力'));
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }
}

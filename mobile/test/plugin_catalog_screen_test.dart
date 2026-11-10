import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/plugin_catalog_screen.dart';
import 'package:soduwork_mobile/screens/plugin_builder_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

Map<String, dynamic> _catalog() => {
  'items': [
    {
      'pluginId': 'hiring',
      'name': '招聘日报',
      'description': '汇总候选人进展',
      'version': '2.1.0',
      'installed': true,
      'permissions': {'canUse': true},
    },
    {
      'pluginId': 'minutes',
      'name': '会议纪要',
      'description': '整理讨论和行动项',
      'version': '1.0.0',
      'installed': false,
      'permissions': {'canUse': true},
      'marketPolicy': {'installation': 'optional'},
    },
  ],
  'submissions': [
    {
      'pluginId': 'my-draft',
      'name': '我的招聘插件',
      'version': '0.2.0',
      'trustState': 'rejected',
      'reviewDecision': 'reject',
      'reviewNote': '请补充使用说明和验收步骤',
    },
  ],
};

class _Api extends SoduWorkApi {
  Map<String, dynamic> result = _catalog();
  Object? failure;
  Completer<Map<String, dynamic>>? pending;
  int calls = 0;
  int saves = 0;

  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );

  @override
  Future<Map<String, dynamic>> pluginCatalog() async {
    calls++;
    if (failure != null) throw failure!;
    return pending?.future ?? result;
  }

  @override
  Future<Map<String, dynamic>> preflightPluginDraft(
    Map<String, dynamic> draft,
  ) async => {'ok': true, 'name': draft['name']};

  @override
  Future<Map<String, dynamic>> createPluginDraft(
    Map<String, dynamic> draft,
  ) async {
    saves++;
    final plugin = {
      'id': 'saved-plugin',
      'name': draft['name'],
      'version': '0.1.0',
    };
    result = {
      'items': [],
      'submissions': [plugin],
    };
    return {'ok': true, 'plugin': plugin};
  }
}

class _State extends MobileState {
  int revision = 0;

  @override
  int get identityRevision => revision;

  void switchAccount(SoduWorkApi next) {
    api = next;
    revision++;
    notifyListeners();
  }
}

Future<void> _show(
  WidgetTester tester,
  _State state, {
  double width = 390,
  VoidCallback? onConversationCreate,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1100);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(state.dispose);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(
        home: Scaffold(
          body: PluginCatalogScreen(onConversationCreate: onConversationCreate),
        ),
      ),
    ),
  );
  await tester.pump();
}

Finder _chip(String label) => find.widgetWithText(ChoiceChip, label);

void main() {
  testWidgets('目录显示服务端插件与版本，提交记录使用独立集合', (tester) async {
    final api = _Api();
    await _show(tester, _State()..api = api);
    await tester.pumpAndSettle();
    expect(api.calls, 1);
    expect(find.text('招聘日报'), findsOneWidget);
    expect(find.text('会议纪要'), findsOneWidget);
    expect(find.text('v2.1.0'), findsOneWidget);
    expect(find.text('我的招聘插件'), findsNothing);
    expect(find.text('管理与设置'), findsOneWidget);
    expect(find.text('查看并安装'), findsOneWidget);
    await tester.tap(_chip('我的提交'));
    await tester.pumpAndSettle();
    expect(find.text('招聘日报'), findsNothing);
    expect(find.text('我的招聘插件'), findsOneWidget);
    expect(find.text('请补充使用说明和验收步骤'), findsOneWidget);
    expect(find.text('需修改'), findsOneWidget);
    expect(find.text('查看并安装'), findsNothing);
    expect(find.text('管理与设置'), findsNothing);
  });

  testWidgets('application declarations stay outside plugin lists and search', (
    tester,
  ) async {
    final api = _Api();
    final items = List<Map<String, dynamic>>.from(api.result['items'] as List);
    api.result['items'] = items;
    items.addAll([
      {
        'pluginId': 'legacy-navigation',
        'name': 'Legacy desktop application',
        'installed': true,
        'ui': {
          'contributions': [
            {'slot': 'workspace.navigation'},
          ],
        },
        'permissions': {'canUse': true},
      },
      {
        'pluginId': 'formal-app',
        'name': 'Formal desktop application',
        'template': 'app',
        'installed': false,
        'permissions': {'canUse': true},
      },
    ]);
    (api.result['submissions'] as List).add({
      'name': 'Application submission',
      'template': 'app',
    });
    await _show(tester, _State()..api = api);
    await tester.pumpAndSettle();
    expect(find.text('Legacy desktop application'), findsNothing);
    expect(find.text('Formal desktop application'), findsNothing);
    expect(find.text('招聘日报'), findsOneWidget);
    await tester.tap(_chip('已安装'));
    await tester.pumpAndSettle();
    expect(find.text('Legacy desktop application'), findsNothing);
    expect(find.text('招聘日报'), findsOneWidget);
    await tester.tap(_chip('全部'));
    await tester.enterText(find.byType(TextField), 'desktop application');
    await tester.pumpAndSettle();
    expect(find.text('没有匹配的插件'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '');
    await tester.tap(_chip('我的提交'));
    await tester.pumpAndSettle();
    expect(find.text('Application submission'), findsNothing);
    expect(find.text('我的招聘插件'), findsOneWidget);
    expect(api.calls, 1);
  });

  testWidgets('名称和用途搜索与已安装筛选组合且不重新请求', (tester) async {
    final api = _Api();
    await _show(tester, _State()..api = api);
    await tester.pumpAndSettle();
    await tester.tap(_chip('已安装'));
    await tester.pumpAndSettle();
    expect(find.text('招聘日报'), findsOneWidget);
    expect(find.text('会议纪要'), findsNothing);
    await tester.enterText(find.byType(TextField), '候选人');
    await tester.pumpAndSettle();
    expect(find.text('招聘日报'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '会议');
    await tester.pumpAndSettle();
    expect(find.text('没有匹配的插件'), findsOneWidget);
    await tester.tap(_chip('全部'));
    await tester.pumpAndSettle();
    expect(find.text('会议纪要'), findsOneWidget);
    expect(find.text('招聘日报'), findsNothing);
    await tester.enterText(find.byType(TextField), '');
    await tester.pumpAndSettle();
    expect(find.text('招聘日报'), findsOneWidget);
    expect(api.calls, 1);
  });

  testWidgets('提交审核状态区分待审核、需修改和已发布', (tester) async {
    final api = _Api();
    api.result = {
      'items': [],
      'submissions': [
        {'name': '待审核作品', 'version': '0.1.0'},
        {'name': '已发布作品', 'version': '1.0.0', 'catalogReady': true},
        {
          'name': '退回作品',
          'version': '0.3.0',
          'trustState': 'rejected',
          'reviewNote': '补充输入参数',
        },
      ],
    };
    await _show(tester, _State()..api = api);
    await tester.pumpAndSettle();
    await tester.tap(_chip('我的提交'));
    await tester.pumpAndSettle();
    expect(find.text('待审核'), findsOneWidget);
    expect(find.text('已发布'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('补充输入参数'),
      150,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(find.text('需修改'), findsOneWidget);
    expect(find.text('补充输入参数'), findsOneWidget);
  });

  testWidgets('加载失败显示真实原因并能重试成功', (tester) async {
    final api = _Api()..failure = const ApiFailure('目录服务暂时不可用');
    await _show(tester, _State()..api = api);
    await tester.pumpAndSettle();
    expect(find.text('目录服务暂时不可用'), findsOneWidget);
    expect(find.text('招聘日报'), findsNothing);
    api.failure = null;
    await tester.tap(find.text('重新加载'));
    await tester.pumpAndSettle();
    expect(api.calls, 2);
    expect(find.text('目录服务暂时不可用'), findsNothing);
    expect(find.text('招聘日报'), findsOneWidget);
  });

  testWidgets('账号切换立即清空旧目录与提交并忽略迟到响应', (tester) async {
    final api = _Api();
    final state = _State()..api = api;
    await _show(tester, state);
    await tester.pumpAndSettle();
    expect(find.text('招聘日报'), findsOneWidget);
    final second = _Api()..pending = Completer<Map<String, dynamic>>();
    state.switchAccount(second);
    await tester.pump();
    expect(find.text('招聘日报'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.tap(_chip('我的提交'));
    await tester.pump();
    expect(find.text('我的招聘插件'), findsNothing);
    final third = _Api()
      ..result = {
        'items': [],
        'submissions': [
          {'name': '新账号自己的提交', 'version': '0.1.0'},
        ],
      };
    state.switchAccount(third);
    await tester.pumpAndSettle();
    expect(find.text('新账号自己的提交'), findsOneWidget);
    second.pending!.complete({
      'items': [],
      'submissions': [
        {'name': '迟到的旧账号提交', 'version': '9.9.9'},
      ],
    });
    await tester.pumpAndSettle();
    expect(find.text('迟到的旧账号提交'), findsNothing);
    expect(find.text('新账号自己的提交'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('320 宽长名称、描述和操作可以滚动且没有布局溢出', (tester) async {
    final api = _Api();
    final longName = '跨部门招聘与人才情报自动汇总工作方法' * 4;
    api.result = {
      'items': [
        {
          'name': longName,
          'description': '按真实来源整理数据并保留完整工作记录。' * 12,
          'version': '2026.10.28',
          'installed': true,
          'updateAvailable': true,
        },
      ],
      'submissions': [],
    };
    await _show(tester, _State()..api = api, width: 320);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(
      find.text('管理与设置'),
      180,
      scrollable: find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(find.text('有更新'), findsOneWidget);
    expect(tester.takeException(), isNull);
    final bounds = tester.getRect(find.text('管理与设置'));
    expect(bounds.left, greaterThanOrEqualTo(0));
    expect(bounds.right, lessThanOrEqualTo(320));
  });

  testWidgets('对话制作直接进入已有会话创建回调', (tester) async {
    var created = 0;
    await _show(
      tester,
      _State()..api = _Api(),
      onConversationCreate: () => created++,
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('对话制作'));
    await tester.pump();
    expect(created, 1);
    expect(find.byType(PluginCatalogScreen), findsOneWidget);
  });
  testWidgets('替换账号状态对象时也立即清除旧目录', (tester) async {
    final oldState = _State()..api = _Api();
    await _show(tester, oldState);
    await tester.pumpAndSettle();
    expect(find.text('招聘日报'), findsOneWidget);
    final nextApi = _Api()..pending = Completer<Map<String, dynamic>>();
    final nextState = _State()..api = nextApi;
    addTearDown(nextState.dispose);
    await tester.pumpWidget(
      MobileScope(
        state: nextState,
        child: const MaterialApp(home: Scaffold(body: PluginCatalogScreen())),
      ),
    );
    await tester.pump();
    expect(find.text('招聘日报'), findsNothing);
    expect(find.text('会议纪要'), findsNothing);
    nextApi.pending!.complete({'items': [], 'submissions': []});
    await tester.pumpAndSettle();
    expect(find.text('当前账号暂无已授权的插件'), findsOneWidget);
  });

  testWidgets('编辑草稿保存后展示我的提交并清空搜索，确认成功可见', (tester) async {
    final api = _Api();
    await _show(tester, _State()..api = api);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '不匹配的旧搜索');
    await tester.tap(find.text('编辑草稿'));
    await tester.pumpAndSettle();
    for (final field in {
      '插件名称': '新增页面插件',
      '用途': '总结输入文字',
      '工作方法': '阅读输入并返回总结',
    }.entries) {
      final input = find.byWidgetPredicate(
        (w) => w is TextField && w.decoration?.labelText == field.key,
      );
      await tester.ensureVisible(input);
      await tester.enterText(input, field.value);
      await tester.pumpAndSettle();
    }
    await tester.scrollUntilVisible(
      find.text('检查并继续'),
      400,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('检查并继续'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('检查并继续'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('提交审核'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('提交审核'));
    await tester.pumpAndSettle();
    expect(api.saves, 1);
    expect(api.calls, 2);
    expect(tester.widget<ChoiceChip>(_chip('我的提交')).selected, isTrue);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
    );
    expect(find.text('新增页面插件'), findsOneWidget);
    expect(find.text('待审核'), findsOneWidget);
    expect(find.text('插件已保存，可在“我的提交”查看审核状态。'), findsOneWidget);
    expect(find.text('当前账号暂无已授权的插件'), findsNothing);
  });

  testWidgets('取消编辑不改变筛选和搜索也不提示已保存', (tester) async {
    await _show(tester, _State()..api = _Api());
    await tester.pumpAndSettle();
    await tester.tap(_chip('已安装'));
    await tester.enterText(find.byType(TextField), '招聘');
    await tester.tap(find.text('编辑草稿'));
    await tester.pumpAndSettle();
    Navigator.of(tester.element(find.byType(PluginBuilderScreen))).pop();
    await tester.pumpAndSettle();
    expect(tester.widget<ChoiceChip>(_chip('已安装')).selected, isTrue);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '招聘',
    );
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets('旧账号编辑页迟到返回不切换新账号筛选或提示成功', (tester) async {
    final firstApi = _Api();
    final state = _State()..api = firstApi;
    await _show(tester, state);
    await tester.pumpAndSettle();
    await tester.tap(find.text('编辑草稿'));
    await tester.pumpAndSettle();
    final secondApi = _Api();
    state.switchAccount(secondApi);
    await tester.pumpAndSettle();
    final callsBeforeReturn = secondApi.calls;
    Navigator.of(tester.element(find.byType(PluginBuilderScreen))).pop({
      'ok': true,
      'plugin': {'id': 'old-plugin'},
    });
    await tester.pumpAndSettle();
    expect(secondApi.calls, callsBeforeReturn);
    expect(tester.widget<ChoiceChip>(_chip('全部')).selected, isTrue);
    expect(find.byType(SnackBar), findsNothing);
  });
  testWidgets('替换状态对象后旧编辑回执不污染相同revision的新账号', (tester) async {
    final old = _State()..api = _Api();
    await _show(tester, old);
    await tester.pumpAndSettle();
    await tester.tap(find.text('编辑草稿'));
    await tester.pumpAndSettle();
    final nextApi = _Api();
    final next = _State()..api = nextApi;
    addTearDown(next.dispose);
    await tester.pumpWidget(
      MobileScope(
        state: next,
        child: const MaterialApp(home: Scaffold(body: PluginCatalogScreen())),
      ),
    );
    await tester.pumpAndSettle();
    final callsBeforeReturn = nextApi.calls;
    Navigator.of(tester.element(find.byType(PluginBuilderScreen))).pop({
      'ok': true,
      'plugin': {'id': 'old-plugin'},
    });
    await tester.pumpAndSettle();
    expect(nextApi.calls, callsBeforeReturn);
    expect(tester.widget<ChoiceChip>(_chip('全部')).selected, isTrue);
    expect(find.byType(SnackBar), findsNothing);
  });
}

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/plugin_builder_screen.dart';
import 'package:soduwork_mobile/screens/plugin_package_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

Map<String, dynamic> _draft() => {
  'template': 'method',
  'name': '月度报告助手',
  'version': '1.0.0',
  'description': '整理月度报告',
  'instructions': '整理材料并验证来源',
  'inputs': [
    {'key': 'topic', 'label': '主题', 'type': 'text'},
  ],
  'setup': {
    'preferences': [
      {'key': 'language', 'type': 'text', 'default': '中文'},
    ],
  },
  'resources': [
    {'path': 'examples/report.txt', 'content': '保留完整附件'},
  ],
};

XFile _json() => XFile.fromData(
  Uint8List.fromList(utf8.encode(jsonEncode(_draft()))),
  name: 'soduwork-plugin-draft.json',
  path: 'soduwork-plugin-draft.json',
  mimeType: 'application/json',
);

XFile _package() => XFile.fromData(
  Uint8List.fromList([80, 75, 3, 4]),
  name: 'report.soduwork-plugin',
  path: 'report.soduwork-plugin',
  mimeType: 'application/zip',
);

class _Api extends SoduWorkApi {
  final checkedPackages = <XFile>[], submittedPackages = <XFile>[];
  Map<String, dynamic>? checkedDraft, savedDraft;
  Object? packageFailure, submitFailure;
  Completer<Map<String, dynamic>>? waiting;
  Map<String, dynamic> preview = {
    'manifest': {'name': '已签名报告插件', 'description': '从 PC 导出的工作方法'},
    'checks': [
      {'label': '包结构检查通过', 'ok': true},
    ],
  };
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://fixture.test',
        ),
      );
  @override
  Future<Map<String, dynamic>> preflightPluginPackage(XFile file) async {
    checkedPackages.add(file);
    if (packageFailure != null) {
      throw packageFailure!;
    }
    return waiting?.future ?? preview;
  }

  @override
  Future<Map<String, dynamic>> submitPluginPackage(XFile file) async {
    submittedPackages.add(file);
    if (submitFailure != null) {
      throw submitFailure!;
    }
    return {'ok': true, 'message': '原包审核已受理'};
  }

  @override
  Future<Map<String, dynamic>> preflightPluginDraft(
    Map<String, dynamic> draft,
  ) async {
    checkedDraft = draft;
    return {'ok': true, 'name': draft['name']};
  }

  @override
  Future<Map<String, dynamic>> createPluginDraft(
    Map<String, dynamic> draft,
  ) async {
    savedDraft = draft;
    return {'ok': true, 'message': '草稿已保存'};
  }
}

class _State extends MobileState {
  int revision = 0;
  @override
  int get identityRevision => revision;
  void switchAccount() {
    revision++;
    notifyListeners();
  }
}

Future<void> _show(
  WidgetTester tester,
  _State state,
  Future<List<XFile>> Function() chooseFiles,
) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(state.dispose);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(home: PluginPackageScreen(chooseFiles: chooseFiles)),
    ),
  );
}

Future<void> _tap(WidgetTester tester, String label) async {
  await tester.scrollUntilVisible(
    find.text(label),
    350,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('新文件预检失败不能沿用旧包预检或草稿提交', (tester) async {
    final api = _Api();
    api.preview = {...api.preview, 'personalDraft': _draft()};
    final state = _State()..api = api;
    final first = _package();
    final second = XFile.fromData(
      Uint8List.fromList([80, 75, 3, 4]),
      path: 'second.soduwork-plugin',
      name: 'second.soduwork-plugin',
    );
    var picked = 0;
    await _show(tester, state, () async => [picked++ == 0 ? first : second]);
    await _tap(tester, '选择插件文件');
    expect(find.text('月度报告助手'), findsOneWidget);
    api.packageFailure = const ApiFailure('新包预检失败');
    await _tap(tester, '重新选择');
    expect(find.text('月度报告助手'), findsNothing);
    expect(find.text('report.soduwork-plugin'), findsNothing);
    expect(find.text('second.soduwork-plugin'), findsWidgets);
    expect(find.text('编辑并确认草稿'), findsNothing);
    expect(find.text('提交原包审核'), findsNothing);
    expect(api.submittedPackages, isEmpty);
    api.packageFailure = null;
    await _tap(tester, '重新检查');
    await _tap(tester, '提交原包审核');
    expect(api.submittedPackages.single, same(second));
  });

  testWidgets('替换同revision的MobileState仍清除旧账号预览', (tester) async {
    final api = _Api(), first = _State(), second = _State();
    first.api = api;
    second.api = _Api();
    addTearDown(second.dispose);
    Future<List<XFile>> picker() async => [_package()];
    await _show(tester, first, picker);
    await _tap(tester, '选择插件文件');
    expect(find.text('已签名报告插件'), findsOneWidget);
    await tester.pumpWidget(
      MobileScope(
        state: second,
        child: MaterialApp(home: PluginPackageScreen(chooseFiles: picker)),
      ),
    );
    await tester.pump();
    expect(find.text('账号或服务已切换，请关闭后重新打开。'), findsOneWidget);
    expect(find.text('已签名报告插件'), findsNothing);
    expect(find.text('提交原包审核'), findsNothing);
    expect(api.submittedPackages, isEmpty);
  });

  testWidgets('提交成功回执在切号后不可见', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    await _show(tester, state, () async => [_package()]);
    await _tap(tester, '选择插件文件');
    await _tap(tester, '提交原包审核');
    expect(find.text('原包审核已受理'), findsOneWidget);
    state.switchAccount();
    await tester.pump();
    expect(find.text('原包审核已受理'), findsNothing);
    expect(find.text('已签名报告插件'), findsNothing);
  });

  testWidgets('JSON草稿进入原表单，预检后才允许保存且完整保留资源', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    await _show(tester, state, () async => [_json()]);
    await _tap(tester, '选择插件文件');
    expect(find.text('月度报告助手'), findsOneWidget);
    expect(api.checkedPackages, isEmpty);
    expect(api.savedDraft, isNull);
    await _tap(tester, '编辑并确认草稿');
    expect(find.byType(PluginBuilderScreen), findsOneWidget);
    await _tap(tester, '检查并继续');
    expect(api.checkedDraft!['resources'], _draft()['resources']);
    expect(api.checkedDraft!['inputs'], _draft()['inputs']);
    expect(api.savedDraft, isNull);
    await _tap(tester, '提交审核');
    expect(api.savedDraft, api.checkedDraft);
  });

  testWidgets('包预检personalDraft进入表单，不提前提交原包', (tester) async {
    final api = _Api();
    api.preview = {...api.preview, 'personalDraft': _draft()};
    final state = _State()..api = api;
    final package = _package();
    await _show(tester, state, () async => [package]);
    await _tap(tester, '选择插件文件');
    expect(api.checkedPackages.single, same(package));
    expect(api.submittedPackages, isEmpty);
    await _tap(tester, '编辑并确认草稿');
    final screen = tester.widget<PluginBuilderScreen>(
      find.byType(PluginBuilderScreen),
    );
    expect(screen.initialValues, _draft());
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('月度报告助手'), findsOneWidget);
    expect(api.savedDraft, isNull);
  });

  testWidgets('取消重新选择保持已有包和预检结果', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    final package = _package();
    var pickCount = 0;
    await _show(tester, state, () async => pickCount++ == 0 ? [package] : []);
    await _tap(tester, '选择插件文件');
    await _tap(tester, '重新选择');
    expect(find.text('已签名报告插件'), findsOneWidget);
    expect(find.text('report.soduwork-plugin'), findsOneWidget);
    expect(api.checkedPackages.length, 1);
    expect(api.submittedPackages, isEmpty);
  });

  testWidgets('原包须预检完成并明确点击提交，重复提交被阻止', (tester) async {
    final api = _Api()..waiting = Completer<Map<String, dynamic>>();
    final state = _State()..api = api;
    final package = _package();
    await _show(tester, state, () async => [package]);
    await tester.tap(find.text('选择插件文件'));
    await tester.pump();
    expect(api.submittedPackages, isEmpty);
    expect(find.text('提交原包审核'), findsNothing);
    api.waiting!.complete(api.preview);
    await tester.pumpAndSettle();
    expect(api.submittedPackages, isEmpty);
    await _tap(tester, '提交原包审核');
    expect(api.submittedPackages.single, same(package));
    expect(find.text('原包审核已受理'), findsOneWidget);
    expect(find.text('提交原包审核'), findsNothing);
  });

  testWidgets('提交401保留已选文件和预检，重新登录后可以重试', (tester) async {
    final api = _Api()..submitFailure = const ApiFailure('请重新登录', status: 401);
    final state = _State()..api = api;
    final package = _package();
    await _show(tester, state, () async => [package]);
    await _tap(tester, '选择插件文件');
    await _tap(tester, '提交原包审核');
    expect(find.text('请重新登录'), findsOneWidget);
    expect(find.text('report.soduwork-plugin'), findsOneWidget);
    api.submitFailure = null;
    await _tap(tester, '提交原包审核');
    expect(api.submittedPackages.length, 2);
    expect(api.submittedPackages.last, same(package));
    expect(find.text('原包审核已受理'), findsOneWidget);
  });

  testWidgets('首次预检401保留文件并可重新检查，失败不允许提交', (tester) async {
    final api = _Api()..packageFailure = const ApiFailure('请重新登录', status: 401);
    final state = _State()..api = api;
    final package = _package();
    await _show(tester, state, () async => [package]);
    await _tap(tester, '选择插件文件');
    expect(find.text('请重新登录'), findsOneWidget);
    expect(find.text('report.soduwork-plugin'), findsWidgets);
    expect(find.text('提交原包审核'), findsNothing);
    api.packageFailure = null;
    await _tap(tester, '重新检查');
    expect(api.checkedPackages.length, 2);
    expect(api.checkedPackages.last, same(package));
    expect(find.text('已签名报告插件'), findsOneWidget);
  });

  testWidgets('账号切换隐藏旧预览，晚返回不能显示上个账号的数据', (tester) async {
    final api = _Api(), state = _State();
    state.api = api;
    await _show(tester, state, () async => [_package()]);
    await _tap(tester, '选择插件文件');
    state.switchAccount();
    await tester.pump();
    expect(find.text('账号或服务已切换，请关闭后重新打开。'), findsOneWidget);
    expect(find.text('已签名报告插件'), findsNothing);
    expect(find.text('report.soduwork-plugin'), findsNothing);
    expect(api.submittedPackages, isEmpty);
  });

  testWidgets('预检中切号忽略异步结果', (tester) async {
    final api = _Api()..waiting = Completer<Map<String, dynamic>>();
    final state = _State()..api = api;
    await _show(tester, state, () async => [_package()]);
    await tester.tap(find.text('选择插件文件'));
    await tester.pump();
    state.switchAccount();
    await tester.pump();
    api.waiting!.complete(api.preview);
    await tester.pumpAndSettle();
    expect(find.text('已签名报告插件'), findsNothing);
    expect(find.text('提交原包审核'), findsNothing);
  });
}

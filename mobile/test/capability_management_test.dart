import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/skill_catalog_screen.dart';
import 'package:soduwork_mobile/screens/skill_detail_screen.dart';
import 'package:soduwork_mobile/screens/connector_editor_screen.dart';
import 'package:soduwork_mobile/screens/connector_catalog_screen.dart';
import 'package:soduwork_mobile/screens/capability_center_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'memory_device_auth.dart';

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'session';
}

class _State extends MobileState {
  int revision = 0;
  @override
  int get identityRevision => revision;
  void changeIdentity() {
    revision++;
    notifyListeners();
  }
}

SoduWorkApi _api(Future<http.Response> Function(http.Request) handler) => SoduWorkApi(
  store: _Store(),
  endpoint: const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'https://fixture.test',
  ),
  client: MockClient(handler),
);
http.Response _json(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Future<_State> _show(WidgetTester tester, Widget page, SoduWorkApi api) async {
  tester.view.physicalSize = const Size(390, 1200);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final state = _State()..api = api;
  addTearDown(state.dispose);
  addTearDown(api.client.close);
  await tester.pumpWidget(
    MobileScope(
      state: state,
      child: MaterialApp(home: Scaffold(body: page)),
    ),
  );
  await tester.pumpAndSettle();
  return state;
}

void main() {
  testWidgets(
    'skill selection preserves hidden selections and uses confirmed receipt',
    (tester) async {
      List<dynamic>? saved;
      await _show(
        tester,
        const SkillCatalogScreen(),
        _api((r) async {
          if (r.url.path.endsWith('/capabilities')) {
            return _json({
              'skills': [
                {
                  'name': 'office',
                  'description': 'documents',
                  'available': true,
                  'enabled': false,
                },
              ],
            });
          }
          if (r.method == 'GET') {
            return _json({
              'skills': [
                {'name': 'office'},
              ],
              'enabled': ['hidden-existing'],
            });
          }
          saved = jsonDecode(r.body)['enabled'];
          return _json({'ok': true, 'enabled': saved});
        }),
      );
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(saved, ['hidden-existing', 'office']);
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
      expect(find.text('选择已保存，下次任务按实际权限生效。'), findsOneWidget);
    },
  );

  testWidgets(
    'account switch during selection lookup prevents write and hides old catalog',
    (tester) async {
      final lookup = Completer<http.Response>();
      var writes = 0;
      final state = await _show(
        tester,
        const SkillCatalogScreen(),
        _api((r) async {
          if (r.url.path.endsWith('/capabilities')) {
            return _json({
              'skills': [
                {'name': 'private-skill', 'available': true},
              ],
            });
          }
          if (r.method == 'GET') return lookup.future;
          writes++;
          return _json({'ok': true});
        }),
      );
      await tester.tap(find.byType(Switch));
      await tester.pump();
      state.changeIdentity();
      await tester.pump();
      lookup.complete(
        _json({
          'skills': [
            {'name': 'private-skill'},
          ],
          'enabled': [],
        }),
      );
      await tester.pumpAndSettle();
      expect(writes, 0);
      expect(find.text('private-skill'), findsNothing);
      expect(find.text('账号或服务已切换，请关闭后重新打开。'), findsOneWidget);
    },
  );

  testWidgets('skill content uses immutable checksum and character offsets', (
    tester,
  ) async {
    final offsets = <String>[];
    await _show(
      tester,
      const SkillDetailScreen(name: 'office'),
      _api((r) async {
        if (r.url.path.endsWith('/details')) {
          return _json({
            'checksum': 'version-one',
            'files': [
              {'path': 'SKILL.md', 'bytes': 12},
            ],
          });
        }
        expect(r.url.queryParameters['checksum'], 'version-one');
        expect(r.url.queryParameters['path'], 'SKILL.md');
        offsets.add(r.url.queryParameters['offset']!);
        return _json(
          offsets.length == 1
              ? {'kind': 'text', 'text': '原文', 'nextOffset': 2}
              : {'kind': 'text', 'text': '后续', 'nextOffset': null},
        );
      }),
    );
    await tester.tap(find.text('SKILL.md'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('继续读取'));
    await tester.pumpAndSettle();
    expect(offsets, ['0', '2']);
    expect(find.text('原文后续'), findsOneWidget);
  });

  testWidgets(
    'connector toggle sends one intent without connection credentials',
    (tester) async {
      Map<String, dynamic>? body;
      final catalog = {
        'company': [
          {'id': 'company-id', 'name': '公司工具', 'selected': false},
        ],
        'personal': [],
      };
      await _show(
        tester,
        const ConnectorCatalogScreen(),
        _api((r) async {
          if (r.method == 'PATCH') {
            expect(r.url.path, '/api/v1/mcp-servers/selection');
            body = jsonDecode(r.body);
            return _json({
              'ok': true,
              'company': [
                {'id': 'company-id', 'name': '公司工具', 'selected': true},
              ],
              'personal': [],
            });
          }
          return _json(catalog);
        }),
      );
      await tester.tap(find.byType(Switch));
      await tester.pumpAndSettle();
      expect(body, {
        'changes': [
          {'kind': 'company', 'id': '公司工具', 'enabled': true},
        ],
      });
      expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    },
  );

  testWidgets(
    'connector editor invalidates preflight and preserves masked secrets on edit',
    (tester) async {
      final original = <String, dynamic>{
        'id': 'original-id',
        'name': '连接',
        'type': 'http',
        'url': 'https://example.com/mcp',
        'headers': {'Authorization': '***', 'X-Api-Key': '***'},
        'enabled': false,
      };
      Map<String, dynamic>? checked, saved;
      await _show(
        tester,
        ConnectorEditorScreen(original: original),
        _api((r) async {
          if (r.url.path.endsWith('/capabilities')) {
            return _json({'mcpTemplates': []});
          }
          if (r.url.path.endsWith('/preflight')) {
            checked = jsonDecode(r.body);
            return _json({'ok': true});
          }
          if (r.url.path.endsWith('/upsert')) {
            saved = jsonDecode(r.body);
            return _json({'ok': true});
          }
          throw StateError('Unexpected request ${r.url}');
        }),
      );
      await tester.ensureVisible(find.byType(CheckboxListTile));
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('检查配置'));
      await tester.tap(find.text('检查配置'));
      await tester.pumpAndSettle();
      expect(checked?['headers'], original['headers']);
      final name = find.widgetWithText(TextFormField, '连接名称');
      await tester.ensureVisible(name);
      await tester.enterText(name, '新名称');
      await tester.pumpAndSettle();
      expect(find.text('保存配置'), findsNothing);
      await tester.ensureVisible(find.byType(CheckboxListTile));
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('检查配置'));
      await tester.tap(find.text('检查配置'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('保存配置'));
      await tester.tap(find.text('保存配置'));
      await tester.pumpAndSettle();
      expect(saved?['original'], original);
      expect(saved?['server']['id'], 'original-id');
      expect(saved?['server']['headers'], original['headers']);
      expect(saved?['server']['name'], '新名称');
    },
  );

  testWidgets(
    'capability tabs retain plugin search and market excludes personal/unlisted',
    (tester) async {
      await _show(
        tester,
        const CapabilityCenterScreen(),
        _api((r) async {
          if (r.url.path.endsWith('/capabilities')) {
            return _json({'skills': []});
          }
          return _json({
            'items': [
              {'name': '个人方法', 'personal': true},
              {'name': '隐藏目录', 'listed': false},
              {'name': '企业插件', 'listed': true},
            ],
          });
        }),
      );
      await tester.tap(find.text('企业目录'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '个人方法');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ChoiceChip, '技能'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ChoiceChip, '插件'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '个人方法',
      );
      await tester.tap(find.widgetWithText(ChoiceChip, '市场'));
      await tester.pumpAndSettle();
      expect(find.text('企业插件'), findsOneWidget);
      expect(find.text('个人方法'), findsNothing);
      expect(find.text('隐藏目录'), findsNothing);
      expect(find.text('我的提交'), findsNothing);
    },
  );
}

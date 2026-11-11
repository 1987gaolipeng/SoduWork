import 'memory_device_auth.dart';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/ai_resources_screen.dart';
import 'package:soduwork_mobile/screens/profile_screen.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets('cloud page reads only existing cloud environment API', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(
          home: const AiResourcesScreen(section: AiResourceSection.cloud),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(state.requests, ['/api/v1/cloud-environments']);
    expect(find.text('测试所选模型连接'), findsNothing);
    expect(find.textContaining('尚无可用云端环境'), findsOneWidget);
  });

  testWidgets(
    'opening resources preserves current dark enterprise theme across navigation',
    (tester) async {
      const brand = SoduWorkBrandTheme(
        brightness: Brightness.dark,
        primary: Color(0xFF31B7A9),
      );
      final state = _State();
      addTearDown(state.dispose);
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: MaterialApp(
            theme: SoduWorkTheme.light(),
            home: Theme(
              data: SoduWorkTheme.light(brand),
              child: const Scaffold(body: ProfileScreen()),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('我的模型'));
      await tester.tap(find.text('我的模型'));
      await tester.pumpAndSettle();
      final theme = Theme.of(tester.element(find.byType(AiResourcesScreen)));
      expect(
        tester
            .widget<AiResourcesScreen>(find.byType(AiResourcesScreen))
            .section,
        AiResourceSection.models,
      );
      expect(
        state.requests.where((route) => route.contains('cloud-environments')),
        isEmpty,
      );
      expect(theme.brightness, Brightness.dark);
      expect(theme.colorScheme.primary, brand.primary);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('resource refresh retains explicit model selection', (
    tester,
  ) async {
    final state = _State();
    addTearDown(state.dispose);
    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(
          theme: SoduWorkTheme.light(),
          home: const AiResourcesScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('模型 B'));
    await tester.tap(find.byTooltip('刷新资源'));
    await tester.pumpAndSettle();
    expect(
      tester.widget<ListTile>(find.widgetWithText(ListTile, '模型 B')).selected,
      isTrue,
    );
    expect(
      tester.widget<ListTile>(find.widgetWithText(ListTile, '模型 A')).selected,
      isFalse,
    );
    expect(
      state.requests.where((route) => route.contains('ai-proxy')),
      isEmpty,
    );
  });
}

class _State extends MobileState {
  final requests = <String>[];
  _State() {
    api = SoduWorkApi(
      store: _Store(),
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://hub.test',
      ),
      client: MockClient((request) async {
        requests.add(request.url.path);
        return http.Response(
          jsonEncode(
            request.url.path.endsWith('/ai-agents')
                ? {
                    'defaultModel': 'a',
                    'modelOptions': [
                      {'name': 'a', 'label': '模型 A'},
                      {'name': 'b', 'label': '模型 B'},
                    ],
                  }
                : {'environments': []},
          ),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
  }
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
}

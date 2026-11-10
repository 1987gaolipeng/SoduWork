import 'memory_device_auth.dart';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/mobile_app.dart';
import 'package:soduwork_mobile/main.dart' as standalone;
import 'package:soduwork_mobile/state/mobile_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the shipping standalone entry leaves Hub selection editable', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({
      'soduwork_mobile.environment': 'development',
      'soduwork_mobile.development_url': '',
    });
    standalone.main();
    await tester.pumpAndSettle();
    final app = tester.widget<SoduWorkMobileApp>(
      find.byType(SoduWorkMobileApp),
    );
    expect(app.configuration.lockServiceEndpoint, isFalse);
    expect(find.text('服务地址'), findsOneWidget);
    final input = find.byType(TextField);
    await tester.enterText(input, 'https://stage.example.com');
    expect(
      tester.widget<TextField>(input).controller!.text,
      'https://stage.example.com',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
  });

  test('fresh settings use only an explicit build endpoint', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final endpoint = EndpointSettings.load(prefs);
    const configured = String.fromEnvironment('SODUWORK_HUB_URL');
    expect(EndpointSettings.productionUrl, configured);
    expect(endpoint.baseUrl, EndpointSettings.normalize(configured));
    expect(
      endpoint.environment,
      configured.trim().isEmpty
          ? SoduWorkEnvironment.development
          : SoduWorkEnvironment.production,
    );
    expect(prefs.getKeys(), isEmpty);
  });

  test(
    'saved custom service wins over a new build default without changing identity keys',
    () async {
      SharedPreferences.setMockInitialValues({
        'soduwork_mobile.environment': 'development',
        'soduwork_mobile.development_url': 'https://tenant.example.test/api/v1/',
        'soduwork_mobile.device_id.existing': 'existing-device',
      });
      final prefs = await SharedPreferences.getInstance();
      final endpoint = EndpointSettings.load(prefs);
      expect(endpoint.environment, SoduWorkEnvironment.development);
      expect(endpoint.baseUrl, 'https://tenant.example.test');
      expect(
        prefs.getString('soduwork_mobile.device_id.existing'),
        'existing-device',
      );
      expect(
        prefs.getString('soduwork_mobile.development_url'),
        'https://tenant.example.test/api/v1/',
      );
    },
  );

  test(
    'explicit enterprise build restores production without clearing saved custom settings',
    () async {
      SharedPreferences.setMockInitialValues({
        'soduwork_mobile.environment': 'production',
        'soduwork_mobile.development_url': 'https://saved.example.test',
      });
      final prefs = await SharedPreferences.getInstance();
      final endpoint = EndpointSettings.load(prefs);
      expect(
        endpoint.baseUrl,
        EndpointSettings.productionUrl.trim().isEmpty
            ? 'https://saved.example.test'
            : EndpointSettings.normalize(EndpointSettings.productionUrl),
      );
      expect(prefs.getString('soduwork_mobile.environment'), 'production');
      expect(
        prefs.getString('soduwork_mobile.development_url'),
        'https://saved.example.test',
      );
    },
  );

  test(
    'legacy explicitly configured service retains device identity and session',
    () async {
      const endpoint = 'http://192.0.2.149:8989';
      final suffix = base64Url
          .encode(utf8.encode(endpoint))
          .replaceAll('=', '');
      SharedPreferences.setMockInitialValues({});
      FlutterSecureStorage.setMockInitialValues({
        'soduwork_mobile.device_id.$suffix': 'existing-device',
        'soduwork_mobile.device_secret.$suffix': 'fixture-device-secret',
        'soduwork_mobile.session.$suffix': 'fixture-session',
      });
      final store = DeviceStore();
      await store.init();
      final credentials = await store.credentials('$endpoint/api/v1/');
      expect(credentials.id, 'existing-device');
      expect(credentials.secret, 'fixture-device-secret');
      expect(await store.readSession(endpoint), 'fixture-session');
      expect(await store.readSession('https://different.example.test'), isNull);
      expect(await store.readSession(endpoint), 'fixture-session');
    },
  );

  test('empty service initializes without enrollment or credentials', () async {
    final store = _EmptyStore();
    final state = MobileState(store: store);
    addTearDown(state.dispose);
    await state.init();
    expect(state.phase, MobilePhase.disconnected);
    expect(state.blockingError, isEmpty);
    expect(state.enrollment, isNull);
    expect(store.credentialRequests, 0);
    await state.connect();
    expect(state.phase, MobilePhase.disconnected);
    expect(store.credentialRequests, 0);
  });

  test(
    'blank manual configuration is rejected before persistence or enrollment',
    () async {
      final store = _EmptyStore();
      final state = MobileState(store: store);
      addTearDown(state.dispose);
      await state.init();
      await expectLater(
        state.setEndpoint(
          environment: SoduWorkEnvironment.development,
          developmentUrl: '  ',
        ),
        throwsA(isA<ApiFailure>()),
      );
      expect(store.credentialRequests, 0);
      expect(store.savedEndpoints, 0);
    },
  );

  testWidgets('unconfigured source app shows the address input immediately', (
    tester,
  ) async {
    final state = MobileState(store: _EmptyStore());
    addTearDown(state.dispose);
    await state.init();
    await tester.pumpWidget(SoduWorkMobileApp(state: state));
    await tester.pumpAndSettle();
    expect(find.text('服务地址'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
    );
    expect(
      find.byType(SegmentedButton<SoduWorkEnvironment>),
      EndpointSettings.productionUrl.trim().isEmpty
          ? findsNothing
          : findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}

class _EmptyStore extends DeviceStore with MemoryDeviceAuthentication {
  int credentialRequests = 0;
  int savedEndpoints = 0;

  @override
  Future<void> init() async {}

  @override
  EndpointSettings loadEndpoint() => const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: '',
  );

  @override
  Future<void> saveEndpoint(EndpointSettings endpoint) async {
    savedEndpoints++;
  }

  @override
  Future<DeviceCredentials> credentials(String endpoint) async {
    credentialRequests++;
    throw StateError('Unconfigured startup must never attempt enrollment');
  }
}

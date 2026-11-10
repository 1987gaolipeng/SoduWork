import 'memory_device_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/soduwork_mobile_sdk.dart';

void main() {
  test('brand manifest is validated and remains serializable', () {
    final theme = SoduWorkBrandTheme.fromJson({
      'brandName': 'Northwind',
      'assistantName': 'Nova',
      'colors': {
        'primary': '#2457D6',
        'surface': '#FFFDFB',
        'ink': 'not-a-color',
        'secondary': -1,
      },
      'shape': {'small': -4, 'medium': 0, 'large': 80},
      'markColors': ['#2457D6', '#16A085', '#F39C12', '#8E44AD'],
    });

    expect(theme.brandName, 'Northwind');
    expect(theme.assistantName, 'Nova');
    expect(theme.primary, const Color(0xFF2457D6));
    expect(theme.surface, const Color(0xFFFFFDFB));
    expect(theme.ink, const SoduWorkBrandTheme().ink);
    expect(theme.secondary, const SoduWorkBrandTheme().secondary);
    expect(theme.radiusSmall, 0);
    expect(theme.radiusMedium, 0);
    expect(theme.radiusLarge, 32);
    expect(theme.markColors, hasLength(4));
    expect(theme.toJson()['schemaVersion'], 1);
  });

  test('unsupported manifests and incomplete marks fail safely', () {
    const fallback = SoduWorkBrandTheme(brandName: 'Safe brand');
    final unsupported = SoduWorkBrandTheme.fromJson({
      'schemaVersion': 2,
      'brandName': 'Unknown contract',
    }, fallback: fallback);
    const incomplete = SoduWorkBrandTheme(markColors: [Color(0xFF112233)]);

    expect(unsupported, same(fallback));
    expect(incomplete.effectiveMarkColors, hasLength(4));
    expect(incomplete.effectiveMarkColors.first, const Color(0xFF112233));
    expect(incomplete.toJson()['markColors'], hasLength(4));
    expect(() => incomplete.lerp(const SoduWorkBrandTheme(), .5), returnsNormally);
  });

  test('enterprise endpoint lock protects the host tenant', () async {
    final state = MobileState(
      initialEndpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.production,
        baseUrl: 'https://tenant.example.com',
      ),
      endpointLocked: true,
    );
    addTearDown(state.dispose);

    expect(state.endpoint.baseUrl, 'https://tenant.example.com');
    await expectLater(
      state.setEndpoint(
        environment: SoduWorkEnvironment.development,
        developmentUrl: 'http://127.0.0.1:9080',
      ),
      throwsA(
        isA<ApiFailure>().having(
          (error) => error.message,
          'message',
          contains('企业应用'),
        ),
      ),
    );
  });

  test(
    'manual connection mode initializes without contacting the service',
    () async {
      final state = MobileState(store: _MemoryDeviceStore());
      addTearDown(state.dispose);

      await state.init(connectNow: false);

      expect(state.phase, MobilePhase.disconnected);
      expect(state.endpoint.baseUrl, EndpointSettings.productionUrl);
    },
  );

  testWidgets('embedded workspace applies a host skin at runtime', (
    tester,
  ) async {
    final state = MobileState()..phase = MobilePhase.ready;
    final brand = SoduWorkBrandController();
    addTearDown(state.dispose);
    addTearDown(brand.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: SoduWorkWorkspace(
          configuration: SoduWorkSdkConfiguration(
            autoConnect: false,
            assets: SoduWorkBrandAssets(
              markBuilder: (context, size) => SizedBox(
                key: const Key('enterprise-mark'),
                width: size,
                height: size,
              ),
            ),
          ),
          brandController: brand,
          state: state,
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('open-sidebar')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('enterprise-mark')), findsOneWidget);
    // The 3-tab shell has no assistant-name tab; brand identity shows
    // through the header mark's semantics label instead.
    final mark = tester.widget<Semantics>(
      find
          .ancestor(
            of: find.byKey(const Key('enterprise-mark')),
            matching: find.byType(Semantics),
          )
          .first,
    );
    expect(mark.properties.label, 'SoduWork');
    await tester.drag(find.byType(Drawer), const Offset(-500, 0));
    await tester.pumpAndSettle();

    brand.applyManifest({
      'brandName': 'Northwind Work',
      'assistantName': 'Nova',
      'colors': {'primary': '#2457D6', 'primarySoft': '#EAF0FF'},
      'shape': {'small': 0, 'medium': 0, 'large': 0},
    });
    await tester.pump();

    final navigation = tester.element(find.byKey(const Key('home-composer')));
    expect(Theme.of(navigation).colorScheme.primary, const Color(0xFF2457D6));
    for (var index = 0; index < 3; index += 1) {
      state.selectTab(index);
      await tester.pump();
      expect(tester.takeException(), isNull);
    }

    brand.updateAssets(
      SoduWorkBrandAssets(
        markBuilder: (context, size) =>
            SizedBox(key: const Key('runtime-mark'), width: size, height: size),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('enterprise-mark')), findsNothing);
    expect(find.byKey(const Key('runtime-mark')), findsOneWidget);
    final renamedMark = tester.widget<Semantics>(
      find
          .ancestor(
            of: find.byKey(const Key('runtime-mark')),
            matching: find.byType(Semantics),
          )
          .first,
    );
    expect(renamedMark.properties.label, 'Northwind Work');
  });

  testWidgets('zero-radius enterprise skin also renders the connection page', (
    tester,
  ) async {
    final state = MobileState()..phase = MobilePhase.disconnected;
    addTearDown(state.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: SoduWorkWorkspace(
          configuration: const SoduWorkSdkConfiguration(
            autoConnect: false,
            initialTheme: SoduWorkBrandTheme(
              radiusSmall: 0,
              radiusMedium: 0,
              radiusLarge: 0,
            ),
          ),
          state: state,
        ),
      ),
    );

    expect(find.text('连接到你的企业'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

class _MemoryDeviceStore extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<void> init() async {}

  @override
  EndpointSettings loadEndpoint() => const EndpointSettings(
    environment: SoduWorkEnvironment.production,
    baseUrl: EndpointSettings.productionUrl,
  );
}

import 'dart:async';

import 'package:flutter/material.dart';

import 'core/device_store.dart';

import 'screens/app_shell.dart';
import 'screens/connect_screen.dart';
import 'sdk/soduwork_brand.dart';
import 'sdk/soduwork_sdk_config.dart';
import 'state/mobile_scope.dart';
import 'state/mobile_state.dart';
import 'ui/mobile_theme.dart';
import 'ui/mobile_display_preferences.dart';
import 'ui/mobile_sheet.dart';
import 'ui/work_widgets.dart';

/// Standalone application shell. Enterprise Flutter applications normally
/// embed [SoduWorkWorkspace] instead, while sharing this exact implementation.
class SoduWorkMobileApp extends StatefulWidget {
  final SoduWorkSdkConfiguration configuration;
  final SoduWorkBrandController? brandController;
  final MobileState? state;

  const SoduWorkMobileApp({
    super.key,
    this.configuration = const SoduWorkSdkConfiguration(),
    this.brandController,
    this.state,
  });

  @override
  State<SoduWorkMobileApp> createState() => _SoduWorkMobileAppState();
}

class _SoduWorkMobileAppState extends State<SoduWorkMobileApp> {
  late SoduWorkBrandController _brandController;
  late bool _ownsBrandController;

  @override
  void initState() {
    super.initState();
    _attachBrandController();
  }

  @override
  void didUpdateWidget(SoduWorkMobileApp oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.brandController != widget.brandController) {
      if (_ownsBrandController) _brandController.dispose();
      _attachBrandController();
    } else if (_ownsBrandController &&
        oldWidget.configuration.initialTheme !=
            widget.configuration.initialTheme) {
      _brandController.updateTheme(widget.configuration.initialTheme);
    }
    if (_ownsBrandController &&
        oldWidget.configuration.assets != widget.configuration.assets) {
      _brandController.updateAssets(widget.configuration.assets);
    }
  }

  void _attachBrandController() {
    _ownsBrandController = widget.brandController == null;
    _brandController =
        widget.brandController ??
        SoduWorkBrandController(
          widget.configuration.initialTheme,
          widget.configuration.assets,
        );
  }

  @override
  void dispose() {
    if (_ownsBrandController) _brandController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<SoduWorkBrandTheme>(
      valueListenable: _brandController,
      builder: (context, brand, _) => MaterialApp(
        debugShowCheckedModeBanner: false,
        title: brand.brandName,
        theme: SoduWorkTheme.light(brand),
        home: SoduWorkWorkspace(
          configuration: widget.configuration.copyWith(
            initialTheme: brand,
            assets: _brandController.resolveAssets(widget.configuration.assets),
          ),
          brandController: _brandController,
          state: widget.state,
        ),
      ),
    );
  }
}

/// Embeddable SoduWork experience for a host enterprise application.
///
/// It owns an isolated business state and nested navigator by default. A host
/// may pass its own [MobileState] for lifecycle control and a shared
/// [SoduWorkBrandController] to update the skin while the workspace is visible.
class SoduWorkWorkspace extends StatefulWidget {
  final SoduWorkSdkConfiguration configuration;
  final SoduWorkBrandController? brandController;
  final MobileState? state;
  final GlobalKey<NavigatorState>? navigatorKey;

  const SoduWorkWorkspace({
    super.key,
    this.configuration = const SoduWorkSdkConfiguration(),
    this.brandController,
    this.state,
    this.navigatorKey,
  });

  @override
  State<SoduWorkWorkspace> createState() => _SoduWorkWorkspaceState();
}

class _SoduWorkWorkspaceState extends State<SoduWorkWorkspace> {
  final _displaySettings = MobileDisplayPreferences();
  late MobileState _state;
  late bool _ownsState;
  late SoduWorkBrandController _brandController;
  late bool _ownsBrandController;
  late GlobalKey<NavigatorState> _navigatorKey;
  int _lastIdentity = -1;

  @override
  void initState() {
    super.initState();
    _attachState();
    _attachBrandController();
    _navigatorKey = widget.navigatorKey ?? GlobalKey<NavigatorState>();
    unawaited(_displaySettings.restore());
  }

  @override
  void didUpdateWidget(SoduWorkWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    final ownedStateConfigurationChanged =
        widget.state == null &&
        (oldWidget.configuration.autoConnect !=
                widget.configuration.autoConnect ||
            oldWidget.configuration.restoreSavedSession !=
                widget.configuration.restoreSavedSession ||
            oldWidget.configuration.serviceBaseUrl !=
                widget.configuration.serviceBaseUrl ||
            oldWidget.configuration.lockServiceEndpoint !=
                widget.configuration.lockServiceEndpoint ||
            oldWidget.configuration.deviceDisplayName !=
                widget.configuration.deviceDisplayName);
    if (oldWidget.state != widget.state || ownedStateConfigurationChanged) {
      _state.removeListener(_identityChanged);
      if (_ownsState) _state.dispose();
      _attachState();
    }
    if (oldWidget.brandController != widget.brandController) {
      if (_ownsBrandController) _brandController.dispose();
      _attachBrandController();
    } else if (_ownsBrandController &&
        oldWidget.configuration.initialTheme !=
            widget.configuration.initialTheme) {
      _brandController.updateTheme(widget.configuration.initialTheme);
    }
    if (_ownsBrandController &&
        oldWidget.configuration.assets != widget.configuration.assets) {
      _brandController.updateAssets(widget.configuration.assets);
    }
    if (oldWidget.navigatorKey != widget.navigatorKey) {
      _navigatorKey = widget.navigatorKey ?? GlobalKey<NavigatorState>();
    }
  }

  void _attachState() {
    _ownsState = widget.state == null;
    _state = widget.state ?? _createState();
    _lastIdentity = _state.identityRevision;
    _state.addListener(_identityChanged);
    if (_ownsState) {
      unawaited(
        _state.init(
          connectNow: widget.configuration.autoConnect,
          restoreSavedSession: widget.configuration.restoreSavedSession,
        ),
      );
    }
  }

  void _identityChanged() {
    if (_lastIdentity == _state.identityRevision) return;
    _lastIdentity = _state.identityRevision;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    });
  }

  MobileState _createState() {
    final configuredUrl = EndpointSettings.normalize(
      widget.configuration.serviceBaseUrl,
    );
    if (widget.configuration.lockServiceEndpoint && configuredUrl.isEmpty) {
      throw ArgumentError.value(
        widget.configuration.serviceBaseUrl,
        'serviceBaseUrl',
        'A locked enterprise SDK endpoint cannot be empty.',
      );
    }
    final deviceName = widget.configuration.deviceDisplayName.trim();
    return MobileState(
      initialEndpoint: configuredUrl.isEmpty
          ? null
          : EndpointSettings(
              environment: SoduWorkEnvironment.production,
              baseUrl: configuredUrl,
            ),
      endpointLocked: widget.configuration.lockServiceEndpoint,
      deviceDisplayName: deviceName.isEmpty
          ? '${widget.configuration.initialTheme.brandName} Mobile'
          : deviceName,
    );
  }

  void _attachBrandController() {
    _ownsBrandController = widget.brandController == null;
    _brandController =
        widget.brandController ??
        SoduWorkBrandController(
          widget.configuration.initialTheme,
          widget.configuration.assets,
        );
  }

  @override
  void dispose() {
    _state.removeListener(_identityChanged);
    _displaySettings.dispose();
    if (_ownsState) _state.dispose();
    if (_ownsBrandController) _brandController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<SoduWorkBrandTheme>(
      valueListenable: _brandController,
      builder: (context, brand, _) => SoduWorkSdkScope(
        configuration: widget.configuration.copyWith(
          initialTheme: brand,
          assets: _brandController.resolveAssets(widget.configuration.assets),
        ),
        child: MobilePresentationTheme(
          preferences: _displaySettings,
          base: brand,
          child: MobileScope(
            state: _state,
            child: Navigator(
              key: _navigatorKey,
              onGenerateRoute: (settings) => MaterialPageRoute<void>(
                settings: settings,
                builder: (_) => const _AppRoot(),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AppRoot extends StatelessWidget {
  const _AppRoot();

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    return switch (state.phase) {
      MobilePhase.booting => const _BootScreen(),
      MobilePhase.connecting
          when state.enrollment == null && !state.authenticatingAccount =>
        const _BootScreen(),
      MobilePhase.ready => const AppShell(),
      _ => const ConnectScreen(),
    };
  }
}

class _BootScreen extends StatelessWidget {
  const _BootScreen();

  @override
  Widget build(BuildContext context) {
    final brand = context.soduWorkTheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SoduWorkMark(size: 52),
              const SizedBox(height: 18),
              Text(
                brand.brandName,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 18),
              const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2.2),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/widgets.dart';

import 'soduwork_brand.dart';

@immutable
class SoduWorkSdkConfiguration {
  final SoduWorkBrandTheme initialTheme;
  final SoduWorkBrandAssets assets;
  final bool autoConnect;
  final bool restoreSavedSession;
  final String integrationId;

  /// Empty in the standalone app, where the employee can switch environments.
  /// Enterprise hosts should inject their tenant endpoint here.
  final String serviceBaseUrl;

  /// Display only; never used for requests, authentication or permission checks.
  final String serviceDisplayName;
  final bool lockServiceEndpoint;
  final String deviceDisplayName;

  const SoduWorkSdkConfiguration({
    this.initialTheme = const SoduWorkBrandTheme(),
    this.assets = const SoduWorkBrandAssets(),
    this.autoConnect = true,
    this.restoreSavedSession = false,
    this.integrationId = 'standalone',
    this.serviceBaseUrl = '',
    this.serviceDisplayName = '',
    this.lockServiceEndpoint = false,
    this.deviceDisplayName = '',
  });

  SoduWorkSdkConfiguration copyWith({
    SoduWorkBrandTheme? initialTheme,
    SoduWorkBrandAssets? assets,
    bool? autoConnect,
    bool? restoreSavedSession,
    String? integrationId,
    String? serviceBaseUrl,
    String? serviceDisplayName,
    bool? lockServiceEndpoint,
    String? deviceDisplayName,
  }) => SoduWorkSdkConfiguration(
    initialTheme: initialTheme ?? this.initialTheme,
    assets: assets ?? this.assets,
    autoConnect: autoConnect ?? this.autoConnect,
    restoreSavedSession: restoreSavedSession ?? this.restoreSavedSession,
    integrationId: integrationId ?? this.integrationId,
    serviceBaseUrl: serviceBaseUrl ?? this.serviceBaseUrl,
    serviceDisplayName: serviceDisplayName ?? this.serviceDisplayName,
    lockServiceEndpoint: lockServiceEndpoint ?? this.lockServiceEndpoint,
    deviceDisplayName: deviceDisplayName ?? this.deviceDisplayName,
  );
}

class SoduWorkSdkScope extends InheritedWidget {
  final SoduWorkSdkConfiguration configuration;

  const SoduWorkSdkScope({
    super.key,
    required this.configuration,
    required super.child,
  });

  static SoduWorkSdkConfiguration? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SoduWorkSdkScope>()?.configuration;

  static SoduWorkSdkConfiguration of(BuildContext context) {
    final configuration = maybeOf(context);
    assert(configuration != null, 'SoduWorkSdkScope is missing above this context');
    return configuration!;
  }

  @override
  bool updateShouldNotify(SoduWorkSdkScope oldWidget) =>
      configuration != oldWidget.configuration;
}

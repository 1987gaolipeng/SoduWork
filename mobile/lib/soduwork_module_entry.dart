import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'mobile_app.dart';
import 'sdk/soduwork_brand.dart';
import 'sdk/soduwork_sdk_config.dart';

const _hostChannel = MethodChannel('com.soduwork.mobile/sdk');
const _maxMarkBytes = 512 * 1024;

/// Add-to-app entry point for Android AAR and iOS Framework hosts.
///
/// The host should register a `bootstrap` method before starting the Flutter
/// engine. It may later call `applyTheme` with the same theme manifest shape.
@pragma('vm:entry-point')
Future<void> soduWorkModuleMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  final bootstrap = await _loadBootstrap();
  final theme = SoduWorkBrandTheme.fromJson(_themeManifest(bootstrap));
  final controller = SoduWorkBrandController(theme);
  final initialAssets = _brandAssets(bootstrap);
  final serviceBaseUrl = _text(bootstrap['serviceBaseUrl']);

  _hostChannel.setMethodCallHandler((call) async {
    if (call.method == 'applyTheme') {
      final payload = _map(call.arguments);
      final manifest = _themeManifest(payload);
      if (!_supportsThemeManifest(manifest)) {
        return {
          'ok': false,
          'schemaVersion': 1,
          'error': 'unsupported_theme_schema',
        };
      }
      controller.applyManifest(manifest);
      final nextAssets = _brandAssets(payload);
      if (nextAssets != null) controller.updateAssets(nextAssets);
      return {
        'ok': true,
        'schemaVersion': 1,
        'assetsUpdated': nextAssets != null,
      };
    }
    if (call.method == 'themeSnapshot') return controller.theme.toJson();
    throw MissingPluginException('Unsupported SoduWork SDK method: ${call.method}');
  });

  runApp(
    SoduWorkMobileApp(
      brandController: controller,
      configuration: SoduWorkSdkConfiguration(
        initialTheme: theme,
        assets: initialAssets ?? const SoduWorkBrandAssets(),
        integrationId: _text(bootstrap['integrationId'], 'native-host'),
        serviceBaseUrl: serviceBaseUrl,
        lockServiceEndpoint:
            serviceBaseUrl.isNotEmpty &&
            bootstrap['lockServiceEndpoint'] != false,
        deviceDisplayName: _text(bootstrap['deviceDisplayName']),
      ),
    ),
  );
}

Future<Map<String, dynamic>> _loadBootstrap() async {
  try {
    final value = await _hostChannel
        .invokeMapMethod<String, dynamic>('bootstrap')
        .timeout(const Duration(seconds: 3));
    return value ?? const {};
  } on TimeoutException {
    return const {};
  } on MissingPluginException {
    return const {};
  } on PlatformException {
    return const {};
  }
}

Map<String, dynamic> _themeManifest(Map<String, dynamic> payload) {
  final nested = _map(payload['theme']);
  return nested.isEmpty ? payload : nested;
}

bool _supportsThemeManifest(Map<String, dynamic> manifest) {
  final version = manifest['schemaVersion'];
  return version == null || version.toString().trim() == '1';
}

SoduWorkBrandAssets? _brandAssets(Map<String, dynamic> payload) {
  if (payload['clearMark'] == true) return const SoduWorkBrandAssets();
  var encoded = _text(payload['markPngBase64']);
  if (encoded.isEmpty || encoded.length > 750000) return null;
  final comma = encoded.indexOf(',');
  if (encoded.startsWith('data:') && comma >= 0) {
    encoded = encoded.substring(comma + 1);
  }
  try {
    final bytes = base64Decode(encoded);
    if (bytes.isEmpty ||
        bytes.length > _maxMarkBytes ||
        !_isSupportedImage(bytes)) {
      return null;
    }
    return SoduWorkBrandAssets(
      markBuilder: (context, size) {
        final pixels = (size * MediaQuery.devicePixelRatioOf(context))
            .ceil()
            .clamp(1, 1024)
            .toInt();
        return Image.memory(
          bytes,
          width: size,
          height: size,
          cacheWidth: pixels,
          cacheHeight: pixels,
          fit: BoxFit.contain,
          gaplessPlayback: true,
          filterQuality: FilterQuality.high,
        );
      },
    );
  } on FormatException {
    return null;
  }
}

bool _isSupportedImage(Uint8List bytes) {
  final png =
      bytes.length >= 8 &&
      bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4E &&
      bytes[3] == 0x47;
  final jpeg = bytes.length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8;
  return png || jpeg;
}

Map<String, dynamic> _map(dynamic value) => value is Map
    ? value.map((key, item) => MapEntry(key.toString(), item))
    : const {};

String _text(dynamic value, [String fallback = '']) {
  final text = value?.toString().trim() ?? '';
  return text.isEmpty ? fallback : text;
}

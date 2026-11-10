import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'platform_label.dart';

enum SoduWorkEnvironment { production, development }

extension SoduWorkEnvironmentLabel on SoduWorkEnvironment {
  String get label => this == SoduWorkEnvironment.production
      ? '\u751f\u4ea7\u73af\u5883'
      : '\u5f00\u53d1\u73af\u5883';
}

class EndpointSettings {
  // Standalone distributions select their service at build time. Unconfigured
  // source builds wait for an explicit address instead of contacting a company Hub.
  static const productionUrl = String.fromEnvironment('SODUWORK_HUB_URL');
  static const _environmentKey = 'soduwork_mobile.environment';
  static const _developmentUrlKey = 'soduwork_mobile.development_url';

  final SoduWorkEnvironment environment;
  final String baseUrl;

  const EndpointSettings({required this.environment, required this.baseUrl});

  bool get isProduction => environment == SoduWorkEnvironment.production;

  static String normalize(String value) {
    var result = value.trim();
    if (result.isEmpty) return '';
    if (!result.contains('://')) result = 'http://$result';
    result = result.replaceFirst(RegExp(r'/api/v1/?$'), '');
    return result.replaceFirst(RegExp(r'/+$'), '');
  }

  static EndpointSettings load(SharedPreferences prefs) {
    final saved = prefs.getString(_environmentKey);
    final environment = saved == 'development' || productionUrl.trim().isEmpty
        ? SoduWorkEnvironment.development
        : SoduWorkEnvironment.production;
    return EndpointSettings(
      environment: environment,
      baseUrl: environment == SoduWorkEnvironment.production
          ? normalize(productionUrl)
          : normalize(prefs.getString(_developmentUrlKey) ?? ''),
    );
  }

  Future<void> save(SharedPreferences prefs) async {
    await prefs.setString(
      _environmentKey,
      environment == SoduWorkEnvironment.production
          ? 'production'
          : 'development',
    );
    if (!isProduction) {
      await prefs.setString(_developmentUrlKey, normalize(baseUrl));
    }
  }
}

class DeviceCredentials {
  final String id;
  final String secret;
  final String name;
  final String platform;

  const DeviceCredentials({
    required this.id,
    required this.secret,
    required this.name,
    required this.platform,
  });
}

class DeviceStore {
  static const _secure = FlutterSecureStorage(aOptions: AndroidOptions());

  late SharedPreferences _prefs;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
  }

  EndpointSettings loadEndpoint() => EndpointSettings.load(_prefs);

  Future<void> saveEndpoint(EndpointSettings endpoint) => endpoint.save(_prefs);

  Future<DeviceCredentials> credentials(String endpoint) async {
    final suffix = _endpointKey(endpoint);
    final idKey = 'soduwork_mobile.device_id.$suffix';
    final secretKey = 'soduwork_mobile.device_secret.$suffix';

    var id = await _readProtected(idKey);
    var secret = await _readProtected(secretKey);
    if (id == null || id.isEmpty) {
      id = 'mobile-${_randomToken(10)}';
      await _writeProtected(idKey, id);
    }
    if (secret == null || secret.isEmpty) {
      secret = _randomToken(32);
      await _writeProtected(secretKey, secret);
    }
    final platform = _platformLabel;
    return DeviceCredentials(
      id: id,
      secret: secret,
      name: 'SoduWork Mobile \u00b7 $platform',
      platform: platform,
    );
  }

  final _authenticationWrites = <String, Future<void>>{};
  final _authenticationLocks = <String, bool>{};
  final _uncertainLogouts = <String, bool>{};

  Future<T> authenticationMutation<T>(
    String endpoint,
    Future<T> Function() action,
  ) {
    final key = _endpointKey(endpoint);
    final previous = _authenticationWrites[key] ?? Future<void>.value();
    final next = previous.then((_) => action());
    _authenticationWrites[key] = next.then<void>(
      (_) {},
      onError: (Object error, StackTrace stack) {},
    );
    return next;
  }

  Future<bool> isSignedOut(String endpoint) async =>
      _authenticationLocks[_endpointKey(endpoint)] ??
      _prefs.getBool('soduwork_mobile.signed_out.${_endpointKey(endpoint)}') ??
      false;

  Future<bool> hasUncertainLogout(String endpoint) async =>
      _uncertainLogouts[_endpointKey(endpoint)] ??
      _prefs.getBool(
        'soduwork_mobile.uncertain_logout.${_endpointKey(endpoint)}',
      ) ??
      false;

  Future<void> setAuthenticationLock(
    String endpoint, {
    required bool signedOut,
    required bool uncertainLogout,
  }) async {
    final key = _endpointKey(endpoint);
    // Lock immediately, but unlock only after both persistent writes succeed.
    _authenticationLocks[key] = true;
    _uncertainLogouts[key] = uncertainLogout;
    try {
      final saved = signedOut
          ? await _prefs.setBool('soduwork_mobile.signed_out.$key', true) &&
                await _prefs.setBool(
                  'soduwork_mobile.uncertain_logout.$key',
                  uncertainLogout,
                )
          : await _prefs.setBool(
                  'soduwork_mobile.uncertain_logout.$key',
                  uncertainLogout,
                ) &&
                await _prefs.setBool('soduwork_mobile.signed_out.$key', false);
      if (!saved) throw StateError('无法保存本机登录状态');
      _authenticationLocks[key] = signedOut;
    } catch (_) {
      // Best effort to restore the persistent lock; caller still receives the
      // original failure and must not claim a durable logout/login succeeded.
      try {
        await _prefs.setBool('soduwork_mobile.signed_out.$key', true);
      } catch (_) {
        /* The public result reports incomplete persistence. */
      }
      rethrow;
    }
  }

  Future<void> rotateDeviceIdentity(String endpoint) async {
    final key = _endpointKey(endpoint);
    await _deleteProtected('soduwork_mobile.device_id.$key');
    await _deleteProtected('soduwork_mobile.device_secret.$key');
    await clearSession(endpoint);
    await credentials(endpoint);
  }

  // The historical branch key also stores versioned ordinary-submission receipt
  // checkpoints. Keeping one scoped slot prevents two uncertain dispatches and
  // preserves branch recovery across app upgrades. Ordinary payloads are excluded.
  Future<String?> readPendingBranch(
    String endpoint,
    String owner,
    String deviceId,
  ) => _readProtected(
    'soduwork_mobile.branch.${_endpointKey(endpoint)}.${_endpointKey('$owner:$deviceId')}',
  );

  Future<void> writePendingBranch(
    String endpoint,
    String owner,
    String deviceId,
    String? value,
  ) => authenticationMutation(endpoint, () async {
    final key =
        'soduwork_mobile.branch.${_endpointKey(endpoint)}.${_endpointKey('$owner:$deviceId')}';
    if (value == null) {
      await _deleteProtected(key);
    } else {
      await _writeProtected(key, value);
    }
  });

  Future<String?> readSession(String endpoint) =>
      _readProtected('soduwork_mobile.session.${_endpointKey(endpoint)}');

  Future<String?> readPersonalRelay(
    String endpoint,
    String owner,
    String deviceId,
  ) => _readProtected(
    'soduwork_mobile.relay.${_endpointKey(endpoint)}.${_endpointKey('$owner:$deviceId')}',
  );

  Future<void> writePersonalRelay(
    String endpoint,
    String owner,
    String deviceId,
    String? value,
  ) => authenticationMutation(endpoint, () async {
    final key =
        'soduwork_mobile.relay.${_endpointKey(endpoint)}.${_endpointKey('$owner:$deviceId')}';
    if (value == null) {
      await _deleteProtected(key);
    } else {
      await _writeProtected(key, value);
    }
  });

  Future<void> writeSession(String endpoint, String session) => _writeProtected(
    'soduwork_mobile.session.${_endpointKey(endpoint)}',
    session,
  );

  Future<void> clearSession(String endpoint) =>
      _deleteProtected('soduwork_mobile.session.${_endpointKey(endpoint)}');

  Future<String?> _readProtected(String key) async {
    if (kIsWeb) return _prefs.getString(key);
    return _secure.read(key: key);
  }

  Future<void> _writeProtected(String key, String value) async {
    if (kIsWeb) {
      if (!await _prefs.setString(key, value)) throw StateError('本机保护数据保存失败');
      return;
    }
    await _secure.write(key: key, value: value);
  }

  Future<void> _deleteProtected(String key) async {
    if (kIsWeb) {
      if (!await _prefs.remove(key)) throw StateError('本机保护数据清除失败');
      return;
    }
    await _secure.delete(key: key);
  }

  static String _endpointKey(String endpoint) {
    return base64Url
        .encode(utf8.encode(EndpointSettings.normalize(endpoint)))
        .replaceAll('=', '');
  }

  static String _randomToken(int bytes) {
    final random = Random.secure();
    return base64Url
        .encode(List<int>.generate(bytes, (_) => random.nextInt(256)))
        .replaceAll('=', '');
  }

  static String get _platformLabel => platformLabel();
}

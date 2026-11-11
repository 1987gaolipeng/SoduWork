part of 'soduwork_api.dart';

int _retrySeconds(dynamic value) {
  final seconds = value is num ? value.toInt() : int.tryParse('$value') ?? 0;
  return seconds.clamp(0, 86400);
}

/// Public policy is authoritative; absent email fields mean an older Hub.
class ClientAuthPolicy {
  final bool supportsEmail;
  final bool mailReady;
  final bool allowSelfRegistration;
  final int passwordMinLength;
  final Map<String, String> requiredConsentVersions;
  final List<Map<String, dynamic>> legalDocuments;
  const ClientAuthPolicy({
    this.supportsEmail = false,
    this.mailReady = false,
    this.allowSelfRegistration = false,
    this.passwordMinLength = 8,
    this.requiredConsentVersions = const {},
    this.legalDocuments = const [],
  });
  factory ClientAuthPolicy.fromJson(Map<String, dynamic> value) {
    final versions = value['requiredConsentVersions'];
    final documents = value['legalDocuments'];
    final minimum = value['passwordMinLength'];
    return ClientAuthPolicy(
      supportsEmail: value['mailReady'] is bool,
      mailReady: value['mailReady'] == true,
      allowSelfRegistration: value['allowSelfRegistration'] == true,
      passwordMinLength: minimum is int && minimum >= 8 && minimum <= 128
          ? minimum
          : 8,
      requiredConsentVersions: Map.unmodifiable({
        if (versions is Map)
          for (final key in const ['terms', 'privacy'])
            if (versions[key] is String && (versions[key] as String).isNotEmpty)
              key: versions[key] as String,
      }),
      legalDocuments: List.unmodifiable(
        documents is List
            ? documents.whereType<Map>().map(
                (row) => Map<String, dynamic>.unmodifiable({
                  for (final key in const [
                    'key',
                    'title',
                    'version',
                    'content',
                  ])
                    if (row[key] is String) key: row[key],
                }),
              )
            : const <Map<String, dynamic>>[],
      ),
    );
  }
  bool get canRegister =>
      supportsEmail &&
      mailReady &&
      allowSelfRegistration &&
      requiredConsentVersions.containsKey('terms') &&
      requiredConsentVersions.containsKey('privacy');
}

class EmailAuthChallenge {
  final String id, email, purpose, endpoint, deviceId;
  final int authenticationRevision, retryAfter;
  final DateTime expiresAt, retryAt;
  final String deliveryState;
  const EmailAuthChallenge({
    required this.id,
    required this.email,
    required this.purpose,
    required this.endpoint,
    required this.deviceId,
    required this.authenticationRevision,
    required this.retryAfter,
    required this.expiresAt,
    required this.retryAt,
    required this.deliveryState,
  });
  bool get expired => !expiresAt.isAfter(DateTime.now());
}

class EmailCodeDelivery {
  final String challengeId, state, errorCode;
  const EmailCodeDelivery({
    required this.challengeId,
    required this.state,
    this.errorCode = '',
  });
  bool get pending => const {'queued', 'sending', 'retry'}.contains(state);
  bool get failed => const {'failed', 'expired'}.contains(state);
}

extension ClientEmailAuthentication on SoduWorkApi {
  Future<ClientAuthPolicy> authenticationPolicy() async {
    final result = await _emailRequest('GET', '/api/v1/client-auth/policy');
    return ClientAuthPolicy.fromJson(result);
  }

  Future<Map<String, dynamic>> _emailRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
    DeviceCredentials? device,
    int? revision,
    String? expectedEndpoint,
  }) async {
    final scope = expectedEndpoint ?? baseUrl;
    final epoch = revision ?? _authRevision;
    _checkEndpoint(scope, epoch);
    final request = http.Request(method, Uri.parse('$scope$path'))
      ..followRedirects = false
      ..headers.addAll({
        'Accept': 'application/json',
        if (body != null) 'Content-Type': 'application/json',
        if (device != null) 'X-Device-Key': device.secret,
      });
    if (body != null) request.body = jsonEncode(body);
    try {
      final response = await (() async => http.Response.fromStream(
        await client.send(request),
      ))().timeout(const Duration(seconds: 20));
      _checkEndpoint(scope, epoch);
      final decoded = _decode(response);
      final data = _asMap(decoded);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final detail = _asMap(data['detail']);
        throw ApiFailure(
          SoduWorkApi._error(decoded, response.statusCode),
          status: response.statusCode,
          code: _text(detail['code']),
          retryAfter: _retrySeconds(
            detail['retryAfter'] ?? response.headers['retry-after'],
          ),
        );
      }
      return data;
    } on ApiFailure {
      rethrow;
    } on TimeoutException {
      throw const ApiFailure('连接超时，请检查服务地址和网络后重试。', isNetwork: true);
    } on Exception {
      throw const ApiFailure('无法连接认证服务，请检查网络后重试。', isNetwork: true);
    }
  }

  Future<(DeviceCredentials, int, String)> _prepareEmailDevice() async {
    if (_signOutOperation != null || _accountLogins.containsKey(baseUrl)) {
      throw const ApiFailure('正在处理账号验证，请稍后重试。', status: 409);
    }
    final scope = baseUrl;
    invalidateAuthentication();
    final epoch = _authRevision;
    final device = await store.authenticationMutation(scope, () async {
      _checkEndpoint(scope, epoch);
      final rotate = await store.hasUncertainLogout(scope);
      _checkEndpoint(scope, epoch);
      await store.setAuthenticationLock(
        scope,
        signedOut: true,
        uncertainLogout: rotate,
      );
      await store.clearSession(scope);
      if (rotate) await store.rotateDeviceIdentity(scope);
      _checkEndpoint(scope, epoch);
      return store.credentials(scope);
    });
    _checkEndpoint(scope, epoch);
    // Explicit account verification may register a device, but must never
    // restore an earlier owner's enrollment session or bypass a revoked key.
    await _emailRequest(
      'POST',
      '/api/v1/clients/enroll',
      device: device,
      revision: epoch,
      expectedEndpoint: scope,
      body: {
        'device': device.id,
        'name': deviceDisplayName,
        'platform': device.platform,
        'version': '1.12.0',
      },
    );
    await store.authenticationMutation(scope, () async {
      _checkEndpoint(scope, epoch);
      await store.setAuthenticationLock(
        scope,
        signedOut: true,
        uncertainLogout: false,
      );
    });
    _checkEndpoint(scope, epoch);
    return (device, epoch, scope);
  }

  Future<EmailAuthChallenge> requestEmailCode({
    required String email,
    required String purpose,
  }) async {
    final normalized = email.trim();
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(normalized) ||
        normalized.length > 254 ||
        !const {'login', 'register', 'reset_password'}.contains(purpose)) {
      throw const ApiFailure('请输入有效的邮箱地址和验证码用途。', status: 422);
    }
    final (device, epoch, scope) = await _prepareEmailDevice();
    final data = await _emailRequest(
      'POST',
      '/api/v1/client-auth/email-challenges',
      device: device,
      revision: epoch,
      expectedEndpoint: scope,
      body: {'device': device.id, 'email': normalized, 'purpose': purpose},
    );
    final id = _text(data['challengeId']);
    final expires = _retrySeconds(data['expiresIn']);
    if (id.isEmpty || expires <= 0 || data['ok'] != true) {
      throw const ApiFailure('服务未返回有效验证码回执，请检查服务版本。');
    }
    final retry = _retrySeconds(data['retryAfter']);
    final now = DateTime.now();
    return EmailAuthChallenge(
      id: id,
      email: normalized,
      purpose: purpose,
      endpoint: scope,
      deviceId: device.id,
      authenticationRevision: epoch,
      retryAfter: retry,
      expiresAt: now.add(Duration(seconds: expires)),
      retryAt: now.add(Duration(seconds: retry)),
      deliveryState: _text(data['deliveryState'], fallback: 'unknown'),
    );
  }

  void _checkEmailChallenge(
    EmailAuthChallenge challenge, {
    String? purpose,
    String? code,
  }) {
    _checkEndpoint(challenge.endpoint, challenge.authenticationRevision);
    if (challenge.expired ||
        (purpose != null && challenge.purpose != purpose)) {
      throw const ApiFailure(
        '验证码已过期或用途已变化，请重新获取。',
        status: 422,
        code: 'EMAIL_CHALLENGE_EXPIRED',
      );
    }
    if (code != null && !RegExp(r'^\d{6}$').hasMatch(code)) {
      throw const ApiFailure('请输入 6 位验证码。', status: 422);
    }
  }

  Future<DeviceCredentials> _challengeDevice(
    EmailAuthChallenge challenge,
  ) async {
    final device = await store.credentials(challenge.endpoint);
    _checkEmailChallenge(challenge);
    if (device.id != challenge.deviceId) {
      throw const ApiFailure(
        '设备身份已变化，请重新获取验证码。',
        status: 409,
        code: 'EMAIL_DEVICE_CHANGED',
      );
    }
    return device;
  }

  Future<EmailCodeDelivery> emailCodeDelivery(
    EmailAuthChallenge challenge,
  ) async {
    _checkEmailChallenge(challenge);
    final device = await _challengeDevice(challenge);
    final data = await _emailRequest(
      'GET',
      '/api/v1/client-auth/email-challenges/${Uri.encodeComponent(challenge.id)}?device=${Uri.encodeQueryComponent(device.id)}',
      device: device,
      revision: challenge.authenticationRevision,
      expectedEndpoint: challenge.endpoint,
    );
    if (data['challengeId'] != challenge.id) {
      throw const ApiFailure('验证码发送状态不匹配，请重新获取。');
    }
    return EmailCodeDelivery(
      challengeId: challenge.id,
      state: _text(data['deliveryState'], fallback: 'unknown'),
      errorCode: _text(data['errorCode']),
    );
  }

  Future<EnrollmentState> _emailLogin(
    String path,
    Map<String, dynamic> body, {
    EmailAuthChallenge? challenge,
  }) {
    if (challenge != null) _checkEmailChallenge(challenge);
    final scope = baseUrl;
    final overlapping = _accountLogins.containsKey(scope);
    if (challenge != null && overlapping) {
      throw const ApiFailure('正在处理账号验证，请稍后重试。', status: 409);
    }
    final epoch = _authRevision;
    final operation =
        _performAccountLogin(
          account: '',
          password: '',
          replaceIdentity: overlapping,
          authenticationPath: path,
          authenticationBody: body,
          expectedDeviceId: challenge?.deviceId ?? '',
          invalidateBeforeLogin: challenge == null,
        ).then((result) {
          if (challenge != null) {
            _checkEndpoint(scope, epoch);
            invalidateAuthentication();
          }
          return result;
        });
    _accountLogins[scope] = operation;
    return operation.whenComplete(() {
      if (identical(_accountLogins[scope], operation)) {
        _accountLogins.remove(scope);
      }
    });
  }

  Future<EnrollmentState> loginWithEmailPassword({
    required String email,
    required String password,
  }) => _emailLogin('/api/v1/client-auth/login/password', {
    'email': email.trim(),
    'password': password,
  });

  Future<EnrollmentState> loginWithEmailCode({
    required EmailAuthChallenge challenge,
    required String code,
  }) {
    _checkEmailChallenge(challenge, purpose: 'login', code: code);
    return _emailLogin('/api/v1/client-auth/login/email-code', {
      'email': challenge.email,
      'challengeId': challenge.id,
      'code': code,
    }, challenge: challenge);
  }

  Future<EnrollmentState> registerWithEmail({
    required EmailAuthChallenge challenge,
    required String code,
    required String password,
    required Map<String, String> consents,
    String displayName = '',
  }) {
    _checkEmailChallenge(challenge, purpose: 'register', code: code);
    if (password.length < 8 ||
        password.length > 128 ||
        (consents['terms'] ?? '').isEmpty ||
        (consents['privacy'] ?? '').isEmpty) {
      throw const ApiFailure('请设置至少 8 位密码，并同意当前用户协议和隐私政策。', status: 422);
    }
    return _emailLogin('/api/v1/client-auth/register', {
      'email': challenge.email,
      'challengeId': challenge.id,
      'code': code,
      'password': password,
      'displayName': displayName.trim(),
      'consents': {'terms': consents['terms'], 'privacy': consents['privacy']},
    }, challenge: challenge);
  }

  Future<void> resetPasswordWithEmail({
    required EmailAuthChallenge challenge,
    required String code,
    required String newPassword,
  }) async {
    _checkEmailChallenge(challenge, purpose: 'reset_password', code: code);
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw const ApiFailure('新密码须为 8 至 128 位。', status: 422);
    }
    final device = await _challengeDevice(challenge);
    final result = await _emailRequest(
      'POST',
      '/api/v1/client-auth/password/reset',
      device: device,
      revision: challenge.authenticationRevision,
      expectedEndpoint: challenge.endpoint,
      body: {
        'device': device.id,
        'email': challenge.email,
        'challengeId': challenge.id,
        'code': code,
        'newPassword': newPassword,
      },
    );
    if (result['ok'] != true || result['logoutRequired'] != true) {
      throw const ApiFailure('服务未确认密码重置，请先核对后再登录。');
    }
    invalidateAuthentication();
    final epoch = _authRevision;
    await store.authenticationMutation(challenge.endpoint, () async {
      _checkEndpoint(challenge.endpoint, epoch);
      await store.clearSession(challenge.endpoint);
      await store.setAuthenticationLock(
        challenge.endpoint,
        signedOut: true,
        uncertainLogout: false,
      );
    });
    _checkEndpoint(challenge.endpoint, epoch);
  }
}

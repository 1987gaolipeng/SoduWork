part of 'soduwork_api.dart';

class SignOutResult {
  final bool remoteConfirmed;
  final bool storageConfirmed;
  const SignOutResult({
    required this.remoteConfirmed,
    required this.storageConfirmed,
  });
}

extension _DeviceAuthentication on SoduWorkApi {
  void _checkAuthentication(int revision) {
    if (revision != _authRevision) {
      throw const ApiFailure('账号已切换，本次操作结果未应用。', status: 409);
    }
  }

  Future<SignOutResult> _signOut() async {
    final requestEndpoint = baseUrl;
    final pendingAccountLogin = _accountLogins.containsKey(requestEndpoint);
    invalidateAuthentication();
    var storageConfirmed = true;
    DeviceCredentials? identity;
    await store.authenticationMutation(requestEndpoint, () async {
      // Failure to save a local flag must not prevent best-effort server
      // revocation or the independent attempt to erase the local session.
      try {
        await store.setAuthenticationLock(
          requestEndpoint,
          signedOut: true,
          uncertainLogout: true,
        );
      } catch (_) {
        storageConfirmed = false;
      }
      try {
        identity = await store.credentials(requestEndpoint);
      } catch (_) {
        storageConfirmed = false;
      }
      try {
        await store.clearSession(requestEndpoint);
      } catch (_) {
        storageConfirmed = false;
      }
    });
    var remoteConfirmed = false;
    if (identity != null) {
      try {
        final request =
            http.Request(
                'POST',
                Uri.parse('$requestEndpoint/api/v1/client-auth/logout'),
              )
              ..followRedirects = false
              ..headers.addAll({
                'Content-Type': 'application/json',
                'X-Device-Key': identity!.secret,
              })
              ..body = jsonEncode({'device': identity!.id});
        final response = await (() async => http.Response.fromStream(
          await client.send(request),
        ))().timeout(const Duration(seconds: 12));
        final decoded = _asMap(_decode(response));
        remoteConfirmed =
            response.statusCode >= 200 &&
            response.statusCode < 300 &&
            decoded['ok'] == true &&
            !pendingAccountLogin;
      } on Exception {
        /* Local signout remains in effect while offline. */
      }
    }
    if (remoteConfirmed) {
      try {
        await store.authenticationMutation(
          requestEndpoint,
          () => store.setAuthenticationLock(
            requestEndpoint,
            signedOut: true,
            uncertainLogout: false,
          ),
        );
      } catch (_) {
        storageConfirmed = false;
      }
    }
    return SignOutResult(
      remoteConfirmed: remoteConfirmed,
      storageConfirmed: storageConfirmed,
    );
  }

  Future<EnrollmentState> _enroll() async {
    final requestEndpoint = baseUrl;
    final requestEpoch = _authRevision;
    if (_signOutOperation != null || await store.isSignedOut(requestEndpoint)) {
      throw const ApiFailure('你已退出此设备，请使用账号密码重新登录。', status: 401);
    }
    _checkAuthentication(requestEpoch);
    final credentials = await store.authenticationMutation(
      requestEndpoint,
      () => store.credentials(requestEndpoint),
    );
    _checkEndpoint(requestEndpoint, requestEpoch);
    final enrollmentName = deviceDisplayName.trim().isEmpty
        ? credentials.name
        : '${deviceDisplayName.trim()} · ${credentials.platform}';
    late http.Response response;
    try {
      response = await client
          .post(
            _uri('/api/v1/clients/enroll'),
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Key': credentials.secret,
            },
            body: jsonEncode({
              'device': credentials.id,
              'name': enrollmentName,
              'platform': credentials.platform,
              'version': '1.12.0',
            }),
          )
          .timeout(const Duration(seconds: 12));
    } on TimeoutException {
      throw const ApiFailure('连接超时，请确认手机能访问当前企业服务。', isNetwork: true);
    } on Exception {
      throw const ApiFailure('无法连接企业服务，请检查网络或环境地址。', isNetwork: true);
    }
    _checkEndpoint(requestEndpoint, requestEpoch);
    final body = _decode(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiFailure(
        SoduWorkApi._error(body, response.statusCode),
        status: response.statusCode,
        code: _text(_asMap(_asMap(body)['detail'])['code']),
        retryAfter: _retrySeconds(_asMap(_asMap(body)['detail'])['retryAfter']),
      );
    }
    final session = _text(_asMap(body)['session']);
    await store.authenticationMutation(requestEndpoint, () async {
      _checkAuthentication(requestEpoch);
      if (session.isNotEmpty) {
        await store.writeSession(requestEndpoint, session);
      } else {
        await store.clearSession(requestEndpoint);
      }
      _checkAuthentication(requestEpoch);
    });
    _checkAuthentication(requestEpoch);
    final data = _asMap(body);
    final state = _text(data['authState'], fallback: 'pending');
    return EnrollmentState(
      active: state == 'active' && session.isNotEmpty,
      deviceId: credentials.id,
      deviceName: enrollmentName,
      authState: state,
      ownerUserId: _text(data['ownerUserId']),
    );
  }

  /// Account login, mirroring the desktop client: a successful
  /// `client-auth/login` activates the device and binds it to the user,
  /// so no separate administrator step is needed.
  Future<EnrollmentState> _performAccountLogin({
    required String account,
    required String password,
    required bool replaceIdentity,
    String authenticationPath = '/api/v1/client-auth/login',
    Map<String, dynamic>? authenticationBody,
    String expectedDeviceId = '',
    bool invalidateBeforeLogin = true,
  }) async {
    final requestEndpoint = baseUrl;
    if (_signOutOperation != null) {
      throw const ApiFailure('正在完成退出，请稍后登录。', status: 409);
    }
    if (invalidateBeforeLogin) invalidateAuthentication();
    final requestEpoch = _authRevision;
    var needsRegistration = false;
    final credentials = await store.authenticationMutation(
      requestEndpoint,
      () async {
        _checkAuthentication(requestEpoch);
        // Set before attempting login. Failed authentication cannot restore an
        // old account by falling back to transparent device enrollment.
        final uncertain =
            replaceIdentity || await store.hasUncertainLogout(requestEndpoint);
        _checkAuthentication(requestEpoch);
        await store.setAuthenticationLock(
          requestEndpoint,
          signedOut: true,
          uncertainLogout: uncertain,
        );
        await store.clearSession(requestEndpoint);
        if (uncertain) {
          needsRegistration = true;
          await store.rotateDeviceIdentity(requestEndpoint);
          _checkAuthentication(requestEpoch);
        }
        _checkAuthentication(requestEpoch);
        return store.credentials(requestEndpoint);
      },
    );
    _checkEndpoint(requestEndpoint, requestEpoch);
    Future<void> registerForExplicitLogin() async {
      // A late logout only knows the old identity. Register the replacement
      // solely as part of this explicit sign-in; never save its enrollment token.
      final registration = await client
          .post(
            _uri('/api/v1/clients/enroll'),
            headers: {
              'Content-Type': 'application/json',
              'X-Device-Key': credentials.secret,
            },
            body: jsonEncode({
              'device': credentials.id,
              'name': deviceDisplayName,
              'platform': credentials.platform,
              'version': '1.12.0',
            }),
          )
          .timeout(const Duration(seconds: 12));
      _checkEndpoint(requestEndpoint, requestEpoch);
      if (registration.statusCode < 200 || registration.statusCode >= 300) {
        throw ApiFailure(
          SoduWorkApi._error(_decode(registration), registration.statusCode),
          status: registration.statusCode,
        );
      }
    }

    if (needsRegistration) {
      await registerForExplicitLogin();
      await store.authenticationMutation(requestEndpoint, () async {
        _checkAuthentication(requestEpoch);
        await store.setAuthenticationLock(
          requestEndpoint,
          signedOut: true,
          uncertainLogout: false,
        );
      });
      _checkAuthentication(requestEpoch);
    }
    final enrollmentName = deviceDisplayName.trim().isEmpty
        ? credentials.name
        : '${deviceDisplayName.trim()} · ${credentials.platform}';
    if (expectedDeviceId.isNotEmpty && credentials.id != expectedDeviceId) {
      throw const ApiFailure(
        '设备身份已变化，请重新获取验证码。',
        status: 409,
        code: 'EMAIL_DEVICE_CHANGED',
      );
    }
    Future<http.Response> sendAccountLogin() async {
      _checkEndpoint(requestEndpoint, requestEpoch);
      final request = http.Request('POST', _uri(authenticationPath))
        ..followRedirects = false
        ..headers.addAll({
          'Content-Type': 'application/json',
          'X-Device-Key': credentials.secret,
        })
        ..body = jsonEncode({
          'device': credentials.id,
          if (authenticationBody == null) ...{
            'account': account,
            'password': password,
          } else
            ...authenticationBody,
          'name': enrollmentName,
          'platform': credentials.platform,
          'version': '1.12.0',
        });
      return (() async => http.Response.fromStream(
        await client.send(request),
      ))().timeout(const Duration(seconds: 12));
    }

    late http.Response response;
    try {
      response = await sendAccountLogin();
      _checkEndpoint(requestEndpoint, requestEpoch);
      final detail = _asMap(_asMap(_decode(response))['detail']);
      // Only a vanished enrollment can be repaired automatically. An invalid
      // password, revoked device, generic 404 or network failure must not enroll
      // another identity or bypass the existing device access decision.
      if (!needsRegistration &&
          response.statusCode == 404 &&
          detail['code'] == 'DEVICE_NOT_ENROLLED') {
        needsRegistration = true;
        await registerForExplicitLogin();
        _checkEndpoint(requestEndpoint, requestEpoch);
        response = await sendAccountLogin();
      }
    } on ApiFailure {
      rethrow;
    } on TimeoutException {
      throw const ApiFailure('连接超时，请确认手机能访问当前企业服务。', isNetwork: true);
    } on Exception {
      throw const ApiFailure('无法连接企业服务，请检查网络或环境地址。', isNetwork: true);
    }
    _checkEndpoint(requestEndpoint, requestEpoch);
    final body = _decode(response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiFailure(
        SoduWorkApi._error(body, response.statusCode),
        status: response.statusCode,
        code: _text(_asMap(_asMap(body)['detail'])['code']),
        retryAfter: _retrySeconds(_asMap(_asMap(body)['detail'])['retryAfter']),
      );
    }
    final data = _asMap(body);
    final session = _text(data['session']);
    await store.authenticationMutation(requestEndpoint, () async {
      _checkAuthentication(requestEpoch);
      if (session.isNotEmpty) {
        await store.writeSession(requestEndpoint, session);
      } else {
        await store.clearSession(requestEndpoint);
      }
      _checkAuthentication(requestEpoch);
      if (session.isNotEmpty) {
        await store.setAuthenticationLock(
          requestEndpoint,
          signedOut: false,
          uncertainLogout: false,
        );
      }
    });
    _checkAuthentication(requestEpoch);
    final ownerUserId = _text(
      _asMap(data['device'])['userRef'],
      fallback: _text(_asMap(data['user'])['id']),
    );
    return EnrollmentState(
      active: session.isNotEmpty,
      deviceId: credentials.id,
      deviceName: enrollmentName,
      authState: session.isNotEmpty ? 'active' : 'pending',
      ownerUserId: ownerUserId,
    );
  }

  Future<String> _session({bool force = false}) async {
    final requestEndpoint = baseUrl;
    final requestEpoch = _authRevision;
    if (await store.isSignedOut(requestEndpoint)) {
      throw const ApiFailure('你已退出此设备，请重新登录。', status: 401);
    }
    _checkAuthentication(requestEpoch);
    if (!force) {
      final saved = await store.readSession(requestEndpoint);
      _checkEndpoint(requestEndpoint, requestEpoch);
      if (saved != null && saved.isNotEmpty) return saved;
    }
    final enrollment = await enroll();
    if (!enrollment.active) {
      throw const ApiFailure(
        '\u8fd9\u53f0\u624b\u673a\u8fd8\u6ca1\u6709\u88ab\u7ba1\u7406\u5458\u6fc0\u6d3b\u3002',
        status: 403,
      );
    }
    _checkAuthentication(requestEpoch);
    final saved = await store.readSession(requestEndpoint);
    _checkAuthentication(requestEpoch);
    if (saved == null || saved.isEmpty) {
      throw const ApiFailure(
        '\u8bbe\u5907\u4f1a\u8bdd\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u8fde\u63a5\u3002',
        status: 401,
      );
    }
    return saved;
  }
}

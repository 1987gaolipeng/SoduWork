import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/artifact_download.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

import 'memory_device_auth.dart';

const _endpoint = EndpointSettings(
  environment: SoduWorkEnvironment.development,
  baseUrl: 'https://hub.test',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'confirmed logout revokes exact device once, clears session and preserves identity',
    () async {
      final store = _Store();
      final requests = <http.Request>[];
      final api = _api(
        store,
        MockClient((request) async {
          requests.add(request);
          return _json({'ok': true});
        }),
      );
      final first = api.signOut();
      expect(identical(first, api.signOut()), isTrue);
      final result = await first;
      expect(result.remoteConfirmed, isTrue);
      expect(result.storageConfirmed, isTrue);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
      expect(await store.hasUncertainLogout(api.baseUrl), isFalse);
      expect(store.session, isNull);
      expect(store.rotations, 0);
      expect(requests, hasLength(1));
      expect(requests.single.url.path, '/api/v1/client-auth/logout');
      expect(requests.single.headers['X-Device-Key'], 'fixture-key-0');
      expect(requests.single.headers['Authorization'], isNull);
      expect(jsonDecode(requests.single.body), {'device': 'fixture-device-0'});
      expect(requests.single.followRedirects, isFalse);
      await expectLater(api.enroll(), throwsA(isA<ApiFailure>()));
      await expectLater(api.tasks(), throwsA(isA<ApiFailure>()));
      expect(requests, hasLength(1));
    },
  );

  test(
    'unconfirmed remote logout rotates only during the next explicit login',
    () async {
      final store = _Store();
      final requests = <http.Request>[];
      final api = _api(
        store,
        MockClient((request) async {
          requests.add(request);
          if (request.url.path.endsWith('/logout')) {
            throw http.ClientException('fixture offline');
          }
          if (request.url.path.endsWith('/enroll')) {
            return _json({'authState': 'pending'});
          }
          return _login('new-session');
        }),
      );
      final result = await api.signOut();
      expect(result.remoteConfirmed, isFalse);
      expect(store.rotations, 0);
      expect(await store.hasUncertainLogout(api.baseUrl), isTrue);
      await expectLater(api.enroll(), throwsA(isA<ApiFailure>()));
      expect(requests, hasLength(1));
      await api.loginWithAccount(
        account: 'new-user',
        password: 'fixture-password',
      );
      expect(store.rotations, 1);
      expect(store.session, 'new-session');
      expect(await store.isSignedOut(api.baseUrl), isFalse);
      expect(await store.hasUncertainLogout(api.baseUrl), isFalse);
      expect(requests.map((r) => r.url.path), [
        '/api/v1/client-auth/logout',
        '/api/v1/clients/enroll',
        '/api/v1/client-auth/login',
      ]);
      expect(jsonDecode(requests.first.body)['device'], 'fixture-device-0');
      expect(jsonDecode(requests.last.body)['device'], 'fixture-device-1');
      expect(requests.last.headers['X-Device-Key'], 'fixture-key-1');
    },
  );

  test(
    'failed explicit login keeps the signed-out lock and cannot recover an old session',
    () async {
      final store = _Store();
      final paths = <String>[];
      final api = _api(
        store,
        MockClient((request) async {
          paths.add(request.url.path);
          return _json({'detail': '账号或密码不正确'}, 401);
        }),
      );
      await expectLater(
        api.loginWithAccount(account: 'other', password: 'wrong'),
        throwsA(isA<ApiFailure>()),
      );
      expect(await store.isSignedOut(api.baseUrl), isTrue);
      expect(store.session, isNull);
      await expectLater(api.tasks(), throwsA(isA<ApiFailure>()));
      expect(paths, ['/api/v1/client-auth/login']);
    },
  );

  test(
    'stale enrollment cannot restore a session after local signout',
    () async {
      final store = _Store();
      final pending = Completer<http.Response>();
      final sent = Completer<void>();
      final api = _api(
        store,
        MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            sent.complete();
            return pending.future;
          }
          return _json({'ok': true});
        }),
      );
      final operation = api.enroll();
      final rejected = expectLater(operation, _conflict);
      await sent.future;
      await api.signOut();
      pending.complete(
        _json({'session': 'old-session', 'authState': 'active'}),
      );
      await rejected;
      expect(store.session, isNull);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
    },
  );

  test('stale login cannot replace a newer account on the same Hub', () async {
    final store = _Store();
    final old = Completer<http.Response>();
    final sent = Completer<void>();
    final api = _api(
      store,
      MockClient((request) async {
        if (jsonDecode(request.body)['account'] == 'old') {
          sent.complete();
          return old.future;
        }
        return _login('new-account-session');
      }),
    );
    final operation = api.loginWithAccount(account: 'old', password: 'fixture');
    final rejected = expectLater(operation, _conflict);
    await sent.future;
    await api.loginWithAccount(account: 'new', password: 'fixture');
    old.complete(_login('old-account-session'));
    await rejected;
    expect(store.session, 'new-account-session');
    expect(await store.isSignedOut(api.baseUrl), isFalse);
  });

  test(
    'stale 401 cannot clear a newer session or transparently enroll',
    () async {
      final store = _Store();
      final old = Completer<http.Response>();
      final sent = Completer<void>();
      final paths = <String>[];
      final api = _api(
        store,
        MockClient((request) async {
          paths.add(request.url.path);
          if (request.url.path.endsWith('/tasks')) {
            sent.complete();
            return old.future;
          }
          return _login('new-account-session');
        }),
      );
      final operation = api.tasks();
      final rejected = expectLater(operation, _conflict);
      await sent.future;
      await api.loginWithAccount(account: 'new', password: 'fixture');
      old.complete(_json({'detail': 'expired'}, 401));
      await rejected;
      expect(store.session, 'new-account-session');
      expect(paths, ['/api/v1/tasks', '/api/v1/client-auth/login']);
    },
  );

  test('same-Hub identity change rejects a late downloaded artifact', () async {
    final store = _Store();
    final bytes = StreamController<List<int>>();
    final sent = Completer<void>();
    final api = _api(
      store,
      MockClient.streaming((request, body) async {
        sent.complete();
        return http.StreamedResponse(bytes.stream, 200);
      }),
    );
    final operation = ArtifactDownloader(
      api,
    ).download('/api/v1/deliveries/fixture/download');
    final rejected = expectLater(operation, _conflict);
    await sent.future;
    api.invalidateAuthentication();
    bytes.add([1, 2, 3]);
    await bytes.close();
    await rejected;
  });

  test(
    'persistent exit lock survives restart and is isolated by endpoint',
    () async {
      SharedPreferences.setMockInitialValues({});
      FlutterSecureStorage.setMockInitialValues({});
      final first = DeviceStore();
      await first.init();
      await first.setAuthenticationLock(
        _endpoint.baseUrl,
        signedOut: true,
        uncertainLogout: true,
      );
      final restarted = DeviceStore();
      await restarted.init();
      expect(await restarted.isSignedOut(_endpoint.baseUrl), isTrue);
      expect(await restarted.hasUncertainLogout(_endpoint.baseUrl), isTrue);
      expect(await restarted.isSignedOut('https://other.test'), isFalse);
    },
  );

  test(
    'storage failure remains locked in memory and reports incomplete exit',
    () async {
      final store = _Store()..failStorage = true;
      var requests = 0;
      final api = _api(
        store,
        MockClient((_) async {
          requests++;
          return _json({'ok': true});
        }),
      );
      final result = await api.signOut();
      expect(result.storageConfirmed, isFalse);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
      expect(store.session, isNull);
      await expectLater(api.tasks(), throwsA(isA<ApiFailure>()));
      expect(requests, 1);
    },
  );

  test(
    'storage serialization clears a session write already in flight before signout',
    () async {
      final store = _Store();
      final started = Completer<void>();
      final release = Completer<void>();
      store.beforeWrite = () async {
        started.complete();
        await release.future;
      };
      final api = _api(
        store,
        MockClient(
          (request) async => request.url.path.endsWith('/logout')
              ? _json({'ok': true})
              : _json({'session': 'late-write', 'authState': 'active'}),
        ),
      );
      final operation = api.enroll();
      final rejected = expectLater(operation, _conflict);
      await started.future;
      final logout = api.signOut();
      release.complete();
      await rejected;
      await logout;
      expect(store.session, isNull);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
    },
  );
  testWidgets(
    'timed-out logout remains locked and its late reply cannot affect the new device',
    (tester) async {
      final store = _Store();
      final oldLogout = Completer<http.Response>();
      final sent = Completer<void>();
      final requests = <http.Request>[];
      final api = _api(
        store,
        MockClient((request) async {
          requests.add(request);
          if (request.url.path.endsWith('/logout')) {
            sent.complete();
            return oldLogout.future;
          }
          if (request.url.path.endsWith('/enroll')) {
            return _json({'authState': 'pending'});
          }
          return _login('new-session');
        }),
      );
      final operation = api.signOut();
      await tester.pump();
      await sent.future;
      await tester.pump(const Duration(seconds: 13));
      final result = await operation;
      expect(result.remoteConfirmed, isFalse);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
      await api.loginWithAccount(account: 'new', password: 'fixture');
      oldLogout.complete(_json({'ok': true}));
      await tester.pump();
      expect(store.session, 'new-session');
      expect(await store.isSignedOut(api.baseUrl), isFalse);
      expect(
        jsonDecode(requests.first.body)['device'],
        isNot(jsonDecode(requests.last.body)['device']),
      );
      expect(
        requests.where((request) => request.url.path.endsWith('/logout')),
        hasLength(1),
      );
    },
  );

  test(
    'failed replacement enrollment keeps uncertainty for the next explicit login',
    () async {
      final store = _Store();
      await store.setAuthenticationLock(
        _endpoint.baseUrl,
        signedOut: true,
        uncertainLogout: true,
      );
      var enrollmentCalls = 0;
      final api = _api(
        store,
        MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            enrollmentCalls++;
            return enrollmentCalls == 1
                ? _json({'detail': '暂不可登记'}, 503)
                : _json({'authState': 'pending'});
          }
          return _login('confirmed-new-session');
        }),
      );
      await expectLater(
        api.loginWithAccount(account: 'new', password: 'fixture'),
        throwsA(isA<ApiFailure>()),
      );
      expect(await store.hasUncertainLogout(api.baseUrl), isTrue);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
      await api.loginWithAccount(account: 'new', password: 'fixture');
      expect(store.rotations, 2);
      expect(store.session, 'confirmed-new-session');
    },
  );

  test(
    'logout with an older sign-in still pending requires a replacement identity',
    () async {
      final store = _Store();
      final pendingLogin = Completer<http.Response>();
      final sent = Completer<void>();
      final api = _api(
        store,
        MockClient((request) async {
          if (request.url.path.endsWith('/logout')) return _json({'ok': true});
          if (request.url.path.endsWith('/enroll')) {
            return _json({'authState': 'pending'});
          }
          if (jsonDecode(request.body)['account'] == 'old') {
            sent.complete();
            return pendingLogin.future;
          }
          return _login('new-session');
        }),
      );
      final operation = api.loginWithAccount(
        account: 'old',
        password: 'fixture',
      );
      final rejected = expectLater(operation, _conflict);
      await sent.future;
      final logout = await api.signOut();
      expect(logout.remoteConfirmed, isFalse);
      expect(await store.hasUncertainLogout(api.baseUrl), isTrue);
      await api.loginWithAccount(account: 'new', password: 'fixture');
      pendingLogin.complete(_login('old-session'));
      await rejected;
      expect(store.rotations, 1);
      expect(store.session, 'new-session');
    },
  );
  test(
    'explicit login repairs exact vanished enrollment once without saving its token',
    () async {
      final store = _Store();
      var logins = 0;
      final requests = <http.Request>[];
      final api = _api(
        store,
        MockClient((request) async {
          requests.add(request);
          expect(await store.isSignedOut(_endpoint.baseUrl), isTrue);
          expect(store.session, isNull);
          if (request.url.path.endsWith('/enroll')) {
            return _json({
              'authState': 'active',
              'session': 'must-never-be-saved',
            });
          }
          logins++;
          return logins == 1
              ? _json({
                  'detail': {
                    'code': 'DEVICE_NOT_ENROLLED',
                    'message': '设备尚未登记',
                  },
                }, 404)
              : _login('explicit-account-session');
        }),
      );
      final result = await api.loginWithAccount(
        account: 'existing-user',
        password: 'fixture',
      );
      expect(result.active, isTrue);
      expect(store.session, 'explicit-account-session');
      expect(store.rotations, 0);
      expect(await store.isSignedOut(api.baseUrl), isFalse);
      expect(requests.map((request) => request.url.path), [
        '/api/v1/client-auth/login',
        '/api/v1/clients/enroll',
        '/api/v1/client-auth/login',
      ]);
      expect(
        requests.map((request) => jsonDecode(request.body)['device']).toSet(),
        {'fixture-device-0'},
      );
      expect(
        requests.map((request) => request.headers['X-Device-Key']).toSet(),
        {'fixture-key-0'},
      );
      expect(requests.first.body, requests.last.body);
    },
  );

  for (final fixture in <(int, Object)>[
    (
      401,
      {
        'detail': {'code': 'ACCOUNT_OR_PASSWORD_INVALID', 'message': '密码不正确'},
      },
    ),
    (
      403,
      {
        'detail': {'code': 'DEVICE_REVOKED', 'message': '设备已停用'},
      },
    ),
    (404, {'detail': 'Not Found'}),
    (
      404,
      {
        'detail': {'code': 'USER_NOT_FOUND', 'message': '账号不存在'},
      },
    ),
    (
      500,
      {
        'detail': {'code': 'DEVICE_NOT_ENROLLED', 'message': '服务异常'},
      },
    ),
  ]) {
    test(
      'login does not bypass non-recoverable response ${fixture.$1} ${fixture.$2}',
      () async {
        final store = _Store();
        var requests = 0;
        final api = _api(
          store,
          MockClient((_) async {
            requests++;
            return _json(fixture.$2, fixture.$1);
          }),
        );
        await expectLater(
          api.loginWithAccount(account: 'existing-user', password: 'fixture'),
          throwsA(
            isA<ApiFailure>().having(
              (error) => error.status,
              'server decision',
              fixture.$1,
            ),
          ),
        );
        expect(requests, 1);
        expect(store.rotations, 0);
        expect(await store.isSignedOut(api.baseUrl), isTrue);
        expect(store.session, isNull);
      },
    );
  }

  test(
    'vanished enrollment recovery is bounded even when retry still returns exact 404',
    () async {
      final store = _Store();
      var requests = 0;
      final api = _api(
        store,
        MockClient((request) async {
          requests++;
          return request.url.path.endsWith('/enroll')
              ? _json({'authState': 'pending'})
              : _json({
                  'detail': {'code': 'DEVICE_NOT_ENROLLED'},
                }, 404);
        }),
      );
      await expectLater(
        api.loginWithAccount(account: 'existing-user', password: 'fixture'),
        throwsA(
          isA<ApiFailure>().having(
            (error) => error.status,
            'still missing',
            404,
          ),
        ),
      );
      expect(requests, 3);
      expect(store.rotations, 0);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
    },
  );

  test(
    'wrong password after registration cannot activate a returned enrollment token',
    () async {
      final store = _Store();
      var logins = 0;
      final api = _api(
        store,
        MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            return _json({
              'session': 'must-never-be-saved',
              'authState': 'active',
            });
          }
          logins++;
          return logins == 1
              ? _json({
                  'detail': {'code': 'DEVICE_NOT_ENROLLED'},
                }, 404)
              : _json({
                  'detail': {'code': 'ACCOUNT_OR_PASSWORD_INVALID'},
                }, 401);
        }),
      );
      await expectLater(
        api.loginWithAccount(account: 'existing-user', password: 'fixture'),
        throwsA(
          isA<ApiFailure>().having(
            (error) => error.status,
            'password remains required',
            401,
          ),
        ),
      );
      expect(logins, 2);
      expect(store.session, isNull);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
      await expectLater(api.tasks(), throwsA(isA<ApiFailure>()));
    },
  );

  test(
    'identity change during vanished enrollment repair prevents login retry',
    () async {
      final store = _Store();
      final pending = Completer<http.Response>();
      final registrationStarted = Completer<void>();
      var logins = 0;
      final api = _api(
        store,
        MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            registrationStarted.complete();
            return pending.future;
          }
          logins++;
          return _json({
            'detail': {'code': 'DEVICE_NOT_ENROLLED'},
          }, 404);
        }),
      );
      final operation = api.loginWithAccount(
        account: 'existing-user',
        password: 'fixture',
      );
      final rejected = expectLater(operation, _conflict);
      await registrationStarted.future;
      api.invalidateAuthentication();
      pending.complete(
        _json({'authState': 'active', 'session': 'must-never-be-saved'}),
      );
      await rejected;
      expect(logins, 1);
      expect(store.session, isNull);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
    },
  );

  test(
    'login network failures never trigger missing-device registration',
    () async {
      final store = _Store();
      var requests = 0;
      final api = _api(
        store,
        MockClient((_) async {
          requests++;
          throw http.ClientException('fixture offline');
        }),
      );
      await expectLater(
        api.loginWithAccount(account: 'existing-user', password: 'fixture'),
        throwsA(
          isA<ApiFailure>().having(
            (error) => error.isNetwork,
            'network error',
            isTrue,
          ),
        ),
      );
      expect(requests, 1);
      expect(store.rotations, 0);
      expect(await store.isSignedOut(api.baseUrl), isTrue);
    },
  );
}

Matcher get _conflict => throwsA(
  isA<ApiFailure>().having((e) => e.status, 'identity conflict', 409),
);
SoduWorkApi _api(_Store store, http.Client client) =>
    SoduWorkApi(store: store, endpoint: _endpoint, client: client);
http.Response _json(Object data, [int status = 200]) => http.Response(
  jsonEncode(data),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
http.Response _login(String session) => _json({
  'session': session,
  'device': {'userRef': 'fixture-user'},
});

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  String? session = 'initial-session';
  int rotations = 0;
  bool failStorage = false;
  Future<void> Function()? beforeWrite;
  @override
  Future<void> init() async {}
  @override
  EndpointSettings loadEndpoint() => _endpoint;
  @override
  Future<String?> readSession(String endpoint) async => session;
  @override
  Future<void> clearSession(String endpoint) async {
    session = null;
  }

  @override
  Future<void> writeSession(String endpoint, String value) async {
    await beforeWrite?.call();
    session = value;
  }

  @override
  Future<void> setAuthenticationLock(
    String endpoint, {
    required bool signedOut,
    required bool uncertainLogout,
  }) async {
    await super.setAuthenticationLock(
      endpoint,
      signedOut: signedOut,
      uncertainLogout: uncertainLogout,
    );
    if (failStorage) throw StateError('fixture disk unavailable');
  }

  @override
  Future<void> rotateDeviceIdentity(String endpoint) async {
    rotations++;
    session = null;
  }

  @override
  Future<DeviceCredentials> credentials(String endpoint) async =>
      DeviceCredentials(
        id: 'fixture-device-$rotations',
        secret: 'fixture-key-$rotations',
        name: 'Fixture Mobile',
        platform: 'test',
      );
}

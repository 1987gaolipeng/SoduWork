import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'memory_device_auth.dart';

const endpoint = EndpointSettings(
  environment: SoduWorkEnvironment.development,
  baseUrl: 'https://hub.test',
);
http.Response reply(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
http.Response challengeReply() => reply({
  'ok': true,
  'challengeId': 'challenge',
  'expiresIn': 600,
  'retryAfter': 60,
  'deliveryState': 'queued',
});
http.Response loggedIn() => reply({
  'session': 'new-session',
  'device': {'userRef': 'account'},
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'old public policy cannot enable unsupported email registration',
    () async {
      final store = TestStore();
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          expect(request.url.path, '/api/v1/client-auth/policy');
          expect(request.headers.containsKey('X-Device-Key'), isFalse);
          expect(request.followRedirects, isFalse);
          return reply({'allowSelfRegistration': true, 'passwordMinLength': 8});
        }),
      );
      final policy = await api.authenticationPolicy();
      expect(policy.supportsEmail, isFalse);
      expect(policy.mailReady, isFalse);
      expect(policy.canRegister, isFalse);
      expect(store.session, 'old-session');
      api.client.close();
    },
  );

  test(
    'public policy preserves server legal versions and minimum password length',
    () {
      final policy = ClientAuthPolicy.fromJson({
        'allowSelfRegistration': true,
        'mailReady': true,
        'passwordMinLength': 12,
        'requiredConsentVersions': {
          'terms': 'v2',
          'privacy': 'v3',
          'other': 'private',
        },
        'legalDocuments': [
          {
            'key': 'terms',
            'title': 'Terms',
            'version': 'v2',
            'content': 'Content',
            'private': 'no',
          },
        ],
      });
      expect(policy.canRegister, isTrue);
      expect(policy.passwordMinLength, 12);
      expect(policy.requiredConsentVersions, {'terms': 'v2', 'privacy': 'v3'});
      expect(policy.legalDocuments.single.containsKey('private'), isFalse);
      expect(
        () => policy.requiredConsentVersions['terms'] = 'modified',
        throwsUnsupportedError,
      );
    },
  );

  test(
    'challenge enrols explicitly, preserves device scope and keeps enrollment session locked out',
    () async {
      final store = TestStore();
      final seen = <http.Request>[];
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          seen.add(request);
          expect(request.followRedirects, isFalse);
          expect(request.headers['X-Device-Key'], 'fixture-key-0');
          if (request.url.path.endsWith('/enroll')) {
            return reply({'session': 'old-owner', 'authState': 'active'});
          }
          expect(jsonDecode(request.body), {
            'device': 'fixture-device-0',
            'email': 'test@example.com',
            'purpose': 'register',
          });
          return challengeReply();
        }),
      );
      final proof = await api.requestEmailCode(
        email: ' test@example.com ',
        purpose: 'register',
      );
      expect(proof.email, 'test@example.com');
      expect(proof.deviceId, 'fixture-device-0');
      expect(proof.retryAfter, 60);
      expect(proof.expired, isFalse);
      expect(proof.deliveryState, 'queued');
      expect(seen.length, 2);
      expect(store.session, isNull);
      expect(await store.isSignedOut(endpoint.baseUrl), isTrue);
      api.client.close();
    },
  );

  test(
    'unconfirmed logout rotates before issuing a challenge, never after it',
    () async {
      final store = TestStore();
      await store.setAuthenticationLock(
        endpoint.baseUrl,
        signedOut: true,
        uncertainLogout: true,
      );
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            return reply({'authState': 'pending'});
          }
          if (request.url.path.endsWith('/email-challenges')) {
            return challengeReply();
          }
          expect(jsonDecode(request.body)['device'], 'fixture-device-1');
          expect(request.headers['X-Device-Key'], 'fixture-key-1');
          return loggedIn();
        }),
      );
      final proof = await api.requestEmailCode(
        email: 'test@example.com',
        purpose: 'login',
      );
      await api.loginWithEmailCode(challenge: proof, code: '123456');
      expect(store.rotations, 1);
      expect(store.session, 'new-session');
      expect(await store.isSignedOut(endpoint.baseUrl), isFalse);
      api.client.close();
    },
  );

  test(
    'wrong code may retry same challenge; successful proof cannot be replayed',
    () async {
      final store = TestStore();
      var attempts = 0;
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            return reply({'authState': 'pending'});
          }
          if (request.url.path.endsWith('/email-challenges')) {
            return challengeReply();
          }
          expect(request.url.path, '/api/v1/client-auth/login/email-code');
          final body = jsonDecode(request.body);
          expect(body['challengeId'], 'challenge');
          expect(body['device'], 'fixture-device-0');
          attempts++;
          return attempts == 1
              ? reply({
                  'detail': {'code': 'EMAIL_CODE_INVALID', 'message': '验证码不正确'},
                }, 401)
              : loggedIn();
        }),
      );
      final proof = await api.requestEmailCode(
        email: 'test@example.com',
        purpose: 'login',
      );
      await expectLater(
        api.loginWithEmailCode(challenge: proof, code: '000000'),
        throwsA(
          isA<ApiFailure>().having((e) => e.code, 'code', 'EMAIL_CODE_INVALID'),
        ),
      );
      expect(store.session, isNull);
      await api.loginWithEmailCode(challenge: proof, code: '123456');
      expect(store.session, 'new-session');
      expect(attempts, 2);
      expect(
        () => api.loginWithEmailCode(challenge: proof, code: '123456'),
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 409)),
      );
      api.client.close();
    },
  );

  test(
    'registration submits confirmed legal versions and real email proof',
    () async {
      final store = TestStore();
      var registrations = 0;
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            return reply({'authState': 'pending'});
          }
          if (request.url.path.endsWith('/email-challenges')) {
            return challengeReply();
          }
          registrations++;
          expect(request.url.path, '/api/v1/client-auth/register');
          final body = jsonDecode(request.body);
          expect(body['consents'], {'terms': 'v2', 'privacy': 'v3'});
          expect(body['code'], '123456');
          expect(body['email'], 'test@example.com');
          expect(body['password'], 'fixture-password');
          expect(body.containsKey('account'), isFalse);
          return loggedIn();
        }),
      );
      final proof = await api.requestEmailCode(
        email: 'test@example.com',
        purpose: 'register',
      );
      expect(
        () => api.registerWithEmail(
          challenge: proof,
          code: '123456',
          password: 'fixture-password',
          consents: {},
        ),
        throwsA(isA<ApiFailure>()),
      );
      await api.registerWithEmail(
        challenge: proof,
        code: '123456',
        password: 'fixture-password',
        consents: {'terms': 'v2', 'privacy': 'v3'},
      );
      expect(registrations, 1);
      expect(store.session, 'new-session');
      api.client.close();
    },
  );

  test(
    'email password uses new bounded login endpoint without silently registering',
    () async {
      final store = TestStore();
      var sends = 0;
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          sends++;
          expect(request.url.path, '/api/v1/client-auth/login/password');
          expect(request.followRedirects, isFalse);
          final body = jsonDecode(request.body);
          expect(body['email'], 'test@example.com');
          expect(body.containsKey('account'), isFalse);
          return loggedIn();
        }),
      );
      await api.loginWithEmailPassword(
        email: ' test@example.com ',
        password: 'fixture',
      );
      expect(sends, 1);
      expect(store.session, 'new-session');
      api.client.close();
    },
  );

  test(
    'password reset does not log in and invalidates the proof after success',
    () async {
      final store = TestStore();
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            return reply({'authState': 'pending'});
          }
          if (request.url.path.endsWith('/email-challenges')) {
            return challengeReply();
          }
          expect(request.url.path, '/api/v1/client-auth/password/reset');
          expect(
            jsonDecode(request.body)['newPassword'],
            'new-fixture-password',
          );
          return reply({
            'ok': true,
            'logoutRequired': true,
            'signedOutDevices': 2,
          });
        }),
      );
      final proof = await api.requestEmailCode(
        email: 'test@example.com',
        purpose: 'reset_password',
      );
      await api.resetPasswordWithEmail(
        challenge: proof,
        code: '123456',
        newPassword: 'new-fixture-password',
      );
      expect(store.session, isNull);
      expect(await store.isSignedOut(endpoint.baseUrl), isTrue);
      await expectLater(
        api.resetPasswordWithEmail(
          challenge: proof,
          code: '123456',
          newPassword: 'new-fixture-password',
        ),
        throwsA(isA<ApiFailure>()),
      );
      api.client.close();
    },
  );

  test(
    'delivery status is scoped to exact challenge and device, no account session',
    () async {
      final store = TestStore();
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            return reply({'authState': 'pending'});
          }
          if (request.method == 'POST') return challengeReply();
          expect(
            request.url.path,
            '/api/v1/client-auth/email-challenges/challenge',
          );
          expect(request.url.queryParameters, {'device': 'fixture-device-0'});
          expect(request.headers.containsKey('Authorization'), isFalse);
          return reply({
            'challengeId': 'challenge',
            'deliveryState': 'failed',
            'errorCode': 'SMTP_TLS_FAILED',
          });
        }),
      );
      final proof = await api.requestEmailCode(
        email: 'test@example.com',
        purpose: 'login',
      );
      final status = await api.emailCodeDelivery(proof);
      expect(status.failed, isTrue);
      expect(status.errorCode, 'SMTP_TLS_FAILED');
      api.client.close();
    },
  );

  test(
    'rate limited or unsupported mail never returns a fake challenge',
    () async {
      for (final status in [404, 429, 503]) {
        final store = TestStore();
        final api = SoduWorkApi(
          store: store,
          endpoint: endpoint,
          client: MockClient((request) async {
            if (request.url.path.endsWith('/enroll')) {
              return reply({'authState': 'pending'});
            }
            return reply({
              'detail': {
                'code': 'AUTH_RATE_LIMITED',
                'message': '不可用',
                'retryAfter': 77,
              },
            }, status);
          }),
        );
        await expectLater(
          api.requestEmailCode(email: 'test@example.com', purpose: 'login'),
          throwsA(
            isA<ApiFailure>()
                .having((e) => e.status, 'status', status)
                .having((e) => e.retryAfter, 'retry', 77),
          ),
        );
        expect(store.session, isNull);
        api.client.close();
      }
    },
  );

  test('Hub change rejects old proof before any credential request', () async {
    final store = TestStore();
    var sent = 0;
    final api = SoduWorkApi(
      store: store,
      endpoint: endpoint,
      client: MockClient((request) async {
        sent++;
        return request.url.path.endsWith('/enroll')
            ? reply({'authState': 'pending'})
            : challengeReply();
      }),
    );
    final proof = await api.requestEmailCode(
      email: 'test@example.com',
      purpose: 'login',
    );
    api.setEndpoint(
      const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://other.test',
      ),
    );
    expect(
      () => api.loginWithEmailCode(challenge: proof, code: '123456'),
      throwsA(isA<ApiFailure>()),
    );
    await expectLater(api.emailCodeDelivery(proof), throwsA(isA<ApiFailure>()));
    expect(sent, 2);
    api.client.close();
  });

  test('late challenge response cannot bind to a newer endpoint', () async {
    final store = TestStore();
    final pending = Completer<http.Response>(), sent = Completer<void>();
    final api = SoduWorkApi(
      store: store,
      endpoint: endpoint,
      client: MockClient((request) async {
        if (request.url.path.endsWith('/enroll')) {
          return reply({'authState': 'pending'});
        }
        sent.complete();
        return pending.future;
      }),
    );
    final result = api.requestEmailCode(
      email: 'test@example.com',
      purpose: 'login',
    );
    final rejection = expectLater(
      result,
      throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 409)),
    );
    await sent.future;
    api.setEndpoint(
      const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://other.test',
      ),
    );
    pending.complete(challengeReply());
    await rejection;
    expect(store.session, isNull);
    api.client.close();
  });

  test(
    'late email login cannot restore a session after explicit logout',
    () async {
      final store = TestStore();
      final pending = Completer<http.Response>(), sent = Completer<void>();
      final api = SoduWorkApi(
        store: store,
        endpoint: endpoint,
        client: MockClient((request) async {
          if (request.url.path.endsWith('/enroll')) {
            return reply({'authState': 'pending'});
          }
          if (request.url.path.endsWith('/email-challenges')) {
            return challengeReply();
          }
          if (request.url.path.endsWith('/logout')) return reply({'ok': true});
          sent.complete();
          return pending.future;
        }),
      );
      final proof = await api.requestEmailCode(
        email: 'test@example.com',
        purpose: 'login',
      );
      final result = api.loginWithEmailCode(challenge: proof, code: '123456');
      final rejection = expectLater(
        result,
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 409)),
      );
      await sent.future;
      await api.signOut();
      pending.complete(loggedIn());
      await rejection;
      expect(store.session, isNull);
      expect(await store.isSignedOut(endpoint.baseUrl), isTrue);
      api.client.close();
    },
  );
}

class TestStore extends DeviceStore with MemoryDeviceAuthentication {
  String? session = 'old-session';
  int rotations = 0;
  @override
  Future<void> init() async {}
  @override
  Future<String?> readSession(String endpoint) async => session;
  @override
  Future<void> clearSession(String endpoint) async {
    session = null;
  }

  @override
  Future<void> writeSession(String endpoint, String value) async {
    session = value;
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
        name: 'Fixture',
        platform: 'test',
      );
}

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

void main() {
  for (final sample in [
    (session: 'existing-session', signedOut: false, calls: 1),
    (session: '', signedOut: false, calls: 0),
    (session: 'old-session', signedOut: true, calls: 0),
  ]) {
    test(
      'startup restores only a saved non-logged-out session: $sample',
      () async {
        final store = _Store(sample.session, sample.signedOut);
        final state = _State(store);
        addTearDown(state.dispose);
        await state.init(connectNow: false, restoreSavedSession: true);
        expect(state.connections, sample.calls);
        expect(store.credentialReads, 0);
        expect(store.sessionReads, sample.signedOut ? 0 : 1);
        expect(
          state.phase,
          sample.calls == 1 ? MobilePhase.ready : MobilePhase.disconnected,
        );
      },
    );
  }
  test(
    'embedded hosts can still explicitly disable automatic restoration',
    () async {
      final store = _Store('saved', false);
      final state = _State(store);
      addTearDown(state.dispose);
      await state.init(connectNow: false);
      expect(state.connections, 0);
      expect(store.sessionReads, 0);
    },
  );
  test(
    'unavailable storage returns to sign-in without enrolling a new device',
    () async {
      final store = _Store('saved', false)..unavailable = true;
      final state = _State(store);
      addTearDown(state.dispose);
      await state.init(connectNow: false, restoreSavedSession: true);
      expect(state.connections, 0);
      expect(store.credentialReads, 0);
      expect(state.phase, MobilePhase.disconnected);
    },
  );
}

class _State extends MobileState {
  int connections = 0;
  _State(DeviceStore store) : super(store: store);
  @override
  Future<void> connect() async {
    connections++;
    phase = MobilePhase.ready;
  }
}

class _Store extends DeviceStore {
  final String session;
  final bool signedOut;
  bool unavailable = false;
  int credentialReads = 0, sessionReads = 0;
  _Store(this.session, this.signedOut);
  @override
  Future<void> init() async {}
  @override
  EndpointSettings loadEndpoint() => const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'http://fixture.invalid',
  );
  @override
  Future<bool> isSignedOut(String endpoint) async => signedOut;
  @override
  Future<String?> readSession(String endpoint) async {
    sessionReads++;
    if (unavailable) throw StateError('unavailable storage');
    return session;
  }

  @override
  Future<DeviceCredentials> credentials(String endpoint) async {
    credentialReads++;
    throw StateError('Startup must not create a fresh identity');
  }
}

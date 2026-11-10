import 'package:soduwork_mobile/core/device_store.dart';

/// Authentication flags for tests that intentionally replace platform storage.
/// No production fallback is permitted when SharedPreferences was not initialized.
mixin MemoryDeviceAuthentication on DeviceStore {
  final authenticationLocks = <String, bool>{};
  final uncertainLogouts = <String, bool>{};

  @override
  Future<bool> isSignedOut(String endpoint) async =>
      authenticationLocks[endpoint] ?? false;

  @override
  Future<bool> hasUncertainLogout(String endpoint) async =>
      uncertainLogouts[endpoint] ?? false;

  @override
  Future<void> setAuthenticationLock(
    String endpoint, {
    required bool signedOut,
    required bool uncertainLogout,
  }) async {
    authenticationLocks[endpoint] = signedOut;
    uncertainLogouts[endpoint] = uncertainLogout;
  }
}

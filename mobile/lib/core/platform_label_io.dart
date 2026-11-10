import 'dart:io';

/// Native (mobile/desktop) implementation backed by `dart:io`.
String platformLabel() {
  if (Platform.isAndroid) return 'Android';
  if (Platform.isIOS) return 'iPhone';
  if (Platform.isMacOS) return 'macOS';
  if (Platform.isWindows) return 'Windows';
  if (Platform.isLinux) return 'Linux';
  return 'Mobile';
}

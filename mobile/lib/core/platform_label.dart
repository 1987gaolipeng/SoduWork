// Platform label that compiles on every target.
//
// Conditional export: the io implementation is only linked when the
// `dart:io` library is available (Android/iOS/desktop); elsewhere the web
// implementation is used, so `flutter build web` never sees `dart:io`.
export 'platform_label_stub.dart'
    if (dart.library.io) 'platform_label_io.dart';

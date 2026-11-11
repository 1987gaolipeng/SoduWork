// Image decoding that compiles on every target.
//
// Conditional export: `Image.file` (io) on native targets, `Image.network`
// (blob URLs) on the web.
export 'platform_image_stub.dart'
    if (dart.library.io) 'platform_image_io.dart';

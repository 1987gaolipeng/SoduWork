import 'remote_screen_transport_base.dart';
import 'remote_screen_transport_io.dart'
    if (dart.library.js_interop) 'remote_screen_transport_web.dart'
    as platform;

export 'remote_screen_transport_base.dart';

Future<RemoteScreenConnection> connectRemoteScreen(Uri uri) =>
    platform.connect(uri);

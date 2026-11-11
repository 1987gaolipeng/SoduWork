import 'dart:async';
import 'dart:js_interop';

import 'remote_screen_transport_base.dart';

@JS('WebSocket')
extension type _Socket._(JSObject _) implements JSObject {
  external factory _Socket(String url);
  external set binaryType(String value);
  external set onopen(JSFunction value);
  external set onmessage(JSFunction value);
  external set onerror(JSFunction value);
  external set onclose(JSFunction value);
  external void send(JSString value);
  external void close();
}

extension type _Message._(JSObject _) implements JSObject {
  external JSAny? get data;
}

class _Connection implements RemoteScreenConnection {
  final _Socket socket;
  final _messages = StreamController<Object>();
  bool closed = false;
  _Connection(this.socket);
  @override
  Stream<Object> get messages => _messages.stream;
  @override
  void send(String value) {
    if (!closed) socket.send(value.toJS);
  }

  @override
  Future<void> close() async {
    if (closed) return;
    closed = true;
    socket.close();
    unawaited(_messages.close());
  }
}

Future<RemoteScreenConnection> connect(Uri uri) async {
  final socket = _Socket(uri.toString())..binaryType = 'arraybuffer';
  final connection = _Connection(socket);
  final opened = Completer<void>();
  socket.onopen = ((JSAny? _) {
    if (!opened.isCompleted) opened.complete();
  }).toJS;
  socket.onmessage = ((_Message event) {
    if (connection.closed) return;
    final data = event.data;
    if (data == null) return;
    if (data.isA<JSString>()) {
      connection._messages.add((data as JSString).toDart);
    } else if (data.isA<JSArrayBuffer>()) {
      connection._messages.add((data as JSArrayBuffer).toDart.asUint8List());
    }
  }).toJS;
  socket.onerror = ((JSAny? _) {
    if (!opened.isCompleted) opened.completeError(StateError('看屏连接失败'));
    unawaited(connection.close());
  }).toJS;
  socket.onclose = ((JSAny? _) {
    if (!opened.isCompleted) opened.completeError(StateError('看屏连接已结束'));
    unawaited(connection.close());
  }).toJS;
  try {
    await opened.future.timeout(const Duration(seconds: 10));
    return connection;
  } catch (_) {
    await connection.close();
    rethrow;
  }
}

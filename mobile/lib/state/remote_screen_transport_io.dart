import 'dart:io';

import 'remote_screen_transport_base.dart';

class _Connection implements RemoteScreenConnection {
  final WebSocket socket;
  _Connection(this.socket);
  @override
  Stream<Object> get messages => socket.cast<Object>();
  @override
  void send(String value) => socket.add(value);
  @override
  Future<void> close() async {
    await socket.close();
  }
}

Future<RemoteScreenConnection> connect(Uri uri) async => _Connection(
  await WebSocket.connect(uri.toString()).timeout(const Duration(seconds: 10)),
);

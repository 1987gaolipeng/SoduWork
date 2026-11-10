abstract class RemoteScreenConnection {
  Stream<Object> get messages;
  void send(String value);
  Future<void> close();
}

import 'dart:async';
import 'dart:convert';

import 'remote_screen_transport.dart';

typedef AccountRealtimeSession = Future<String> Function();

/// The WebSocket is only a low-latency invalidation channel.  All content is
/// still fetched through the authenticated account-conversation APIs, which
/// keeps reconnects, missed events and permission changes safe.
class AccountConversationRealtime {
  RemoteScreenConnection? _connection;
  StreamSubscription<Object>? _subscription;
  Timer? _reconnect;
  Timer? _heartbeat;
  bool _stopped = true;
  bool _connecting = false;
  bool _lossScheduled = false;
  int _generation = 0;
  int _attempt = 0;

  Future<void> start({
    required Uri baseUrl,
    required String deviceId,
    required AccountRealtimeSession session,
    required bool Function() isCurrent,
    required void Function() onEvent,
  }) async {
    await stop();
    _stopped = false;
    _lossScheduled = false;
    _attempt = 0;
    final generation = ++_generation;
    unawaited(
      _connect(
        baseUrl: baseUrl,
        deviceId: deviceId,
        session: session,
        isCurrent: isCurrent,
        onEvent: onEvent,
        generation: generation,
      ),
    );
  }

  Future<void> _connect({
    required Uri baseUrl,
    required String deviceId,
    required AccountRealtimeSession session,
    required bool Function() isCurrent,
    required void Function() onEvent,
    required int generation,
  }) async {
    if (_stopped || generation != _generation || !isCurrent() || _connecting) {
      return;
    }
    _connecting = true;
    try {
      final token = await session();
      if (_stopped || generation != _generation || !isCurrent()) return;
      final uri = baseUrl
          .resolve('/api/v1/ws')
          .replace(
            scheme: baseUrl.scheme == 'https' ? 'wss' : 'ws',
            queryParameters: {'device': deviceId},
          );
      final connection = await connectRemoteScreen(uri);
      if (_stopped || generation != _generation || !isCurrent()) {
        await connection.close();
        return;
      }
      _connection = connection;
      _attempt = 0;
      _lossScheduled = false;
      connection.send(
        jsonEncode({'t': 'auth', 'device': deviceId, 'session': token}),
      );
      _subscription = connection.messages.listen(
        (event) {
          if (_stopped || generation != _generation || !isCurrent()) return;
          if (event is! String) return;
          try {
            final value = jsonDecode(event);
            if (value is! Map) return;
            final type = value['type'];
            if (type == 'account-conversation') {
              onEvent();
            }
          } catch (_) {
            // The server's ready/event envelope is deliberately ignorable if
            // a newer Hub adds an unrelated message type.
          }
        },
        onDone: () => _lost(
          baseUrl: baseUrl,
          deviceId: deviceId,
          session: session,
          isCurrent: isCurrent,
          onEvent: onEvent,
          generation: generation,
        ),
        onError: (_) => _lost(
          baseUrl: baseUrl,
          deviceId: deviceId,
          session: session,
          isCurrent: isCurrent,
          onEvent: onEvent,
          generation: generation,
        ),
      );
      _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
        if (!_stopped && generation == _generation) {
          try {
            _connection?.send('{"type":"ping"}');
          } catch (_) {
            _lost(
              baseUrl: baseUrl,
              deviceId: deviceId,
              session: session,
              isCurrent: isCurrent,
              onEvent: onEvent,
              generation: generation,
            );
          }
        }
      });
    } catch (_) {
      _lost(
        baseUrl: baseUrl,
        deviceId: deviceId,
        session: session,
        isCurrent: isCurrent,
        onEvent: onEvent,
        generation: generation,
      );
    } finally {
      _connecting = false;
    }
  }

  void _lost({
    required Uri baseUrl,
    required String deviceId,
    required AccountRealtimeSession session,
    required bool Function() isCurrent,
    required void Function() onEvent,
    required int generation,
  }) {
    if (_stopped || generation != _generation || _lossScheduled) return;
    _lossScheduled = true;
    _heartbeat?.cancel();
    _heartbeat = null;
    final connection = _connection;
    _connection = null;
    unawaited(_subscription?.cancel());
    _subscription = null;
    unawaited(connection?.close());
    _reconnect?.cancel();
    final seconds = (1 << _attempt.clamp(0, 4)).clamp(1, 16);
    _attempt = (_attempt + 1).clamp(0, 8);
    _reconnect = Timer(Duration(seconds: seconds), () {
      _reconnect = null;
      _lossScheduled = false;
      unawaited(
        _connect(
          baseUrl: baseUrl,
          deviceId: deviceId,
          session: session,
          isCurrent: isCurrent,
          onEvent: onEvent,
          generation: generation,
        ),
      );
    });
  }

  Future<void> stop() async {
    _stopped = true;
    _lossScheduled = false;
    ++_generation;
    _reconnect?.cancel();
    _reconnect = null;
    _heartbeat?.cancel();
    _heartbeat = null;
    final subscription = _subscription;
    _subscription = null;
    await subscription?.cancel();
    final connection = _connection;
    _connection = null;
    await connection?.close();
    _connecting = false;
  }
}

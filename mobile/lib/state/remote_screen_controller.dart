import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../models/remote_screen.dart';
import 'remote_screen_transport.dart';

typedef RemoteScreenRequest =
    Future<Map<String, dynamic>> Function(
      String method,
      String path, {
      Map<String, dynamic>? body,
    });
typedef RemoteScreenConnect = Future<RemoteScreenConnection> Function(Uri uri);

/// Receives pixels only; no pointer, keyboard, clipboard or file commands exist.
/// The caller supplies its existing identity-guarded HTTP request function.
class RemoteScreenController extends ChangeNotifier {
  final Uri baseUrl;
  final RemoteScreenRequest request;
  final RemoteScreenConnect connect;
  final bool Function()? isCurrent;
  RemoteScreenGrant? grant;
  Uint8List? frame;
  DateTime? receivedAt;
  String status = '电脑同意后，才能开始查看所选屏幕。';
  bool busy = false;
  bool ended = false;
  bool _disposed = false;
  int _generation = 0;
  Timer? _timer;
  RemoteScreenConnection? _connection;
  StreamSubscription<Object>? _subscription;
  bool _opening = false;
  bool _polling = false;
  DateTime? _connectedAt;
  bool _ready = false;
  bool _awaitingFrame = false;
  int _lastSequence = 0;

  RemoteScreenController({
    required this.baseUrl,
    required this.request,
    RemoteScreenConnect? connect,
    this.isCurrent,
  }) : connect = connect ?? connectRemoteScreen;

  bool _current(int generation) {
    if (_disposed || ended || generation != _generation) return false;
    if (isCurrent != null && !isCurrent!()) {
      unawaited(stop(message: '登录身份已变化，画面已清除'));
      return false;
    }
    return true;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> start(String sourceClientId) async {
    if (busy || grant != null || _disposed) return;
    if (!_current(_generation)) return;
    if (baseUrl.userInfo.isNotEmpty ||
        (baseUrl.scheme != 'https' &&
            !(baseUrl.scheme == 'http' &&
                ['127.0.0.1', 'localhost'].contains(baseUrl.host)))) {
      status = '看屏只支持HTTPS服务';
      ended = true;
      _notify();
      return;
    }
    busy = true;
    ended = false;
    final generation = ++_generation;
    status = '正在向电脑申请只读看屏…';
    _notify();
    try {
      final result = await request(
        'POST',
        '/api/v1/remote-screen/requests',
        body: {'sourceClientId': sourceClientId},
      );
      if (!_current(generation)) {
        if (result['id'] is String) {
          await request(
            'POST',
            '/api/v1/remote-screen/requests/${result['id']}/stop',
            body: {},
          );
        }
        return;
      }
      grant = RemoteScreenGrant.fromJson(result);
      if (grant!.sourceClientId != sourceClientId) {
        throw const FormatException('来源电脑不匹配');
      }
      status = '等待电脑上的用户选择屏幕并明确同意';
      _timer = Timer.periodic(
        const Duration(seconds: 1),
        (_) => unawaited(_poll(generation)),
      );
      await _poll(generation);
    } catch (_) {
      await stop(message: '看屏申请失败，请检查连接后重新打开此页面');
    } finally {
      if (_current(generation)) {
        busy = false;
        _notify();
      }
    }
  }

  Future<void> _poll(int generation) async {
    if (_polling || !_current(generation) || grant == null) return;
    _polling = true;
    try {
      final result = await request(
        'GET',
        '/api/v1/remote-screen/requests/${grant!.id}',
      );
      if (!_current(generation)) return;
      final next = RemoteScreenGrant.fromJson(result);
      if (next.id != grant!.id ||
          next.sourceClientId != grant!.sourceClientId ||
          !['pending', 'active'].contains(next.state)) {
        await stop(message: '本次屏幕共享已结束');
        return;
      }
      grant = next;
      if (next.state == 'active' && _connection == null && !_opening) {
        await _open(generation);
      }
      if (_connection != null) {
        _connection!.send('{"type":"ping"}');
        if (receivedAt != null &&
            DateTime.now().difference(receivedAt!).inSeconds >= 3) {
          frame = null;
          status = '来源画面暂时中断，已隐藏旧画面';
        }
        if (frame == null &&
            _connectedAt != null &&
            DateTime.now().difference(_connectedAt!).inSeconds >= 15) {
          await stop(message: '未收到来源画面，本次看屏已停止');
        }
      }
      _notify();
    } catch (_) {
      if (_current(generation)) await stop(message: '看屏连接或授权已失效，画面已清除');
    } finally {
      _polling = false;
    }
  }

  Future<void> _open(int generation) async {
    _opening = true;
    try {
      final ticket = await request(
        'POST',
        '/api/v1/remote-screen/requests/${grant!.id}/ticket',
        body: {},
      );
      if (!_current(generation)) return;
      if (ticket['role'] != 'viewer' || ticket['ticket'] is! String) {
        throw const FormatException('看屏票据无效');
      }
      final uri = baseUrl
          .resolve('/api/v1/remote-screen/media')
          .replace(scheme: baseUrl.scheme == 'https' ? 'wss' : 'ws');
      final channel = await connect(uri);
      if (!_current(generation)) {
        await channel.close();
        return;
      }
      _connection = channel;
      _connectedAt = DateTime.now();
      _subscription = channel.messages.listen(
        (event) {
          if (!_current(generation)) return;
          if (event is String) {
            try {
              final message = jsonDecode(event) as Map<String, dynamic>;
              if (message['type'] == 'ended') {
                unawaited(stop(message: '来源电脑已停止共享'));
              } else if (message['type'] == 'ready' &&
                  !_ready &&
                  message['role'] == 'viewer' &&
                  message['permission'] == 'view') {
                _ready = true;
                status = '已取得只读授权，等待来源画面';
                _notify();
              } else if (message['type'] == 'frame' &&
                  _ready &&
                  !_awaitingFrame &&
                  message['sequence'] is int &&
                  message['sequence'] > _lastSequence &&
                  message['width'] is int &&
                  message['height'] is int &&
                  message['width'] > 0 &&
                  message['height'] > 0 &&
                  message['width'] <= 1280 &&
                  message['height'] <= 1280 &&
                  message['at'] is num &&
                  (message['at'] as num).isFinite) {
                _lastSequence = message['sequence'] as int;
                _awaitingFrame = true;
              } else {
                throw const FormatException('看屏协议不匹配');
              }
            } catch (_) {
              unawaited(stop(message: '看屏消息无效，已停止'));
            }
          } else if (event is List<int>) {
            if (!_ready ||
                !_awaitingFrame ||
                event.length > 384 * 1024 ||
                event.length < 10 ||
                event[0] != 255 ||
                event[1] != 216 ||
                event[event.length - 2] != 255 ||
                event.last != 217) {
              unawaited(stop(message: '画面超过安全上限'));
              return;
            }
            _awaitingFrame = false;
            frame = Uint8List.fromList(event);
            receivedAt = DateTime.now();
            status = '正在只读查看 · 最多每秒2帧';
            _notify();
          }
        },
        onDone: () {
          if (_current(generation)) unawaited(stop(message: '屏幕共享连接已断开'));
        },
        onError: (Object _) {
          if (_current(generation)) unawaited(stop(message: '屏幕共享连接失败'));
        },
      );
      channel.send(jsonEncode({'type': 'auth', 'ticket': ticket['ticket']}));
    } finally {
      _opening = false;
    }
  }

  Future<void> stop({String message = '屏幕共享已停止'}) async {
    if (ended) return;
    ended = true;
    busy = false;
    ++_generation;
    frame = null;
    receivedAt = null;
    _awaitingFrame = false;
    status = message;
    _timer?.cancel();
    _notify();
    final channel = _connection;
    _connection = null;
    await _subscription?.cancel();
    await channel?.close();
    if (grant != null) {
      try {
        await request(
          'POST',
          '/api/v1/remote-screen/requests/${grant!.id}/stop',
          body: {},
        );
      } catch (_) {
        /* Finite server grant and socket closure also revoke. */
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(stop());
    super.dispose();
  }
}

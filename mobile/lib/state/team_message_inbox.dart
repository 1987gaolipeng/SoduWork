import 'package:flutter/foundation.dart';

import '../core/soduwork_api.dart';
import '../models/team_message.dart';

typedef TeamMessagePageLoader =
    Future<Map<String, dynamic>> Function({
      required String folder,
      required String before,
    });
typedef TeamMessageReader = Future<Map<String, dynamic>> Function(String id);

enum TeamMessageFolder { received, sent }

class TeamMessageFolderState {
  final Map<String, TeamMessage> _rows = {};
  final Set<String> _traversal = {};
  final Set<String> _requestedCursors = {};
  String _nextCursor = '';
  String _error = '';
  bool _initialized = false;
  bool _loading = false;
  bool _loadingMore = false;
  int _request = 0;
  Future<void>? _operation;

  List<TeamMessage> get messages => List.unmodifiable(
    _rows.values.toList()..sort((a, b) {
      final time = (b.createdAt?.millisecondsSinceEpoch ?? 0).compareTo(
        a.createdAt?.millisecondsSinceEpoch ?? 0,
      );
      return time != 0 ? time : b.id.compareTo(a.id);
    }),
  );
  String get nextCursor => _nextCursor;
  String get error => _error;
  bool get initialized => _initialized;
  bool get loading => _loading;
  bool get loadingMore => _loadingMore;
  bool get hasMore => _nextCursor.isNotEmpty;
  bool get complete => _initialized && !hasMore;
  TeamMessage? find(String id) => _rows[id];

  void _clear() {
    _request++;
    _rows.clear();
    _traversal.clear();
    _requestedCursors.clear();
    _nextCursor = _error = '';
    _initialized = _loading = _loadingMore = false;
    _operation = null;
  }
}

/// A read cache for the authenticated user's inbox, never a team-wide feed.
/// The host must call [clear] when endpoint or account identity changes.
class TeamMessageInbox extends ChangeNotifier {
  final TeamMessagePageLoader load;
  final TeamMessageReader read;
  final received = TeamMessageFolderState();
  final sent = TeamMessageFolderState();
  final Map<String, Future<bool>> _reads = {};
  final Map<String, String> _readErrors = {};
  final Map<String, TeamMessage> _confirmedReads = {};
  int? _serverUnreadCount;
  int _generation = 0;
  int _readVersion = 0;
  bool _disposed = false;

  TeamMessageInbox({required this.load, required this.read});

  TeamMessageFolderState folder(TeamMessageFolder folder) =>
      folder == TeamMessageFolder.received ? received : sent;

  /// Null means the total is unknown, never a count of just the loaded page.
  int? get unreadCount =>
      _serverUnreadCount ??
      (received.complete
          ? received._rows.values.where((message) => message.isUnread).length
          : null);
  bool isReading(String id) => _reads.containsKey(id);
  String readError(String id) => _readErrors[id] ?? '';

  Future<void> refresh([TeamMessageFolder side = TeamMessageFolder.received]) {
    if (_disposed) return Future.value();
    final state = folder(side);
    if (state.loading && !state.loadingMore) {
      return state._operation ?? Future.value();
    }
    return _beginLoad(side, before: '', refresh: true);
  }

  Future<void> loadMore([TeamMessageFolder side = TeamMessageFolder.received]) {
    if (_disposed) return Future.value();
    final state = folder(side);
    if (state.loading) return state._operation ?? Future.value();
    if (!state.initialized) return refresh(side);
    if (!state.hasMore) return Future.value();
    return _beginLoad(side, before: state.nextCursor, refresh: false);
  }

  Future<void> _beginLoad(
    TeamMessageFolder side, {
    required String before,
    required bool refresh,
  }) {
    final state = folder(side);
    final generation = _generation;
    final request = ++state._request;
    final readVersion = _readVersion;
    state._loading = true;
    state._loadingMore = !refresh;
    state._error = '';
    final operation = _loadPage(
      side,
      before: before,
      refresh: refresh,
      generation: generation,
      request: request,
      readVersion: readVersion,
    );
    state._operation = operation;
    notifyListeners();
    return operation;
  }

  bool _current(int generation) => !_disposed && generation == _generation;

  Future<void> _loadPage(
    TeamMessageFolder side, {
    required String before,
    required bool refresh,
    required int generation,
    required int request,
    required int readVersion,
  }) async {
    final state = folder(side);
    bool current() => _current(generation) && request == state._request;
    try {
      await Future<void>.value();
      if (!current()) return;
      final body = await load(folder: side.name, before: before);
      if (!current()) return;
      final values = body['items'];
      final cursor = body['nextCursor'];
      if (body['ok'] == false ||
          values is! List ||
          values.length > 100 ||
          cursor is! String ||
          body['folder'] != null && body['folder'] != side.name) {
        throw const ApiFailure('消息列表响应不完整，请重试。');
      }
      final rows = <TeamMessage>[];
      for (final value in values) {
        if (value is! Map<String, dynamic>) {
          throw const ApiFailure('消息记录无法识别，请重试。');
        }
        final row = TeamMessage.fromJson(value);
        if (row.id.isEmpty) throw const ApiFailure('消息编号缺失，请重试。');
        final confirmed = _confirmedReads[row.id];
        rows.add(
          confirmed != null
              ? row.asRead(
                  readAt: confirmed.readAt,
                  deliveredAt: confirmed.deliveredAt,
                )
              : row,
        );
      }
      if (cursor.isNotEmpty &&
          (rows.isEmpty ||
              rows.last.id != cursor ||
              cursor == before ||
              !refresh && state._requestedCursors.contains(cursor))) {
        throw const ApiFailure('消息分页位置没有前进，请刷新后重试。');
      }
      if (state._rows.length +
              rows.where((row) => !state._rows.containsKey(row.id)).length >
          10000) {
        throw const ApiFailure('消息缓存过大，请在电脑端整理后重试。');
      }
      int? unread;
      if (body['unreadCount'] != null) {
        final value = body['unreadCount'];
        if (value is! int || value < 0) {
          throw const ApiFailure('未读消息总数无法识别，请重试。');
        }
        unread = value;
      }
      // Validation is complete before touching visible content or cursor state.
      if (refresh) {
        state._traversal.clear();
        state._requestedCursors.clear();
      }
      if (before.isNotEmpty) state._requestedCursors.add(before);
      for (final row in rows) {
        state._rows[row.id] = row;
        if (!row.isUnread) _readErrors.remove(row.id);
        state._traversal.add(row.id);
      }
      state._nextCursor = cursor;
      state._initialized = true;
      if (cursor.isEmpty) {
        state._rows.removeWhere((id, _) => !state._traversal.contains(id));
      }
      if (side == TeamMessageFolder.received) {
        if (cursor.isEmpty) {
          _confirmedReads.removeWhere(
            (id, _) => !received._rows.containsKey(id),
          );
        }
        if (readVersion != _readVersion) {
          // An older list/count cannot undo an acknowledged read. A fresh
          // server count or complete traversal will make the total known again.
          _serverUnreadCount = null;
        } else if (unread != null) {
          _serverUnreadCount = unread;
        } else if (refresh) {
          _serverUnreadCount = null;
        }
      }
    } on ApiFailure catch (failure) {
      if (current()) state._error = failure.message;
    } catch (_) {
      if (current()) state._error = '暂时无法加载消息，请重试。';
    } finally {
      if (current()) {
        state._loading = state._loadingMore = false;
        state._operation = null;
        notifyListeners();
      }
    }
  }

  /// Called only when a user opens/confirms an incoming message. Refreshing or
  /// polling the list never invokes the read endpoint.
  Future<bool> markRead(String id) {
    if (_disposed) return Future.value(false);
    final pending = _reads[id];
    if (pending != null) return pending;
    final row = received.find(id);
    if (row == null) return Future.value(false);
    if (!row.isUnread) return Future.value(true);
    _readErrors.remove(id);
    final operation = _markRead(id, _generation);
    _reads[id] = operation;
    notifyListeners();
    return operation;
  }

  Future<bool> _markRead(String id, int generation) async {
    try {
      await Future<void>.value();
      if (!_current(generation)) return false;
      final receipt = await read(id);
      if (!_current(generation)) return false;
      if (receipt['ok'] != true ||
          receipt['messageId'] != id ||
          receipt['status'] != 'read') {
        throw const ApiFailure('已读状态尚未确认，请重试。');
      }
      final current = received.find(id);
      if (current != null) {
        final row = current.asRead(
          readAt: teamMessageDate(receipt['readAt']),
          deliveredAt: teamMessageDate(receipt['deliveredAt']),
        );
        received._rows[id] = row;
        _confirmedReads[id] = row;
        if (current.isUnread &&
            _serverUnreadCount != null &&
            _serverUnreadCount! > 0) {
          _serverUnreadCount = _serverUnreadCount! - 1;
        }
      }
      final outgoing = sent.find(id);
      if (outgoing != null) {
        sent._rows[id] = outgoing.asRead(
          readAt: teamMessageDate(receipt['readAt']),
        );
      }
      _readVersion++;
      return true;
    } on ApiFailure catch (failure) {
      if (_current(generation)) _readErrors[id] = failure.message;
      return false;
    } catch (_) {
      if (_current(generation)) _readErrors[id] = '暂时无法标记已读，请重试。';
      return false;
    } finally {
      if (_current(generation)) {
        _reads.remove(id);
        notifyListeners();
      }
    }
  }

  void clear() {
    _generation++;
    received._clear();
    sent._clear();
    _reads.clear();
    _readErrors.clear();
    _confirmedReads.clear();
    _serverUnreadCount = null;
    _readVersion = 0;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    clear();
    super.dispose();
  }
}

import '../core/soduwork_api.dart';
import '../models/account_conversation.dart';

typedef ConversationPageLoader =
    Future<Map<String, dynamic>> Function({
      required int after,
      required int limit,
    });

/// Incremental read cache. It never writes a complete table back to the Hub.
/// A missing item is not a deletion; only explicit tombstones remove an item.
class AccountConversationSync {
  final Map<String, AccountConversation> _rows = {};
  int _generation = 0;
  int cursor = 0;
  bool hasMore = false;
  bool loading = false;
  bool? supported;
  String error = '';

  List<AccountConversation> get conversations =>
      _rows.values.where((row) => !row.deleted).toList(growable: false)
        ..sort((a, b) => b.revision.compareTo(a.revision));

  AccountConversation? find(String id) => _rows[id];

  void clear() {
    _generation++;
    _rows.clear();
    cursor = 0;
    hasMore = false;
    loading = false;
    supported = null;
    error = '';
  }

  Future<void> refresh({
    required ConversationPageLoader load,
    required bool Function() isCurrent,
    int maxPages = 5,
  }) async {
    if (loading) return;
    final generation = _generation;
    bool current() => generation == _generation && isCurrent();
    loading = true;
    error = '';
    try {
      for (var page = 0; page < maxPages; page++) {
        final body = await load(after: cursor, limit: 100);
        if (!current()) return;
        final items = body['items'];
        final next = body['cursor'];
        if (items is! List || next is! int || body['hasMore'] is! bool) {
          throw const ApiFailure('会话同步响应不完整，请重试。');
        }
        final rows = <AccountConversation>[];
        var previous = cursor;
        for (final value in items) {
          if (value is! Map<String, dynamic>) {
            throw const ApiFailure('会话同步记录无法识别。');
          }
          final row = AccountConversation.fromJson(value);
          if (row.id.isEmpty || row.revision <= previous) {
            throw const ApiFailure('会话同步顺序异常，请刷新后重试。');
          }
          previous = row.revision;
          rows.add(row);
        }
        final more = body['hasMore'] == true;
        if (next != previous || (more && rows.isEmpty)) {
          throw const ApiFailure('会话同步游标异常，请重试。');
        }
        final additions = rows
            .where((row) => !_rows.containsKey(row.id) && !row.deleted)
            .length;
        if (_rows.length + additions > 10000) {
          throw const ApiFailure('本次会话目录过大，请先在电脑端整理会话。');
        }
        for (final row in rows) {
          if (row.deleted) {
            _rows.remove(row.id);
          } else {
            _rows[row.id] = row;
          }
        }
        cursor = next;
        hasMore = more;
        supported = true;
        if (!more) break;
      }
    } on ApiFailure catch (failure) {
      if (!current()) return;
      if (failure.status == 404) {
        supported = false;
        error = '当前企业服务尚未提供电脑会话同步。';
      } else {
        error = failure.message;
      }
      if (failure.status == 401 || failure.status == 403) {
        // Revocation must not leave previously authorized content visible.
        clear();
        error = failure.message;
      }
    } catch (_) {
      if (current()) error = '暂时无法同步电脑会话，请重试。';
    } finally {
      if (generation == _generation) loading = false;
    }
  }
}

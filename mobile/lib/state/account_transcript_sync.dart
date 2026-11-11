import '../core/soduwork_api.dart';
import '../models/account_conversation.dart';
import 'account_conversation_sync.dart';

class AccountTranscriptSync {
  final Map<String, AccountConversationMessage> _messages = {};
  AccountConversation? conversation;
  int cursor = 0;
  bool hasMore = false;
  bool loading = false;
  bool inaccessible = false;
  String error = '';
  int _generation = 0;

  List<AccountConversationMessage> get messages =>
      _messages.values.toList()..sort((a, b) {
        final position = a.position.compareTo(b.position);
        return position != 0 ? position : a.id.compareTo(b.id);
      });

  void clear() {
    _generation++;
    _messages.clear();
    conversation = null;
    cursor = 0;
    hasMore = false;
    loading = false;
  }

  Future<void> refresh({
    required String conversationId,
    required ConversationPageLoader load,
    required bool Function() isCurrent,
    int maxPages = 5,
  }) async {
    if (loading || inaccessible) return;
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
        final metadata = body['conversation'];
        if (items is! List ||
            next is! int ||
            metadata is! Map<String, dynamic> ||
            body['hasMore'] is! bool) {
          throw const ApiFailure('聊天记录响应不完整，请重试。');
        }
        final row = AccountConversation.fromJson(metadata);
        if (row.id != conversationId) {
          throw const ApiFailure('聊天记录与当前会话不匹配。');
        }
        if (row.deleted) {
          clear();
          inaccessible = true;
          error = '这条会话已在来源设备删除。';
          return;
        }
        var previous = cursor;
        final changes = <AccountConversationMessage>[];
        for (final value in items) {
          if (value is! Map<String, dynamic>) {
            throw const ApiFailure('聊天记录无法识别。');
          }
          final message = AccountConversationMessage.fromJson(value);
          if (message.id.isEmpty ||
              message.revision <= previous ||
              message.position < 0 ||
              !{'user', 'assistant'}.contains(message.role)) {
            throw const ApiFailure('聊天记录同步顺序异常。');
          }
          previous = message.revision;
          changes.add(message);
        }
        final more = body['hasMore'] == true;
        if (next != previous || (more && changes.isEmpty)) {
          throw const ApiFailure('聊天记录同步游标异常。');
        }
        final merged = {..._messages};
        for (final message in changes) {
          if (message.deleted) {
            merged.remove(message.id);
          } else {
            merged[message.id] = message;
          }
        }
        if (merged.length > 20000 ||
            merged.values.fold<int>(
                  0,
                  (size, message) => size + message.text.length,
                ) >
                32 * 1024 * 1024) {
          throw const ApiFailure('这条会话内容较大，请在来源电脑查看完整记录。');
        }
        _messages
          ..clear()
          ..addAll(merged);
        conversation = row;
        cursor = next;
        hasMore = more;
        if (!more) break;
      }
    } on ApiFailure catch (failure) {
      if (!current()) return;
      error = failure.message;
      if ({401, 403, 404, 410}.contains(failure.status)) {
        clear();
        inaccessible = true;
        error = failure.status == 404 || failure.status == 410
            ? '这条会话已删除或暂不可访问。'
            : failure.message;
      }
    } catch (_) {
      if (current()) error = '暂时无法更新聊天记录，请重试。';
    } finally {
      if (generation == _generation) loading = false;
    }
  }
}

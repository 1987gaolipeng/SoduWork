import '../models/general_chat.dart';
import 'general_chat_store.dart';

class LocalChatEntry {
  final String sessionId, title;
  const LocalChatEntry(this.sessionId, this.title);
}

/// Read-only projection of the existing durable outbox, not another database.
Future<List<LocalChatEntry>> localChatDirectory(GeneralChatScope scope) async {
  final store = GeneralChatStore(), rows = <LocalChatEntry>[];
  for (final id in await store.pendingSessions(scope)) {
    final box = await store.read(scope, id);
    if (box == null || box.batches.isEmpty) continue;
    final title = (box.batches.last.body['title'] ?? '未同步聊天').toString();
    rows.add(LocalChatEntry(id, title));
  }
  return rows.reversed.toList();
}

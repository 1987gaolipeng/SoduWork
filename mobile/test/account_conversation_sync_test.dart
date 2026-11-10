import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/account_conversation_sync.dart';
import 'package:soduwork_mobile/state/account_transcript_sync.dart';

Map<String, dynamic> row(
  String id,
  int revision, {
  bool deleted = false,
  bool archived = false,
}) => {
  'id': id,
  'sourceSessionId': 'source-$id',
  'sourceClientId': 'pc-test',
  'sourceDeviceName': '测试电脑',
  'title': '测试会话$id',
  'state': 'idle',
  'archived': archived,
  'deleted': deleted,
  'revision': revision,
};

Map<String, dynamic> page(
  List<Map<String, dynamic>> items,
  int cursor, {
  bool more = false,
}) => {'items': items, 'cursor': cursor, 'hasMore': more};

Map<String, dynamic> message(
  String id,
  int position,
  int revision,
  String text, {
  bool deleted = false,
}) => {
  'id': id,
  'position': position,
  'revision': revision,
  'text': text,
  'role': 'assistant',
  'deleted': deleted,
};

void main() {
  test(
    'directory merges paginated updates, retains absent rows, and applies explicit tombstones',
    () async {
      final sync = AccountConversationSync();
      final requests = <int>[];
      await sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async {
          requests.add(after);
          return after == 0
              ? page([row('one', 1)], 1, more: true)
              : page([row('two', 3)], 3);
        },
      );
      expect(requests, [0, 1]);
      expect(sync.conversations.map((row) => row.id), ['two', 'one']);
      await sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async =>
            page([row('one', 4, archived: true)], 4),
      );
      expect(sync.find('one')!.archived, isTrue);
      expect(sync.find('two'), isNotNull);
      await sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async =>
            page([row('one', 5, deleted: true)], 5),
      );
      expect(sync.find('one'), isNull);
      expect(sync.cursor, 5);
    },
  );

  test(
    'a response from a previous login cannot repopulate a cleared directory',
    () async {
      final response = Completer<Map<String, dynamic>>();
      final sync = AccountConversationSync();
      final pending = sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) => response.future,
      );
      sync.clear();
      response.complete(page([row('old-account', 1)], 1));
      await pending;
      expect(sync.conversations, isEmpty);
      expect(sync.cursor, 0);
      expect(sync.loading, isFalse);
    },
  );

  test(
    'invalid cursor does not consume a page or delete cached rows',
    () async {
      final sync = AccountConversationSync();
      await sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async =>
            page([row('one', 1)], 1),
      );
      await sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async =>
            page([row('bad', 2)], 999),
      );
      expect(sync.cursor, 1);
      expect(sync.find('one'), isNotNull);
      expect(sync.find('bad'), isNull);
      expect(sync.error, contains('游标异常'));
    },
  );

  test(
    'directory limits a refresh and resumes from the last applied cursor',
    () async {
      final sync = AccountConversationSync();
      Future<Map<String, dynamic>> load({
        required int after,
        required int limit,
      }) async =>
          page([row('id-${after + 1}', after + 1)], after + 1, more: true);
      await sync.refresh(isCurrent: () => true, load: load, maxPages: 2);
      expect(sync.cursor, 2);
      expect(sync.hasMore, isTrue);
      await sync.refresh(isCurrent: () => true, load: load, maxPages: 1);
      expect(sync.cursor, 3);
      expect(sync.conversations.length, 3);
    },
  );

  test(
    'an old Hub reports unsupported and access revocation clears cached rows',
    () async {
      final sync = AccountConversationSync();
      await sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async =>
            page([row('one', 1)], 1),
      );
      await sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async {
          throw const ApiFailure('not deployed', status: 404);
        },
      );
      expect(sync.supported, isFalse);
      expect(sync.find('one'), isNotNull);
      await sync.refresh(
        isCurrent: () => true,
        load: ({required after, required limit}) async {
          throw const ApiFailure('设备已撤销', status: 403);
        },
      );
      expect(sync.conversations, isEmpty);
      expect(sync.loading, isFalse);
      expect(sync.error, '设备已撤销');
    },
  );

  test(
    'message updates replace a stable id and keep display position across change cursors',
    () async {
      final sync = AccountTranscriptSync();
      Future<void> apply(List<Map<String, dynamic>> changes, int cursor) =>
          sync.refresh(
            conversationId: 'one',
            isCurrent: () => true,
            load: ({required after, required limit}) async => {
              ...page(changes, cursor),
              'conversation': row('one', cursor),
            },
          );
      await apply([
        message('first', 0, 1, '开始'),
        message('second', 1, 2, '之后'),
      ], 2);
      await apply([message('first', 0, 3, '完整回答')], 3);
      expect(sync.messages.map((m) => m.id), ['first', 'second']);
      expect(sync.messages.first.text, '完整回答');
      await apply([message('second', 1, 4, '', deleted: true)], 4);
      expect(sync.messages.map((m) => m.id), ['first']);
      expect(sync.cursor, 4);
    },
  );

  test(
    'denied access clears a transcript and prevents background polling',
    () async {
      final sync = AccountTranscriptSync();
      await sync.refresh(
        conversationId: 'one',
        isCurrent: () => true,
        load: ({required after, required limit}) async => {
          ...page([message('first', 0, 1, '私有内容')], 1),
          'conversation': row('one', 1),
        },
      );
      await sync.refresh(
        conversationId: 'one',
        isCurrent: () => true,
        load: ({required after, required limit}) async =>
            throw const ApiFailure('无权访问', status: 403),
      );
      expect(sync.messages, isEmpty);
      expect(sync.inaccessible, isTrue);
      await sync.refresh(
        conversationId: 'one',
        isCurrent: () => true,
        load: ({required after, required limit}) async =>
            throw StateError('must not retry'),
      );
      expect(sync.error, '无权访问');
    },
  );

  test('late transcript results after identity change are discarded', () async {
    final response = Completer<Map<String, dynamic>>();
    final sync = AccountTranscriptSync();
    var current = true;
    final pending = sync.refresh(
      conversationId: 'one',
      isCurrent: () => current,
      load: ({required after, required limit}) => response.future,
    );
    current = false;
    response.complete({
      ...page([message('one', 0, 1, '旧账号')], 1),
      'conversation': row('one', 1),
    });
    await pending;
    expect(sync.messages, isEmpty);
  });

  test(
    'a foreign conversation envelope cannot populate this transcript',
    () async {
      final sync = AccountTranscriptSync();
      await sync.refresh(
        conversationId: 'one',
        isCurrent: () => true,
        load: ({required after, required limit}) async => {
          ...page([message('first', 0, 1, '其他会话内容')], 1),
          'conversation': row('other', 1),
        },
      );
      expect(sync.messages, isEmpty);
      expect(sync.cursor, 0);
      expect(sync.error, contains('不匹配'));
    },
  );
}

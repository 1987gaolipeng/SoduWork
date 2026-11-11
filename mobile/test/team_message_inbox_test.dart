import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/team_message_inbox.dart';

void main() {
  test(
    'old Hub incomplete pages never pretend loaded unread rows are the total',
    () async {
      var reads = 0;
      final cursors = <String>[];
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async {
          cursors.add(before);
          return before.isEmpty
              ? _page([_row('a', 3), _row('b', 2)], cursor: 'b')
              : _page([_row('b', 2, read: true), _row('c', 1)]);
        },
        read: (_) async {
          reads++;
          return _ack('a');
        },
      );
      addTearDown(inbox.dispose);
      expect(inbox.unreadCount, isNull);
      await inbox.refresh();
      expect(inbox.received.messages.map((row) => row.id), ['a', 'b']);
      expect(inbox.unreadCount, isNull);
      expect(inbox.received.complete, isFalse);
      await inbox.loadMore();
      expect(inbox.received.messages.map((row) => row.id), ['a', 'b', 'c']);
      expect(inbox.received.find('b')!.isUnread, isFalse);
      expect(inbox.unreadCount, 2);
      expect(inbox.received.complete, isTrue);
      expect(cursors, ['', 'b']);
      expect(reads, 0);
    },
  );

  test(
    'received and sent keep independent cursors, errors and totals',
    () async {
      final calls = <String>[];
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async {
          calls.add('$folder:$before');
          return _page(
            [_row('$folder-${before.isEmpty ? 'a' : 'b'}', 1)],
            folder: folder,
            cursor: before.isEmpty ? '$folder-a' : '',
            unread: folder == 'received' ? 12 : 999,
          );
        },
        read: (id) async => _ack(id),
      );
      addTearDown(inbox.dispose);
      await inbox.refresh(TeamMessageFolder.sent);
      expect(inbox.unreadCount, isNull);
      await inbox.refresh();
      expect(inbox.unreadCount, 12);
      await inbox.loadMore(TeamMessageFolder.sent);
      expect(inbox.sent.messages, hasLength(2));
      expect(inbox.received.messages, hasLength(1));
      expect(inbox.received.nextCursor, 'received-a');
      expect(inbox.unreadCount, 12);
      expect(calls, ['sent:', 'received:', 'sent:sent-a']);
    },
  );

  test(
    'refresh failure retains old content and total and can be retried',
    () async {
      var calls = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async {
          calls++;
          if (calls == 2) throw const ApiFailure('暂时断网', isNetwork: true);
          return calls == 1
              ? _page([_row('old', 1)], unread: 4)
              : _page([_row('new', 2)], unread: 1);
        },
        read: (id) async => _ack(id),
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      await inbox.refresh();
      expect(inbox.received.messages.single.id, 'old');
      expect(inbox.received.error, '暂时断网');
      expect(inbox.unreadCount, 4);
      await inbox.refresh();
      expect(inbox.received.messages.single.id, 'new');
      expect(inbox.received.error, isEmpty);
      expect(inbox.unreadCount, 1);
    },
  );

  test(
    'partial refresh keeps loaded tail until a complete traversal recalibrates it',
    () async {
      var calls = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async {
          calls++;
          if (calls == 1) {
            return _page([_row('c', 3), _row('b', 2), _row('a', 1)]);
          }
          if (before.isEmpty) {
            return _page([_row('d', 4), _row('c', 3)], cursor: 'c');
          }
          return _page([_row('b', 2)]);
        },
        read: (id) async => _ack(id),
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      expect(inbox.unreadCount, 3);
      await inbox.refresh();
      expect(inbox.received.messages.map((row) => row.id), [
        'd',
        'c',
        'b',
        'a',
      ]);
      expect(inbox.unreadCount, isNull);
      await inbox.loadMore();
      expect(inbox.received.messages.map((row) => row.id), ['d', 'c', 'b']);
      expect(inbox.unreadCount, 3);
    },
  );

  test('cursor loop is rejected atomically and retry can advance', () async {
    var calls = 0;
    final inbox = TeamMessageInbox(
      load: ({required folder, required before}) async {
        calls++;
        return calls < 3
            ? _page([_row('a', 2)], cursor: 'a')
            : _page([_row('b', 1)]);
      },
      read: (id) async => _ack(id),
    );
    addTearDown(inbox.dispose);
    await inbox.refresh();
    await inbox.loadMore();
    expect(inbox.received.error, contains('没有前进'));
    expect(inbox.received.nextCursor, 'a');
    expect(inbox.received.messages, hasLength(1));
    await inbox.loadMore();
    expect(inbox.received.messages, hasLength(2));
    expect(inbox.received.error, isEmpty);
  });

  test(
    'malformed page does not overwrite a valid list, cursor or unread count',
    () async {
      var calls = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async {
          calls++;
          return calls == 1
              ? _page([_row('a', 1)], unread: 6)
              : _page([_row('bad', 2)], unread: -1);
        },
        read: (id) async => _ack(id),
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      await inbox.refresh();
      expect(inbox.received.messages.single.id, 'a');
      expect(inbox.unreadCount, 6);
      expect(inbox.received.error, contains('总数'));
    },
  );

  test(
    'read requires an exact acknowledged receipt, deduplicates requests, and retries',
    () async {
      var reads = 0;
      final first = Completer<Map<String, dynamic>>();
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async =>
            _page([_row('a', 1)], cursor: 'a', unread: 5),
        read: (id) {
          reads++;
          return reads == 1 ? first.future : Future.value(_ack(id));
        },
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      final reading = inbox.markRead('a');
      expect(identical(reading, inbox.markRead('a')), isTrue);
      expect(inbox.isReading('a'), isTrue);
      first.complete({'ok': true, 'messageId': 'different', 'status': 'read'});
      expect(await reading, isFalse);
      expect(inbox.received.find('a')!.isUnread, isTrue);
      expect(inbox.unreadCount, 5);
      expect(inbox.readError('a'), contains('尚未确认'));
      expect(await inbox.markRead('a'), isTrue);
      expect(inbox.received.find('a')!.isUnread, isFalse);
      expect(inbox.readError('a'), isEmpty);
      expect(inbox.unreadCount, 4);
      expect(await inbox.markRead('a'), isTrue);
      expect(reads, 2);
      expect(inbox.isReading('a'), isFalse);
    },
  );

  test(
    'different messages have independent read errors and busy states',
    () async {
      final a = Completer<Map<String, dynamic>>();
      final b = Completer<Map<String, dynamic>>();
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async =>
            _page([_row('a', 2), _row('b', 1)], unread: 9),
        read: (id) => id == 'a' ? a.future : b.future,
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      final readingA = inbox.markRead('a');
      final readingB = inbox.markRead('b');
      expect(inbox.isReading('a'), isTrue);
      expect(inbox.isReading('b'), isTrue);
      a.completeError(const ApiFailure('a读取失败'));
      expect(await readingA, isFalse);
      expect(inbox.isReading('a'), isFalse);
      expect(inbox.isReading('b'), isTrue);
      b.complete(_ack('b'));
      expect(await readingB, isTrue);
      expect(inbox.readError('a'), 'a读取失败');
      expect(inbox.readError('b'), isEmpty);
      expect(inbox.received.find('a')!.isUnread, isTrue);
      expect(inbox.received.find('b')!.isUnread, isFalse);
      expect(inbox.unreadCount, 8);
    },
  );

  test(
    'identity clear discards old pages and permits loading the new identity immediately',
    () async {
      final old = Completer<Map<String, dynamic>>();
      var calls = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) {
          calls++;
          return calls == 1
              ? old.future
              : Future.value(_page([_row('new', 2)], unread: 1));
        },
        read: (id) async => _ack(id),
      );
      addTearDown(inbox.dispose);
      final pending = inbox.refresh();
      await Future<void>.value();
      inbox.clear();
      expect(inbox.received.messages, isEmpty);
      expect(inbox.received.loading, isFalse);
      expect(inbox.unreadCount, isNull);
      await inbox.refresh();
      old.complete(_page([_row('old-private', 9)], unread: 88));
      await pending;
      expect(inbox.received.messages.single.id, 'new');
      expect(inbox.unreadCount, 1);
    },
  );

  test(
    'old read completion cannot clear a new identity read operation for the same ID',
    () async {
      final old = Completer<Map<String, dynamic>>();
      final fresh = Completer<Map<String, dynamic>>();
      var reads = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async =>
            _page([_row('same', 1)]),
        read: (id) {
          reads++;
          return reads == 1 ? old.future : fresh.future;
        },
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      final first = inbox.markRead('same');
      await Future<void>.value();
      inbox.clear();
      await inbox.refresh();
      final second = inbox.markRead('same');
      old.complete(_ack('same'));
      expect(await first, isFalse);
      expect(inbox.isReading('same'), isTrue);
      expect(inbox.received.find('same')!.isUnread, isTrue);
      fresh.complete(_ack('same'));
      expect(await second, isTrue);
      expect(inbox.isReading('same'), isFalse);
    },
  );

  test('fresh head refresh supersedes an older load-more result', () async {
    final older = Completer<Map<String, dynamic>>();
    var heads = 0;
    final inbox = TeamMessageInbox(
      load: ({required folder, required before}) async {
        if (before.isNotEmpty) return older.future;
        heads++;
        return heads == 1
            ? _page([_row('a', 1)], cursor: 'a')
            : _page([_row('fresh', 3)]);
      },
      read: (id) async => _ack(id),
    );
    addTearDown(inbox.dispose);
    await inbox.refresh();
    final loadingMore = inbox.loadMore();
    await Future<void>.value();
    await inbox.refresh();
    older.complete(_page([_row('stale', 0)]));
    await loadingMore;
    expect(inbox.received.messages.single.id, 'fresh');
    expect(inbox.received.complete, isTrue);
  });

  test(
    'stale poll cannot restore unread status or stale server count after a read',
    () async {
      var calls = 0;
      final stale = Completer<Map<String, dynamic>>();
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) {
          calls++;
          return calls == 2
              ? stale.future
              : Future.value(
                  _page(
                    [_row('a', 1, read: calls > 2)],
                    cursor: 'a',
                    unread: calls > 2 ? 4 : 5,
                  ),
                );
        },
        read: (id) async => _ack(id),
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      final polling = inbox.refresh();
      await Future<void>.value();
      await inbox.markRead('a');
      stale.complete(_page([_row('a', 1)], cursor: 'a', unread: 5));
      await polling;
      expect(inbox.received.find('a')!.isUnread, isFalse);
      expect(inbox.unreadCount, isNull);
      await inbox.refresh();
      expect(inbox.unreadCount, 4);
    },
  );

  test(
    'a failed or unsupported initial response never becomes a known zero',
    () async {
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async => {
          'ok': false,
          'items': [],
          'nextCursor': '',
        },
        read: (id) async => _ack(id),
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      expect(inbox.received.initialized, isFalse);
      expect(inbox.received.error, isNotEmpty);
      expect(inbox.unreadCount, isNull);
    },
  );

  test(
    'sent or unknown rows cannot trigger an incoming read request',
    () async {
      var reads = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) async =>
            _page([_row('outgoing', 1)], folder: folder),
        read: (id) async {
          reads++;
          return _ack(id);
        },
      );
      addTearDown(inbox.dispose);
      await inbox.refresh(TeamMessageFolder.sent);
      expect(await inbox.markRead('outgoing'), isFalse);
      expect(await inbox.markRead('missing'), isFalse);
      expect(reads, 0);
    },
  );

  test(
    'synchronous callback failures remain retryable and never strand busy flags',
    () async {
      var loads = 0;
      var reads = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) {
          loads++;
          if (loads == 1) throw const ApiFailure('同步加载失败');
          return Future.value(_page([_row('a', 1)]));
        },
        read: (id) {
          reads++;
          if (reads == 1) throw const ApiFailure('同步已读失败');
          return Future.value(_ack(id));
        },
      );
      addTearDown(inbox.dispose);
      await inbox.refresh();
      expect(inbox.received.loading, isFalse);
      expect(inbox.received.error, '同步加载失败');
      await inbox.refresh();
      expect(await inbox.markRead('a'), isFalse);
      expect(inbox.isReading('a'), isFalse);
      expect(await inbox.markRead('a'), isTrue);
    },
  );

  test(
    'concurrent head refresh calls share one operation and polling never marks read',
    () async {
      final page = Completer<Map<String, dynamic>>();
      var loads = 0;
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) {
          loads++;
          return page.future;
        },
        read: (_) async => throw StateError('Polling must not mark read'),
      );
      addTearDown(inbox.dispose);
      final first = inbox.refresh();
      expect(identical(first, inbox.refresh()), isTrue);
      page.complete(_page([]));
      await first;
      expect(loads, 1);
      expect(inbox.unreadCount, 0);
      expect(inbox.received.complete, isTrue);
    },
  );

  test(
    'dispose prevents pending responses from restoring data or notifying',
    () async {
      final page = Completer<Map<String, dynamic>>();
      final inbox = TeamMessageInbox(
        load: ({required folder, required before}) => page.future,
        read: (id) async => _ack(id),
      );
      var notifications = 0;
      inbox.addListener(() => notifications++);
      final operation = inbox.refresh();
      await Future<void>.value();
      inbox.dispose();
      final previous = notifications;
      page.complete(_page([_row('old', 1)], unread: 999));
      await operation;
      expect(notifications, previous);
      expect(inbox.received.messages, isEmpty);
      expect(inbox.unreadCount, isNull);
    },
  );
}

Map<String, dynamic> _row(String id, int order, {bool read = false}) => {
  'id': id,
  'messageId': 'client-$id',
  'senderId': 'sender',
  'recipientId': 'recipient',
  'text': '消息 $id',
  'status': read ? 'read' : 'delivered',
  'createdAt': 1700000000000 + order,
  'readAt': read ? 1700000001000 : 0,
};
Map<String, dynamic> _page(
  List<Map<String, dynamic>> items, {
  String folder = 'received',
  String cursor = '',
  int? unread,
}) => {
  'ok': true,
  'folder': folder,
  'items': items,
  'nextCursor': cursor,
  'unreadCount': ?unread,
};
Map<String, dynamic> _ack(String id) => {
  'ok': true,
  'messageId': id,
  'status': 'read',
  'readAt': 1700000001000,
  'deliveredAt': 1700000000000,
};

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/team_message.dart';

void main() {
  test(
    'Hub message IDs, task links, delivery and read times retain their meaning',
    () {
      final row = TeamMessage.fromJson({
        'id': 'server-message',
        'messageId': 'sender-idempotency',
        'senderId': 'sender',
        'recipientId': 'recipient',
        'senderName': '同事甲',
        'recipientName': '同事乙',
        'conversationId': 'task:task-9',
        'kind': 'task_assignment',
        'taskId': 'task-9',
        'text': '第一行\n第二行',
        'status': 'delivered',
        'createdAt': 1700000000000,
        'deliveredAt': 1700000001000,
        'readAt': 0,
        'attachments': [
          {'id': 'attachment-1', 'name': '文档.pdf'},
        ],
        'website': {
          'status': 'available',
          'url': 'https://fixture.example/result',
        },
      });
      expect(row.id, 'server-message');
      expect(row.messageId, 'sender-idempotency');
      expect(row.isTaskAssignment, isTrue);
      expect(row.taskId, 'task-9');
      expect(row.isUnread, isTrue);
      expect(row.createdAt?.millisecondsSinceEpoch, 1700000000000);
      expect(row.createdAt?.isUtc, isTrue);
      expect(row.text, '第一行\n第二行');
      final updated = row.asRead(
        readAt: DateTime.fromMillisecondsSinceEpoch(1700000002000, isUtc: true),
      );
      expect(updated.isUnread, isFalse);
      expect(row.isUnread, isTrue);
      expect(updated.deliveredAt, row.deliveredAt);
      expect(updated.attachments.single['id'], 'attachment-1');
      expect(() => updated.attachments.add({}), throwsUnsupportedError);
      expect(
        () => updated.attachments.single['name'] = 'changed',
        throwsUnsupportedError,
      );
      expect(
        () => updated.website['url'] = 'https://other.example',
        throwsUnsupportedError,
      );
    },
  );

  test(
    'read status is sufficient without timestamps and fallback text invents no sender',
    () {
      final read = TeamMessage.fromJson({'id': 'read', 'status': 'read'});
      expect(read.isUnread, isFalse);
      expect(read.readAt, isNull);
      expect(read.displaySender, '团队成员');
      expect(read.previewText, '团队消息');
      final attachment = TeamMessage.fromJson({
        'id': 'file',
        'attachments': [
          {'name': 'a.txt'},
        ],
      });
      expect(attachment.previewText, '发来 1 个附件');
      expect(
        TeamMessage.fromJson({
          'id': 'task',
          'kind': 'task_assignment',
          'taskId': 't',
        }).previewText,
        '发来一项工作',
      );
    },
  );
}

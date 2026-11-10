/// A Hub-owned private inbox record. [id] is the server message ID used to read
/// or open it; [messageId] is the sender's idempotency ID and is not a URL ID.
class TeamMessage {
  final String id;
  final String messageId;
  final String senderId;
  final String recipientId;
  final String senderName;
  final String recipientName;
  final String conversationId;
  final String text;
  final String kind;
  final String taskId;
  final String status;
  final DateTime? deliveredAt;
  final DateTime? readAt;
  final DateTime? createdAt;
  final List<Map<String, dynamic>> attachments;
  final Map<String, dynamic> website;

  const TeamMessage({
    required this.id,
    required this.messageId,
    required this.senderId,
    required this.recipientId,
    required this.senderName,
    required this.recipientName,
    required this.conversationId,
    required this.text,
    required this.kind,
    required this.taskId,
    required this.status,
    required this.attachments,
    required this.website,
    this.deliveredAt,
    this.readAt,
    this.createdAt,
  });

  factory TeamMessage.fromJson(Map<String, dynamic> json) => TeamMessage(
    id: _text(json['id']),
    messageId: _text(json['messageId']),
    senderId: _text(json['senderId']),
    recipientId: _text(json['recipientId']),
    senderName: _text(json['senderName']),
    recipientName: _text(json['recipientName']),
    conversationId: _text(json['conversationId']),
    text: json['text'] is String ? json['text'] as String : '',
    kind: _text(json['kind']),
    taskId: _text(json['taskId']),
    status: _text(json['status']),
    deliveredAt: teamMessageDate(json['deliveredAt']),
    readAt: teamMessageDate(json['readAt']),
    createdAt: teamMessageDate(json['createdAt']),
    attachments: List.unmodifiable(
      (json['attachments'] is List ? json['attachments'] as List : const [])
          .whereType<Map>()
          .map(
            (row) => Map<String, dynamic>.unmodifiable(
              row.map((key, value) => MapEntry(key.toString(), value)),
            ),
          ),
    ),
    website: Map.unmodifiable(
      json['website'] is Map
          ? (json['website'] as Map).map(
              (key, value) => MapEntry(key.toString(), value),
            )
          : <String, dynamic>{},
    ),
  );

  bool get isUnread => status != 'read' && readAt == null;
  bool get isTaskAssignment => kind == 'task_assignment' && taskId.isNotEmpty;
  String get displaySender => senderName.isEmpty ? '团队成员' : senderName;
  String get displayRecipient => recipientName.isEmpty ? '团队成员' : recipientName;
  String get previewText => text.trim().isNotEmpty
      ? text.trim()
      : isTaskAssignment
      ? '发来一项工作'
      : attachments.isNotEmpty
      ? '发来 ${attachments.length} 个附件'
      : '团队消息';

  TeamMessage asRead({DateTime? readAt, DateTime? deliveredAt}) => TeamMessage(
    id: id,
    messageId: messageId,
    senderId: senderId,
    recipientId: recipientId,
    senderName: senderName,
    recipientName: recipientName,
    conversationId: conversationId,
    text: text,
    kind: kind,
    taskId: taskId,
    status: 'read',
    attachments: attachments,
    website: website,
    createdAt: createdAt,
    readAt: readAt ?? this.readAt,
    deliveredAt: deliveredAt ?? this.deliveredAt,
  );
}

DateTime? teamMessageDate(dynamic value) {
  if (value is int && value > 0) {
    return DateTime.fromMillisecondsSinceEpoch(value, isUtc: true);
  }
  if (value is String) return DateTime.tryParse(value);
  return null;
}

String _text(dynamic value) => value is String ? value.trim() : '';

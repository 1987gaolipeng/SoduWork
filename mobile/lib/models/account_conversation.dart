/// Hub-owned projection of a conversation created on another device.
/// The source device owns native checkpoints; an account device may continue
/// on the original PC through the authorized relay, or explicitly branch.
class AccountConversation {
  final String id;
  final String sourceSessionId;
  final String taskProjectionId;
  final int? messageCount;
  final String sourceClientId;
  final String sourceDeviceName;
  final String title;
  final String state;
  final bool archived;
  final bool deleted;
  final bool canContinue;
  final int revision;
  final DateTime? updatedAt;

  const AccountConversation({
    required this.id,
    required this.sourceSessionId,
    this.taskProjectionId = '',
    this.messageCount,
    required this.sourceClientId,
    required this.sourceDeviceName,
    required this.title,
    required this.state,
    required this.archived,
    required this.deleted,
    required this.canContinue,
    required this.revision,
    this.updatedAt,
  });

  factory AccountConversation.fromJson(Map<String, dynamic> json) =>
      AccountConversation(
        id: json['id']?.toString() ?? '',
        sourceSessionId: json['sourceSessionId']?.toString() ?? '',
        taskProjectionId: json['taskProjectionId']?.toString() ?? '',
        messageCount: (json['messageCount'] as num?)?.toInt(),
        sourceClientId: json['sourceClientId']?.toString() ?? '',
        sourceDeviceName: json['sourceDeviceName']?.toString() ?? '',
        title: json['title']?.toString() ?? '',
        state: json['state']?.toString() ?? '',
        archived: json['archived'] == true,
        deleted: json['deleted'] == true,
        canContinue: json['canContinue'] != false,
        revision: (json['revision'] as num?)?.toInt() ?? 0,
        updatedAt: DateTime.tryParse(json['updatedAt']?.toString() ?? ''),
      );

  String get displayTitle => title.trim().isEmpty ? '未命名会话' : title;

  // Unknown counts from older servers must not hide existing conversations.
  bool get isEmptyPlaceholder =>
      messageCount == 0 && taskProjectionId.isEmpty && state == 'idle';
}

class AccountConversationMessage {
  final String id;
  final int position;
  final String role;
  final String text;
  final bool deleted;
  final int revision;
  final DateTime? createdAt;

  const AccountConversationMessage({
    required this.id,
    required this.position,
    required this.role,
    required this.text,
    required this.deleted,
    required this.revision,
    this.createdAt,
  });

  factory AccountConversationMessage.fromJson(Map<String, dynamic> json) =>
      AccountConversationMessage(
        id: json['id']?.toString() ?? '',
        position: (json['position'] as num?)?.toInt() ?? 0,
        role: json['role']?.toString() ?? '',
        text: json['text']?.toString() ?? '',
        deleted: json['deleted'] == true,
        revision: (json['revision'] as num?)?.toInt() ?? 0,
        createdAt: DateTime.tryParse(json['createdAt']?.toString() ?? ''),
      );
}

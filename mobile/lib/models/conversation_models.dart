import 'work_models.dart';

/// A task row that originated from a mobile-initiated cloud conversation.
class CloudConversation {
  final WorkTask task;
  final String requestId;
  final String sessionId;
  final List<String> requiredSkills;
  final List<String> suggestedSkills;

  const CloudConversation({
    required this.task,
    required this.requestId,
    required this.sessionId,
    required this.requiredSkills,
    required this.suggestedSkills,
  });

  factory CloudConversation.fromJson(Map<String, dynamic> json) {
    final routing = _map(json['workRouting']);
    final conversation = _map(routing['cloudConversation']);
    return CloudConversation(
      task: WorkTask.fromJson(json),
      requestId: _text(conversation['requestId']),
      sessionId: _text(conversation['sessionId']),
      requiredSkills: _list(routing['requiredSkills'])
          .map(_text)
          .where((value) => value.isNotEmpty)
          .toList(growable: false),
      suggestedSkills: _list(routing['suggestedSkills'])
          .map(_text)
          .where((value) => value.isNotEmpty)
          .toList(growable: false),
    );
  }

  String get id => task.id;
  String get title => task.title;
  String get status => task.status;
  int get createdAt => task.createdAt;
  bool get isCloudConversation => task.origin == 'cloud-conversation';
  bool get finished => task.status == 'done' || task.status == 'cancel';
  bool get running => task.isOpen && !finished;
  bool get needsAttention =>
      task.needsAttention || (!finished && task.aiState == 'failed');
  DateTime get createdDate =>
      DateTime.fromMillisecondsSinceEpoch(task.createdAt);
  String get agentLabel {
    if (task.aiName.isNotEmpty) return task.aiName;
    if (task.createdByName.isNotEmpty) return task.createdByName;
    return '';
  }
}

Map<String, dynamic> _map(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map((key, item) => MapEntry(key.toString(), item));
  }
  return <String, dynamic>{};
}

List<dynamic> _list(dynamic value) => value is List ? value : const [];

String _text(dynamic value, {String fallback = ''}) {
  final result = value == null ? '' : value.toString().trim();
  return result.isEmpty ? fallback : result;
}

/// One entry of the cloud conversation transcript.
class ConversationEvent {
  final int seq;
  final String kind;
  final String text;
  final String full;
  final String tool;
  final String callId;
  final bool isError;
  final List<ConversationEventAttachment> attachments;
  final String serviceUrl;
  final String previewUrl;
  final DateTime? at;

  const ConversationEvent({
    required this.seq,
    required this.kind,
    required this.text,
    required this.full,
    required this.tool,
    required this.callId,
    required this.isError,
    required this.attachments,
    required this.serviceUrl,
    required this.previewUrl,
    required this.at,
  });

  factory ConversationEvent.fromJson(Map<String, dynamic> json) {
    return ConversationEvent(
      seq: (json['seq'] as num?)?.toInt() ?? 0,
      kind: _text(json['kind'], fallback: 'say'),
      text: _text(json['text']),
      full: _text(json['full']),
      tool: _text(json['tool']),
      callId: _text(json['callId']),
      isError: json['isError'] == true,
      attachments: _list(json['attachments'])
          .map(_map)
          .map(ConversationEventAttachment.fromJson)
          .toList(growable: false),
      serviceUrl: _text(json['serviceUrl']),
      previewUrl: _text(json['previewUrl']),
      at: _parseDate(json['at']),
    );
  }

  bool get isUser => kind == 'user';
  bool get isStep => kind == 'do';
  bool get isThinking => kind == 'thinking';
  bool get isUsage => kind == 'usage';
  bool get isSay => kind == 'say' || kind == 'out';

  /// Assistant-visible chat text: prefer the full body over a truncated echo.
  String get displayText => full.isNotEmpty ? full : text;

  String get stepLabel {
    if (tool.isNotEmpty) return tool;
    final firstLine = text.trim().split('\n').first.trim();
    if (firstLine.isEmpty) return '执行步骤';
    return firstLine.length > 42
        ? '${firstLine.substring(0, 42)}…'
        : firstLine;
  }

  List<String> get attachmentNames => [
    for (final item in attachments)
      if (item.name.isNotEmpty) item.name,
  ];
}

class ConversationEventAttachment {
  final String name;
  final String url;

  const ConversationEventAttachment({required this.name, required this.url});

  factory ConversationEventAttachment.fromJson(Map<String, dynamic> json) =>
      ConversationEventAttachment(
        name: _text(json['name']),
        url: _text(json['url']),
      );
}

/// A result file attached to the finished conversation task.
class ConversationAttachment {
  final String id;
  final String filename;
  final String contentType;
  final int size;
  final bool isImage;
  final String url;
  final bool byAgent;
  final String role;
  final DateTime? createdAt;

  const ConversationAttachment({
    required this.id,
    required this.filename,
    required this.contentType,
    required this.size,
    required this.isImage,
    required this.url,
    required this.byAgent,
    required this.role,
    required this.createdAt,
  });

  factory ConversationAttachment.fromJson(Map<String, dynamic> json) =>
      ConversationAttachment(
        id: _text(json['id']),
        filename: _text(json['filename'], fallback: '附件'),
        contentType: _text(json['contentType']),
        size: (json['size'] as num?)?.toInt() ?? 0,
        isImage: json['isImage'] == true,
        url: _text(json['url']),
        byAgent: json['byAgent'] == true,
        role: _text(json['role']),
        createdAt: _parseDate(json['createdAt']),
      );

  bool get isInput => role == 'input';
  bool get isDeliverable => role == 'output' && byAgent;
  bool get isEvidence => role == 'evidence';
}

DateTime? _parseDate(dynamic value) {
  final raw = value?.toString().trim() ?? '';
  if (raw.isEmpty) return null;
  return DateTime.tryParse(raw)?.toLocal();
}

// ---------------------------------------------------------------------------
// Conversation session state helpers
// ---------------------------------------------------------------------------

const Set<String> _terminalStates = {'done', 'failed', 'cancelled', 'stopped'};
const Set<String> _runningStates = {
  'dispatching',
  'queued',
  'running',
  'working',
  'streaming',
};

bool isTerminalConversationState(String state) =>
    _terminalStates.contains(state.trim().toLowerCase());

bool isRunningConversationState(String state) =>
    _runningStates.contains(state.trim().toLowerCase());

String conversationStateLabel(String state) => switch (state.trim().toLowerCase())
{
  'dispatching' || 'queued' => '正在派发',
  'running' || 'working' || 'streaming' => '执行中',
  'done' => '已完成',
  'failed' => '执行失败',
  'cancelled' || 'canceled' => '已停止',
  'stopped' => '已停止',
  _ => '',
};

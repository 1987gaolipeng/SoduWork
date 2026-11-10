import 'dart:convert';
import 'dart:math';

class GeneralChatScope {
  final String endpoint;
  final String ownerId;
  final String deviceId;
  const GeneralChatScope({
    required this.endpoint,
    required this.ownerId,
    required this.deviceId,
  });
  String get storageKey => base64Url
      .encode(
        utf8.encode(
          jsonEncode([
            endpoint.replaceFirst(RegExp(r'/+$'), ''),
            ownerId,
            deviceId,
          ]),
        ),
      )
      .replaceAll('=', '');
  bool get valid =>
      ownerId.trim().isNotEmpty &&
      deviceId.trim().isNotEmpty &&
      Uri.tryParse(endpoint)?.hasAuthority == true;
}

String generalChatId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

class GeneralChatModel {
  final String name;
  final String label;
  final String providerName;
  final String protocol;
  final int contextWindow;
  const GeneralChatModel({
    required this.name,
    required this.label,
    required this.providerName,
    required this.protocol,
    this.contextWindow = 0,
  });
  bool get supported => protocol == 'openai-compat';
  String get unavailableReason => supported
      ? ''
      : protocol.isEmpty
      ? '模型服务未声明接口协议，请联系管理员检查。'
      : '普通聊天暂不支持此模型接口协议。';
  static List<GeneralChatModel> fromCatalog(Map<String, dynamic> body) {
    final providers = <String, String>{};
    for (final row in _list(body['providers']).whereType<Map>()) {
      providers[_text(row['id'])] = _text(row['kind']);
    }
    final seen = <String>{};
    return _list(body['usable'])
        .whereType<Map>()
        .where(
          (row) =>
              _text(row['name']).isNotEmpty && seen.add(_text(row['name'])),
        )
        .map(
          (row) => GeneralChatModel(
            name: _text(row['name']),
            label: _text(row['label']).isEmpty
                ? _text(row['name'])
                : _text(row['label']),
            providerName: _text(row['providerName']),
            protocol: _text(row['kind']).isNotEmpty
                ? _text(row['kind'])
                : providers[_text(row['providerId'])] ?? '',
            contextWindow: row['ctxWindow'] is int
                ? row['ctxWindow'] as int
                : 0,
          ),
        )
        .toList(growable: false);
  }
}

class GeneralChatMessage {
  final String id;
  final int position;
  final String role;
  final String text;
  final String createdAt;
  final bool deleted;
  const GeneralChatMessage({
    required this.id,
    required this.position,
    required this.role,
    required this.text,
    required this.createdAt,
    this.deleted = false,
  });
  factory GeneralChatMessage.fromJson(Map<String, dynamic> body) {
    final row = GeneralChatMessage(
      id: _text(body['id']),
      position: body['position'] is int ? body['position'] as int : -1,
      role: _text(body['role']),
      text: body['text'] is String ? body['text'] as String : '',
      createdAt: _text(body['createdAt']),
      deleted: body['deleted'] == true,
    );
    final date = DateTime.tryParse(row.createdAt);
    if (row.id.isEmpty ||
        row.id.length > 180 ||
        row.position < 0 ||
        !{'user', 'assistant'}.contains(row.role) ||
        row.text.length > 200000 ||
        date == null ||
        !RegExp(r'(Z|[+-]\d\d:\d\d)$').hasMatch(row.createdAt)) {
      throw const FormatException('聊天记录格式不完整');
    }
    return row;
  }
  Map<String, dynamic> toSync() => {
    'id': id,
    'position': position,
    'role': role,
    'text': text,
    'deleted': deleted,
    'createdAt': createdAt,
  };
  Map<String, dynamic> toModel() => {'role': role, 'content': text};
  GeneralChatMessage withText(String value) => GeneralChatMessage(
    id: id,
    position: position,
    role: role,
    text: value,
    createdAt: createdAt,
    deleted: deleted,
  );
}

class GeneralChatBatch {
  final String purpose;
  final String _encoded;
  late final List<GeneralChatMessage> messages;
  GeneralChatBatch({required this.purpose, required Map<String, dynamic> body})
    : _encoded = jsonEncode(body) {
    if (!{'user', 'checkpoint', 'final'}.contains(purpose) ||
        body.keys.toSet().difference({
          'sourceSessionId',
          'sourceEpoch',
          'sourceRevision',
          'title',
          'state',
          'archived',
          'deleted',
          'messages',
        }).isNotEmpty ||
        body.length != 8 ||
        body['sourceRevision'] is! int ||
        (body['sourceRevision'] as int) < 1 ||
        !_text(body['sourceSessionId']).startsWith('mobile-chat:') ||
        _text(body['sourceEpoch']).isEmpty ||
        body['messages'] is! List ||
        (body['messages'] as List).length > 100 ||
        utf8.encode(_encoded).length > 2 * 1024 * 1024) {
      throw const FormatException('待同步聊天批次不完整或超出限制');
    }
    messages = List.unmodifiable(
      (body['messages'] as List).map(
        (row) =>
            GeneralChatMessage.fromJson(Map<String, dynamic>.from(row as Map)),
      ),
    );
  }
  Map<String, dynamic> get body => jsonDecode(_encoded) as Map<String, dynamic>;
  int get revision => body['sourceRevision'] as int;
  Map<String, dynamic> toJson() => {'purpose': purpose, 'body': body};
  factory GeneralChatBatch.fromJson(Map<String, dynamic> body) =>
      GeneralChatBatch(
        purpose: _text(body['purpose']),
        body: Map<String, dynamic>.from(body['body'] as Map),
      );
}

class GeneralChatOutbox {
  final String sourceSessionId;
  final String conversationId;
  final String sourceEpoch;
  final String selectedModel;
  final List<GeneralChatBatch> batches;
  const GeneralChatOutbox({
    required this.sourceSessionId,
    required this.conversationId,
    required this.sourceEpoch,
    required this.selectedModel,
    required this.batches,
  });
  Map<String, dynamic> toJson() => {
    'version': 1,
    'sourceSessionId': sourceSessionId,
    'conversationId': conversationId,
    'sourceEpoch': sourceEpoch,
    'selectedModel': selectedModel,
    'batches': batches.map((row) => row.toJson()).toList(),
  };
  factory GeneralChatOutbox.fromJson(Map<String, dynamic> body) {
    final batches = _list(body['batches'])
        .map(
          (row) =>
              GeneralChatBatch.fromJson(Map<String, dynamic>.from(row as Map)),
        )
        .toList();
    final session = _text(body['sourceSessionId']);
    final epoch = _text(body['sourceEpoch']);
    if (body['version'] != 1 ||
        !session.startsWith('mobile-chat:') ||
        epoch.isEmpty ||
        batches.isEmpty ||
        batches.length > 2) {
      throw const FormatException('待同步会话格式不正确');
    }
    for (var i = 0; i < batches.length; i++) {
      final batch = batches[i].body;
      if (batch['sourceSessionId'] != session ||
          batch['sourceEpoch'] != epoch ||
          i > 0 && batches[i].revision != batches[i - 1].revision + 1) {
        throw const FormatException('待同步会话版本不连续');
      }
    }
    return GeneralChatOutbox(
      sourceSessionId: session,
      conversationId: _text(body['conversationId']),
      sourceEpoch: epoch,
      selectedModel: _text(body['selectedModel']),
      batches: List.unmodifiable(batches),
    );
  }
}

String _text(dynamic value) => value is String ? value.trim() : '';
List<dynamic> _list(dynamic value) => value is List ? value : const [];

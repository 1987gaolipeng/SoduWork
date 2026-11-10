import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Durable queue for cloud conversation follow-ups.
class CloudConversationPendingMessage {
  final String id;
  final String text;
  final int afterSeq;
  final bool resume;
  final bool retryable;
  final bool accepted;
  final Map<String, String>? executionSelection;

  const CloudConversationPendingMessage({
    required this.id,
    required this.text,
    required this.afterSeq,
    required this.resume,
    required this.retryable,
    required this.accepted,
    this.executionSelection,
  });

  factory CloudConversationPendingMessage.fromJson(Map<String, dynamic> json) {
    final rawSelection = json['executionSelection'];
    final selection = rawSelection is Map
        ? rawSelection.map(
            (key, value) => MapEntry(key.toString(), value.toString()),
          )
        : null;
    return CloudConversationPendingMessage(
      id: _text(json['id']),
      text: _text(json['text']),
      afterSeq: _number(json['afterSeq']),
      resume: json['resume'] == true,
      retryable: json['retryable'] == true,
      accepted: json['accepted'] == true,
      executionSelection: selection?.isEmpty == true ? null : selection,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'text': text,
    'afterSeq': afterSeq,
    'resume': resume,
    'retryable': retryable,
    'accepted': accepted,
    if (executionSelection != null) 'executionSelection': executionSelection,
  };
}

class CloudConversationPendingStore {
  static const _secure = FlutterSecureStorage();
  static final Map<String, Future<void>> _tails = {};

  String _key(String scope) =>
      'soduwork_mobile.cloud_conversation_pending.${base64Url.encode(utf8.encode(scope)).replaceAll('=', '')}';

  Future<List<CloudConversationPendingMessage>> load(String scope) async {
    final key = _key(scope);
    final raw = kIsWeb
        ? (await SharedPreferences.getInstance()).getString(key)
        : await _secure.read(key: key);
    if (raw == null || raw.trim().isEmpty) return const [];
    final decoded = jsonDecode(raw);
    if (decoded is! List) return const [];
    return decoded
        .whereType<Map>()
        .map(
          (item) => CloudConversationPendingMessage.fromJson(
            item.map((key, value) => MapEntry(key.toString(), value)),
          ),
        )
        .where((item) => item.id.isNotEmpty && item.text.isNotEmpty)
        .take(20)
        .toList(growable: false);
  }

  Future<void> save(
    String scope,
    Iterable<CloudConversationPendingMessage> messages,
  ) => _mutate(scope, () async {
    final items = messages
        .where((item) => item.id.isNotEmpty && item.text.isNotEmpty)
        .take(20)
        .map((item) => item.toJson())
        .toList(growable: false);
    final key = _key(scope);
    final raw = jsonEncode(items);
    if (kIsWeb) {
      if (!await (await SharedPreferences.getInstance()).setString(key, raw)) {
        throw StateError('无法保存待发送消息');
      }
    } else {
      await _secure.write(key: key, value: raw);
    }
  });

  Future<void> clear(String scope) => _mutate(scope, () async {
    final key = _key(scope);
    if (kIsWeb) {
      await (await SharedPreferences.getInstance()).remove(key);
    } else {
      await _secure.delete(key: key);
    }
  });

  Future<void> _mutate(String scope, Future<void> Function() action) {
    final old = _tails[scope] ?? Future<void>.value();
    final next = old.then((_) => action());
    final settled = next.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    _tails[scope] = settled;
    settled.then((_) {
      if (identical(_tails[scope], settled)) _tails.remove(scope);
    });
    return next;
  }
}

String _text(dynamic value) => value?.toString().trim() ?? '';

int _number(dynamic value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

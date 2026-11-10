import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

class WorkSubmission {
  final String id;
  final String kind;
  final String label;
  final String _payload;
  WorkSubmission({
    required this.id,
    required this.kind,
    required this.label,
    required Map<String, dynamic> payload,
  }) : _payload = jsonEncode(payload) {
    if (!RegExp(r'^[A-Za-z0-9-]{1,80}$').hasMatch(id) ||
        !{'workflow', 'teammate'}.contains(kind) ||
        _payload.length > 120000) {
      throw const FormatException('工作提交记录无效');
    }
  }
  Map<String, dynamic> get payload =>
      jsonDecode(_payload) as Map<String, dynamic>;
  Map<String, dynamic> toJson() => {
    'id': id,
    'kind': kind,
    'label': label,
    'payload': payload,
  };
  factory WorkSubmission.fromJson(Map<String, dynamic> body) => WorkSubmission(
    id: body['id'] as String,
    kind: body['kind'] as String,
    label: body['label'] as String,
    payload: Map<String, dynamic>.from(body['payload'] as Map),
  );
}

class WorkSubmissionStore {
  static const _secure = FlutterSecureStorage();
  static final Map<String, Future<void>> _tails = {};
  String _key(String scope) =>
      'soduwork_mobile.work_submission.${base64Url.encode(utf8.encode(scope)).replaceAll('=', '')}';
  Future<WorkSubmission?> load(String scope) async {
    final key = _key(scope);
    final raw = kIsWeb
        ? (await SharedPreferences.getInstance()).getString(key)
        : await _secure.read(key: key);
    return raw == null
        ? null
        : WorkSubmission.fromJson(jsonDecode(raw) as Map<String, dynamic>);
  }

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

  Future<void> save(String scope, WorkSubmission value) =>
      _mutate(scope, () async {
        final existing = await load(scope);
        if (existing != null &&
            jsonEncode(existing.toJson()) != jsonEncode(value.toJson())) {
          throw StateError('还有一笔工作结果待核对，不能覆盖。');
        }
        final key = _key(scope);
        final raw = jsonEncode(value.toJson());
        if (kIsWeb) {
          if (!await (await SharedPreferences.getInstance()).setString(
            key,
            raw,
          )) {
            throw StateError('无法保存本次工作');
          }
        } else {
          await _secure.write(key: key, value: raw);
        }
      });
  Future<void> clear(String scope, String expectedId) =>
      _mutate(scope, () async {
        if ((await load(scope))?.id != expectedId) return;
        final key = _key(scope);
        if (kIsWeb) {
          if (!await (await SharedPreferences.getInstance()).remove(key)) {
            throw StateError('无法清理已确认的工作');
          }
        } else {
          await _secure.delete(key: key);
        }
      });
}

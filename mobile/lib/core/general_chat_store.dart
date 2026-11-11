import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/general_chat.dart';

/// Only unacknowledged batches live here. Confirmed transcript/context is read
/// from the Hub. No model ticket, device key or account credential is accepted.
class GeneralChatStore {
  static const _secure = FlutterSecureStorage(aOptions: AndroidOptions());
  static final _writes = <String, Future<void>>{};
  String _index(GeneralChatScope scope) =>
      'soduwork.general-chat.index.v1.${scope.storageKey}';
  String _key(GeneralChatScope scope, String session) =>
      'soduwork.general-chat.pending.v1.${scope.storageKey}.${base64Url.encode(utf8.encode(session))}';

  Future<T> _serial<T>(GeneralChatScope scope, Future<T> Function() action) {
    if (!scope.valid) {
      return Future.error(const FormatException('聊天身份不完整'));
    }
    final previous = _writes[scope.storageKey] ?? Future<void>.value();
    final operation = previous.then((_) => action());
    _writes[scope.storageKey] = operation.then<void>(
      (_) {},
      onError: (Object error, StackTrace stack) {},
    );
    return operation;
  }

  Future<List<String>> pendingSessions(GeneralChatScope scope) =>
      _serial(scope, () async {
        final prefs = await SharedPreferences.getInstance();
        return List<String>.unmodifiable(
          prefs.getStringList(_index(scope)) ?? const [],
        );
      });

  Future<GeneralChatOutbox?> read(GeneralChatScope scope, String session) =>
      _serial(scope, () async {
        final key = _key(scope, session);
        final raw = kIsWeb
            ? (await SharedPreferences.getInstance()).getString(key)
            : await _secure.read(key: key);
        if (raw == null) {
          return null;
        }
        if (utf8.encode(raw).length > 4 * 1024 * 1024) {
          throw const FormatException('待同步聊天超出存储限制');
        }
        final box = GeneralChatOutbox.fromJson(
          jsonDecode(raw) as Map<String, dynamic>,
        );
        if (box.sourceSessionId != session) {
          throw const FormatException('待同步聊天身份不匹配');
        }
        return box;
      });

  Future<void> write(GeneralChatScope scope, GeneralChatOutbox box) => _serial(
    scope,
    () async {
      final checked = GeneralChatOutbox.fromJson(box.toJson());
      final raw = jsonEncode(checked.toJson());
      if (utf8.encode(raw).length > 4 * 1024 * 1024) {
        throw const FormatException('待同步聊天超出存储限制');
      }
      final prefs = await SharedPreferences.getInstance();
      final sessions = {
        ...?prefs.getStringList(_index(scope)),
        box.sourceSessionId,
      };
      if (sessions.length > 50) {
        throw const FormatException('待同步会话较多，请先完成现有同步');
      }
      // Register the non-secret identity first so a crash cannot orphan a body.
      if (!await prefs.setStringList(_index(scope), sessions.toList())) {
        throw StateError('待同步索引保存失败');
      }
      final key = _key(scope, box.sourceSessionId);
      if (kIsWeb) {
        if (!await prefs.setString(key, raw)) {
          throw StateError('待同步聊天保存失败');
        }
      } else {
        await _secure.write(key: key, value: raw);
      }
    },
  );

  Future<void> remove(GeneralChatScope scope, String session) => _serial(
    scope,
    () async {
      final prefs = await SharedPreferences.getInstance();
      final key = _key(scope, session);
      if (kIsWeb) {
        if (!await prefs.remove(key)) {
          throw StateError('待同步聊天清理失败');
        }
      } else {
        await _secure.delete(key: key);
      }
      final remaining = (prefs.getStringList(_index(scope)) ?? const <String>[])
          .where((value) => value != session)
          .toList();
      if (!await prefs.setStringList(_index(scope), remaining)) {
        throw StateError('待同步索引清理失败');
      }
    },
  );
}

import 'dart:convert';
import 'soduwork_api.dart';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Matches the PC sidebar's project organization, never task execution state.
/// The Hub owns synchronized projects; local storage is an offline cache.
class ConversationProject {
  final String id, name;
  final List<String> chatIds;
  const ConversationProject(this.id, this.name, this.chatIds);
  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'chatIds': chatIds,
    'folders': <String>[],
    'collapsed': false,
    'businessProjectId': '',
  };
}

class ConversationProjects {
  final String storageKey;
  final SoduWorkApi? api;
  static final changes = ValueNotifier<int>(0);
  static final _writes = <String, Future<void>>{};
  ConversationProjects(String hub, String owner, {this.api})
    : storageKey = owner.isEmpty
          ? ''
          : 'soduwork.mobile.sidebar.v1.${base64Url.encode(utf8.encode(jsonEncode([hub, owner])))}';

  Future<List<ConversationProject>> read() async {
    if (api != null) {
      final data = await api!.conversationProjects();
      final items = (data['items'] as List).cast<Map<String, dynamic>>();
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(storageKey);
      final local = raw == null
          ? <dynamic>[]
          : (jsonDecode(raw)['projects'] as List);
      // Import old mobile-only groups once, without overwriting an existing ID.
      for (final row in local) {
        if (!items.any((item) => item['id'] == row['id'])) {
          items.add(
            await api!.saveConversationProject(row['id'], {
              'name': row['name'],
              'chatIds': row['chatIds'],
              'revision': 0,
            }),
          );
        }
      }
      await prefs.setString(
        '$storageKey:revisions',
        jsonEncode({for (final item in items) item['id']: item['revision']}),
      );
      await prefs.setString(
        storageKey,
        jsonEncode({
          'version': 1,
          'projects': items
              .where((r) => r['deleted'] != true)
              .map(
                (r) => {
                  'id': r['id'],
                  'name': r['name'],
                  'chatIds': r['chatIds'],
                },
              )
              .toList(),
        }),
      );
    }
    return _readCache();
  }

  Future<List<ConversationProject>> _readCache() async {
    if (storageKey.isEmpty) throw const FormatException('请先登录账号');
    final raw = (await SharedPreferences.getInstance()).getString(storageKey);
    if (raw == null) return [];
    final data = jsonDecode(raw);
    if (data is! Map || data['version'] != 1 || data['projects'] is! List) {
      throw const FormatException('项目分组无法读取，原数据已保留');
    }
    final rows = <ConversationProject>[];
    final seen = <String>{};
    for (final row in data['projects']) {
      if (row is! Map ||
          row['id'] is! String ||
          row['name'] is! String ||
          row['chatIds'] is! List ||
          !seen.add(row['id'])) {
        throw const FormatException('项目分组格式不正确，原数据已保留');
      }
      rows.add(
        ConversationProject(
          row['id'],
          row['name'],
          List<String>.unmodifiable((row['chatIds'] as List).cast<String>()),
        ),
      );
    }
    return rows;
  }

  Future<void> _change(void Function(List<ConversationProject>) change) {
    if (storageKey.isEmpty) {
      return Future.error(const FormatException('请先登录账号'));
    }
    final operation = (_writes[storageKey] ?? Future<void>.value()).then((
      _,
    ) async {
      final rows = await read();
      final before = {for (final row in rows) row.id: row};
      change(rows);
      if (api != null) {
        final prefs = await SharedPreferences.getInstance();
        final revisions =
            jsonDecode(prefs.getString('$storageKey:revisions') ?? '{}') as Map;
        for (final id in {...before.keys, ...rows.map((r) => r.id)}) {
          final matches = rows.where((r) => r.id == id);
          final after = matches.isEmpty ? null : matches.first;
          final previous = before[id];
          if (jsonEncode(previous?.toJson()) == jsonEncode(after?.toJson())) {
            continue;
          }
          final body = <String, dynamic>{
            'name': after?.name ?? previous!.name,
            'revision': revisions[id] ?? 0,
            'deleted': after == null,
          };
          if (after != null && !listEquals(previous?.chatIds, after.chatIds)) {
            body['chatIds'] = after.chatIds;
          }
          await api!.saveConversationProject(id, body);
        }
      }
      if (!await (await SharedPreferences.getInstance()).setString(
        storageKey,
        jsonEncode({
          'version': 1,
          'projects': rows.map((r) => r.toJson()).toList(),
        }),
      )) {
        throw StateError('项目未保存，请重试');
      }
      changes.value++;
    });
    late final Future<void> pending;
    void release() {
      if (identical(_writes[storageKey], pending)) {
        _writes.remove(storageKey);
      }
    }
    pending = operation.then<void>(
      (_) => release(),
      onError: (Object _, StackTrace _) => release(),
    );
    _writes[storageKey] = pending;
    return operation;
  }

  Future<void> save(String name, {String? id}) => _change((rows) {
    name = name.trim();
    if (name.isEmpty || name.runes.length > 80) {
      throw const FormatException('项目名称需要1至80个字');
    }
    if (rows.any(
      (r) => r.id != id && r.name.toLowerCase() == name.toLowerCase(),
    )) {
      throw const FormatException('已有同名项目，请换一个名称');
    }
    if (id == null) {
      if (rows.length >= 100) throw const FormatException('最多创建100个项目');
      final key =
          'project-${DateTime.now().microsecondsSinceEpoch}-${Random.secure().nextInt(1 << 30)}';
      rows.add(ConversationProject(key, name, const []));
    } else {
      final i = rows.indexWhere((r) => r.id == id);
      if (i < 0) throw const FormatException('项目已移除，请刷新');
      rows[i] = ConversationProject(id, name, rows[i].chatIds);
    }
  });

  Future<void> assign(String id, List<String> chats) => _change((rows) {
    if (!rows.any((r) => r.id == id)) throw const FormatException('项目已移除，请刷新');
    final unique = chats.toSet().toList();
    if (unique.length > 1000) throw const FormatException('单个项目最多整理1000个会话');
    for (var i = 0; i < rows.length; i++) {
      final r = rows[i];
      rows[i] = ConversationProject(
        r.id,
        r.name,
        r.id == id
            ? unique
            : r.chatIds.where((c) => !unique.contains(c)).toList(),
      );
    }
  });

  Future<void> remove(String id) =>
      _change((rows) => rows.removeWhere((r) => r.id == id));
}

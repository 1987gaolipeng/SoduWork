import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/core/conversation_projects.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));
  test(
    'remote groups preserve unresolved members through rename and assignment',
    () async {
      final api = _Api();
      final store = ConversationProjects('https://hub.test', 'alice', api: api);
      expect((await store.read()).single.chatIds, [
        'member:opaque',
        'account:visible',
      ]);
      await store.save('手机改名', id: 'project-one');
      expect(api.writes.single.containsKey('chatIds'), isFalse);
      await store.assign('project-one', [
        'member:opaque',
        'account:visible',
        'task:new',
      ]);
      expect(api.rows.single['chatIds'], [
        'member:opaque',
        'account:visible',
        'task:new',
      ]);
      await store.remove('project-one');
      expect(api.rows.single['deleted'], isTrue);
      expect(await store.read(), isEmpty);
      expect(
        await ConversationProjects('https://hub.test', 'bob').read(),
        isEmpty,
      );
    },
  );
  test('revision conflict does not replace the last readable cache', () async {
    final api = _Api();
    final store = ConversationProjects('https://hub.test', 'alice', api: api);
    await store.read();
    api.conflict = true;
    await expectLater(
      store.save('未保存', id: 'project-one'),
      throwsA(isA<ApiFailure>()),
    );
    expect(
      (await ConversationProjects(
        'https://hub.test',
        'alice',
      ).read()).single.name,
      'PC项目',
    );
    expect(api.rows.single['name'], 'PC项目');
  });
  test(
    'legacy local group imports once and server tombstone never resurrects it',
    () async {
      final legacy = ConversationProjects('https://hub.test', 'alice');
      await legacy.save('旧分组');
      final api = _Api()..rows.clear();
      final store = ConversationProjects('https://hub.test', 'alice', api: api);
      await store.read();
      await store.read();
      expect(api.writes.length, 1);
      api.rows.single['deleted'] = true;
      expect(await store.read(), isEmpty);
      expect(api.writes.length, 1);
    },
  );
}

class _Api extends SoduWorkApi {
  final rows = <Map<String, dynamic>>[
    {
      'id': 'project-one',
      'name': 'PC项目',
      'revision': 2,
      'chatIds': ['member:opaque', 'account:visible'],
    },
  ];
  final writes = <Map<String, dynamic>>[];
  bool conflict = false;
  _Api()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          baseUrl: 'https://hub.test',
          environment: SoduWorkEnvironment.development,
        ),
      );
  @override
  Future<Map<String, dynamic>> conversationProjects() async => {
    'items': rows.map((r) => Map<String, dynamic>.from(r)).toList(),
  };
  @override
  Future<Map<String, dynamic>> saveConversationProject(
    String id,
    Map<String, dynamic> data,
  ) async {
    if (conflict) throw const ApiFailure('项目已在其他设备更新', status: 409);
    writes.add(Map.from(data));
    final index = rows.indexWhere((r) => r['id'] == id);
    final before = index < 0
        ? <String, dynamic>{'chatIds': <String>[]}
        : rows[index];
    expect(data['revision'], before['revision'] ?? 0);
    final after = {
      ...before,
      ...data,
      'id': id,
      'revision': (data['revision'] as int) + 1,
    };
    if (index < 0) {
      rows.add(after);
    } else {
      rows[index] = after;
    }
    return Map.from(after);
  }
}

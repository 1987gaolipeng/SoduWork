import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/state/session_feed.dart';

void main() {
  test(
    'only owned and accessible recorded requirement executions enter history',
    () {
      WorkTask execution(
        String id, {
        String owner = 'alice',
        bool access = true,
        bool history = true,
        bool runner = true,
      }) => WorkTask.fromJson({
        'id': id,
        'origin': 'local',
        'createdBy': owner,
        'canViewExecution': access,
        'hasExecutionHistory': history,
        if (runner)
          'workRouting': {
            'executionContext': {
              'runner': {'clientId': 'pc'},
            },
          },
      });
      final rows = buildPersonalConversationFeed([
        execution('owned'),
        execution('team', owner: 'bob'),
        execution('denied', access: false),
        execution('unstarted', history: false),
        execution('manual', runner: false),
      ], ownerUserId: 'alice');
      expect(rows.map((entry) => entry.task.id), ['owned']);
    },
  );
  List<String> personal(List<WorkTask> tasks, {String user = 'alice'}) =>
      buildPersonalConversationFeed(
        tasks,
        ownerUserId: user,
      ).map((entry) => entry.task.id).toList();

  test('same-account cloud conversations remain visible across devices', () {
    expect(
      personal([
        _task('pc-chat', createdBy: 'alice', ownerClientId: 'pc'),
        _task('phone-chat', createdBy: 'alice', ownerClientId: 'phone'),
        _task('other-chat', createdBy: 'bob', ownerClientId: 'other-pc'),
      ]),
      unorderedEquals(['pc-chat', 'phone-chat']),
    );
  });

  test(
    'device-only legacy provenance cannot establish current account ownership',
    () {
      final unknown = _task('legacy-device-chat', ownerClientId: 'phone');
      expect(personal([unknown]), isEmpty);
      expect(personal([unknown], user: ''), isEmpty);
      expect(buildSessionFeed([unknown]).single.task.id, 'legacy-device-chat');
    },
  );
  test('rebinding the same phone never imports the previous account chats', () {
    final rows = [
      _task('old-alice', createdBy: 'alice', ownerClientId: 'phone'),
      _task('new-bob', createdBy: 'bob', ownerClientId: 'phone'),
    ];
    expect(personal(rows, user: 'bob'), ['new-bob']);
    expect(personal(rows, user: ''), isEmpty);
  });

  test('ordinary work tasks never become personal conversations', () {
    expect(
      personal([
        _task('own-work', createdBy: 'alice', origin: 'manual'),
        _task('shared-work', ownerClientId: 'phone', origin: ''),
      ]),
      isEmpty,
    );
  });

  test(
    'missing or redacted provenance fails closed even with the same name',
    () {
      final redacted = WorkTask.fromJson({
        'id': 'redacted',
        'origin': 'cloud-conversation',
        'createdByName': 'alice',
        'canViewExecution': true,
      });
      expect(personal([_task('missing'), redacted]), isEmpty);
    },
  );

  test(
    'team grants and execution access cannot establish personal ownership',
    () {
      final shared = WorkTask.fromJson({
        'id': 'shared-cloud',
        'origin': 'cloud-conversation',
        'createdBy': 'bob',
        'ownerClientId': 'bob-pc',
        'requesterUserId': 'alice',
        'assigneeUserId': 'alice',
        'myRoles': ['requester', 'assignee'],
        'visibility': 'company',
        'sharedOrgId': 'company',
        'canViewExecution': true,
      });
      expect(personal([shared]), isEmpty);
    },
  );

  test('an explicit execution denial overrides matching account or device', () {
    expect(
      personal([
        _task('denied-user', createdBy: 'alice', canViewExecution: false),
        _task('denied-device', ownerClientId: 'phone', canViewExecution: false),
      ]),
      isEmpty,
    );
  });

  test('empty identity never matches empty ownership', () {
    expect(
      personal([
        _task('missing'),
        _task('owned', createdBy: 'alice', ownerClientId: 'phone'),
      ], user: ''),
      isEmpty,
    );
    expect(personal([_task('missing')], user: 'alice'), isEmpty);
    expect(personal([_task('missing')], user: ''), isEmpty);
  });

  test(
    'legacy task defaults stay compatible and team feed keeps its scope',
    () {
      final legacy = WorkTask.fromJson({'id': 'legacy'});
      expect(legacy.ownerClientId, isEmpty);
      expect(legacy.createdBy, isEmpty);
      expect(legacy.canViewExecution, isNull);
      expect(buildSessionFeed([legacy]).single.task.id, 'legacy');
      expect(personal([legacy]), isEmpty);
    },
  );

  test('server ownership ids and nullable execution flag survive parsing', () {
    final task = _task(
      'known',
      createdBy: 'alice',
      ownerClientId: 'phone',
      canViewExecution: true,
    );
    expect(task.createdBy, 'alice');
    expect(task.ownerClientId, 'phone');
    expect(task.canViewExecution, isTrue);
  });
}

WorkTask _task(
  String id, {
  String createdBy = '',
  String ownerClientId = '',
  String origin = 'cloud-conversation',
  bool? canViewExecution,
}) => WorkTask.fromJson({
  'id': id,
  'origin': origin,
  'createdBy': createdBy,
  'ownerClientId': ownerClientId,
  'canViewExecution': ?canViewExecution,
});

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/conversation_requirement_handoff.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';

ConversationRequirementSource source(String id) =>
    ConversationRequirementSource(id: id, name: '$id.txt', size: 2, at: 10);
Map<String, dynamic> bytes(String id) => {
  'ok': true,
  'name': '$id.txt',
  'size': 2,
  'at': 10,
  'data': base64Encode([1, 2]),
};
WorkTask task() => WorkTask.fromJson({'id': 'new-task', 'title': '需求'});

void main() {
  test('uploads exact bytes and retries only unconfirmed materials', () async {
    var creates = 0;
    var fail = true;
    final reads = <String>[];
    final uploads = <String>[];
    final handoff = ConversationRequirementHandoff(
      sources: [source('a'), source('b')],
      check: () {},
      createTask: (payload) async {
        creates++;
        return task();
      },
      readSource: (id) async {
        reads.add(id);
        return bytes(id);
      },
      upload: (id, file) async {
        expect(id, 'new-task');
        expect(await file.readAsBytes(), [1, 2]);
        uploads.add(file.name);
        if (file.name == 'b.txt' && fail) {
          fail = false;
          throw const ApiFailure('上传失败');
        }
        return {'id': file.name};
      },
    );
    await expectLater(
      handoff.submit({'title': '需求'}),
      throwsA(isA<ApiFailure>()),
    );
    expect(handoff.task!.id, 'new-task');
    expect(handoff.receipts.length, 1);
    expect(handoff.complete, isFalse);
    await handoff.submit({'title': '不会重复建单'});
    expect(creates, 1);
    expect(reads, ['a', 'b', 'a', 'b', 'b', 'b']);
    expect(uploads, ['a.txt', 'b.txt', 'b.txt']);
    expect(handoff.complete, isTrue);
  });

  test('changed version or revoked read prevents task creation', () async {
    for (final revoked in [false, true]) {
      var creates = 0;
      final handoff = ConversationRequirementHandoff(
        sources: [source('a')],
        check: () {},
        createTask: (_) async {
          creates++;
          return task();
        },
        readSource: (id) async {
          if (revoked) throw const ApiFailure('不可访问', status: 403);
          return {...bytes(id), 'at': 11};
        },
        upload: (_, file) async => {'id': 'never'},
      );
      await expectLater(handoff.submit({}), throwsA(isA<ApiFailure>()));
      expect(creates, 0);
      expect(handoff.uncertain, isFalse);
    }
  });

  test(
    'unknown create result blocks replay while explicit rejection can retry',
    () async {
      for (final status in [0, 409, 403]) {
        var creates = 0;
        final handoff = ConversationRequirementHandoff(
          check: () {},
          readSource: (id) async => bytes(id),
          upload: (_, file) async => {'id': 'never'},
          createTask: (_) async {
            creates++;
            if (creates == 1) throw ApiFailure('失败', status: status);
            return task();
          },
        );
        await expectLater(handoff.submit({}), throwsA(isA<ApiFailure>()));
        if (status != 403) {
          expect(handoff.uncertain, isTrue);
          await expectLater(handoff.submit({}), throwsA(isA<ApiFailure>()));
          expect(creates, 1);
        } else {
          await handoff.submit({});
          expect(creates, 2);
        }
      }
    },
  );

  test(
    'account switch preserves confirmed creation and stops upload',
    () async {
      var valid = true;
      var uploads = 0;
      final handoff = ConversationRequirementHandoff(
        sources: [source('a')],
        check: () {
          if (!valid) throw const ApiFailure('账号已切换');
        },
        readSource: (id) async => bytes(id),
        createTask: (_) async {
          valid = false;
          return task();
        },
        upload: (_, file) async {
          uploads++;
          return {'id': 'never'};
        },
      );
      await expectLater(handoff.submit({}), throwsA(isA<ApiFailure>()));
      expect(handoff.task!.id, 'new-task');
      expect(uploads, 0);
      expect(handoff.uncertain, isFalse);
    },
  );

  test('account switch after upload preserves the confirmed receipt', () async {
    var valid = true;
    final handoff = ConversationRequirementHandoff(
      sources: [source('a'), source('b')],
      check: () {
        if (!valid) throw const ApiFailure('账号已切换');
      },
      readSource: (id) async => bytes(id),
      createTask: (_) async => task(),
      upload: (_, file) async {
        valid = false;
        return {'id': 'uploaded'};
      },
    );
    await expectLater(handoff.submit({}), throwsA(isA<ApiFailure>()));
    expect(handoff.receipts.single['id'], 'uploaded');
    expect(handoff.complete, isFalse);
  });

  test('version change during creation prevents material upload', () async {
    var created = false;
    var uploads = 0;
    final handoff = ConversationRequirementHandoff(
      sources: [source('a')],
      check: () {},
      readSource: (id) async => {...bytes(id), 'at': created ? 11 : 10},
      createTask: (_) async {
        created = true;
        return task();
      },
      upload: (_, file) async {
        uploads++;
        return {'id': 'never'};
      },
    );
    await expectLater(handoff.submit({}), throwsA(isA<ApiFailure>()));
    expect(handoff.task!.id, 'new-task');
    expect(uploads, 0);
  });

  test('double submit shares a single in-flight creation', () async {
    var creates = 0;
    final delayed = Completer<WorkTask>();
    final handoff = ConversationRequirementHandoff(
      check: () {},
      readSource: (id) async => bytes(id),
      upload: (_, file) async => {'id': 'never'},
      createTask: (_) {
        creates++;
        return delayed.future;
      },
    );
    final first = handoff.submit({});
    final second = handoff.submit({});
    delayed.complete(task());
    await Future.wait([first, second]);
    expect(creates, 1);
    await handoff.submit({});
    expect(creates, 1);
  });
}

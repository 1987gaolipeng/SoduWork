import 'dart:async';
import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/shared_conversation_team.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

const messageId = '12345678-1234-4234-8234-123456789abc';
Map<String, dynamic> request({List<Map<String, dynamic>> files = const []}) => {
  'recipientId': 'mate',
  'text': '已完成初稿，待核对。',
  'messageId': messageId,
  'conversationId': 'mobile-view:task',
  'files': files,
};

class Harness {
  bool current = true;
  int sends = 0, drafts = 0, reads = 0;
  Map<String, dynamic>? sent, drafted;
  Completer<Map<String, dynamic>>? directoryGate, sendGate, draftGate;
  Map<String, dynamic> directory = {
    'mates': [
      {
        'id': 'mate',
        'name': '同事',
        'hasBox': true,
        'canReceive': true,
        'org': '研发',
        'secret': 'never-forward',
      },
    ],
    'reason': '',
  };
  Map<String, dynamic> reply = {
    'ok': true,
    'messageId': 'server-id',
    'status': 'accepted',
  };
  bool fail = false;
  List<Map<String, dynamic>> attachments = [
    {'id': 'file', 'size': 3, 'role': 'output'},
    {'id': 'input', 'size': 3, 'role': 'input'},
  ];
  late final team = SharedConversationTeam(
    check: () {
      if (!current) throw const ApiFailure('账号已切换');
    },
    allowedTaskIds: {'owned-task'},
    loadMates: () async => directoryGate?.future ?? directory,
    loadAttachments: (id) async {
      expect(id, 'owned-task');
      reads++;
      return attachments;
    },
    draftMessage: (body) async {
      drafts++;
      drafted = body;
      return draftGate?.future ??
          {'text': '来自服务端的小结', 'source': 'model', 'secret': 'hidden'};
    },
    sendMessage: (uid, body) async {
      expect(uid, 'mate');
      sends++;
      sent = body;
      if (fail) throw const ApiFailure('网络中断');
      return sendGate?.future ?? reply;
    },
  );
}

void main() {
  test(
    'directory exposes public fields and honors an explicit cannot-receive flag',
    () async {
      final h = Harness();
      final result = await h.team.mates();
      expect(jsonEncode(result), isNot(contains('secret')));
      expect(h.sends, 0);
      (h.directory['mates'] as List).first['canReceive'] = false;
      expect(((await h.team.mates())['mates'] as List).first['hasBox'], false);
      await expectLater(h.team.send(request()), throwsA(isA<ApiFailure>()));
      expect(h.sends, 0);
    },
  );
  test(
    'same request coalesces, preserves server receipt state, and does not claim delivered',
    () async {
      final h = Harness()..sendGate = Completer<Map<String, dynamic>>();
      final first = h.team.send(request());
      final second = h.team.send(request());
      await Future<void>.delayed(Duration.zero);
      expect(h.sends, 1);
      h.sendGate!.complete(h.reply);
      final results = await Future.wait([first, second]);
      expect(results.first['status'], 'accepted');
      expect(results.first['delivered'], false);
      expect(results.last, results.first);
      await expectLater(
        h.team.send({...request(), 'text': '不同内容'}),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'uncertain send retries original identity but cannot reuse it for changed content',
    () async {
      final h = Harness()..fail = true;
      await expectLater(h.team.send(request()), throwsA(isA<ApiFailure>()));
      h.fail = false;
      await expectLater(
        h.team.send({...request(), 'text': '不同内容'}),
        throwsA(isA<ApiFailure>()),
      );
      expect((await h.team.send(request()))['messageId'], 'server-id');
      expect(h.sends, 2);
    },
  );
  test(
    'attachment references must belong to authorized task outputs',
    () async {
      final h = Harness();
      await h.team.send(
        request(
          files: [
            {'attachmentId': 'file'},
          ],
        ),
      );
      expect(h.reads, 1);
      expect((h.sent!['files'] as List).first, {'attachmentId': 'file'});
      for (final id in ['input', 'other-task-file']) {
        final other = Harness();
        await expectLater(
          other.team.send(
            request(
              files: [
                {'attachmentId': id},
              ],
            ),
          ),
          throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 403)),
        );
        expect(other.sends, 0);
      }
    },
  );
  test('uploaded bytes and names are checked before delivery', () async {
    final h = Harness();
    await h.team.send(
      request(
        files: [
          {'name': '资料.txt', 'data': 'YWJj'},
        ],
      ),
    );
    expect((h.sent!['files'] as List).first['data'], 'YWJj');
    for (final file in [
      {'name': '../a.txt', 'data': 'YWJj'},
      {'name': 'a.txt', 'data': 'invalid@'},
      {'name': 'a.txt', 'data': ''},
      {'attachmentId': 'file', 'data': 'YWJj'},
    ]) {
      final invalid = Harness();
      await expectLater(
        invalid.team.send(request(files: [file])),
        throwsA(isA<ApiFailure>()),
      );
      expect(invalid.sends, 0);
    }
  });
  test(
    'file totals and text length cannot be truncated into a different notification',
    () async {
      final h = Harness()
        ..attachments = [
          {'id': 'large1', 'size': 15 * 1024 * 1024, 'role': 'output'},
          {'id': 'large2', 'size': 15 * 1024 * 1024, 'role': 'output'},
        ];
      await expectLater(
        h.team.send(
          request(
            files: [
              {'attachmentId': 'large1'},
              {'attachmentId': 'large2'},
            ],
          ),
        ),
        throwsA(isA<ApiFailure>()),
      );
      expect(h.sends, 0);
      final other = Harness();
      await expectLater(
        other.team.send({...request(), 'text': 'a' * 501}),
        throwsA(isA<ApiFailure>()),
      );
      expect(other.sends, 0);
    },
  );
  test('account change during preflight prevents transmission', () async {
    final h = Harness()..directoryGate = Completer<Map<String, dynamic>>();
    final pending = h.team.send(request());
    h.current = false;
    h.directoryGate!.complete(h.directory);
    await expectLater(pending, throwsA(isA<ApiFailure>()));
    expect(h.sends, 0);
  });
  test('late send receipt cannot be applied to a different account', () async {
    final h = Harness()..sendGate = Completer<Map<String, dynamic>>();
    final pending = h.team.send(request());
    await Future<void>.delayed(Duration.zero);
    expect(h.sends, 1);
    h.current = false;
    h.sendGate!.complete(h.reply);
    await expectLater(pending, throwsA(isA<ApiFailure>()));
  });
  test('invalid receipt does not report success', () async {
    for (final reply in [
      {'ok': true},
      {'ok': false, 'messageId': 'x', 'status': 'accepted'},
      {'ok': true, 'messageId': 'x', 'status': 'unknown'},
    ]) {
      final h = Harness()..reply = reply;
      await expectLater(h.team.send(request()), throwsA(isA<ApiFailure>()));
    }
  });
  test(
    'draft uses the server model endpoint, public fields only, and never sends',
    () async {
      final h = Harness();
      final result = await h.team.draft({
        'messages': [
          {'role': 'user', 'text': '写报告'},
        ],
        'outputs': ['report.txt'],
        'topic': '报告',
        'state': 'idle',
        'secret': 'never-forward',
      });
      expect(result, {'text': '来自服务端的小结', 'source': 'model'});
      expect(jsonEncode(h.drafted), isNot(contains('secret')));
      expect(h.drafts, 1);
      expect(h.sends, 0);
      await expectLater(
        h.team.draft({
          'messages': [
            {'role': 'tool', 'text': 'secret'},
          ],
          'outputs': [],
        }),
        throwsA(isA<ApiFailure>()),
      );
      expect(h.drafts, 1);
    },
  );
  test(
    'changing caller input during preflight cannot alter approved bytes',
    () async {
      final h = Harness()..directoryGate = Completer<Map<String, dynamic>>();
      final file = {'name': 'a.txt', 'data': 'YWJj'};
      final pending = h.team.send(request(files: [file]));
      file['data'] = 'eHl6';
      h.directoryGate!.complete(h.directory);
      await pending;
      expect((h.sent!['files'] as List).first['data'], 'YWJj');
    },
  );
}

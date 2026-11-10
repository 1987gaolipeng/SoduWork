import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/models/work_models.dart';

void main() {
  test(
    'work picker expands authenticated model catalog independently of Runner default',
    () {
      final roster = AiRoster.fromJson({
        'defaultModel': 'careful',
        'modelOptions': [
          {'name': 'fast'},
          {'name': 'careful'},
          {'name': 'fast'},
        ],
        'agents': [
          {
            'id': 'remote',
            'cli': 'pi',
            'remote': true,
            'model': 'stale-default',
          },
          {'id': 'same-cli-other-runner', 'cli': 'pi', 'remote': true},
          {'id': 'local', 'cli': 'codex', 'remote': false},
        ],
      });
      expect(roster.cloudAgents.map((row) => row.model), ['careful', 'fast']);
      expect(
        roster.cloudAgents.every((row) => row.remote && row.cli == 'pi'),
        isTrue,
      );
      expect(
        roster.cloudAgents.any((row) => row.model == 'stale-default'),
        isFalse,
      );
    },
  );

  test(
    'explicit skill names and initial files remain structured immutable execution inputs',
    () async {
      final skills = [' writer ', 'analyst', 'writer'];
      final request = await CloudConversationRequest.prepare(
        text: '检查文档',
        agentId: 'pi',
        requiredSkills: skills,
        files: [
          XFile.fromData(
            Uint8List.fromList([1, 2]),
            name: 'notes.txt',
            path: 'notes.txt',
          ),
        ],
      );
      skills.clear();
      expect(request.options['requiredSkills'], ['analyst', 'writer']);
      expect(request.files.single.name, 'notes.txt');
      expect(
        () => (request.options['requiredSkills'] as List).add('new'),
        throwsUnsupportedError,
      );
      await expectLater(
        CloudConversationRequest.prepare(
          text: '检查',
          agentId: 'pi',
          requiredSkills: [''],
        ),
        throwsFormatException,
      );
    },
  );

  test('account branch freezes source and restores the same route-safe ID', () {
    final request = CloudConversationRequest.accountBranch(
      conversationId: 'hub-source',
      revision: 7,
      text: '  继续整理清单  ',
      agentId: 'pi',
    );
    expect(request.isAccountBranch, isTrue);
    expect(request.id, matches(RegExp(r'^[A-Za-z0-9-]{1,80}$')));
    expect(request.files, isEmpty);
    expect(request.options, {
      'accountConversationId': 'hub-source',
      'expectedRevision': 7,
      'text': '继续整理清单',
      'agentId': 'pi',
    });
    final targeted = CloudConversationRequest.accountBranch(
      conversationId: 'hub-source',
      revision: 7,
      text: '??????',
      agentId: 'pi',
      targetRunnerId: 'desktop-runner',
      targetRunnerKind: 'work-computer',
    );
    expect(targeted.options['targetRunnerId'], 'desktop-runner');
    expect(targeted.options['targetRunnerKind'], 'work-computer');
    final recovered = CloudConversationRequest.restoreBranch(
      request.branchCheckpoint(),
    );
    expect(recovered.id, request.id);
    expect(recovered.options, request.options);
    expect(
      () => request.options['expectedRevision'] = 8,
      throwsUnsupportedError,
    );
    expect(
      () => CloudConversationRequest.restoreBranch({
        'id': 'invalid_id',
        'options': request.options,
      }),
      throwsFormatException,
    );
    expect(
      CloudConversationRequest.accountBranch(
        conversationId: 'hub-source',
        revision: 7,
        text: '继续',
        agentId: 'pi',
      ).id,
      isNot(request.id),
    );
    expect(
      () => CloudConversationRequest.accountBranch(
        conversationId: 'hub-source',
        revision: 0,
        text: '继续',
        agentId: 'pi',
      ),
      throwsFormatException,
    );
  });
  test('a submission freezes content and file bytes across retries', () async {
    final bytes = Uint8List.fromList([1, 2, 3]);
    final request = await CloudConversationRequest.prepare(
      text: '  整理发布清单  ',
      agentId: 'pi',
      files: [XFile.fromData(bytes, name: '参考.png', path: '参考.png')],
    );
    bytes[0] = 9;
    expect(request.options['text'], '整理发布清单');
    expect(request.options['agentId'], 'pi');
    expect(request.options['sessionId'], 'mobile:${request.id}');
    expect(request.id, matches(RegExp(r'^[A-Za-z0-9._:-]{1,160}$')));
    expect(() => request.options['text'] = '另一份内容', throwsUnsupportedError);
    expect(() => request.files.single.bytes[0] = 99, throwsUnsupportedError);
    expect(request.files.single.bytes, [1, 2, 3]);
  });

  test(
    'oversized, empty and duplicate inputs reject the whole submission',
    () async {
      for (final files in [
        [_OversizedFile()],
        [XFile.fromData(Uint8List(0), name: 'empty.txt', path: 'empty.txt')],
        [
          XFile.fromData(Uint8List.fromList([1]), name: 'A.txt', path: 'A.txt'),
          XFile.fromData(Uint8List.fromList([2]), name: 'a.txt', path: 'a.txt'),
        ],
      ]) {
        await expectLater(
          CloudConversationRequest.prepare(
            text: '检查附件',
            agentId: 'pi',
            files: files,
          ),
          throwsFormatException,
        );
      }
    },
  );

  test('a task assignee id cannot stand in for the foundation id', () async {
    await expectLater(
      CloudConversationRequest.prepare(text: '整理清单', agentId: 'runner:desk:pi'),
      throwsFormatException,
    );
  });

  test(
    'cloud choices exclude local seats and deduplicate foundation/model',
    () {
      final roster = AiRoster.fromJson({
        'agents': [
          {
            'id': 'runner:a:pi',
            'cli': 'pi',
            'remote': true,
            'model': 'model-a',
          },
          {
            'id': 'runner:b:pi',
            'cli': 'pi',
            'remote': true,
            'model': 'model-a',
          },
          {
            'id': 'runner:c:pi',
            'cli': 'pi',
            'remote': true,
            'model': 'model-b',
          },
          {'id': 'local:codex', 'cli': 'codex', 'remote': false},
          {
            'id': 'runner:offline:pi',
            'cli': 'pi',
            'remote': true,
            'online': false,
          },
        ],
      });
      expect(roster.cloudAgents.map((item) => item.id), [
        'runner:a:pi',
        'runner:c:pi',
      ]);
    },
  );
}

class _OversizedFile extends XFile {
  _OversizedFile() : super('oversized.bin', name: 'oversized.bin');

  @override
  Future<int> length() async => 96 * 1024 * 1024 + 1;

  @override
  Future<Uint8List> readAsBytes() =>
      throw StateError('must reject before reading');
}

import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/shared_conversation_workflow.dart';
import 'package:soduwork_mobile/core/work_submission_store.dart';

class MemoryWorkStore extends WorkSubmissionStore {
  WorkSubmission? saved;
  @override
  Future<WorkSubmission?> load(String scope) async => saved;
  @override
  Future<void> save(String scope, WorkSubmission value) async {
    if (saved != null && saved!.id != value.id) throw StateError('pending');
    saved = value;
  }

  @override
  Future<void> clear(String scope, String expectedId) async {
    if (saved?.id == expectedId) saved = null;
  }
}

class Fixture {
  final store = MemoryWorkStore();
  bool current = true, loseReceipt = false;
  final submissions = <String>[];
  final cursors = <String, int>{};
  final cancelled = <String>[];
  List<WorkflowMap> catalogRows = [
    {
      'pluginId': 'plugin',
      'bindingId': 'binding',
      'name': '远端流程',
      'version': '1',
      'runnable': true,
      'capabilities': {'hasWorkflow': true},
    },
  ];
  WorkflowMap run = {
    'id': 'run',
    'taskId': 'task',
    'state': 'running',
    'nodes': [],
  };
  List<WorkflowMap>? listed;
  Future<WorkflowMap> Function(String, WorkflowMap)? onSubmit;
  Future<WorkflowMap> Function(String, String, int)? onPoll;
  late final service = SharedConversationWorkflow(
    scope: 'hub:owner',
    check: () {
      if (!current) throw StateError('account changed');
    },
    store: store,
    catalog: (_) async => {'items': catalogRows},
    submit: (id, body) async {
      submissions.add(id);
      if (onSubmit != null) return onSubmit!(id, body);
      if (loseReceipt) throw StateError('lost receipt');
      return receipt(id);
    },
    status: (id) async => receipt(id),
    listRuns: (_) async => {
      'items': listed ?? [run],
    },
    getRun: (_) async => run,
    pollSession: (task, ref, since) async {
      cursors[ref] = since;
      if (onPoll != null) return onPoll!(task, ref, since);
      return {
        'ok': true,
        'taskId': task,
        'ref': ref,
        'items': [
          {'seq': 1, 'text': ref},
        ],
        'last': 1,
      };
    },
    cancelRun: (id) async {
      cancelled.add(id);
      run = {...run, 'state': 'cancelled'};
      return {'ok': true, 'run': run};
    },
  );
  WorkflowMap receipt(String id) => {
    'ok': true,
    'requestId': id,
    'phase': 'started',
    'taskId': 'task',
    'runId': 'run',
    'run': run,
  };
  Future<WorkflowMap> start({String id = 'request', String text = '原始需求'}) =>
      service.start(
        requestId: id,
        instruction: text,
        plugins: [
          {
            'pluginId': 'plugin',
            'version': '1',
            'name': '远端流程',
            'inputValues': {'count': 3, 'confirm': true},
          },
        ],
      );
}

void main() {
  test(
    'workflow submission carries structured original inputs and clears only confirmed receipt',
    () async {
      final f = Fixture();
      f.onSubmit = (id, body) async {
        expect(f.store.saved?.id, id);
        expect(body, {
          'bindingId': 'binding',
          'instruction': '原始需求',
          'projectId': '',
          'inputs': {'count': 3, 'confirm': true},
        });
        return f.receipt(id);
      };
      final result = await f.start();
      expect(result['workflow'], true);
      expect(f.store.saved, isNull);
      expect(f.submissions, ['request']);
    },
  );

  test(
    'lost receipt persists request and retry from a new UI id uses original id',
    () async {
      final f = Fixture()..loseReceipt = true;
      await expectLater(f.start(), throwsStateError);
      expect(f.store.saved?.id, 'request');
      await expectLater(
        f.start(id: 'another', text: '不同需求'),
        throwsFormatException,
      );
      f.loseReceipt = false;
      await f.start(id: 'new-ui-id');
      expect(f.submissions, ['request']);
    },
  );

  test(
    'concurrent same submission shares receipt while different work is blocked',
    () async {
      final f = Fixture(), gate = Completer<WorkflowMap>();
      f.onSubmit = (_, _) => gate.future;
      final first = f.start(), repeated = f.start(id: 'other');
      expect(() => f.start(text: 'different'), throwsFormatException);
      await Future<void>.delayed(Duration.zero);
      expect(f.submissions, ['request']);
      gate.complete(f.receipt('request'));
      expect(await first, await repeated);
    },
  );

  test(
    'ambiguous binding, revoked runtime and changed version never submit',
    () async {
      for (final kind in ['ambiguous', 'revoked', 'version', 'not-workflow']) {
        final f = Fixture();
        if (kind == 'ambiguous') {
          f.catalogRows.add({...f.catalogRows.first, 'bindingId': 'other'});
        }
        if (kind == 'revoked') f.catalogRows.first['runnable'] = false;
        if (kind == 'version') f.catalogRows.first['version'] = '2';
        if (kind == 'not-workflow') {
          f.catalogRows.first['capabilities'] = {'hasWorkflow': false};
        }
        await expectLater(f.start(), throwsFormatException);
        expect(f.submissions, isEmpty);
      }
    },
  );

  test(
    'malformed or mismatched receipts preserve durable submission',
    () async {
      final f = Fixture();
      f.onSubmit = (id, _) async => {...f.receipt(id), 'requestId': 'wrong'};
      await expectLater(f.start(), throwsFormatException);
      expect(f.store.saved, isNotNull);
      f.store.saved = null; // Independent malformed server response.
      f.onSubmit = (id, _) async => {
        ...f.receipt(id),
        'run': {...f.run, 'taskId': 'another'},
      };
      await expectLater(f.start(), throwsFormatException);
      expect(f.store.saved, isNotNull);
    },
  );

  test(
    'pending phase is retained without inventing a running AI session',
    () async {
      final f = Fixture();
      f.onSubmit = (id, _) async => {
        'ok': true,
        'requestId': id,
        'taskId': 'task',
        'runId': '',
        'phase': 'pending',
        'run': null,
      };
      final receipt = await f.start();
      expect(receipt['phase'], 'pending');
      expect(f.store.saved, isNotNull);
      expect(f.cursors, isEmpty);
    },
  );

  test(
    'restore with no runs falls back; pure script result remains a workflow',
    () async {
      final f = Fixture()..listed = [];
      expect((await f.service.poll(taskId: 'task'))['workflow'], false);
      f.listed = null;
      f.run = {
        'id': 'run',
        'taskId': 'task',
        'state': 'succeeded',
        'nodes': [
          {
            'id': 'script',
            'type': 'script',
            'state': 'succeeded',
            'output': {'text': '实际脚本结果'},
          },
        ],
      };
      final result = await f.service.poll(taskId: 'task');
      expect(result['workflow'], true);
      expect((result['run'] as Map)['state'], 'succeeded');
      expect(result['sessions'], isEmpty);
      expect(f.cursors, isEmpty);
    },
  );

  test(
    'every workflow node has its exact ref and independent incremental cursor',
    () async {
      final f = Fixture();
      f.run['nodes'] = [
        {
          'id': 'node-a',
          'executor': {'ref': 'ref-a'},
        },
        {
          'id': 'node-b',
          'executor': {'ref': 'ref-b'},
        },
      ];
      final result = await f.service.poll(
        taskId: 'task',
        since: {'node-a:ref-a': 10, 'node-b:ref-b': 20},
      );
      expect(f.cursors, {'ref-a': 10, 'ref-b': 20});
      expect((result['sessions'] as List).map((row) => row['key']), [
        'node-a:ref-a',
        'node-b:ref-b',
      ]);
      expect((result['run'] as Map)['state'], 'running');
    },
  );

  test(
    'node log failure is explicit and does not invent a completed run',
    () async {
      final f = Fixture();
      f.run['nodes'] = [
        {
          'id': 'n',
          'executor': {'ref': 'ref'},
        },
      ];
      f.onPoll = (_, _, _) async => {'ok': false, 'error': '执行机离线'};
      final result = await f.service.poll(taskId: 'task');
      expect(((result['sessions'] as List).single as Map)['error'], '执行机离线');
      expect((result['run'] as Map)['state'], 'running');
    },
  );

  test(
    'wrong task run is rejected before reading any node transcript or cancellation',
    () async {
      final f = Fixture();
      f.run['taskId'] = 'foreign-task';
      await expectLater(f.service.poll(taskId: 'task'), throwsFormatException);
      await expectLater(
        f.service.cancel(taskId: 'task', runId: 'run'),
        throwsFormatException,
      );
      expect(f.cursors, isEmpty);
      expect(f.cancelled, isEmpty);
    },
  );

  test(
    'cancel targets entire run and displays returned authoritative state',
    () async {
      final f = Fixture();
      final result = await f.service.cancel(taskId: 'task', runId: 'run');
      expect(f.cancelled, ['run']);
      expect((result['run'] as Map)['state'], 'cancelled');
    },
  );

  test(
    'account change after request prevents accepting or clearing prior session receipt',
    () async {
      final f = Fixture();
      f.onSubmit = (id, _) async {
        f.current = false;
        return f.receipt(id);
      };
      await expectLater(f.start(), throwsStateError);
      expect(f.store.saved?.id, 'request');
    },
  );

  test(
    'embedded run uses public fields and omits credentials and internal executor config',
    () async {
      final f = Fixture();
      f.run['input'] = {'instruction': '公开需求', 'password': 'hidden'};
      f.run['output'] = {
        'text': '真实结果',
        'accessToken': 'hidden',
        'nested': {'api_key': 'hidden', 'count': 1},
      };
      f.run['nodes'] = [
        {
          'id': 'n',
          'type': 'script',
          'state': 'succeeded',
          'input': {'secret': 'hidden'},
          'executor': {
            'config': {'secret': 'hidden'},
            'host': 'internal',
          },
          'output': {'text': '公开节点结果', 'authorization': 'hidden'},
        },
      ];
      final result = await f.service.poll(taskId: 'task');
      final public = result['run'] as Map;
      expect(public['input'], {'instruction': '公开需求'});
      expect(public['output'], {
        'text': '真实结果',
        'nested': {'count': 1},
      });
      expect(((public['nodes'] as List).single as Map)['input'], isNull);
      expect(((public['nodes'] as List).single as Map)['executor'], {
        'ref': '',
        'resolved': {},
      });
    },
  );

  test(
    'complete event batches are preserved when advancing independent cursors',
    () async {
      final f = Fixture();
      f.run['nodes'] = [
        {
          'id': 'n',
          'executor': {'ref': 'ref'},
        },
      ];
      f.onPoll = (task, ref, _) async => {
        'ok': true,
        'taskId': task,
        'ref': ref,
        'items': List.generate(
          240,
          (index) => {'seq': index + 1, 'kind': 'say', 'text': 'event'},
        ),
        'last': 240,
      };
      final result = await f.service.poll(taskId: 'task');
      final page = ((result['sessions'] as List).single as Map)['page'] as Map;
      expect((page['items'] as List).length, 240);
      expect(page['last'], 240);
    },
  );
}

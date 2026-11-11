import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:soduwork_mobile/core/artifact_download.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/shared_conversation_host.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

void main() {
  test(
    'library conversation draft exposes the selected bytes without submitting a task',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final host = SharedConversationHost(
        state: state,
        clearNewDraft: true,
        initialDraft: 'review',
        initialFiles: [
          LibraryMaterialFile(
            DownloadedArtifact(
              bytes: Uint8List.fromList([65, 66]),
              filename: 'note.txt',
              contentType: 'text/plain',
            ),
          ),
        ],
        onDraft: (_) {},
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
      );
      expect((await host.call('ready', {}) as Map)['initialLibraryCount'], 1);
      expect(await host.call('initialLibraryFile', {'index': 0}), {
        'name': 'note.txt',
        'contentType': 'text/plain',
        'data': 'QUI=',
      });
      await expectLater(
        host.call('initialLibraryFile', {'index': 1}),
        throwsA(isA<ApiFailure>()),
      );
      state.revision++;
      await expectLater(
        host.call('initialLibraryFile', {'index': 0}),
        throwsA(isA<ApiFailure>()),
      );
      expect(state.posts, 0);
    },
  );
  test(
    'native library selection returns a file snapshot and rejects a changed account',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      var change = false;
      final host = SharedConversationHost(
        state: state,
        onDraft: (_) {},
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
        onLibraryPick: () async {
          if (change) state.revision++;
          return DownloadedArtifact(
            bytes: Uint8List.fromList([65, 66, 67]),
            filename: 'proof.txt',
            contentType: 'text/plain',
          );
        },
      );
      expect(await host.call('libraryPick', {}), {
        'name': 'proof.txt',
        'contentType': 'text/plain',
        'data': 'QUJD',
      });
      change = true;
      await expectLater(
        host.call('libraryPick', {}),
        throwsA(isA<ApiFailure>()),
      );
      expect(state.posts, 0);
    },
  );
  test(
    'multiple machines require selection and explicit personal PC survives preparation',
    () async {
      final state = _State()
        ..extraTarget = {
          'id': 'runner:own-pc:opencode',
          'type': 'agent',
          'agentId': 'opencode',
          'runnerId': 'own-pc',
          'runnerKind': 'work-computer',
          'runnerName': 'My PC',
          'remote': true,
          'online': true,
          'modelPick': true,
        };
      addTearDown(state.dispose);
      final args = <String, dynamic>{
        'messageId': 'selection-one',
        'text': 'read',
        'agentId': 'opencode',
        'files': [],
        'skills': [],
      };
      final host = _host(state, draft: true);
      await expectLater(host.call('send', args), throwsA(isA<ApiFailure>()));
      expect(state.posts, 0);
      await host.call('send', {
        ...args,
        'targetRunnerId': 'own-pc',
        'targetRunnerKind': 'work-computer',
      });
      expect(state.sentRequest!.options['targetRunnerId'], 'own-pc');
      expect(state.sentRequest!.options['targetRunnerKind'], 'work-computer');
      expect(state.posts, 1);
    },
  );
  test(
    'library files use authenticated bytes and public listing omits paths and secrets',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final api = _MaterialApi(state);
      state.api = api;
      final host = _host(state);
      final listing = await host.call('libraryList', {'query': 'proof'});
      expect(jsonEncode(listing), isNot(contains('secret')));
      final file = await host.call('libraryFile', {'id': 'proof'}) as Map;
      expect(file['data'], base64Encode(utf8.encode('actual bytes')));
      expect(file['name'], 'proof.txt');
      expect(file['contentType'], 'text/plain');
      expect(api.paths.single, '/api/v1/library/items/proof/download');
      await expectLater(
        host.call('libraryFile', {'id': '../private'}),
        throwsA(isA<ApiFailure>()),
      );
      expect(api.paths.length, 1);
    },
  );
  test(
    'follow-up files retain binary contract and cannot escape the bound task',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final api = _MaterialApi(state);
      state.api = api;
      final args = <String, dynamic>{
        'taskId': 'owned-task',
        'text': 'read',
        'messageId': 'stable',
        'files': [
          {'name': 'proof.txt', 'data': 'QUJD', 'contentType': 'text/plain'},
        ],
      };
      final host = _host(state);
      await host.call('say', args);
      expect(api.turns.single['task'], 'owned-task');
      expect(
        (api.turns.single['files'] as List).single['contentType'],
        'text/plain',
      );
      await expectLater(
        host.call('say', {...args, 'taskId': 'other'}),
        throwsA(isA<ApiFailure>()),
      );
      expect(api.turns.length, 1);
    },
  );
  test(
    'remount restores edited review draft and preserves intentional clearing',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      var latest = '';
      final host = SharedConversationHost(
        state: state,
        initialDraft: 'Review the delivery',
        onDraft: (value) => latest = value,
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
      );
      await host.call('draft', {
        'text': 'Review the delivery. Keep my extra notes.',
      });
      final restored = await host.call('ready', {}) as Map;
      expect(
        restored['initialDraft'],
        'Review the delivery. Keep my extra notes.',
      );
      expect(latest, restored['initialDraft']);
      await host.call('draft', {'text': ''});
      final cleared = await host.call('ready', {}) as Map;
      expect(cleared['initialDraft'] ?? '', isEmpty);
      expect(latest, isEmpty);
    },
  );
  test(
    'peer cloud automation restores as a conversation without probing plugin ownership',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final api = _WorkflowProbeApi(state);
      state.api = api;
      final host = _host(state);
      final result =
          await host.call('workflowPoll', {'taskId': 'owned-task'}) as Map;
      expect(result, {'ok': true, 'workflow': false, 'taskId': 'owned-task'});
      expect(api.taskReads, 1);
      expect(api.workflowReads, 0);
      final page = await host.call('poll', {'taskId': 'owned-task'}) as Map;
      expect(page['ok'], true);
      expect(state.reads, 1);
    },
  );

  test(
    'non-cloud and unproven cloud tasks retain the real workflow lookup',
    () async {
      for (final row in [
        {'id': 'owned-task', 'origin': 'local'},
        {'id': 'owned-task', 'origin': 'cloud-conversation'},
      ]) {
        final state = _State();
        addTearDown(state.dispose);
        final api = _WorkflowProbeApi(state)..row = row;
        state.api = api;
        final result =
            await _host(state).call('workflowPoll', {'taskId': 'owned-task'})
                as Map;
        expect(result['workflow'], false);
        expect(api.workflowReads, 1);
      }
    },
  );

  test(
    'confirmed direct requirement reads its session without a plugin probe',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final api = _WorkflowProbeApi(state)
        ..row = {
          'id': 'owned-task',
          'origin': 'local',
          'status': 'done',
          'canViewExecution': true,
          'workRouting': {
            'selectedStrategy': 'direct',
            'workflowBindingId': '',
            'executionContext': {'strategy': 'direct'},
          },
        }
        ..workflowFailure = 404;
      state.api = api;
      final host = _host(state);
      expect(await host.call('workflowPoll', {'taskId': 'owned-task'}), {
        'ok': true,
        'workflow': false,
        'taskId': 'owned-task',
      });
      expect(api.taskReads, 1);
      expect(api.workflowReads, 0);
      expect(
        (await host.call('poll', {'taskId': 'owned-task'}) as Map)['ok'],
        true,
      );
      expect(state.reads, 1);
    },
  );

  test('ambiguous or denied direct records retain workflow errors', () async {
    for (final override in [
      {'selectedStrategy': 'workflow'},
      {'workflowBindingId': 'bound-workflow'},
      {'workflowBindingId': null},
      {
        'executionContext': {'strategy': 'workflow'},
      },
      {'executionContext': null},
      {
        'mobileWorkSubmission': {'requestId': 'pending-workflow'},
      },
    ]) {
      final state = _State();
      addTearDown(state.dispose);
      final api = _WorkflowProbeApi(state)
        ..row = {
          'id': 'owned-task',
          'canViewExecution': true,
          'workRouting': {
            'selectedStrategy': 'direct',
            'workflowBindingId': '',
            'executionContext': {'strategy': 'direct'},
            ...override,
          },
        }
        ..workflowFailure = 404;
      state.api = api;
      await expectLater(
        _host(state).call('workflowPoll', {'taskId': 'owned-task'}),
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 404)),
      );
      expect(api.workflowReads, 1);
    }
    final state = _State();
    addTearDown(state.dispose);
    final api = _WorkflowProbeApi(state)
      ..row = {
        'id': 'owned-task',
        'canViewExecution': false,
        'workRouting': {
          'selectedStrategy': 'direct',
          'workflowBindingId': '',
          'executionContext': {'strategy': 'direct'},
        },
      }
      ..workflowFailure = 403;
    state.api = api;
    await expectLater(
      _host(state).call('workflowPoll', {'taskId': 'owned-task'}),
      throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 403)),
    );
    expect(api.workflowReads, 1);
  });

  test(
    'failed or mismatched source lookup never masquerades as no workflow',
    () async {
      for (final failure in [403, 404, 500]) {
        final state = _State();
        addTearDown(state.dispose);
        final api = _WorkflowProbeApi(state)..failure = failure;
        state.api = api;
        await expectLater(
          _host(state).call('workflowPoll', {'taskId': 'owned-task'}),
          throwsA(isA<ApiFailure>().having((e) => e.status, 'status', failure)),
        );
        expect(api.workflowReads, 0);
      }
      final state = _State();
      addTearDown(state.dispose);
      state.api = _WorkflowProbeApi(state)..row = {'id': 'another-task'};
      await expectLater(
        _host(state).call('workflowPoll', {'taskId': 'owned-task'}),
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 409)),
      );
    },
  );

  test(
    'changing account while resolving conversation type invalidates the result',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      state.api = _WorkflowProbeApi(state)..onRead = () => state.revision++;
      await expectLater(
        _host(state).call('workflowPoll', {'taskId': 'owned-task'}),
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 409)),
      );
    },
  );

  test(
    'cloud read access blocks continuation until the server explicitly grants it',
    () async {
      final state = _State();
      final api = _CatalogApi(state);
      state.api = api;
      state.tasks = [
        WorkTask.fromJson({
          'id': 'cloud-task',
          'origin': 'cloud-conversation',
          'readOnly': true,
        }),
      ];
      addTearDown(state.dispose);
      final host = SharedConversationHost(
        state: state,
        taskId: 'cloud-task',
        onDraft: (_) {},
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
      );
      final read = await host.call('poll', {'taskId': 'cloud-task'}) as Map;
      expect(read['canSend'], false);
      expect(read['readOnlyReason'], contains('当前设备仅可查看'));
      await expectLater(
        host.call('say', {
          'taskId': 'cloud-task',
          'text': 'draft',
          'messageId': 'one',
        }),
        throwsA(isA<ApiFailure>()),
      );
      expect(api.sends, 0);
      state.gate = Completer()
        ..complete({'ok': true, 'items': [], 'canSend': true});
      expect(
        (await host.call('poll', {'taskId': 'cloud-task'}) as Map)['canSend'],
        true,
      );
      await host.call('say', {
        'taskId': 'cloud-task',
        'text': 'draft',
        'messageId': 'one',
      });
      expect(api.sends, 1);
    },
  );

  test(
    'explicit composer mode survives host re-read and removal cannot resurrect it',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final changes = <String>[];
      final host = SharedConversationHost(
        state: state,
        initialAction: 'work.requirement.create',
        onDraft: (_) {},
        onDraftAction: changes.add,
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
      );
      expect(
        (await host.call('ready', {}) as Map)['initialAction'],
        'work.requirement.create',
      );
      await host.call('draft', {
        'text': '完整正文',
        'actionId': 'work.automation.create',
      });
      expect(
        (await host.call('ready', {}) as Map)['initialAction'],
        'work.automation.create',
      );
      await host.call('draft', {'text': '完整正文', 'actionId': ''});
      expect(
        (await host.call('ready', {}) as Map).containsKey('initialAction'),
        false,
      );
      await host.call('draft', {
        'text': '完整正文',
        'actionId': 'unregistered.action',
      });
      expect(
        (await host.call('ready', {}) as Map).containsKey('initialAction'),
        false,
      );
      expect(changes, ['work.automation.create', '', '']);
    },
  );

  test(
    'plugin confirmation reads an owned artifact, preserves fields and serializes the form',
    () async {
      final state = _State();
      final api = _DraftApi(state);
      state.api = api;
      addTearDown(state.dispose);
      final gate = Completer<Map<String, dynamic>?>();
      Map<String, dynamic>? received;
      final host = SharedConversationHost(
        state: state,
        taskId: 'owned-task',
        onDraft: (_) {},
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
        onPluginDraft: (draft) {
          received = draft;
          return gate.future;
        },
      );
      await expectLater(
        host.call('pluginDraft', {
          'taskId': 'foreign',
          'attachmentId': 'draft',
        }),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        host.call('pluginDraft', {
          'taskId': 'owned-task',
          'attachmentId': 'missing',
        }),
        throwsA(isA<ApiFailure>()),
      );
      final pending = host.call('pluginDraft', {
        'taskId': 'owned-task',
        'attachmentId': 'draft',
      });
      for (var i = 0; i < 20 && received == null; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(received!['inputs'], [
        {'key': 'topic', 'type': 'text'},
      ]);
      await expectLater(
        host.call('pluginDraft', {
          'taskId': 'owned-task',
          'attachmentId': 'draft',
        }),
        throwsA(isA<ApiFailure>()),
      );
      gate.complete(null);
      expect(await pending, {'cancelled': true});
      api.body = 'not json';
      await expectLater(
        host.call('pluginDraft', {
          'taskId': 'owned-task',
          'attachmentId': 'draft',
        }),
        throwsA(isA<ApiFailure>()),
      );
    },
  );

  test(
    'handoff uses authorized title/files, serializes forms and acknowledges cancellation',
    () async {
      final state = _State();
      final api = _HandoffApi(state);
      state.api = api;
      addTearDown(state.dispose);
      final gate = Completer<Map<String, dynamic>?>();
      Map<String, dynamic>? seed;
      final host = SharedConversationHost(
        state: state,
        taskId: 'owned-task',
        onDraft: (_) {},
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
        onHandoff: (kind, data) {
          seed = data;
          return gate.future;
        },
      );
      final args = {
        'taskId': 'owned-task',
        'kind': 'requirement',
        'contextText': 'visible',
        'instruction': 'next',
        'title': 'forged',
      };
      final pending = host.call('handoff', args);
      await Future<void>.delayed(Duration.zero);
      expect(seed!['title'], 'authorized title');
      expect(seed!['attachments'], isEmpty);
      await expectLater(host.call('handoff', args), throwsA(isA<ApiFailure>()));
      gate.complete(null);
      expect(await pending, {'cancelled': true});
      await expectLater(
        host.call('handoff', {...args, 'taskId': 'foreign'}),
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 403)),
      );
      await expectLater(
        host.call('handoff', {...args, 'contextText': 'x' * 40001}),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'models bridge does not wait for executor and exposes only approved display fields',
    () async {
      final state = _State();
      state.api = _CatalogApi(state);
      addTearDown(state.dispose);
      state.targetGate = Completer<Map<String, dynamic>>();
      final host = _host(state);
      var fullCatalogDone = false;
      final full = host.call('catalog', {}).then((result) {
        fullCatalogDone = true;
        return result;
      });
      final models = await host.call('models', {}) as Map;
      expect(fullCatalogDone, false);
      expect((models['usable'] as List).first, {
        'name': 'safe-model',
        'label': '测试模型',
      });
      expect(
        models.keys,
        unorderedEquals(['error', 'usable', 'defaultModel', 'defaultModels']),
      );
      state.targetGate!.complete({'targets': []});
      await full;
    },
  );

  test('model and executor catalogs preserve independent failures', () async {
    final state = _State();
    final api = _CatalogApi(state);
    state.api = api;
    addTearDown(state.dispose);
    state.targetError = true;
    final host = _host(state);
    final first = await host.call('catalog', {}) as Map;
    expect((first['models'] as Map)['usable'], isNotEmpty);
    expect((first['targets'] as Map)['error'], '执行目录暂不可用');
    state.targetError = false;
    api.modelError = true;
    final second = await host.call('catalog', {}) as Map;
    expect((second['targets'] as Map)['targets'], isNotEmpty);
    expect((second['models'] as Map)['error'], '模型目录暂不可用');
  });

  test(
    'selected follow-up validates current Runner and forwards only execution fields',
    () async {
      final state = _State();
      final api = _CatalogApi(state);
      state.api = api;
      addTearDown(state.dispose);
      final host = _host(state);
      await host.call('say', {
        'taskId': 'owned-task',
        'text': '继续',
        'messageId': 'next',
        'executionSelection': {
          'agentId': 'opencode',
          'modelName': 'safe-model',
        },
      });
      expect(api.selected, {
        'agentId': 'opencode',
        'modelName': 'safe-model',
        'reasoningEffort': '',
      });
      await expectLater(
        host.call('say', {
          'taskId': 'owned-task',
          'text': '继续',
          'messageId': 'bad',
          'executionSelection': {
            'agentId': 'other-runner',
            'modelName': 'safe-model',
          },
        }),
        throwsA(isA<ApiFailure>()),
      );
      expect(api.sends, 1);
    },
  );

  test(
    'file and delivery methods cannot escape the bound conversation',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final host = _host(state);
      for (final method in [
        'artifacts',
        'artifactAction',
        'delivery',
        'openDelivery',
        'previewDeliveryFile',
        'syncDelivery',
      ]) {
        await expectLater(
          host.call(method, {'taskId': 'another-task'}),
          throwsA(
            isA<ApiFailure>().having((error) => error.status, 'status', 403),
          ),
        );
      }
    },
  );

  test(
    'lost frame reply replays the existing task receipt without creating another task',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final host = _host(state, draft: true);
      final args = <String, dynamic>{
        'messageId': 'ui-safe',
        'text': '执行工作',
        'agentId': 'opencode',
        'model': '',
        'files': [],
        'skills': [],
      };
      final first = await host.call('send', args) as Map;
      final replay = await host.call('send', args) as Map;
      expect(first['taskId'], 'created-task');
      expect(replay['taskId'], first['taskId']);
      expect(state.posts, 1);
      await expectLater(
        host.call('send', {...args, 'text': '不同工作'}),
        throwsA(isA<ApiFailure>()),
      );
      expect(state.posts, 1);
    },
  );
  test(
    'catalog bridge forwards display fields only, even if a provider adds secrets',
    () async {
      final state = _State();
      state.api = _CatalogApi(state);
      addTearDown(state.dispose);
      final result = await _host(state).call('catalog', {});
      final models = (result as Map)['models'] as Map;
      expect(models['defaultModel'], 'safe-model');
      expect(models['defaultModels'], {'pi': 'safe-model', 'opencode': ''});
      final encoded = jsonEncode(result);
      expect(encoded, contains('safe-model'));
      expect(encoded, isNot(contains('unexpected-secret')));
      expect(encoded, isNot(contains('providers')));
    },
  );
  test(
    'embedded view cannot choose a different task or invoke arbitrary APIs',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final host = _host(state);
      await expectLater(
        host.call('poll', {'taskId': 'someone-elses-task'}),
        throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 403)),
      );
      await expectLater(
        host.call('admin/users', {}),
        throwsA(isA<ApiFailure>()),
      );
      expect(state.reads, 0);
      await host.call('poll', {'taskId': 'owned-task', 'since': 9});
      expect(state.reads, 1);
      expect(state.cursor, 9);
    },
  );

  test(
    'identity change rejects late operation results and subsequent calls',
    () async {
      final state = _State()..gate = Completer<Map<String, dynamic>>();
      addTearDown(state.dispose);
      final host = _host(state);
      final pending = host.call('poll', {'taskId': 'owned-task'});
      state.revision++;
      state.gate!.complete({'ok': true, 'items': []});
      await expectLater(pending, throwsA(isA<ApiFailure>()));
      await expectLater(host.call('ready', {}), throwsA(isA<ApiFailure>()));
    },
  );

  test(
    'host returns no device secret, account password or model key',
    () async {
      final state = _State();
      addTearDown(state.dispose);
      final result = await _host(state).call('ready', {}) as Map;
      expect(result.keys.toSet(), {
        'identity',
        'workCardHistoryId',
        'scope',
        'taskId',
        'title',
        'dark',
        'executionMode',
        'clearNewDraft',
      });
      expect(result['taskId'], 'owned-task');
      expect(result['executionMode'], 'cloud');
      expect(
        result['identity'],
        [
          state.endpoint.baseUrl,
          state.enrollment?.ownerUserId,
          state.enrollment?.deviceId,
        ].join(':'),
      );
      expect(result.keys, isNot(contains('session')));
      expect(result.keys, isNot(contains('secret')));
    },
  );

  test('external links and host navigation remain bounded', () async {
    final state = _State();
    addTearDown(state.dispose);
    final host = _host(state);
    for (final url in [
      'javascript:alert(1)',
      'file:///C:/x',
      'https://key@example.com/',
    ]) {
      await expectLater(
        host.call('external', {'url': url}),
        throwsA(isA<ApiFailure>()),
      );
    }
    await expectLater(
      host.call('resource', {'key': 'admin'}),
      throwsA(isA<ApiFailure>()),
    );
  });
}

SharedConversationHost _host(_State state, {bool draft = false}) =>
    SharedConversationHost(
      state: state,
      taskId: draft ? null : 'owned-task',
      onDraft: (_) {},
      onCreated: (_) {},
      onResource: (_) async {},
      onExternal: (_) async {},
    );

class _State extends MobileState {
  Map<String, dynamic>? extraTarget;
  CloudConversationRequest? sentRequest;
  bool targetError = false;
  Completer<Map<String, dynamic>>? targetGate;
  int revision = 1, reads = 0, cursor = 0, posts = 0;
  Completer<Map<String, dynamic>>? gate;
  _State() {
    endpoint = const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'http://fixture.test',
    );
    api = SoduWorkApi(store: store, endpoint: endpoint);
    phase = MobilePhase.ready;
  }
  @override
  Future<void> restorePendingBranch() async {}
  @override
  Future<void> rememberCloudRequest(CloudConversationRequest request) async {
    pendingCloudRequest = request;
  }

  @override
  Future<Map<String, dynamic>> startCloudConversation({
    required String text,
    String agentId = '',
    String model = '',
    String title = '',
    List files = const [],
    CloudConversationRequest? request,
  }) async {
    posts++;
    sentRequest = request;
    pendingCloudRequest = null;
    return {'ok': true, 'taskId': 'created-task'};
  }

  @override
  int get identityRevision => revision;
  @override
  Future<Map<String, dynamic>> cloudConversationTargets() async =>
      targetGate != null
      ? await targetGate!.future
      : targetError
      ? throw const ApiFailure('执行目录暂不可用')
      : {
          'targets': [
            ?extraTarget,
            {
              'type': 'agent',
              'agentId': 'opencode',
              'online': true,
              'remote': true,
              'name': 'OpenCode',
              'modelPick': true,
              'runnerId': 'fixture-runner',
              'modelMode': 'managed',
              'key': 'unexpected-secret',
            },
          ],
        };
  @override
  Future<Map<String, dynamic>> loadConversationSession(
    String taskId, {
    String ref = '',
    int since = 0,
  }) async {
    reads++;
    cursor = since;
    return gate?.future ??
        Future.value({'ok': true, 'items': [], 'runnerId': 'fixture-runner'});
  }
}

class _MaterialApi extends SoduWorkApi {
  final paths = <String>[];
  final turns = <Map<String, dynamic>>[];
  factory _MaterialApi(_State state) {
    late _MaterialApi api;
    api = _MaterialApi._(
      state,
      MockClient((request) async {
        api.paths.add(request.url.path);
        expect(request.headers['Authorization'], 'fixture-auth');
        return http.Response(
          'actual bytes',
          200,
          headers: {
            'content-type': 'text/plain',
            'content-disposition': 'attachment; filename="proof.txt"',
          },
        );
      }),
    );
    return api;
  }
  _MaterialApi._(_State state, http.Client client)
    : super(store: state.store, endpoint: state.endpoint, client: client);
  @override
  Future<Map<String, String>> authorizationHeaders() async => {
    'Authorization': 'fixture-auth',
  };
  @override
  Future<Map<String, dynamic>> library({
    String scope = 'recommended',
    String query = '',
    String folderId = '',
    String storage = '',
  }) async => {
    'ok': true,
    'items': [
      {
        'id': 'proof',
        'title': 'Proof',
        'filename': 'proof.txt',
        'size': 12,
        'contentType': 'text/plain',
        'secret': 'private-secret',
        'path': '/secret/path',
      },
    ],
  };
  @override
  Future<Map<String, dynamic>> sayWithFiles(
    String taskId, {
    required String text,
    required String messageId,
    required List<Map<String, dynamic>> files,
    Map<String, String>? executionSelection,
  }) async {
    turns.add({'task': taskId, 'files': files, 'messageId': messageId});
    return {'ok': true};
  }
}

class _CatalogApi extends SoduWorkApi {
  Map<String, String>? selected;
  int sends = 0;
  bool modelError = false;
  @override
  Future<Map<String, dynamic>> sayToConversation(
    String taskId, {
    required String text,
    required String messageId,
    Map<String, String>? executionSelection,
  }) async {
    sends++;
    selected = executionSelection;
    return {'ok': true, 'acceptedSelection': executionSelection};
  }

  _CatalogApi(_State state)
    : super(store: state.store, endpoint: state.endpoint);
  @override
  Future<Map<String, dynamic>> chatModelCatalog() async => modelError
      ? throw const ApiFailure('模型目录暂不可用')
      : {
          'usable': [
            {'name': 'safe-model', 'label': '测试模型', 'key': 'unexpected-secret'},
          ],
          'defaultModel': 'safe-model',
          'defaultModels': {'pi': 'safe-model', 'opencode': '', 'invalid': {}},
          'providers': [
            {'key': 'unexpected-secret'},
          ],
        };
}

class _HandoffApi extends SoduWorkApi {
  _HandoffApi(_State state)
    : super(store: state.store, endpoint: state.endpoint);
  @override
  Future<WorkTask> task(String id) async =>
      WorkTask.fromJson({'id': id, 'title': 'authorized title'});
  @override
  Future<List<Map<String, dynamic>>> taskAttachments(String id) async => [];
}

class _DraftApi extends SoduWorkApi {
  String body =
      '{"template":"method","name":"Report","inputs":[{"key":"topic","type":"text"}]}';
  factory _DraftApi(_State state) {
    late _DraftApi api;
    final client = MockClient(
      (request) async => http.Response(
        request.url.path.endsWith('/access')
            ? jsonEncode({'url': '/api/v1/attachments/draft?ticket=test'})
            : api.body,
        200,
      ),
    );
    api = _DraftApi._(state, client);
    return api;
  }
  _DraftApi._(_State state, http.Client client)
    : super(store: state.store, endpoint: state.endpoint, client: client);
  @override
  Future<Map<String, String>> authorizationHeaders() async => {
    'Authorization': 'fixture',
  };
  @override
  Future<List<Map<String, dynamic>>> taskAttachments(String id) async => [
    {
      'id': 'draft',
      'filename': 'soduwork-plugin-draft.json',
      'contentType': 'application/json',
      'role': 'output',
    },
  ];
}

class _WorkflowProbeApi extends SoduWorkApi {
  _WorkflowProbeApi(_State state)
    : super(store: state.store, endpoint: state.endpoint);
  int taskReads = 0, workflowReads = 0;
  int? failure;
  int? workflowFailure;
  void Function()? onRead;
  Map<String, dynamic> row = {
    'id': 'owned-task',
    'origin': 'cloud-conversation',
    'canViewExecution': true,
    'workRouting': {
      'cloudConversation': {'sessionId': 'schedule-confirmed'},
    },
  };
  @override
  Future<WorkTask> task(String id) async {
    taskReads++;
    if (failure != null) {
      throw ApiFailure('Source unavailable', status: failure!);
    }
    onRead?.call();
    return WorkTask.fromJson(row);
  }

  @override
  Future<Map<String, dynamic>> conversationWorkflowRuns(String taskId) async {
    workflowReads++;
    if (workflowFailure != null) {
      throw ApiFailure('Workflow unavailable', status: workflowFailure!);
    }
    return {'items': <dynamic>[]};
  }
}

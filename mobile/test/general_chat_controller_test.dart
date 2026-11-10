import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/general_chat_store.dart';
import 'package:soduwork_mobile/core/general_chat_transport.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/general_chat.dart';
import 'package:soduwork_mobile/state/general_chat_controller.dart';

void main() {
  test(
    'user outbox and Hub acknowledgment precede the only paid request',
    () async {
      final harness = _Harness();
      final receipt = Completer<void>();
      harness.beforePublish = (body) async {
        if (body['sourceRevision'] == 1) await receipt.future;
      };
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      final operation = controller.send('测试问题');
      await _tick();
      expect(harness.store.boxes, hasLength(1));
      expect(controller.hasPending, isTrue);
      expect(harness.modelCalls, 0);
      expect(harness.configCalls, 0);
      receipt.complete();
      expect(await operation, isTrue);
      await controller.replyCompleted;
      expect(harness.modelCalls, 1);
      expect(harness.configCalls, 1);
      expect(controller.messages.map((row) => row.role), ['user', 'assistant']);
      expect(controller.messages.last.text, '测试回答');
      expect(harness.bodies.map((body) => body['sourceRevision']), [1, 2]);
      expect(harness.store.boxes, isEmpty);
      expect(harness.contexts.single, [
        {'role': 'user', 'content': '测试问题'},
      ]);
      expect(
        harness.bodies.first['sourceEpoch'],
        harness.bodies.last['sourceEpoch'],
      );
    },
  );

  test(
    'failed user sync preserves exact batch and manual sync retry never charges',
    () async {
      final harness = _Harness()
        ..publishFailure = const ApiFailure('Hub暂不可用', status: 503);
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      expect(await controller.send('必须保留的问题'), isTrue);
      final original = jsonEncode(harness.bodies.single);
      expect(controller.hasPending, isTrue);
      expect(harness.modelCalls, 0);
      harness.publishFailure = null;
      await controller.retryPending();
      expect(jsonEncode(harness.bodies.last), original);
      expect(harness.modelCalls, 0);
      expect(controller.canAnswer, isTrue);
      await controller.answer();
      expect(harness.modelCalls, 1);
      expect(controller.hasPending, isFalse);
    },
  );

  test(
    'storage failure keeps the draft unsent and does not contact Hub or model',
    () async {
      final harness = _Harness()..store.failWrite = true;
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      expect(await controller.send('不可丢失的草稿'), isFalse);
      expect(harness.bodies, isEmpty);
      expect(harness.modelCalls, 0);
      expect(controller.error, isNotEmpty);
    },
  );

  test(
    'uncertain local removal retries identical committed batch and never repeats paid work',
    () async {
      final harness = _Harness()..store.failRemove = true;
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      expect(await controller.send('先存后答'), isTrue);
      expect(harness.modelCalls, 0);
      expect(controller.hasPending, isTrue);
      harness.store.failRemove = false;
      await controller.retryPending();
      expect(harness.bodies.first, harness.bodies.last);
      expect(harness.modelCalls, 0);
      expect(controller.canAnswer, isTrue);
    },
  );

  test(
    'source version conflict preserves pending content and explicitly blocks future writes',
    () async {
      final harness = _Harness()
        ..publishFailure = const ApiFailure('同一来源版本已绑定其他内容', status: 409);
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      await controller.send('不能覆盖');
      expect(controller.conflict, isTrue);
      expect(controller.hasPending, isTrue);
      final count = harness.bodies.length;
      await controller.retryPending();
      expect(harness.bodies, hasLength(count));
      expect(await controller.send('另一条'), isFalse);
      expect(harness.modelCalls, 0);
    },
  );

  test('response ticket model mismatch never reaches paid endpoint', () async {
    final harness = _Harness()
      ..config = {'ok': true, 'key': 'fixture-ticket', 'model': 'unexpected'};
    final controller = harness.controller();
    addTearDown(controller.dispose);
    await controller.initialize();
    await controller.send('保持所选模型');
    await controller.replyCompleted;
    expect(harness.modelCalls, 0);
    expect(controller.error, contains('模型'));
    expect(controller.messages, hasLength(1));
    expect(controller.canAnswer, isTrue);
  });

  test(
    'identity switch while configuration is pending stops paid request and hides old content',
    () async {
      final harness = _Harness();
      final config = Completer<Map<String, dynamic>>();
      harness.pendingConfig = config.future;
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      final operation = controller.send('旧账号问题');
      await _tick();
      expect(harness.configCalls, 1);
      harness.current = false;
      config.complete({'ok': true, 'key': 'fixture-ticket', 'model': 'model'});
      await operation;
      await controller.replyCompleted;
      expect(harness.modelCalls, 0);
      expect(controller.messages, isEmpty);
      expect(harness.bodies, hasLength(1));
    },
  );

  test(
    'same device reopens Hub source and sends complete committed history without local body copies',
    () async {
      final harness = _Harness();
      final first = harness.controller();
      await first.initialize();
      await first.send('第一个问题');
      await first.replyCompleted;
      final sid = first.sourceSessionId;
      first.dispose();
      expect(harness.store.boxes, isEmpty);
      final reopened = harness.controller();
      addTearDown(reopened.dispose);
      await reopened.initialize(conversationId: 'cid', sourceSessionId: sid);
      expect(reopened.messages.map((row) => row.text), ['第一个问题', '测试回答']);
      await reopened.send('第二个问题');
      await reopened.replyCompleted;
      expect(harness.contexts.last.map((row) => row['content']), [
        '第一个问题',
        '测试回答',
        '第二个问题',
      ]);
      expect(harness.bodies.last['sourceRevision'], 4);
      expect(reopened.messages.map((row) => row.position), [0, 1, 2, 3]);
    },
  );

  test(
    'other device projection and desktop source are never adopted as writable mobile chats',
    () async {
      for (final source in [
        {
          'sourceClientId': 'another-device',
          'sourceSessionId': 'mobile-chat:other',
        },
        {'sourceClientId': 'device', 'sourceSessionId': 'pi:desktop-session'},
      ]) {
        final harness = _Harness()..sourceOverride = source;
        final controller = harness.controller();
        await controller.initialize(conversationId: 'cid');
        expect(controller.conflict, isTrue);
        expect(controller.canSend, isFalse);
        expect(await controller.send('不得复制'), isFalse);
        expect(harness.bodies, isEmpty);
        expect(harness.modelCalls, 0);
        controller.dispose();
      }
    },
  );

  test(
    'restored outbox syncs before source loading and never automatically invokes a model',
    () async {
      final harness = _Harness()
        ..publishFailure = const ApiFailure('offline', status: 503);
      final first = harness.controller();
      await first.initialize();
      await first.send('刷新后保留');
      final sid = first.sourceSessionId;
      first.dispose();
      harness.publishFailure = null;
      harness.events.clear();
      final restored = harness.controller();
      addTearDown(restored.dispose);
      await restored.initialize(sourceSessionId: sid);
      expect(
        harness.events.indexOf('publish'),
        lessThan(harness.events.indexOf('source')),
      );
      expect(restored.messages.single.text, '刷新后保留');
      expect(restored.hasPending, isFalse);
      expect(restored.canAnswer, isTrue);
      expect(harness.modelCalls, 0);
    },
  );

  test(
    'unknown model protocols and overlong context stop before any producer or model request',
    () async {
      final harness = _Harness();
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      controller.selectModel('unknown');
      expect(controller.selectedModel, 'model');
      expect(controller.error, contains('协议'));
      expect(await controller.send('a' * 131072), isFalse);
      expect(controller.error, contains('未截断'));
      expect(harness.bodies, isEmpty);
      expect(harness.modelCalls, 0);
    },
  );

  testWidgets(
    'checkpoint is serialized and final update keeps the assistant identity',
    (tester) async {
      final harness = _Harness()..reply = StreamController<String>();
      final controller = harness.controller(
        checkpoint: const Duration(milliseconds: 10),
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final operation = controller.send('流式测试');
      await tester.pump();
      harness.reply!.add('第一段');
      await tester.pump();
      expect(controller.messages.last.text, '第一段');
      await tester.pump(const Duration(milliseconds: 11));
      expect(harness.bodies.map((body) => body['sourceRevision']), [1, 2]);
      harness.reply!.add('第二段');
      await tester.pump();
      await controller.stop();
      await operation;
      expect(harness.bodies.last['sourceRevision'], 3);
      expect(harness.bodies.last['state'], 'stopped');
      final checkpoint = (harness.bodies[1]['messages'] as List).single as Map;
      final finalRow = (harness.bodies.last['messages'] as List).single as Map;
      expect(finalRow['id'], checkpoint['id']);
      expect(finalRow['position'], checkpoint['position']);
      expect(finalRow['createdAt'], checkpoint['createdAt']);
      expect(finalRow['text'], '第一段第二段');
      expect(controller.hasPending, isFalse);
    },
  );

  testWidgets(
    'failed checkpoint aborts model and preserves exact checkpoint plus final tail',
    (tester) async {
      final harness = _Harness()..reply = StreamController<String>();
      harness.beforePublish = (body) async {
        if (body['sourceRevision'] == 2) {
          throw const ApiFailure('checkpoint offline', status: 503);
        }
      };
      final controller = harness.controller(
        checkpoint: const Duration(milliseconds: 10),
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final operation = controller.send('必须保留部分回复');
      await tester.pump();
      harness.reply!.add('部分回答');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 11));
      await operation;
      await controller.replyCompleted;
      expect(harness.transportAborts, greaterThan(0));
      expect(harness.modelCalls, 1);
      expect(controller.hasPending, isTrue);
      final saved = harness.store.boxes.values.single;
      expect(saved.batches.map((batch) => batch.revision), [2, 3]);
      expect(saved.batches.first.purpose, 'checkpoint');
      final original = jsonEncode(saved.batches.first.body);
      harness.beforePublish = null;
      await controller.retryPending();
      expect(jsonEncode(harness.bodies[harness.bodies.length - 2]), original);
      expect(controller.hasPending, isFalse);
      expect(harness.modelCalls, 1);
      expect(controller.messages.last.text, '部分回答');
    },
  );
  test(
    'accepted send returns during streaming and rejects a duplicate send',
    () async {
      final harness = _Harness()..reply = StreamController<String>();
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      var transientIdle = 0;
      controller.addListener(() {
        if (controller.canSend &&
            controller.messages.isNotEmpty &&
            controller.messages.last.role == 'user' &&
            harness.modelCalls == 0) {
          transientIdle++;
        }
      });
      expect(
        await controller.send('立即清空已接受草稿').timeout(const Duration(seconds: 1)),
        isTrue,
      );
      expect(transientIdle, 0);
      expect(controller.streaming, isTrue);
      expect(await controller.send('不应重复发送'), isFalse);
      await _tick();
      expect(harness.modelCalls, 1);
      harness.reply!.add('部分回答');
      await _tick();
      await controller.stop();
      expect(harness.bodies.first['messages'], hasLength(1));
    },
  );
  test(
    'refresh without a route identity restores the unique pending session but does not generate',
    () async {
      final harness = _Harness()
        ..publishFailure = const ApiFailure('offline', status: 503);
      final first = harness.controller();
      await first.initialize();
      await first.send('无路由也不能丢失');
      first.dispose();
      harness.publishFailure = null;
      final restored = harness.controller();
      addTearDown(restored.dispose);
      await restored.initialize();
      expect(restored.messages.single.text, '无路由也不能丢失');
      expect(restored.hasPending, isFalse);
      expect(restored.canAnswer, isTrue);
      expect(harness.modelCalls, 0);
    },
  );

  test(
    'multiple pending sessions require a choice and explicit new leaves both untouched',
    () async {
      final harness = _Harness()
        ..publishFailure = const ApiFailure('offline', status: 503);
      final first = harness.controller();
      await first.initialize();
      await first.send('第一条待同步');
      first.dispose();
      final original = harness.store.boxes.values.single;
      final secondBody = {
        ...original.batches.single.body,
        'sourceSessionId': 'mobile-chat:second',
        'title': '第二条待同步',
      };
      harness.store.boxes['mobile-chat:second'] = GeneralChatOutbox(
        sourceSessionId: 'mobile-chat:second',
        conversationId: '',
        sourceEpoch: original.sourceEpoch,
        selectedModel: 'model',
        batches: [GeneralChatBatch(purpose: 'user', body: secondBody)],
      );
      final controller = harness.controller();
      addTearDown(controller.dispose);
      final count = harness.bodies.length;
      await controller.initialize();
      expect(controller.canSend, isFalse);
      expect(controller.recoverableSessions, hasLength(2));
      expect(controller.recoverableTitles.values, ['第一条待同步', '第二条待同步']);
      expect(harness.bodies, hasLength(count));
      await controller.initialize(recoverPending: false);
      expect(controller.canSend, isTrue);
      expect(harness.store.boxes, hasLength(2));
      expect(harness.modelCalls, 0);
    },
  );

  test(
    'model directory retries preserve transcript source and selected model without initialize',
    () async {
      final harness = _Harness();
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      await controller.send('目录刷新');
      await controller.replyCompleted;
      final ids = controller.messages.map((row) => row.id).toList();
      final sid = controller.sourceSessionId;
      harness.catalogFailure = const ApiFailure('目录暂时断网', status: 503);
      await controller.refreshModels();
      expect(controller.modelError, '目录暂时断网');
      harness.catalogFailure = null;
      await controller.refreshModels();
      expect(controller.modelError, isEmpty);
      expect(controller.error, isEmpty);
      expect(controller.selectedModel, 'model');
      expect(controller.sourceSessionId, sid);
      expect(controller.messages.map((row) => row.id), ids);
      expect(harness.modelCalls, 1);
    },
  );

  test(
    'older model directory response cannot restore a removed choice',
    () async {
      final harness = _Harness();
      final controller = harness.controller();
      addTearDown(controller.dispose);
      await controller.initialize();
      final old = Completer<Map<String, dynamic>>();
      harness.pendingCatalog = old.future;
      final stale = controller.refreshModels();
      harness.pendingCatalog = null;
      await controller.refreshModels();
      old.complete({
        'providers': [
          {'id': 'p', 'kind': 'openai-compat'},
        ],
        'usable': [
          {'name': 'removed', 'providerId': 'p'},
        ],
      });
      await stale;
      expect(controller.models.map((row) => row.name), ['model', 'unknown']);
      expect(controller.selectedModel, 'model');
    },
  );

  test('stop during ticket preparation never invokes paid endpoint', () async {
    final harness = _Harness();
    final pending = Completer<Map<String, dynamic>>();
    harness.pendingConfig = pending.future;
    final controller = harness.controller();
    addTearDown(controller.dispose);
    await controller.initialize();
    expect(await controller.send('启动前停止'), isTrue);
    final stopping = controller.stop();
    pending.complete({'ok': true, 'key': 'fixture-ticket', 'model': 'model'});
    await stopping;
    expect(harness.modelCalls, 0);
    expect(harness.bodies.last['state'], 'stopped');
    expect(controller.messages.single.role, 'user');
  });
  for (final status in [404, 405]) {
    test(
      'legacy missing projection $status keeps durable device chat and later syncs without another model call',
      () async {
        final harness = _Harness()
          ..publishFailure = ApiFailure('old service', status: status);
        final chat = harness.controller();
        await chat.initialize();
        expect(await chat.send('第一问'), isTrue);
        await chat.replyCompleted;
        expect(chat.syncUnavailable, isTrue);
        expect(chat.error, isEmpty);
        expect(chat.hasPending, isTrue);
        expect(chat.messages.map((r) => r.role), ['user', 'assistant']);
        expect(await chat.send('继续第二问'), isTrue);
        await chat.replyCompleted;
        expect(harness.modelCalls, 2);
        expect(harness.contexts.last.map((r) => r['role']), [
          'user',
          'assistant',
          'user',
        ]);
        expect(harness.store.boxes.values.single.batches, hasLength(1));
        expect(chat.messages.map((r) => r.position), [0, 1, 2, 3]);
        final id = chat.sourceSessionId;
        chat.dispose();
        final restored = harness.controller();
        addTearDown(restored.dispose);
        await restored.initialize(sourceSessionId: id);
        expect(restored.messages, hasLength(4));
        expect(harness.modelCalls, 2);
        harness.publishFailure = null;
        await restored.retryPending();
        expect(restored.syncUnavailable, isFalse);
        expect(restored.hasPending, isFalse);
        expect(harness.remote, hasLength(4));
        expect(harness.modelCalls, 2);
        expect(harness.store.boxes, isEmpty);
      },
    );
  }
  for (final status in [401, 403, 409, 503]) {
    test(
      'HTTP $status never enables legacy mode or invokes the model',
      () async {
        final harness = _Harness()
          ..publishFailure = ApiFailure('fixture failure', status: status);
        final chat = harness.controller();
        addTearDown(chat.dispose);
        await chat.initialize();
        await chat.send('不能绕过的请求');
        await chat.replyCompleted;
        expect(chat.syncUnavailable, isFalse);
        expect(harness.modelCalls, 0);
        expect(chat.hasPending, isTrue);
      },
    );
  }
  test(
    'legacy streaming checkpoints preserve partial text in one valid outbox batch',
    () async {
      final harness = _Harness()
        ..publishFailure = const ApiFailure('old service', status: 405)
        ..reply = StreamController<String>();
      final chat = harness.controller(
        checkpoint: const Duration(milliseconds: 10),
      );
      addTearDown(chat.dispose);
      await chat.initialize();
      await chat.send('保存流式进度');
      await _tick();
      final checkpointWritten = Completer<void>();
      harness.store.onWrite = (box) {
        if (!checkpointWritten.isCompleted &&
            box.batches.any(
              (batch) => batch.messages.any((row) => row.role == 'assistant'),
            )) {
          checkpointWritten.complete();
        }
      };
      harness.reply!.add('第一段');
      await checkpointWritten.future.timeout(const Duration(seconds: 5));
      expect(
        harness.store.boxes.values.single.batches.single.messages.last.text,
        '第一段',
      );
      harness.reply!.add('第二段');
      await harness.reply!.close();
      await chat.replyCompleted;
      expect(chat.messages.last.text, '第一段第二段');
      expect(harness.modelCalls, 1);
    },
  );
}

Future<void> _tick() => Future<void>.delayed(Duration.zero);
const _scope = GeneralChatScope(
  endpoint: 'https://hub.test',
  ownerId: 'owner',
  deviceId: 'device',
);

class _MemoryStore extends GeneralChatStore {
  final boxes = <String, GeneralChatOutbox>{};
  void Function(GeneralChatOutbox)? onWrite;
  bool failWrite = false, failRemove = false;
  @override
  Future<List<String>> pendingSessions(GeneralChatScope scope) async =>
      boxes.keys.toList();
  @override
  Future<GeneralChatOutbox?> read(
    GeneralChatScope scope,
    String session,
  ) async => boxes[session];
  @override
  Future<void> write(GeneralChatScope scope, GeneralChatOutbox box) async {
    if (failWrite) {
      throw StateError('fixture storage failure');
    }
    boxes[box.sourceSessionId] = GeneralChatOutbox.fromJson(box.toJson());
    onWrite?.call(boxes[box.sourceSessionId]!);
  }

  @override
  Future<void> remove(GeneralChatScope scope, String session) async {
    if (failRemove) {
      throw StateError('fixture storage deletion failure');
    }
    boxes.remove(session);
  }
}

class _Harness {
  final store = _MemoryStore();
  final bodies = <Map<String, dynamic>>[];
  final contexts = <List<Map<String, dynamic>>>[];
  final events = <String>[];
  final remote = <String, Map<String, dynamic>>{};
  final receipts = <int, String>{};
  bool current = true;
  int modelCalls = 0,
      configCalls = 0,
      transportAborts = 0,
      revision = 0,
      messageClock = 0;
  ApiFailure? publishFailure;
  Future<void> Function(Map<String, dynamic>)? beforePublish;
  Future<Map<String, dynamic>>? pendingConfig;
  Future<Map<String, dynamic>>? pendingCatalog;
  ApiFailure? catalogFailure;
  Map<String, dynamic> config = {
    'ok': true,
    'key': 'fixture-ticket',
    'model': 'model',
  };
  Map<String, dynamic>? sourceOverride;
  StreamController<String>? reply;
  Map<String, dynamic>? head;
  Map<String, dynamic> get metadata => {
    'id': 'cid',
    'sourceClientId': 'device',
    'sourceSessionId': head?['sourceSessionId'] ?? 'mobile-chat:fixture',
    'title': head?['title'] ?? '会话',
    'state': head?['state'] ?? 'completed',
    'deleted': false,
    ...?sourceOverride,
  };
  GeneralChatController controller({
    Duration checkpoint = const Duration(seconds: 1),
  }) => GeneralChatController(
    scope: _scope,
    scopeKey: 'fixture-owner-device',
    isCurrent: () => current,
    store: store,
    checkpointInterval: checkpoint,
    loadModels: () async {
      if (catalogFailure != null) {
        throw catalogFailure!;
      }
      if (pendingCatalog != null) {
        return pendingCatalog!;
      }
      return {
        'defaultModel': 'model',
        'providers': [
          {'id': 'p', 'kind': 'openai-compat'},
        ],
        'usable': [
          {'name': 'model', 'label': '模型', 'providerId': 'p'},
          {'name': 'unknown', 'providerId': 'unknown'},
        ],
      };
    },
    loadConfig: (model) async {
      configCalls++;
      return pendingConfig ?? Future.value(config);
    },
    publish: (body) async {
      events.add('publish');
      bodies.add(jsonDecode(jsonEncode(body)) as Map<String, dynamic>);
      if (publishFailure != null) {
        throw publishFailure!;
      }
      await beforePublish?.call(body);
      final rev = body['sourceRevision'] as int;
      final digest = jsonEncode(body);
      if (receipts[rev] != null) {
        if (receipts[rev] != digest) {
          throw const ApiFailure('版本冲突', status: 409);
        }
      } else {
        if (rev != revision + 1) {
          throw const ApiFailure('版本不连续', status: 409);
        }
        receipts[rev] = digest;
        revision = rev;
        head = body;
        for (final raw in body['messages'] as List) {
          final row = Map<String, dynamic>.from(raw as Map);
          if (remote[row['id']]?['text'] != row['text']) {
            messageClock++;
            remote[row['id'] as String] = {...row, 'revision': messageClock};
          }
        }
      }
      return {
        'ok': true,
        'conversationId': 'cid',
        'sourceRevision': rev,
        'revision': rev,
      };
    },
    loadSource: (cid) async {
      events.add('source');
      return {
        'conversation': metadata,
        'sourceEpoch': head?['sourceEpoch'] ?? 'fixture-epoch',
        'sourceRevision': revision > 0 ? revision : 1,
      };
    },
    loadMessages: (cid, after) async {
      events.add('messages');
      final rows =
          remote.values
              .where((row) => (row['revision'] as int) > after)
              .toList()
            ..sort(
              (a, b) => (a['revision'] as int).compareTo(b['revision'] as int),
            );
      return {
        'conversation': metadata,
        'items': rows,
        'cursor': rows.isEmpty ? after : rows.last['revision'],
        'hasMore': false,
      };
    },
    onConversationSaved: (cid) {
      events.add('saved');
    },
    transportFactory: () => _ReplyTransport(this),
  );
}

class _ReplyTransport extends GeneralChatTransport {
  final _Harness harness;
  bool stopped = false;
  _ReplyTransport(this.harness);
  @override
  Stream<String> stream({
    required String endpoint,
    required String ticket,
    required String model,
    required List<Map<String, dynamic>> messages,
    int maxTokens = 4096,
  }) async* {
    harness.modelCalls++;
    harness.contexts.add(messages);
    yield* harness.reply?.stream ?? Stream.value('测试回答');
    if (stopped) {
      throw const GeneralChatTransportFailure(
        'fixture stopped',
        code: 'stopped',
      );
    }
  }

  @override
  void abort() {
    stopped = true;
    harness.transportAborts++;
    if (harness.reply != null) unawaited(harness.reply!.close());
  }
}

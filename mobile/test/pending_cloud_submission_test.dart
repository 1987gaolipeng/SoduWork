import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:image_picker/image_picker.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

void main() {
  test(
    'initial acceptance must match the durable receipt before clearing it',
    () async {
      final store = _CheckpointStore();
      final state = await _state(store);
      addTearDown(state.dispose);
      final request = await _request();
      await state.rememberCloudRequest(request);
      final api = _setApi(state, store, _receipt(request));
      for (final change in [
        {'phase': 'prepared'},
        {'phase': 'committing'},
        {'phase': 'aborted'},
        {'ref': ''},
        {'taskId': ''},
        {'ok': false},
        {'transferId': 'another-request'},
        {
          'source': {
            'entryKind': 'cloud',
            'sessionId': 'another-session',
            'adapterId': 'pi',
          },
        },
        {
          'source': {
            'entryKind': 'cloud',
            'sessionId': request.options['sessionId'],
            'adapterId': 'other',
          },
        },
      ]) {
        api.receipt = {..._receipt(request), ...change};
        await expectLater(
          state.startCloudConversation(text: '保密正文', request: request),
          throwsA(
            isA<ApiFailure>().having(
              (e) => e.isNetwork,
              'uncertain acceptance',
              isTrue,
            ),
          ),
        );
        expect(state.pendingCloudRequest?.id, request.id);
        expect(jsonDecode(store.values.values.single)['id'], request.id);
      }
      api.receipt = _receipt(request);
      await state.startCloudConversation(text: '保密正文', request: request);
      expect(state.pendingCloudRequest, isNull);
      expect(store.values, isEmpty);
    },
  );

  test(
    'reopen keeps only submission identity, never draft or attachment bytes',
    () async {
      final store = _CheckpointStore();
      final first = await _state(store);
      final request = await _request();
      await first.rememberCloudRequest(request);
      final encoded = store.values.values.single;
      expect(encoded.length, lessThan(512));
      expect(encoded, isNot(contains('保密正文')));
      expect(encoded, isNot(contains('private.txt')));
      expect(
        jsonDecode(encoded).keys,
        unorderedEquals(['kind', 'version', 'id', 'sessionId', 'agentId']),
      );
      first.dispose();
      final restored = await _state(store);
      addTearDown(restored.dispose);
      await restored.restorePendingBranch();
      final recovered = restored.pendingCloudRequest!;
      expect(recovered.id, request.id);
      expect(recovered.receiptOnly, isTrue);
      expect(recovered.options.containsKey('text'), isFalse);
      expect(recovered.files, isEmpty);
      final api = _setApi(restored, store, _receipt(request));
      await expectLater(
        restored.startCloudConversation(text: 'other', request: recovered),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        restored.rememberCloudRequest(await _request()),
        throwsA(isA<ApiFailure>()),
      );
      expect(api.postCalls, 0);
      for (final changes in [
        {'owner': 'other'},
        {'device': 'other'},
        {'url': 'http://other.test'},
      ]) {
        final other = await _state(
          store,
          owner: changes['owner'] ?? 'owner',
          device: changes['device'] ?? 'device',
          url: changes['url'] ?? 'http://unit.test',
        );
        addTearDown(other.dispose);
        await other.restorePendingBranch();
        expect(other.pendingCloudRequest, isNull);
      }
    },
  );

  test(
    'ordinary checkpoint cannot smuggle replay payloads or different sessions',
    () async {
      final request = await _request();
      for (final mutation in [
        {'sessionId': 'mobile:other'},
        {'version': 2},
        {'text': 'replay'},
        {'agentId': 'runner:private:pi'},
        {'id': '../other'},
      ]) {
        expect(
          () => CloudConversationRequest.restoreCheckpoint({
            ...request.checkpoint(),
            ...mutation,
          }),
          throwsFormatException,
        );
      }
      final branch = CloudConversationRequest.accountBranch(
        conversationId: 'source',
        revision: 1,
        text: '继续',
        agentId: 'pi',
      );
      final restored = CloudConversationRequest.restoreCheckpoint(
        branch.checkpoint(),
      );
      expect(restored.options, branch.options);
      expect(restored.receiptOnly, isFalse);
    },
  );

  test(
    'committed original receipt recovers task and clears checkpoint with GET only',
    () async {
      final store = _CheckpointStore();
      final state = await _state(store);
      addTearDown(state.dispose);
      final request = await _request();
      await state.rememberCloudRequest(request);
      final api = _setApi(state, store, _receipt(request));
      var notices = 0;
      state.addListener(() => notices++);
      final receipt = await state.reconcilePendingCloudRequest();
      expect(receipt['taskId'], 'accepted-task');
      expect(api.checkedIds, [request.id]);
      expect(api.postCalls, 0);
      expect(state.pendingCloudRequest, isNull);
      expect(store.values, isEmpty);
      expect(notices, greaterThan(0));
    },
  );

  test(
    '404, uncertain, mismatched and unfinished receipts retain original identity',
    () async {
      final store = _CheckpointStore();
      final state = await _state(store);
      addTearDown(state.dispose);
      final request = await _request();
      await state.rememberCloudRequest(request);
      final api = _setApi(state, store, _receipt(request));
      for (final error in [
        const ApiFailure('not found', status: 404),
        const ApiFailure('forbidden', status: 403),
        const ApiFailure('timeout', isNetwork: true),
      ]) {
        api.error = error;
        await expectLater(
          state.reconcilePendingCloudRequest(),
          throwsA(isA<ApiFailure>()),
        );
        expect(state.pendingCloudRequest!.id, request.id);
        expect(store.values, isNotEmpty);
      }
      api.error = null;
      for (final change in [
        {'transferId': 'other'},
        {
          'source': {'sessionId': 'other'},
        },
        {'phase': 'committing'},
        {'phase': 'aborted'},
        {'ref': ''},
        {'taskId': ''},
      ]) {
        api.receipt = {..._receipt(request), ...change};
        await expectLater(
          state.reconcilePendingCloudRequest(),
          throwsA(isA<ApiFailure>()),
        );
        expect(state.pendingCloudRequest!.id, request.id);
        expect(store.values, isNotEmpty);
      }
      expect(api.postCalls, 0);
    },
  );

  test(
    'disposal while receipt is in flight cannot clear durable identity',
    () async {
      final store = _CheckpointStore();
      final state = await _state(store);
      final request = await _request();
      await state.rememberCloudRequest(request);
      final api = _setApi(state, store, _receipt(request));
      api.waiter = Completer<Map<String, dynamic>>();
      final operation = state.reconcilePendingCloudRequest();
      await Future<void>.delayed(Duration.zero);
      state.dispose();
      api.waiter!.complete(_receipt(request));
      await expectLater(operation, throwsA(isA<ApiFailure>()));
      expect(store.values, isNotEmpty);
    },
  );

  test(
    'a new composer cannot overwrite an unrestored durable submission',
    () async {
      final store = _CheckpointStore();
      final first = await _state(store);
      final original = await _request();
      await first.rememberCloudRequest(original);
      first.dispose();
      final second = await _state(store);
      addTearDown(second.dispose);
      await expectLater(
        second.rememberCloudRequest(await _request()),
        throwsA(isA<ApiFailure>()),
      );
      expect(second.pendingCloudRequest!.id, original.id);
      expect(jsonDecode(store.values.values.single)['id'], original.id);
    },
  );

  test(
    'failed checkpoint write rejects ordinary dispatch without forgetting data',
    () async {
      final store = _CheckpointStore()..failWrite = true;
      final state = await _state(store);
      addTearDown(state.dispose);
      await expectLater(
        state.rememberCloudRequest(await _request()),
        throwsStateError,
      );
      expect(state.pendingCloudRequest, isNull);
    },
  );
}

Future<CloudConversationRequest> _request() => CloudConversationRequest.prepare(
  text: '保密正文',
  agentId: 'pi',
  files: [
    XFile.fromData(
      Uint8List.fromList([1, 2, 3]),
      name: 'private.txt',
      path: 'private.txt',
    ),
  ],
);

Map<String, dynamic> _receipt(CloudConversationRequest request) => {
  'ok': true,
  'transferId': request.id,
  'phase': 'committed',
  'taskId': 'accepted-task',
  'ref': 'authorized-ref',
  'source': {
    'entryKind': 'cloud',
    'sessionId': request.options['sessionId'],
    'adapterId': request.options['agentId'],
  },
};

Future<MobileState> _state(
  _CheckpointStore store, {
  String owner = 'owner',
  String device = 'device',
  String url = 'http://unit.test',
}) async {
  final state = MobileState(
    store: store,
    initialEndpoint: EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: url,
    ),
  );
  await state.init(connectNow: false);
  state.phase = MobilePhase.ready;
  state.enrollment = EnrollmentState(
    active: true,
    deviceId: device,
    deviceName: 'Fixture',
    authState: 'active',
    ownerUserId: owner,
  );
  return state;
}

_ReceiptApi _setApi(
  MobileState state,
  DeviceStore store,
  Map<String, dynamic> receipt,
) {
  state.api.client.close();
  final api = _ReceiptApi(store, receipt);
  state.api = api;
  return api;
}

class _CheckpointStore extends DeviceStore {
  final values = <String, String>{};
  bool failWrite = false;
  @override
  Future<void> init() async {}
  @override
  Future<String?> readPendingBranch(
    String endpoint,
    String owner,
    String deviceId,
  ) async => values['$endpoint:$owner:$deviceId'];
  @override
  Future<void> writePendingBranch(
    String endpoint,
    String owner,
    String deviceId,
    String? value,
  ) async {
    if (failWrite) throw StateError('write failed');
    final key = '$endpoint:$owner:$deviceId';
    if (value == null) {
      values.remove(key);
    } else {
      values[key] = value;
    }
  }
}

class _ReceiptApi extends SoduWorkApi {
  Map<String, dynamic> receipt;
  ApiFailure? error;
  Completer<Map<String, dynamic>>? waiter;
  int postCalls = 0;
  final checkedIds = <String>[];
  _ReceiptApi(DeviceStore store, this.receipt)
    : super(
        store: store,
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://unit.test',
        ),
        client: MockClient((_) async => throw StateError('unexpected HTTP')),
      );
  @override
  Future<Map<String, dynamic>> cloudConversationReceipt(
    String requestId,
  ) async {
    checkedIds.add(requestId);
    if (error != null) throw error!;
    return waiter == null ? receipt : await waiter!.future;
  }

  @override
  Future<Map<String, dynamic>> createCloudConversation({
    required String text,
    String agentId = '',
    String targetRunnerId = '',
    String targetRunnerKind = '',
    String model = '',
    String title = '',
    dynamic files = const [],
    CloudConversationRequest? request,
  }) async {
    postCalls++;
    return receipt;
  }

  @override
  Future<List<Map<String, dynamic>>> cloudConversations() async => [];
}

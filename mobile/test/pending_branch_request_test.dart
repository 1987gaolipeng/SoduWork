import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';

void main() {
  test(
    'refresh restores only this Hub, owner and device frozen request',
    () async {
      final store = _BranchStore();
      final first = await _state(store);
      final request = _request();
      await first.rememberCloudRequest(request);
      first.dispose();
      final restored = await _state(store);
      addTearDown(restored.dispose);
      await restored.restorePendingBranch();
      expect(restored.pendingCloudRequest!.id, request.id);
      expect(restored.pendingCloudRequest!.options, request.options);
      final other = await _state(store, owner: 'other');
      addTearDown(other.dispose);
      await other.restorePendingBranch();
      expect(other.pendingCloudRequest, isNull);
      await restored.forgetCloudRequest('unrelated-request');
      expect(restored.pendingCloudRequest!.id, request.id);
      await restored.forgetCloudRequest(request.id);
      expect(store.values, isEmpty);
    },
  );

  test(
    'parallel composers cannot replace or clear a different pending request',
    () async {
      final state = await _state(_BranchStore());
      addTearDown(state.dispose);
      final one = _request();
      final two = _request();
      final first = state.rememberCloudRequest(one);
      final second = state.rememberCloudRequest(two);
      await first;
      await expectLater(second, throwsA(isA<ApiFailure>()));
      await state.forgetCloudRequest(two.id);
      expect(state.pendingCloudRequest, same(one));
    },
  );

  test('failed durable save never replaces the pending request', () async {
    final store = _BranchStore()..failWrite = true;
    final state = await _state(store);
    addTearDown(state.dispose);
    await expectLater(state.rememberCloudRequest(_request()), throwsStateError);
    expect(state.pendingCloudRequest, isNull);
    expect(store.values, isEmpty);
  });

  test(
    'malformed checkpoint blocks dispatch without discarding its identity',
    () async {
      final store = _BranchStore();
      final state = await _state(store);
      addTearDown(state.dispose);
      store.values[store.key('http://unit.test', 'owner', 'device')] =
          '{malformed';
      await state.restorePendingBranch();
      expect(state.pendingRequestError, isNotEmpty);
      await expectLater(
        state.rememberCloudRequest(_request()),
        throwsA(isA<ApiFailure>()),
      );
      expect(store.values.values.single, '{malformed');
    },
  );

  test(
    'mismatched aborted receipt remains uncertain and retains checkpoint',
    () async {
      final store = _BranchStore();
      final state = await _state(store);
      addTearDown(state.dispose);
      final request = _request();
      await state.rememberCloudRequest(request);
      state.api.client.close();
      state.api = _ReceiptApi(store, {
        'ok': true,
        'phase': 'aborted',
        'transferId': 'someone-else',
      });
      await expectLater(
        state.startCloudConversation(text: 'ignored', request: request),
        throwsA(
          isA<ApiFailure>().having(
            (error) => error.isNetwork,
            'uncertain',
            isTrue,
          ),
        ),
      );
      expect(state.pendingCloudRequest, same(request));
      expect(jsonDecode(store.values.values.single)['id'], request.id);
    },
  );

  test(
    'only a matching committed receipt clears durable branch checkpoint',
    () async {
      final store = _BranchStore();
      final state = await _state(store);
      addTearDown(state.dispose);
      final request = _request();
      await state.rememberCloudRequest(request);
      state.api.client.close();
      final api = _ReceiptApi(store, {
        'ok': true,
        'phase': 'committing',
        'taskId': 'task',
        'ref': '',
        'transferId': request.id,
        'sessionId': 'cloud-${request.id}',
        'branch': {'accountConversationId': 'source', 'expectedRevision': 3},
      });
      state.api = api;
      await expectLater(
        state.startCloudConversation(text: 'ignored', request: request),
        throwsA(
          isA<ApiFailure>().having(
            (error) => error.isNetwork,
            'uncertain',
            isTrue,
          ),
        ),
      );
      expect(state.pendingCloudRequest, same(request));
      api.receipt['phase'] = 'committed';
      api.receipt['ref'] = 'authorized-ref';
      await state.startCloudConversation(text: 'ignored', request: request);
      expect(state.pendingCloudRequest, isNull);
      expect(store.values, isEmpty);
    },
  );
}

CloudConversationRequest _request() => CloudConversationRequest.accountBranch(
  conversationId: 'source',
  revision: 3,
  text: '继续整理',
  agentId: 'pi',
);

Future<MobileState> _state(_BranchStore store, {String owner = 'owner'}) async {
  final state = MobileState(
    store: store,
    initialEndpoint: const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'http://unit.test',
    ),
  );
  await state.init(connectNow: false);
  state.phase = MobilePhase.ready;
  state.enrollment = EnrollmentState(
    active: true,
    deviceId: 'device',
    deviceName: 'Fixture',
    authState: 'active',
    ownerUserId: owner,
  );
  return state;
}

class _BranchStore extends DeviceStore {
  final values = <String, String>{};
  bool failWrite = false;
  String key(String endpoint, String owner, String device) =>
      '$endpoint:$owner:$device';
  @override
  Future<void> init() async {}
  @override
  Future<String?> readPendingBranch(
    String endpoint,
    String owner,
    String deviceId,
  ) async => values[key(endpoint, owner, deviceId)];
  @override
  Future<void> writePendingBranch(
    String endpoint,
    String owner,
    String deviceId,
    String? value,
  ) async {
    if (failWrite) throw StateError('fixture storage failure');
    final id = key(endpoint, owner, deviceId);
    if (value == null) {
      values.remove(id);
    } else {
      values[id] = value;
    }
  }
}

class _ReceiptApi extends SoduWorkApi {
  final Map<String, dynamic> receipt;
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
  Future<Map<String, dynamic>> createCloudConversation({
    required String text,
    String agentId = '',
    String targetRunnerId = '',
    String targetRunnerKind = '',
    String model = '',
    String title = '',
    dynamic files = const [],
    CloudConversationRequest? request,
  }) async => receipt;
  @override
  Future<List<Map<String, dynamic>>> cloudConversations() async => [];
}

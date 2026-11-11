import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/conversation_acceptance.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'memory_device_auth.dart';

class Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture';
}

class StateFixture extends MobileState {
  @override
  Future<void> refreshAll() async {}
}

void main() {
  late StateFixture state;
  late ConversationAcceptance service;
  late Map<String, dynamic> packet;
  late List<http.Request> writes;
  bool current = true;
  setUp(() {
    current = true;
    packet = {
      'approvalId': 'approval-1',
      'artifactVersionId': 'v1',
      'requirementVersion': 1,
      'canDecide': true,
      'readiness': {'canApprove': true},
    };
    writes = [];
    state = StateFixture();
    state.api = SoduWorkApi(
      store: Store(),
      endpoint: const EndpointSettings(
        baseUrl: 'https://hub.test',
        environment: SoduWorkEnvironment.development,
      ),
      client: MockClient((request) async {
        Object body;
        if (request.method != 'GET') {
          writes.add(request);
          body = {'ok': true};
        } else if (request.url.path.endsWith('/acceptance-context')) {
          body = packet;
        } else {
          body = {
            'id': 't',
            'kind': 'requirement',
            'status': 'doing',
            'requirementStage': 'reviewing',
          };
        }
        return http.Response(
          jsonEncode(body),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    service = ConversationAcceptance(state, () {
      if (!current) throw const ApiFailure('account changed');
    });
  });
  tearDown(() => state.dispose());
  Future<Map> load() async =>
      await service.call('t', {'action': 'load'}) as Map;

  test(
    'formal decisions use approval identity and cannot be submitted twice',
    () async {
      final shown = await load();
      expect(shown['available'], true);
      await service.call('t', {
        'action': 'approve',
        'version': shown['version'],
      });
      expect(writes.single.url.path, '/api/v1/approvals/approval-1/decision');
      expect(jsonDecode(writes.single.body)['decision'], 'approve');
      await expectLater(
        service.call('t', {'action': 'approve', 'version': shown['version']}),
        throwsA(isA<ApiFailure>()),
      );
      expect(writes.length, 1);
    },
  );
  test('direct review uses task endpoint', () async {
    packet['approvalId'] = 'direct:t';
    final shown = await load();
    await service.call('t', {'action': 'approve', 'version': shown['version']});
    expect(writes.single.url.path, '/api/v1/tasks/t/review');
  });
  test('polling a new version never authorizes an old rendered card', () async {
    final shown = await load();
    packet['artifactVersionId'] = 'v2';
    await load();
    await expectLater(
      service.call('t', {'action': 'approve', 'version': shown['version']}),
      throwsA(isA<ApiFailure>()),
    );
    expect(writes, isEmpty);
  });
  test(
    'revoked permission, missing evidence and account changes prevent decisions',
    () async {
      final shown = await load();
      packet['canDecide'] = false;
      await expectLater(
        service.call('t', {'action': 'approve', 'version': shown['version']}),
        throwsA(isA<ApiFailure>()),
      );
      packet['canDecide'] = true;
      packet['readiness'] = {'canApprove': false};
      await expectLater(
        service.call('t', {'action': 'approve', 'version': shown['version']}),
        throwsA(isA<ApiFailure>()),
      );
      current = false;
      await expectLater(
        service.call('t', {
          'action': 'reject',
          'version': shown['version'],
          'note': 'fix',
        }),
        throwsA(isA<ApiFailure>()),
      );
      expect(writes, isEmpty);
    },
  );
  test(
    'reject requires feedback and disallows foreign rework attachments',
    () async {
      final shown = await load();
      await expectLater(
        service.call('t', {'action': 'reject', 'version': shown['version']}),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        service.call('t', {
          'action': 'reject',
          'version': shown['version'],
          'note': 'fix',
          'attachmentIds': ['foreign'],
        }),
        throwsA(isA<ApiFailure>()),
      );
      expect(writes, isEmpty);
      await service.call('t', {
        'action': 'reject',
        'version': shown['version'],
        'note': 'fix',
      });
      expect(jsonDecode(writes.single.body)['decision'], 'reject');
    },
  );
}

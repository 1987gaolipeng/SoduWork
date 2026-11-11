import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/screens/approval_detail_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/task_lifecycle.dart';

import 'memory_device_auth.dart';

const _task = {
  'id': 'task',
  'title': 'Current task',
  'status': 'doing',
  'handler': 'auto',
};

void main() {
  for (final source in ['trace', 'detail', 'legacy', 'summary', 'mismatch']) {
    testWidgets(
      'approval loads lifecycle from $source without losing AI state',
      (tester) async {
        final paths = <String>[];
        final state = _state(
          MockClient((request) async {
            paths.add(request.url.path);
            if (request.url.path == '/api/v1/approvals/approval') {
              return _json({
                'item': {
                  'id': 'approval',
                  'status': 'approved',
                  'task': source == 'detail'
                      ? _task
                      : {'id': 'task', 'title': 'Summary only'},
                },
                if (source != 'legacy')
                  'trace': {
                    'task': switch (source) {
                      'trace' => _task,
                      'mismatch' => {..._task, 'id': 'other-task'},
                      _ => {'id': 'task'},
                    },
                  },
              });
            }
            if (request.url.path == '/api/v1/tasks/task/trace') {
              return _json({'task': _task});
            }
            if (request.url.path == '/api/v1/tasks/task') return _json(_task);
            return _json({'detail': 'Unexpected request'}, 500);
          }),
        );
        addTearDown(state.api.client.close);
        addTearDown(state.dispose);
        await tester.pumpWidget(_app(state));
        await tester.pumpAndSettle();

        expect(paths, [
          '/api/v1/approvals/approval',
          if (source == 'legacy') '/api/v1/tasks/task/trace',
          if (source == 'summary' || source == 'mismatch') '/api/v1/tasks/task',
        ]);
        final panel = tester.widget<TaskLifecyclePanel>(
          find.byType(TaskLifecyclePanel),
        );
        expect(panel.task.id, 'task');
        expect(panel.task.isAi, isTrue);
        expect(panel.task.title, 'Current task');
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('missing lifecycle data does not bypass a denied task read', (
    tester,
  ) async {
    final paths = <String>[];
    final state = _state(
      MockClient((request) async {
        paths.add(request.url.path);
        if (request.url.path == '/api/v1/approvals/approval') {
          return _json({
            'item': {
              'id': 'approval',
              'status': 'pending',
              'task': {'id': 'task'},
            },
            'trace': {
              'task': {'id': 'task'},
            },
          });
        }
        return _json({'detail': '无权读取此任务'}, 403);
      }),
    );
    addTearDown(state.api.client.close);
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(state));
    await tester.pumpAndSettle();

    expect(paths, ['/api/v1/approvals/approval', '/api/v1/tasks/task']);
    expect(find.text('无权读取此任务'), findsOneWidget);
    expect(find.byType(TaskLifecyclePanel), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

http.Response _json(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

MobileState _state(http.Client client) {
  final store = _Store();
  return MobileState(store: store)
    ..api = SoduWorkApi(
      store: store,
      endpoint: const EndpointSettings(
        baseUrl: 'https://fixture.test',
        environment: SoduWorkEnvironment.development,
      ),
      client: client,
    );
}

Widget _app(MobileState state) => MobileScope(
  state: state,
  child: MaterialApp(
    theme: SoduWorkTheme.light(),
    home: const ApprovalDetailScreen(approvalId: 'approval'),
  ),
);

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
}

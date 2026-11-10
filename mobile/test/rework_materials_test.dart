import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image_picker/image_picker.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/approval_detail_screen.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/requirement_acceptance_card.dart';
import 'package:soduwork_mobile/ui/rework_materials.dart';
import 'memory_device_auth.dart';

XFile file(String name) =>
    XFile.fromData(Uint8List.fromList([1, 2]), name: name, path: name);
Map<String, dynamic> receipt(String id, String scope) => {
  'ok': true,
  'attachment': {'id': id, 'role': 'rework_input', 'sourceRef': scope},
};
Map<String, dynamic> contextPacket() => {
  'approvalId': 'direct:t',
  'canDecide': true,
  'artifactVersionId': 'v1',
  'requirementVersion': 1,
  'criteria': [],
  'attachments': [],
};
http.Response response(Object data) => http.Response(
  jsonEncode(data),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Widget app(MobileState state, Widget child, {bool scroll = true}) =>
    MobileScope(
      state: state,
      child: MaterialApp(
        theme: SoduWorkTheme.light(),
        home: Scaffold(
          body: scroll ? SingleChildScrollView(child: child) : child,
        ),
      ),
    );
void main() {
  test('disposing during file stat cannot publish a late selection', () async {
    final controller = ReworkMaterialsController();
    final delayed = Completer<int>();
    final pending = controller.add([_DelayedFile(delayed.future)]);
    controller.dispose();
    delayed.complete(2);
    await pending;
    expect(controller.files, isEmpty);
  });
  test(
    'overlapping selections cannot exceed the aggregate file limit',
    () async {
      final controller = ReworkMaterialsController();
      addTearDown(controller.dispose);
      final delayed = Completer<int>();
      final pending = controller.add([_DelayedFile(delayed.future)]);
      await controller.add(List.generate(20, (_) => file('current')));
      delayed.complete(2);
      await pending;
      expect(controller.files.length, 20);
    },
  );

  test(
    'partial uploads retry only missing files and preserve exact IDs',
    () async {
      final controller = ReworkMaterialsController();
      addTearDown(controller.dispose);
      await controller.add([file('same.txt'), file('same.txt')]);
      int sent = 0;
      Future<Map<String, dynamic>> upload(XFile _) async {
        sent++;
        if (sent == 2) throw const ApiFailure('network');
        return receipt('id-$sent', 'task-rework:t');
      }

      await expectLater(
        controller.upload(
          sourceRef: 'task-rework:t',
          send: upload,
          check: () {},
        ),
        throwsA(isA<ApiFailure>()),
      );
      final ids = await controller.upload(
        sourceRef: 'task-rework:t',
        send: upload,
        check: () {},
      );
      expect(ids, ['id-1', 'id-3']);
      expect(sent, 3);
      await expectLater(
        controller.upload(
          sourceRef: 'task-rework:other',
          send: upload,
          check: () {},
        ),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test('rejects wrong attachment role and foreign task scope', () async {
    final controller = ReworkMaterialsController();
    addTearDown(controller.dispose);
    await controller.add([file('a')]);
    await expectLater(
      controller.upload(
        sourceRef: 'task-rework:t',
        send: (_) async => receipt('a', 'approval-rework:a'),
        check: () {},
      ),
      throwsA(isA<ApiFailure>()),
    );
    expect(controller.files.single.attachmentId, isEmpty);
  });
  test(
    'empty files and over-limit selection are rejected atomically',
    () async {
      final controller = ReworkMaterialsController();
      addTearDown(controller.dispose);
      await expectLater(
        controller.add(List.generate(21, (_) => file('a'))),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        controller.add([
          file('ok'),
          XFile.fromData(Uint8List(0), name: 'empty'),
        ]),
        throwsA(isA<ApiFailure>()),
      );
      expect(controller.files, isEmpty);
    },
  );
  testWidgets('late file picker cannot add to a changed task', (tester) async {
    final controller = ReworkMaterialsController();
    addTearDown(controller.dispose);
    final picked = Completer<List<XFile>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ReworkMaterialsPicker(
            controller: controller,
            filePicker: () => picked.future,
          ),
        ),
      ),
    );
    await tester.tap(find.text('添加返修资料'));
    await tester.pump();
    controller.clear();
    picked.complete([file('old.txt')]);
    await tester.pumpAndSettle();
    expect(controller.files, isEmpty);
  });
  testWidgets(
    'creator rejection uploads and binds material only after submit',
    (tester) async {
      final seen = <http.Request>[];
      final state = _State(
        MockClient((request) async {
          seen.add(request);
          if (request.url.path.endsWith('/acceptance-context')) {
            return response(contextPacket());
          }
          if (request.url.path.endsWith('/rework-materials')) {
            return response(receipt('file-id', 'task-rework:t'));
          }
          return response({'ok': true});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        app(
          state,
          RequirementAcceptanceCard(
            task: WorkTask.fromJson({'id': 't', 'status': 'done'}),
            onChanged: () async {},
            onOpen: (_) {},
            filePicker: () async => [file('参考.txt')],
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('添加返修资料'));
      await tester.pumpAndSettle();
      expect(seen.where((r) => r.method == 'POST'), isEmpty);
      await tester.enterText(find.byType(TextField), '按资料补齐');
      await tester.ensureVisible(find.text('退回修改'));
      await tester.tap(find.text('退回修改'));
      await tester.pumpAndSettle();
      expect(
        seen.where((r) => r.url.path.endsWith('/rework-materials')).length,
        1,
      );
      final decision = seen.singleWhere(
        (r) => r.url.path.endsWith('/reject-artifact'),
      );
      expect(jsonDecode(decision.body)['reworkAttachmentIds'], ['file-id']);
    },
  );
  testWidgets(
    'approval rejection uses approval-specific material authorization',
    (tester) async {
      final seen = <http.Request>[];
      final item = {
        'id': 'approval',
        'action': 'review',
        'status': 'pending',
        'artifact': {'id': 'v1'},
        'task': {'id': 't', 'title': '验收'},
        'myDecision': {},
      };
      final state = _State(
        MockClient((request) async {
          seen.add(request);
          if (request.url.path.endsWith('/rework-materials')) {
            return response(receipt('proof', 'approval-rework:approval'));
          }
          if (request.url.path.endsWith('/decision')) {
            return response({'ok': true});
          }
          return response({
            'item': item,
            'trace': {
              'task': {'id': 't'},
            },
          });
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        app(
          state,
          ApprovalDetailScreen(
            approvalId: 'approval',
            filePicker: () async => [file('修订要求.txt')],
          ),
          scroll: false,
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('添加返修资料'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      // Center the picker above the fixed decision bar before tapping it.
      await Scrollable.ensureVisible(
        tester.element(find.text('添加返修资料')),
        alignment: 0.5,
      );
      await tester.pumpAndSettle();
      expect(find.text('添加返修资料').hitTestable(), findsOneWidget);
      await tester.tap(find.text('添加返修资料'));
      await tester.pumpAndSettle();
      expect(find.text('修订要求.txt'), findsOneWidget);
      await tester.tap(find.text('驳回'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '请按说明修改');
      await tester.tap(find.text('确认驳回'));
      await tester.pumpAndSettle();
      final decision = seen.singleWhere(
        (r) => r.url.path.endsWith('/decision'),
      );
      expect(decision.url.path, '/api/v1/approvals/approval/decision');
      expect(jsonDecode(decision.body)['reworkAttachmentIds'], ['proof']);
      expect(
        seen.where((r) => r.url.path.endsWith('/tasks/t/rework-materials')),
        isEmpty,
      );
    },
  );
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture';
}

class _State extends MobileState {
  _State(http.Client client) {
    api = SoduWorkApi(
      store: _Store(),
      endpoint: const EndpointSettings(
        baseUrl: 'https://hub.test',
        environment: SoduWorkEnvironment.development,
      ),
      client: client,
    );
  }
  @override
  Future<void> refreshAll() async {}
}

class _DelayedFile extends XFile {
  final Future<int> result;
  _DelayedFile(this.result) : super('delayed');
  @override
  Future<int> length() => result;
}

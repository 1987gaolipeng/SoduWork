import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/core/work_submission_store.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });
  WorkSubmission request(String id, [String instruction = '整理报告']) =>
      WorkSubmission(
        id: id,
        kind: 'workflow',
        label: '报告插件',
        payload: {
          'bindingId': 'binding-a',
          'inputs': {'copies': 0, 'publish': false},
          'instruction': instruction,
        },
      );
  test(
    'work outbox preserves immutable payload and original request across restart',
    () async {
      final store = WorkSubmissionStore();
      final value = request('request-a');
      final edited = value.payload;
      edited['instruction'] = '已改动';
      await store.save('hub:owner:device', value);
      final restored = await WorkSubmissionStore().load('hub:owner:device');
      expect(restored!.id, 'request-a');
      expect(restored.payload['instruction'], '整理报告');
      expect(restored.payload['inputs'], {'copies': 0, 'publish': false});
      expect(await store.load('hub:other:device'), isNull);
      expect(await store.load('hub:owner:other'), isNull);
      expect(await store.load('other:owner:device'), isNull);
    },
  );
  test(
    'outbox forbids replacing unknown work and clears only matching receipt',
    () async {
      final store = WorkSubmissionStore();
      await store.save('scope', request('first'));
      await store.save('scope', request('first'));
      await expectLater(
        store.save('scope', request('second')),
        throwsStateError,
      );
      await expectLater(
        store.save('scope', request('first', '不同内容')),
        throwsStateError,
      );
      await store.clear('scope', 'second');
      expect((await store.load('scope'))!.id, 'first');
      await store.clear('scope', 'first');
      expect(await store.load('scope'), isNull);
      await store.save('scope', request('second'));
      expect((await store.load('scope'))!.id, 'second');
    },
  );
  test(
    'concurrent windows in one process cannot replace the first durable request',
    () async {
      final store = WorkSubmissionStore();
      final a = store.save('serial', request('first'));
      final b = store.save('serial', request('second'));
      await a;
      await expectLater(b, throwsStateError);
      expect((await store.load('serial'))!.id, 'first');
    },
  );
  test('outbox rejects invalid request kind and route identifier', () {
    expect(
      () => WorkSubmission(
        id: '../bad',
        kind: 'workflow',
        label: '',
        payload: {},
      ),
      throwsFormatException,
    );
    expect(
      () => WorkSubmission(id: 'valid', kind: 'model', label: '', payload: {}),
      throwsFormatException,
    );
  });
}

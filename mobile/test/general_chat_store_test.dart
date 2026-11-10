import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:soduwork_mobile/core/general_chat_store.dart';
import 'package:soduwork_mobile/models/general_chat.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });
  test(
    'only pending batches persist, isolated by endpoint owner device and session',
    () async {
      final store = GeneralChatStore();
      const scope = GeneralChatScope(
        endpoint: 'https://hub.test',
        ownerId: 'owner',
        deviceId: 'device',
      );
      final box = _box();
      await store.write(scope, box);
      expect(await store.pendingSessions(scope), ['mobile-chat:fixture']);
      expect(
        (await GeneralChatStore().read(
          scope,
          box.sourceSessionId,
        ))!.batches.single.body,
        box.batches.single.body,
      );
      for (final other in [
        const GeneralChatScope(
          endpoint: 'https://other.test',
          ownerId: 'owner',
          deviceId: 'device',
        ),
        const GeneralChatScope(
          endpoint: 'https://hub.test',
          ownerId: 'other',
          deviceId: 'device',
        ),
        const GeneralChatScope(
          endpoint: 'https://hub.test',
          ownerId: 'owner',
          deviceId: 'other',
        ),
      ]) {
        expect(await store.read(other, box.sourceSessionId), isNull);
      }
      expect(await store.read(scope, 'mobile-chat:another'), isNull);
      await store.remove(scope, box.sourceSessionId);
      expect(await store.read(scope, box.sourceSessionId), isNull);
      expect(await store.pendingSessions(scope), isEmpty);
    },
  );
  test(
    'outbox rejects extra credential fields and non-contiguous source revisions',
    () {
      final original = _box();
      final raw = original.batches.single.body;
      expect(
        () => GeneralChatBatch(
          purpose: 'user',
          body: {...raw, 'key': 'forbidden-ticket'},
        ),
        throwsFormatException,
      );
      final third = GeneralChatBatch(
        purpose: 'final',
        body: {...raw, 'sourceRevision': 3},
      );
      expect(
        () => GeneralChatOutbox.fromJson({
          ...original.toJson(),
          'batches': [original.batches.single.toJson(), third.toJson()],
        }),
        throwsFormatException,
      );
    },
  );
  test(
    'batch payload is immutable across caller edits and unknown protocol is disabled',
    () {
      final box = _box();
      final body = box.batches.single.body;
      (body['messages'] as List).clear();
      expect(box.batches.single.body['messages'], hasLength(1));
      final catalog = GeneralChatModel.fromCatalog({
        'usable': [
          {'name': 'unknown', 'providerId': 'p'},
          {'name': 'supported', 'providerId': 'q'},
        ],
        'providers': [
          {'id': 'q', 'kind': 'openai-compat'},
        ],
      });
      expect(catalog.first.supported, isFalse);
      expect(catalog.last.supported, isTrue);
    },
  );
}

GeneralChatOutbox _box() => GeneralChatOutbox(
  sourceSessionId: 'mobile-chat:fixture',
  conversationId: '',
  sourceEpoch: 'epoch',
  selectedModel: 'model',
  batches: [
    GeneralChatBatch(
      purpose: 'user',
      body: {
        'sourceSessionId': 'mobile-chat:fixture',
        'sourceEpoch': 'epoch',
        'sourceRevision': 1,
        'title': '测试',
        'state': 'awaiting_reply',
        'archived': false,
        'deleted': false,
        'messages': [
          const GeneralChatMessage(
            id: 'message',
            position: 0,
            role: 'user',
            text: 'hello',
            createdAt: '2026-10-24T00:00:00Z',
          ).toSync(),
        ],
      },
    ),
  ],
);

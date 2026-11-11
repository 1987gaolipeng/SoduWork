import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/voice_input.dart';
import 'package:soduwork_mobile/core/voice_input_controller.dart';

import 'voice_input_test_engine.dart';

void main() {
  test(
    'interim results stay in preview until recognition ends, and never send',
    () {
      final engine = TestVoiceInputEngine();
      final drafts = <String>[];
      final controller = VoiceInputController(
        engine: engine,
        onTranscript: drafts.add,
      );
      addTearDown(controller.dispose);
      expect(engine.starts, 0);
      controller.start();
      expect(controller.status, VoiceInputStatus.starting);
      controller.start();
      expect(engine.starts, 1);
      engine.started!();
      expect(controller.status, VoiceInputStatus.listening);
      engine.transcript!('第一段');
      engine.transcript!('第一段和第二段');
      expect(controller.transcript, '第一段和第二段');
      expect(drafts, isEmpty);
      controller.stop();
      controller.stop();
      expect(engine.stops, 1);
      expect(controller.status, VoiceInputStatus.stopping);
      engine.transcript!('第一段和最终第二段');
      engine.ended!();
      engine.ended!();
      expect(drafts, ['第一段和最终第二段']);
      expect(controller.status, VoiceInputStatus.idle);
    },
  );

  test('cancel discards partial input and ignores every late callback', () {
    final engine = TestVoiceInputEngine();
    var draft = '原草稿';
    final controller = VoiceInputController(
      engine: engine,
      onTranscript: (text) => draft += text,
    );
    addTearDown(controller.dispose);
    controller.start();
    engine.started!();
    engine.transcript!('不应写入');
    controller.cancel();
    engine.transcript!('迟到文字');
    engine.error!(const VoiceInputFailure('network'));
    engine.ended!();
    expect(draft, '原草稿');
    expect(controller.transcript, isEmpty);
    expect(controller.status, VoiceInputStatus.idle);
    expect(engine.aborts, 1);
  });

  test(
    'permission and network errors have actionable messages and allow retry',
    () {
      final engine = TestVoiceInputEngine();
      final drafts = <String>[];
      final controller = VoiceInputController(
        engine: engine,
        onTranscript: drafts.add,
      );
      addTearDown(controller.dispose);
      controller.start();
      final oldTranscript = engine.transcript!;
      engine.error!(const VoiceInputFailure('not-allowed'));
      expect(controller.status, VoiceInputStatus.failed);
      expect(controller.message, contains('权限'));
      controller.start();
      engine.started!();
      oldTranscript('旧请求');
      expect(controller.transcript, isEmpty);
      engine.error!(const VoiceInputFailure('network'));
      expect(controller.message, contains('网络'));
      expect(drafts, isEmpty);
    },
  );

  test('unsupported target never tries to start recording', () {
    final engine = TestVoiceInputEngine()..supported = false;
    final controller = VoiceInputController(
      engine: engine,
      onTranscript: (_) => fail('must not commit'),
    );
    addTearDown(controller.dispose);
    controller.start();
    expect(engine.starts, 0);
    expect(controller.message, contains('系统键盘听写'));
    expect(createVoiceInputEngine().availability.supported, isFalse);
  });

  test(
    'synchronous start and stop failures release resources without committing partials',
    () {
      final engine = TestVoiceInputEngine()..startThrows = true;
      final controller = VoiceInputController(
        engine: engine,
        onTranscript: (_) => fail('must not commit'),
      );
      addTearDown(controller.dispose);
      controller.start();
      expect(controller.status, VoiceInputStatus.failed);
      expect(engine.aborts, 1);
      engine.startThrows = false;
      controller.start();
      engine.started!();
      engine.transcript!('尚未确认');
      engine.stopThrows = true;
      controller.stop();
      expect(controller.status, VoiceInputStatus.failed);
      expect(engine.aborts, 2);
    },
  );

  test('window interruption and disposal discard old results', () {
    final engine = TestVoiceInputEngine();
    final controller = VoiceInputController(
      engine: engine,
      onTranscript: (_) => fail('must not commit'),
    );
    controller.start();
    engine.started!();
    engine.transcript!('未完成');
    engine.interrupted!();
    expect(controller.isActive, isFalse);
    expect(engine.aborts, 1);
    controller.start();
    controller.dispose();
    engine.started!();
    engine.transcript!('销毁后结果');
    engine.ended!();
    expect(engine.disposals, 1);
  });

  testWidgets('startup timeout releases microphone without silently retrying', (
    tester,
  ) async {
    final engine = TestVoiceInputEngine();
    final controller = VoiceInputController(
      engine: engine,
      onTranscript: (_) => fail('must not commit'),
    );
    addTearDown(controller.dispose);
    controller.start();
    await tester.pump(const Duration(seconds: 13));
    expect(controller.status, VoiceInputStatus.failed);
    expect(controller.message, contains('未能启动'));
    expect(engine.aborts, 1);
    expect(engine.starts, 1);
  });

  testWidgets(
    'stop timeout discards uncertain final input and ignores late result',
    (tester) async {
      final engine = TestVoiceInputEngine();
      final controller = VoiceInputController(
        engine: engine,
        onTranscript: (_) => fail('must not commit'),
      );
      addTearDown(controller.dispose);
      controller.start();
      engine.started!();
      engine.transcript!('未确认');
      controller.stop();
      await tester.pump(const Duration(seconds: 6));
      expect(controller.status, VoiceInputStatus.failed);
      expect(controller.message, contains('未能正常结束'));
      engine.transcript!('迟到');
      engine.ended!();
      expect(controller.transcript, isEmpty);
    },
  );

  testWidgets(
    'bounded session stops listening and commits only after the real end callback',
    (tester) async {
      final engine = TestVoiceInputEngine();
      final drafts = <String>[];
      final controller = VoiceInputController(
        engine: engine,
        onTranscript: drafts.add,
      );
      addTearDown(controller.dispose);
      controller.start();
      engine.started!();
      engine.transcript!('已识别文字');
      await tester.pump(const Duration(seconds: 91));
      expect(engine.stops, 1);
      expect(drafts, isEmpty);
      engine.ended!();
      expect(drafts, ['已识别文字']);
    },
  );

  test('empty recognition does not change the draft', () {
    final engine = TestVoiceInputEngine();
    final controller = VoiceInputController(
      engine: engine,
      onTranscript: (_) => fail('must not commit'),
    );
    addTearDown(controller.dispose);
    controller.start();
    engine.started!();
    engine.ended!();
    expect(controller.message, contains('没有识别到文字'));
    expect(controller.isActive, isFalse);
  });
}

import 'package:soduwork_mobile/core/voice_input.dart';

/// Deterministic lifecycle fixture; it does not record or transcribe audio.
class TestVoiceInputEngine implements VoiceInputEngine {
  bool supported = true;
  bool startThrows = false;
  bool stopThrows = false;
  int starts = 0;
  int stops = 0;
  int aborts = 0;
  int disposals = 0;
  void Function()? started;
  void Function(String)? transcript;
  void Function(VoiceInputFailure)? error;
  void Function()? ended;
  void Function()? interrupted;

  @override
  VoiceInputAvailability get availability => VoiceInputAvailability(
    supported,
    supported ? '支持测试接口' : '当前浏览器未提供语音识别，请使用系统键盘听写。',
  );

  @override
  void start({
    required void Function() onStarted,
    required void Function(String text) onTranscript,
    required void Function(VoiceInputFailure failure) onError,
    required void Function() onEnded,
    required void Function() onInterrupted,
  }) {
    starts++;
    started = onStarted;
    transcript = onTranscript;
    error = onError;
    ended = onEnded;
    interrupted = onInterrupted;
    if (startThrows) throw StateError('fixture failed to start');
  }

  @override
  void stop() {
    stops++;
    if (stopThrows) throw StateError('fixture failed to stop');
  }

  @override
  void abort() {
    aborts++;
  }

  @override
  void dispose() {
    disposals++;
  }
}

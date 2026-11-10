import 'voice_input.dart';

VoiceInputEngine createVoiceInputEngine() => _UnavailableVoiceInput();

class _UnavailableVoiceInput implements VoiceInputEngine {
  @override
  VoiceInputAvailability get availability => const VoiceInputAvailability(
    false,
    '此版本尚未接入原生语音识别。你可以点击系统键盘上的麦克风听写，再确认文字后发送。',
  );

  @override
  void start({
    required void Function() onStarted,
    required void Function(String text) onTranscript,
    required void Function(VoiceInputFailure failure) onError,
    required void Function() onEnded,
    required void Function() onInterrupted,
  }) => onError(const VoiceInputFailure('unsupported'));

  @override
  void stop() {}
  @override
  void abort() {}
  @override
  void dispose() {}
}

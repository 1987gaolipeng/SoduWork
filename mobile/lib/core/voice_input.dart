import 'voice_input_stub.dart'
    if (dart.library.js_interop) 'voice_input_web.dart'
    as platform;

class VoiceInputAvailability {
  final bool supported;
  final String message;
  const VoiceInputAvailability(this.supported, this.message);
}

class VoiceInputFailure implements Exception {
  final String code;
  const VoiceInputFailure(this.code);

  String get message => switch (code) {
    'not-allowed' ||
    'service-not-allowed' => '麦克风或语音识别权限未获允许，请在浏览器的网站权限中检查后重试。',
    'audio-capture' => '未找到可用麦克风，请检查设备连接和系统麦克风权限。',
    'network' => '浏览器语音服务暂时无法连接，请检查网络，或使用键盘听写。',
    'no-speech' => '没有识别到语音，请靠近麦克风后重试。',
    'language-not-supported' => '当前浏览器语音服务不支持中文，请使用键盘听写。',
    'start-timeout' => '语音输入未能启动，请检查浏览器权限后重试。',
    'stop-timeout' => '语音输入未能正常结束，已取消本次识别，请重试。',
    'aborted' => '本次语音输入已取消。',
    _ => '语音输入暂时无法启动，请重试或使用键盘听写。',
  };
}

/// Optional device capability. Creating an engine must never request access.
abstract class VoiceInputEngine {
  VoiceInputAvailability get availability;
  void start({
    required void Function() onStarted,
    required void Function(String text) onTranscript,
    required void Function(VoiceInputFailure failure) onError,
    required void Function() onEnded,
    required void Function() onInterrupted,
  });
  void stop();
  void abort();
  void dispose();
}

VoiceInputEngine createVoiceInputEngine() => platform.createVoiceInputEngine();

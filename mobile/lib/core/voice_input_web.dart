import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'voice_input.dart';

@JS('window')
external _BrowserWindow get _window;

extension type _BrowserWindow(JSObject _) implements JSObject {
  @JS('SpeechRecognition')
  external JSFunction? get speechRecognition;
  external JSFunction? get webkitSpeechRecognition;
  external bool get isSecureContext;
  external _BrowserDocument get document;
  external void addEventListener(String type, JSFunction callback);
  external void removeEventListener(String type, JSFunction callback);
}

extension type _BrowserDocument(JSObject _) implements JSObject {
  external bool get hidden;
  external void addEventListener(String type, JSFunction callback);
  external void removeEventListener(String type, JSFunction callback);
}

extension type _Recognition(JSObject _) implements JSObject {
  external set lang(String value);
  external set continuous(bool value);
  external set interimResults(bool value);
  external set maxAlternatives(int value);
  external set onstart(JSFunction? callback);
  external set onresult(JSFunction? callback);
  external set onerror(JSFunction? callback);
  external set onend(JSFunction? callback);
  external void start();
  external void stop();
  external void abort();
}

extension type _ResultEvent(JSObject _) implements JSObject {
  external _Results get results;
}

extension type _Results(JSObject _) implements JSObject {
  external int get length;
  external _Result item(int index);
}

extension type _Result(JSObject _) implements JSObject {
  external _Alternative item(int index);
}

extension type _Alternative(JSObject _) implements JSObject {
  external String get transcript;
}

extension type _ErrorEvent(JSObject _) implements JSObject {
  external String get error;
}

VoiceInputEngine createVoiceInputEngine() => _BrowserVoiceInput();

/// Web Speech is provided by the browser and can use its network service.
/// stop() asks for a final result; abort() discards it (MDN Web Speech API).
class _BrowserVoiceInput implements VoiceInputEngine {
  _Recognition? _recognition;
  JSFunction? _onBlur;
  JSFunction? _onVisibility;
  int _generation = 0;

  @override
  VoiceInputAvailability get availability {
    if (!_window.isSecureContext) {
      return const VoiceInputAvailability(
        false,
        '语音输入需要 HTTPS 或本机 localhost 安全连接。当前可使用键盘输入或键盘听写。',
      );
    }
    if (_window.speechRecognition == null &&
        _window.webkitSpeechRecognition == null) {
      return const VoiceInputAvailability(
        false,
        '当前浏览器未提供语音识别。你可以使用系统键盘上的麦克风听写，或换用支持语音识别的浏览器。',
      );
    }
    return const VoiceInputAvailability(true, '可使用浏览器语音识别');
  }

  @override
  void start({
    required void Function() onStarted,
    required void Function(String text) onTranscript,
    required void Function(VoiceInputFailure failure) onError,
    required void Function() onEnded,
    required void Function() onInterrupted,
  }) {
    abort();
    final generation = _generation;
    if (!availability.supported) {
      onError(const VoiceInputFailure('unsupported'));
      return;
    }
    try {
      final constructor =
          _window.speechRecognition ?? _window.webkitSpeechRecognition!;
      final recognition = constructor.callAsConstructor<_Recognition>();
      _recognition = recognition;
      recognition
        ..lang = 'zh-CN'
        ..continuous = true
        ..interimResults = true
        ..maxAlternatives = 1;
      recognition.onstart = (() {
        if (generation == _generation) onStarted();
      }).toJS;
      recognition.onresult = ((JSObject event) {
        if (generation != _generation) return;
        // Every event includes the cumulative list. Reading only resultIndex
        // would drop final text from earlier segments of the same dictation.
        final results = _ResultEvent(event).results;
        final text = StringBuffer();
        for (var index = 0; index < results.length; index++) {
          text.write(results.item(index).item(0).transcript);
        }
        onTranscript(text.toString());
      }).toJS;
      recognition.onerror = ((JSObject event) {
        if (generation != _generation) return;
        final failure = VoiceInputFailure(_ErrorEvent(event).error);
        abort();
        onError(failure);
      }).toJS;
      recognition.onend = (() {
        if (generation != _generation) return;
        _release(abortRecognition: false);
        onEnded();
      }).toJS;
      _onBlur = (() {
        if (generation == _generation) onInterrupted();
      }).toJS;
      _onVisibility = (() {
        if (generation == _generation && _window.document.hidden) {
          onInterrupted();
        }
      }).toJS;
      _window.addEventListener('blur', _onBlur!);
      _window.document.addEventListener('visibilitychange', _onVisibility!);
      // Called synchronously from the user's explicit Start button, preserving
      // the browser's user activation and native permission prompt.
      recognition.start();
    } catch (_) {
      abort();
      onError(const VoiceInputFailure('start-failed'));
    }
  }

  @override
  void stop() => _recognition?.stop();

  void _release({required bool abortRecognition}) {
    final recognition = _recognition;
    _recognition = null;
    if (_onBlur != null) _window.removeEventListener('blur', _onBlur!);
    if (_onVisibility != null) {
      _window.document.removeEventListener('visibilitychange', _onVisibility!);
    }
    _onBlur = null;
    _onVisibility = null;
    if (recognition != null) {
      recognition
        ..onstart = null
        ..onresult = null
        ..onerror = null
        ..onend = null;
      if (abortRecognition) {
        try {
          recognition.abort();
        } catch (_) {
          /* Already ended. */
        }
      }
    }
  }

  @override
  void abort() {
    _generation++;
    _release(abortRecognition: true);
  }

  @override
  void dispose() => abort();
}

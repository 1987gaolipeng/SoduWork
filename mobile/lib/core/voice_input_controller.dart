import 'dart:async';

import 'package:flutter/foundation.dart';

import 'voice_input.dart';

enum VoiceInputStatus { idle, starting, listening, stopping, failed }

class VoiceInputController extends ChangeNotifier {
  final VoiceInputEngine engine;
  final ValueChanged<String> onTranscript;
  VoiceInputStatus status = VoiceInputStatus.idle;
  String transcript = '';
  String message = '';
  Timer? _startupTimer;
  Timer? _stopTimer;
  Timer? _sessionTimer;
  int _revision = 0;
  bool _disposed = false;

  VoiceInputController({VoiceInputEngine? engine, required this.onTranscript})
    : engine = engine ?? createVoiceInputEngine();

  VoiceInputAvailability get availability => engine.availability;
  bool get isActive =>
      status == VoiceInputStatus.starting ||
      status == VoiceInputStatus.listening ||
      status == VoiceInputStatus.stopping;

  void start() {
    if (_disposed || isActive) return;
    if (!availability.supported) {
      message = availability.message;
      status = VoiceInputStatus.failed;
      notifyListeners();
      return;
    }
    final revision = ++_revision;
    status = VoiceInputStatus.starting;
    transcript = '';
    message = '正在启动麦克风…';
    notifyListeners();
    _startupTimer = Timer(const Duration(seconds: 12), () {
      if (_current(revision)) _fail(const VoiceInputFailure('start-timeout'));
    });
    try {
      engine.start(
        onStarted: () {
          if (!_current(revision) || status != VoiceInputStatus.starting) {
            return;
          }
          _startupTimer?.cancel();
          status = VoiceInputStatus.listening;
          message = '正在聆听，说完后点击停止';
          _sessionTimer = Timer(const Duration(seconds: 90), stop);
          notifyListeners();
        },
        onTranscript: (text) {
          if (!_current(revision)) return;
          transcript = text;
          notifyListeners();
        },
        onError: (failure) {
          if (_current(revision)) _fail(failure);
        },
        onEnded: () {
          if (!_current(revision)) return;
          final text = transcript.trim();
          _revision++;
          _cancelTimers();
          status = VoiceInputStatus.idle;
          transcript = '';
          message = text.isEmpty ? '没有识别到文字，请重试。' : '语音已转为文字，请确认草稿后发送。';
          notifyListeners();
          if (text.isNotEmpty) onTranscript(text);
        },
        onInterrupted: () {
          if (_current(revision)) cancel(message: '页面已离开，已取消本次语音输入。');
        },
      );
    } catch (_) {
      if (_current(revision)) _fail(const VoiceInputFailure('start-failed'));
    }
  }

  void stop() {
    if (_disposed || !isActive || status == VoiceInputStatus.stopping) return;
    _startupTimer?.cancel();
    _sessionTimer?.cancel();
    status = VoiceInputStatus.stopping;
    message = '正在完成识别…';
    final revision = _revision;
    _stopTimer = Timer(const Duration(seconds: 5), () {
      if (_current(revision)) _fail(const VoiceInputFailure('stop-timeout'));
    });
    notifyListeners();
    try {
      engine.stop();
    } catch (_) {
      _fail(const VoiceInputFailure('stop-failed'));
    }
  }

  void cancel({String message = '已取消本次语音输入，原草稿未改变。'}) {
    if (_disposed) return;
    _revision++;
    _cancelTimers();
    engine.abort();
    transcript = '';
    status = VoiceInputStatus.idle;
    this.message = message;
    notifyListeners();
  }

  bool _current(int revision) => !_disposed && revision == _revision;

  void _fail(VoiceInputFailure failure) {
    _revision++;
    _cancelTimers();
    engine.abort();
    status = VoiceInputStatus.failed;
    transcript = '';
    message = failure.message;
    notifyListeners();
  }

  void _cancelTimers() {
    _startupTimer?.cancel();
    _stopTimer?.cancel();
    _sessionTimer?.cancel();
    _startupTimer = _stopTimer = _sessionTimer = null;
  }

  @override
  void dispose() {
    _revision++;
    _disposed = true;
    _cancelTimers();
    engine.dispose();
    super.dispose();
  }
}

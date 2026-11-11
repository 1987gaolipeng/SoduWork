import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'package:webview_flutter_android/webview_flutter_android.dart';
import '../core/work_file_picker_native.dart';
import '../core/soduwork_api.dart';

const sharedConversationAvailable = bool.fromEnvironment(
  'SODUWORK_ANDROID_WEBVIEW',
  defaultValue: false,
);
const _androidChannel = 'soduwork-android';

/// Android hosts the same shared conversation bundle as Web. Authentication,
/// Hub requests, and task capabilities remain owned by Flutter; the WebView
/// only renders the existing conversation UI and forwards narrow bridge calls.
class SharedConversationView extends StatefulWidget {
  final Future<Object?> Function(String, Map<String, dynamic>) onRequest;
  final bool dark;
  final String accent;
  final String locale;

  const SharedConversationView({
    super.key,
    required this.onRequest,
    this.dark = false,
    this.accent = 'neutral',
    this.locale = 'zh-CN',
  });

  @override
  State<SharedConversationView> createState() => _SharedConversationViewState();
}

class _SharedConversationViewState extends State<SharedConversationView> {
  late final WebViewController _controller;
  final Set<String> _pending = <String>{};
  final List<Map<String, dynamic>> _outbox = <Map<String, dynamic>>[];
  bool _pageReady = false;

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(
        'SoduWorkBridge',
        onMessageReceived: (message) {
          unawaited(_receive(message.message));
        },
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onPageFinished: (_) {
            _pageReady = true;
            _flushOutbox();
          },
        ),
      )
      ..loadFlutterAsset('assets/shared-conversation/android-index.html');
    final android = _controller.platform;
    if (android is AndroidWebViewController) {
      unawaited(
        android.setOnShowFileSelector((params) async {
          const composerUrl =
              'file:///android_asset/flutter_assets/assets/shared-conversation/android-index.html';
          try {
            if (params.mode == FileSelectorMode.save ||
                await _controller.currentUrl() != composerUrl) {
              return [];
            }
            final files = await pickWorkFiles(
              multiple: params.mode == FileSelectorMode.openMultiple,
            );
            if (!mounted || await _controller.currentUrl() != composerUrl) {
              return [];
            }
            return [for (final file in files) Uri.file(file.path).toString()];
          } catch (_) {
            if (mounted) {
              ScaffoldMessenger.maybeOf(context)?.showSnackBar(
                const SnackBar(content: Text('未能添加文件，请检查文件大小后重试。')),
              );
            }
            return [];
          }
        }),
      );
    }
  }

  Future<void> _receive(String raw) async {
    if (!mounted) return;
    Map<String, dynamic> message;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return;
      message = Map<String, dynamic>.from(decoded);
    } catch (_) {
      return;
    }
    if (message['channel'] != _androidChannel ||
        message['type'] != 'soduwork-conversation' ||
        message['id'] is! String ||
        message['method'] is! String ||
        message['args'] is! Map) {
      return;
    }
    final id = message['id'] as String;
    if (id.length > 20 || _pending.length >= 24 || !_pending.add(id)) return;
    try {
      final result = await widget.onRequest(
        message['method'] as String,
        Map<String, dynamic>.from(message['args'] as Map),
      );
      if (mounted) {
        _post({
          'id': id,
          'result': message['method'] == 'ready' && result is Map
              ? {
                  ...Map<String, dynamic>.from(result),
                  'dark': widget.dark,
                  'accent': widget.accent,
                  'locale': widget.locale,
                }
              : result,
        });
      }
    } catch (error) {
      if (mounted) {
        _post({
          'id': id,
          'error': error.toString(),
          'status': error is ApiFailure ? error.status : 0,
        });
      }
    } finally {
      _pending.remove(id);
    }
  }

  void _post(Map<String, dynamic> value) {
    final message = <String, dynamic>{
      'channel': _androidChannel,
      'type': 'soduwork-conversation-host',
      ...value,
    };
    if (!_pageReady) {
      _outbox.add(message);
      return;
    }
    unawaited(_sendToPage(message));
  }

  void _flushOutbox() {
    if (!_pageReady || !mounted) return;
    final queued = List<Map<String, dynamic>>.from(_outbox);
    _outbox.clear();
    for (final message in queued) {
      unawaited(_sendToPage(message));
    }
  }

  Future<void> _sendToPage(Map<String, dynamic> message) async {
    try {
      final encoded = jsonEncode(jsonEncode(message));
      await _controller.runJavaScript(
        'window.soduWorkAndroidReceive($encoded);',
      );
    } catch (_) {
      // A page navigation can race with a response. The Web UI will retry the
      // read on its next lifecycle event; do not surface a native error here.
    }
  }

  @override
  void didUpdateWidget(SharedConversationView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.dark != oldWidget.dark ||
        widget.accent != oldWidget.accent ||
        widget.locale != oldWidget.locale) {
      _post({
        'event': 'appearance',
        'dark': widget.dark,
        'accent': widget.accent,
        'locale': widget.locale,
      });
    }
  }

  @override
  void dispose() {
    _pending.clear();
    _outbox.clear();
    _pageReady = false;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _controller);
}

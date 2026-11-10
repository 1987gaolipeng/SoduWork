import 'mobile_display_preferences.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:flutter/material.dart';
import '../core/automation_chat_host.dart';
import '../core/cloud_conversation_request.dart';
import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import 'mobile_sheet.dart';
import 'mobile_sheet_pages.dart';

@JS('window')
external _Window get _window;
@JS('JSON.stringify')
external String _stringify(JSAny? value);
@JS('JSON.parse')
external JSAny _parse(String value);

extension type _Window(JSObject _) implements JSObject {
  external void addEventListener(String type, JSFunction listener);
  external void removeEventListener(String type, JSFunction listener);
  external void postMessage(JSAny value, String targetOrigin);
}
extension type _Frame(JSObject _) implements JSObject {
  external set src(String value);
  external void setAttribute(String name, String value);
  external _Window? get contentWindow;
}
extension type _Message(JSObject _) implements JSObject {
  external String get origin;
  external JSObject? get source;
  external JSAny? get data;
}

Future<AutomationSchedule?> showAutomationChat(BuildContext context) {
  final nested = MobileSheetPages.maybeOf(context) != null;
  final presentationNavigator = Navigator.of(context);
  return showMobileSheet<AutomationSchedule>(
    context,
    title: '新建自动化',
    initialSize: .96,
    builder: (sheetContext, _) => _AutomationChat(
      onClose: (result) =>
          (nested ? Navigator.of(sheetContext) : presentationNavigator).pop(
            result,
          ),
    ),
  );
}

class _AutomationChat extends StatefulWidget {
  final ValueChanged<AutomationSchedule?> onClose;
  const _AutomationChat({required this.onClose});
  @override
  State<_AutomationChat> createState() => _AutomationChatState();
}

class _AutomationChatState extends State<_AutomationChat> {
  final _channel = mobileRequestId();
  final _pending = <String>{};
  late final JSFunction _listener;
  _Frame? _frame;
  AutomationChatHost? _host;
  MobileState? _state;
  int? _identity;

  @override
  void initState() {
    super.initState();
    _listener = ((_Message event) => unawaited(_receive(event))).toJS;
    _window.addEventListener('message', _listener);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_host != null) return;
    _state = state;
    _identity = state.identityRevision;
    final owner = state.enrollment?.ownerUserId ?? '';
    final device = state.enrollment?.deviceId ?? '';
    _host = AutomationChatHost(
      api: state.api,
      identity: '${state.endpoint.baseUrl}:$owner:$device',
      dark: Theme.of(context).brightness == Brightness.dark,
      checkCurrent: () {
        if (!mounted ||
            state.identityRevision != _identity ||
            state.phase != MobilePhase.ready) {
          throw const ApiFailure('账号或连接已变化，请重新打开自动化。');
        }
      },
      onClose: () {
        final result = _host?.created;
        widget.onClose(
          result == null ? null : AutomationSchedule.fromJson(result),
        );
      },
    );
  }

  void _post(Map<String, dynamic> value) {
    _frame?.contentWindow?.postMessage(
      _parse(
        jsonEncode({
          'channel': _channel,
          'type': 'soduwork-automation-host',
          ...value,
        }),
      ),
      Uri.base.origin,
    );
  }

  Future<void> _receive(_Message event) async {
    if (!mounted ||
        _frame == null ||
        event.origin != Uri.base.origin ||
        event.source != _frame?.contentWindow) {
      return;
    }
    Map<String, dynamic> data;
    try {
      final encoded = _stringify(event.data);
      if (encoded.length > 300000) return;
      final decoded = jsonDecode(encoded);
      if (decoded is! Map<String, dynamic>) return;
      data = decoded;
    } catch (_) {
      return;
    }
    if (data['channel'] != _channel ||
        data['type'] != 'soduwork-automation' ||
        data['id'] is! String ||
        data['method'] is! String ||
        data['args'] is! Map<String, dynamic>) {
      return;
    }
    final id = data['id'] as String;
    if (id.length > 20 || _pending.length >= 16 || !_pending.add(id)) return;
    try {
      final result = await _host!.handle(
        data['method'] as String,
        data['args'] as Map<String, dynamic>,
      );
      if (mounted) _post({'id': id, 'result': result});
    } catch (error) {
      if (mounted) {
        _post({
          'id': id,
          'error': error is ApiFailure ? error.message : '自动化操作没有完成，请保留内容后重试。',
        });
      }
    } finally {
      _pending.remove(id);
    }
  }

  @override
  void dispose() {
    _window.removeEventListener('message', _listener);
    _frame?.src = 'about:blank';
    _pending.clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    if (_state?.identityRevision != _identity) {
      return Center(child: Text(mobileText(context, '账号已变化，请重新打开自动化。')));
    }
    return SizedBox.expand(
      child: HtmlElementView.fromTagName(
        tagName: 'iframe',
        onElementCreated: (element) {
          final frame = _Frame(element as JSObject);
          _frame = frame;
          frame.setAttribute('title', 'SoduWork 自动化对话');
          frame.setAttribute(
            'style',
            'width:100%;height:100%;border:0;display:block',
          );
          frame.setAttribute(
            'sandbox',
            'allow-scripts allow-same-origin allow-forms',
          );
          frame.src = Uri.base
              .resolve('shared-automation/index.html')
              .replace(
                query: 'instance=$_channel',
                fragment: 'channel=$_channel',
              )
              .toString();
        },
      ),
    );
  }
}

import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';
import 'package:flutter/widgets.dart';
import 'mobile_layer_surface.dart';
import 'mobile_sidebar_surface.dart';
import '../core/cloud_conversation_request.dart';
import '../core/soduwork_api.dart';

const sharedConversationAvailable = bool.fromEnvironment(
  'SODUWORK_SHARED_CONVERSATION',
  defaultValue: false,
);

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
  external void removeAttribute(String name);
  external _Window? get contentWindow;
}

extension type _Message(JSObject _) implements JSObject {
  external String get origin;
  external JSObject? get source;
  external JSAny? get data;
}

/// The host owns authentication. Only narrow operation results cross the frame
/// boundary; device credentials, account passwords and model keys never do.
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
  final _channel = mobileRequestId();
  final _pending = <String>{};
  late final JSFunction _listener;
  _Frame? _frame;
  MobileLayerCoordinator? _layers;
  bool _covered = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final layers = MobileLayerScope.maybeOf(context);
    if (_layers != layers) {
      _layers?.removeListener(_updateInteraction);
      _layers = layers;
      _layers?.addListener(_updateInteraction);
    }
    _covered =
        MobileSidebarInteraction.blockedOf(context) ||
        ModalRoute.isCurrentOf(context) == false;
    _updateInteraction();
  }

  void _updateInteraction() {
    final blocked = _covered || (_layers?.depthAbove(null) ?? 0) > 0;
    _frame?.setAttribute(
      'style',
      'width:100%;height:100%;border:0;display:block;pointer-events:${blocked ? "none" : "auto"}',
    );
    if (blocked) {
      _frame?.setAttribute('inert', '');
      _frame?.setAttribute('aria-hidden', 'true');
      _post({'event': 'suspend-input'});
    } else {
      _frame?.removeAttribute('inert');
      _frame?.removeAttribute('aria-hidden');
    }
  }

  @override
  void initState() {
    super.initState();
    _listener = ((_Message event) => unawaited(_receive(event))).toJS;
    _window.addEventListener('message', _listener);
  }

  void _post(Map<String, dynamic> value) {
    _frame?.contentWindow?.postMessage(
      _parse(
        jsonEncode({
          'channel': _channel,
          'type': 'soduwork-conversation-host',
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
    Map<String, dynamic> message;
    try {
      final decoded = jsonDecode(_stringify(event.data));
      if (decoded is! Map<String, dynamic>) return;
      message = decoded;
    } catch (_) {
      return;
    }
    if (message['channel'] != _channel ||
        message['type'] != 'soduwork-conversation' ||
        message['id'] is! String ||
        message['method'] is! String ||
        message['args'] is! Map<String, dynamic>) {
      return;
    }
    final id = message['id'] as String;
    if (id.length > 20 || _pending.length >= 24 || !_pending.add(id)) return;
    try {
      final result = await widget.onRequest(
        message['method'] as String,
        message['args'] as Map<String, dynamic>,
      );
      if (mounted) {
        _post({
          'id': id,
          'result': message['method'] == 'ready' && result is Map
              ? {
                  ...result,
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
    _layers?.removeListener(_updateInteraction);
    _window.removeEventListener('message', _listener);
    _frame?.src = 'about:blank';
    _pending.clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => HtmlElementView.fromTagName(
    tagName: 'iframe',
    onElementCreated: (element) {
      final frame = _Frame(element as JSObject);
      _frame = frame;
      frame.setAttribute('title', 'SoduWork 对话');
      frame.setAttribute(
        'style',
        'width:100%;height:100%;border:0;display:block',
      );
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.setAttribute('allow', 'clipboard-write');
      _updateInteraction();
      frame.src = Uri.base
          .resolve('shared-conversation/index.html')
          .replace(query: 'instance=$_channel', fragment: 'channel=$_channel')
          .toString();
    },
  );
}

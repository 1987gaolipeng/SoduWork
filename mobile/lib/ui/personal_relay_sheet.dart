import 'mobile_input_border.dart';
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../core/cloud_conversation_request.dart';
import '../core/soduwork_api.dart';
import '../models/account_conversation.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';

Future<void> showPersonalRelaySheet(
  BuildContext context,
  AccountConversation source,
) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  builder: (_) => PersonalRelaySheet(source: source),
);

class PersonalRelaySheet extends StatefulWidget {
  final AccountConversation source;
  const PersonalRelaySheet({super.key, required this.source});
  @override
  State<PersonalRelaySheet> createState() => _PersonalRelaySheetState();
}

class _PersonalRelaySheetState extends State<PersonalRelaySheet> {
  final _text = TextEditingController();
  MobileState? _state;
  int? _identity;
  String _endpoint = '', _owner = '', _device = '';
  Map<String, dynamic>? _target, _pending, _receipt;
  bool _busy = true;
  bool _checkedOnPc = false;
  String _error = '';
  Timer? _timer;
  bool get _current =>
      mounted &&
      _state?.phase == MobilePhase.ready &&
      _state?.identityRevision == _identity;
  bool get _otherConversation =>
      _pending != null &&
      (_pending!['body'] as Map)['conversationId'] != widget.source.id;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_state != null) return;
    final state = MobileScope.of(context);
    _state = state;
    _identity = state.identityRevision;
    _endpoint = state.endpoint.baseUrl;
    _owner = state.enrollment?.ownerUserId ?? '';
    _device = state.enrollment?.deviceId ?? '';
    unawaited(_load());
  }

  Future<void> _save(Map<String, dynamic>? value) =>
      _state!.store.writePersonalRelay(
        _endpoint,
        _owner,
        _device,
        value == null ? null : jsonEncode(value),
      );

  Future<void> _load() async {
    try {
      final saved = await _state!.store.readPersonalRelay(
        _endpoint,
        _owner,
        _device,
      );
      if (!_current) return;
      if (saved != null) {
        final decoded = jsonDecode(saved);
        if (decoded is! Map ||
            decoded['id'] is! String ||
            decoded['body'] is! Map ||
            (decoded['body'] as Map)['conversationId'] is! String) {
          throw const FormatException('待核对接力记录损坏，请保留记录并联系支持');
        }
        _pending = Map<String, dynamic>.from(decoded);
        await _check();
      } else {
        _target = await _state!.api.personalRelayTarget(widget.source.id);
      }
    } on ApiFailure catch (e) {
      _error = e.status == 404
          ? (_pending == null
                ? '当前服务尚未支持本人 PC 原会话接力'
                : '尚未找到原请求回执，可核对原请求；不会新建或改派')
          : e.message;
    } catch (e) {
      _error = e is FormatException ? e.message : '未能读取接力状态，请重试';
    }
    if (_current) setState(() => _busy = false);
  }

  void _schedule() {
    _timer?.cancel();
    if (_current &&
        _pending != null &&
        const ['prepared', 'claimed'].contains(_receipt?['phase'])) {
      _timer = Timer(const Duration(seconds: 3), () async {
        try {
          await _check();
        } catch (_) {
          if (_current) setState(() => _error = '暂未确认结果，请核对原请求，不要重复发送');
        }
      });
    }
  }

  Future<void> _check() async {
    if (!_current || _pending == null) return;
    final result = await _state!.api.personalRelayStatus(
      _pending!['id'] as String,
    );
    if (!_current) return;
    _receipt = result;
    _error = '';
    if (const ['accepted', 'rejected', 'closed'].contains(result['phase'])) {
      await _save(null);
      if (!_current) return;
      _pending = null;
    }
    setState(() {});
    _schedule();
  }

  Future<void> _send() async {
    if (!_current || _busy || _otherConversation) return;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      if (_pending == null) {
        if (_target?['available'] != true ||
            _text.text.trim().isEmpty ||
            _receipt != null) {
          return;
        }
        _pending = {
          'id': mobileRequestId(),
          'body': {
            'conversationId': widget.source.id,
            'targetClientId': _target!['targetClientId'],
            'expectedRevision': _target!['revision'],
            'instruction': _text.text.trim(),
          },
        };
        // Persist the immutable request before networking; retry uses this ID.
        await _save(_pending);
      }
      if (!_current) return;
      try {
        await _check();
      } on ApiFailure catch (e) {
        if (e.status != 404) rethrow;
        final saved = _pending!;
        final result = await _state!.api.sendPersonalRelay(
          saved['id'] as String,
          Map<String, dynamic>.from(saved['body'] as Map),
        );
        if (!_current) return;
        _receipt = result;
        await _check();
      }
    } on ApiFailure catch (e) {
      if (_current) setState(() => _error = e.message);
      // Definite admission rejection means no PC command was queued.
      if (const [400, 403, 409, 410, 422].contains(e.status) &&
          _receipt == null) {
        await _save(null);
        if (_current) _pending = null;
      }
    } catch (_) {
      if (_current) setState(() => _error = '发送结果尚未确认，请核对原请求；不会自动换到其他电脑或云端');
    } finally {
      if (_current) setState(() => _busy = false);
    }
  }

  Future<void> _resolve() async {
    if (!_current || _busy || !_checkedOnPc || _pending == null) return;
    setState(() => _busy = true);
    try {
      await _state!.api.resolvePersonalRelay(_pending!['id'] as String);
      if (_current) await _check();
    } on ApiFailure catch (e) {
      if (_current) setState(() => _error = e.message);
    } catch (_) {
      if (_current) setState(() => _error = '未确认回执是否关闭，请再次核对原请求');
    } finally {
      if (_current) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    final phase = _receipt?['phase'];
    final status = switch (phase) {
      'accepted' => '本人 PC 已接收。请关闭此面板，在原聊天中查看同步回复。',
      'prepared' => '等待本人 PC 接收；到期未领取不会继续执行。',
      'claimed' => '本人 PC 已领取，正在确认发送结果，请勿重复发送。',
      'uncertain' => '发送结果暂不能确认，请在来源 PC 核对；不会自动重发。',
      'rejected' => (_receipt?['reason'] ?? '接力未执行，请刷新聊天后重试').toString(),
      'closed' => '回执已关闭，没有重新发送。请返回原聊天查看实际结果。',
      _ => '',
    };
    final locked = _pending != null || _receipt != null;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        8,
        20,
        MediaQuery.viewInsetsOf(context).bottom + 20,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('在本人 PC 原会话继续', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            Text(
              _target?['name']?.toString() ?? widget.source.sourceDeviceName,
            ),
            const SizedBox(height: 8),
            const Text('保留原会话、工作目录和已授权的本机能力。沿用原底座与模型；需要新的权限时仍由来源电脑确认。'),
            if (_target?['available'] == false)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_target!['reason'].toString()),
              ),
            const SizedBox(height: 16),
            if (_otherConversation) const Text('另一条聊天还有接力待核对，请返回那条聊天处理原请求。'),
            if (!locked)
              TextField(
                controller: _text,
                minLines: 3,
                maxLines: 8,
                maxLength: 50000,
                enabled: !_busy && _current,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  labelText: '接下来做什么',
                  border: MobileInputBorder(),
                ),
              ),
            if (status.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(status, key: const Key('personal-relay-status')),
              ),
            if (_error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  _error,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (!_current) const Text('账号已切换，请关闭面板后重新打开。'),
            if (_receipt == null || _pending != null)
              FilledButton(
                onPressed:
                    _current &&
                        !_busy &&
                        !_otherConversation &&
                        (_pending != null ||
                            (_target?['available'] == true &&
                                _text.text.trim().isNotEmpty))
                    ? _send
                    : null,
                child: Text(
                  _busy
                      ? '正在核对…'
                      : _pending != null
                      ? '核对原请求'
                      : '发送到本人 PC 原会话',
                ),
              ),
            if (phase == 'uncertain' && !_otherConversation) ...[
              CheckboxListTile(
                value: _checkedOnPc,
                onChanged: _busy
                    ? null
                    : (value) => setState(() => _checkedOnPc = value == true),
                title: const Text('已在来源 PC 核对实际结果，确认没有仍在发送的请求'),
              ),
              TextButton(
                onPressed: _current && !_busy && _checkedOnPc ? _resolve : null,
                child: const Text('关闭待核对回执（不重发、不停止执行）'),
              ),
            ],
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('返回原聊天'),
            ),
          ],
        ),
      ),
    );
  }
}

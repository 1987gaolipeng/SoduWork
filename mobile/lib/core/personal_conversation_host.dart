import 'dart:convert';
import '../models/account_conversation.dart';
import '../state/account_transcript_sync.dart';
import '../state/mobile_state.dart';
import 'cloud_conversation_request.dart';
import 'soduwork_api.dart';

/// Adapts the original PC transcript and durable relay to the shared composer.
/// Reading, remounting and polling never submit work.
class PersonalConversationHost {
  final MobileState state;
  final AccountConversation source;
  final void Function() check;
  final transcript = AccountTranscriptSync();
  String _lastReason = '', _lastPhase = '';
  static final _queues = Expando<Future<void>>();
  late final endpoint = state.endpoint.baseUrl;
  late final owner = state.enrollment?.ownerUserId ?? '';
  late final device = state.enrollment?.deviceId ?? '';

  PersonalConversationHost(this.state, this.source, this.check);

  Future<Object?> call(String method, Map<String, dynamic> args) async {
    final previous = _queues[state] ?? Future<void>.value();
    final result = previous.then((_) async {
      check();
      final result = await _call(method, args);
      check();
      return result;
    });
    _queues[state] = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }

  Future<Map<String, dynamic>?> _pending() async {
    final saved = await state.store.readPersonalRelay(endpoint, owner, device);
    check();
    if (saved == null) return null;
    final value = jsonDecode(saved);
    if (value is! Map ||
        value['id'] is! String ||
        value['body'] is! Map ||
        value['body']['conversationId'] is! String) {
      throw const ApiFailure('待确认的发送记录无法读取，请保留记录并联系支持。');
    }
    return Map<String, dynamic>.from(value);
  }

  Future<void> _save(Map<String, dynamic>? value) async {
    check();
    await state.store.writePersonalRelay(
      endpoint,
      owner,
      device,
      value == null ? null : jsonEncode(value),
    );
    check();
  }

  Future<void> _read() async {
    await transcript.refresh(
      conversationId: source.id,
      load: ({required after, required limit}) => state.api
          .accountConversationMessages(source.id, after: after, limit: limit),
      isCurrent: () {
        check();
        return true;
      },
    );
    check();
    if (transcript.error.isNotEmpty) throw ApiFailure(transcript.error);
  }

  Future<Map<String, dynamic>> _status(Map<String, dynamic> pending) async {
    final receipt = await state.api.personalRelayStatus(
      pending['id'] as String,
    );
    check();
    if (receipt['conversationId'] != pending['body']['conversationId']) {
      throw const ApiFailure('发送回执与原聊天不匹配。');
    }
    return receipt;
  }

  Future<Object?> _call(String method, Map<String, dynamic> args) async {
    if (args['taskId'] != source.id) {
      throw const ApiFailure('不能访问其他聊天。', status: 403);
    }
    if (method == 'workflowPoll') return {'ok': true, 'workflow': false};
    if (method == 'artifacts') return <Map<String, dynamic>>[];
    if (method == 'poll') {
      await _read();
      var pending = await _pending();
      var reason = _lastReason;
      var phase = _lastPhase;
      var retry = false;
      var resolve = false;
      if (pending != null) {
        if (pending['body']['conversationId'] != source.id) {
          reason = '另一条聊天的发送尚待确认，请先返回那条聊天核对。';
        } else {
          try {
            final receipt = await _status(pending);
            phase = receipt['phase'] as String? ?? '';
            reason = switch (phase) {
              'prepared' => '正在等待你的电脑接收…',
              'claimed' => '你的电脑已接收，正在确认发送结果…',
              'accepted' => '已发送到你的电脑，正在同步回复…',
              'uncertain' => '发送结果尚未确认，请在电脑核对后再继续，避免重复执行。',
              _ => receipt['reason']?.toString() ?? '',
            };
            resolve = phase == 'uncertain';
            final echoed = transcript.messages.any(
              (message) =>
                  message.role == 'user' &&
                  message.text == pending!['body']['instruction'] &&
                  message.revision > (pending['cursor'] as int? ?? 0),
            );
            if (const ['rejected', 'closed'].contains(phase) ||
                (phase == 'accepted' && echoed)) {
              if (phase != 'accepted') {
                _lastReason = reason.isEmpty ? '电脑未执行这条消息，请核对后重新发送。' : reason;
                reason = _lastReason;
                _lastPhase = phase;
              }
              await _save(null);
              pending = null;
              if (phase == 'accepted') reason = '';
            }
          } on ApiFailure catch (error) {
            if (error.status != 404) rethrow;
            reason = '上一条发送尚未确认，可核对并重试原请求。';
            retry = true;
          }
        }
      }
      Map<String, dynamic> target = {};
      try {
        target = await state.api.personalRelayTarget(source.id);
        check();
      } on ApiFailure catch (error) {
        reason = reason.isEmpty ? error.message : reason;
      }
      final busy = transcript.conversation?.state == 'responding';
      final available =
          target['available'] == true && pending == null && !transcript.hasMore;
      if (reason.isEmpty && !available) {
        reason = transcript.hasMore
            ? '正在读取完整聊天记录…'
            : target['reason']?.toString() ?? '你的电脑暂不可连接，请保持电脑在线并登录同一账号。';
      }
      return {
        'ok': true,
        'personal': true,
        'resetItems': true,
        'items': [
          for (final message in transcript.messages)
            {
              'seq': message.position + 1,
              'kind': message.role == 'user' ? 'user' : 'say',
              'text': message.text,
              'at': message.createdAt?.toIso8601String(),
            },
        ],
        'last': transcript.messages.fold<int>(
          0,
          (last, message) =>
              message.position + 1 > last ? message.position + 1 : last,
        ),
        'status': busy ? 'running' : 'idle',
        'canStop': false,
        'canSend': available && !busy,
        'readOnlyReason': reason.isNotEmpty
            ? reason
            : busy
            ? '电脑正在回复，请等待本轮完成。'
            : '',
        'personalRelay': {'phase': phase, 'retry': retry, 'resolve': resolve},
        'personalDevice': source.sourceDeviceName,
      };
    }
    if (method == 'personalResolve') {
      final pending = await _pending();
      if (pending == null ||
          pending['body']['conversationId'] != source.id ||
          args['checkedOnSourcePC'] != true) {
        throw const ApiFailure('请先在来源电脑核对实际发送结果。');
      }
      await state.api.resolvePersonalRelay(pending['id'] as String);
      check();
      return {'ok': true};
    }
    if (method != 'say' && method != 'personalRetry') {
      throw const ApiFailure('此聊天沿用原电脑的执行环境，请在电脑管理底座、模型和授权。');
    }
    var pending = await _pending();
    var createdPending = false;
    if (pending != null && pending['body']['conversationId'] != source.id) {
      throw const ApiFailure('请先核对另一条聊天尚未确认的发送。');
    }
    if (method == 'say') {
      final text = args['text'];
      if (text is! String ||
          text.trim().isEmpty ||
          text.length > 50000 ||
          (args['files'] as List? ?? []).isNotEmpty ||
          (args['skills'] as List? ?? []).isNotEmpty ||
          args['executionSelection'] != null) {
        throw const ApiFailure('请发送文字；此聊天沿用电脑原有的文件、插件、模型和授权。');
      }
      if (pending != null && pending['body']['instruction'] != text.trim()) {
        throw const ApiFailure('请先核对上一条发送，未发送的新内容会保留。');
      }
      if (pending == null) {
        _lastReason = '';
        _lastPhase = '';
        await _read();
        if (transcript.hasMore ||
            transcript.conversation?.state == 'responding') {
          throw const ApiFailure('正在同步或执行，请稍后再发送。');
        }
        final target = await state.api.personalRelayTarget(source.id);
        check();
        if (target['available'] != true ||
            target['targetClientId'] != source.sourceClientId) {
          throw ApiFailure(target['reason']?.toString() ?? '原电脑暂不可连接。');
        }
        final messageId = args['messageId'];
        if (messageId != null &&
            (messageId is! String ||
                !RegExp(r'^[A-Za-z0-9_-]{1,80}$').hasMatch(messageId))) {
          throw const ApiFailure('发送编号无效，请重新打开聊天。');
        }
        pending = {
          'id': messageId ?? mobileRequestId(),
          'cursor': transcript.cursor,
          'body': {
            'conversationId': source.id,
            'targetClientId': target['targetClientId'],
            'expectedRevision': target['revision'],
            'instruction': text.trim(),
          },
        };
        await _save(pending);
        createdPending = true;
      }
    }
    if (pending == null) throw const ApiFailure('没有需要重试的发送。');
    Map<String, dynamic> receipt;
    try {
      receipt = await _status(pending);
      // A replay of an already accepted message ID is an acknowledgement only.
      if (createdPending && receipt['phase'] == 'accepted') await _save(null);
    } on ApiFailure catch (error) {
      if (error.status != 404) rethrow;
      try {
        receipt = await state.api.sendPersonalRelay(
          pending['id'] as String,
          Map<String, dynamic>.from(pending['body'] as Map),
        );
        check();
      } on ApiFailure catch (error) {
        if (const [400, 403, 409, 410, 422].contains(error.status)) {
          await _save(null);
        }
        rethrow;
      }
    }
    if (!const ['prepared', 'claimed', 'accepted'].contains(receipt['phase'])) {
      throw ApiFailure(receipt['reason']?.toString() ?? '请先核对原请求的发送结果。');
    }
    return {'ok': true};
  }
}

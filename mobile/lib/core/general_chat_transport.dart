import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'soduwork_api.dart';

class GeneralChatTransportFailure extends ApiFailure {
  const GeneralChatTransportFailure(
    super.message, {
    required super.code,
    super.status = 0,
    super.isNetwork = false,
  });
}

/// One paid request per instance. This client is independent of the shared
/// authenticated API client, so stopping a reply cannot cancel other screens.
class GeneralChatTransport {
  final http.Client Function() clientFactory;
  final Duration idleTimeout;
  final Duration totalTimeout;
  http.Client? _client;
  bool _aborted = false;
  bool _used = false;
  bool _timedOut = false;
  GeneralChatTransport({
    http.Client Function()? clientFactory,
    this.idleTimeout = const Duration(seconds: 45),
    this.totalTimeout = const Duration(minutes: 3),
  }) : clientFactory = clientFactory ?? http.Client.new;

  bool get aborted => _aborted;
  void abort() {
    _aborted = true;
    _client?.close();
  }

  Stream<String> stream({
    required String endpoint,
    required String ticket,
    required String model,
    required List<Map<String, dynamic>> messages,
    int maxTokens = 4096,
  }) async* {
    if (_used) {
      throw const GeneralChatTransportFailure(
        '本次模型请求已使用，请明确发起新请求。',
        code: 'busy',
      );
    }
    _used = true;
    if (_aborted) {
      throw const GeneralChatTransportFailure('回复已停止。', code: 'stopped');
    }
    final origin = Uri.tryParse(endpoint);
    if (origin == null ||
        !{'http', 'https'}.contains(origin.scheme) ||
        origin.host.isEmpty ||
        origin.userInfo.isNotEmpty ||
        origin.hasQuery ||
        origin.hasFragment ||
        origin.path.isNotEmpty && origin.path != '/' ||
        origin.scheme == 'http' &&
            !{'localhost', '127.0.0.1', '::1'}.contains(origin.host)) {
      throw const GeneralChatTransportFailure(
        '聊天需要有效的 HTTPS 服务地址或本机安全联调地址。',
        code: 'endpoint',
      );
    }
    if (ticket.isEmpty ||
        model.isEmpty ||
        messages.isEmpty ||
        maxTokens < 1 ||
        maxTokens > 4096) {
      throw const GeneralChatTransportFailure(
        '模型请求参数不完整。',
        code: 'configuration',
      );
    }
    _timedOut = false;
    final client = clientFactory();
    _client = client;
    final deadline = Timer(totalTimeout, () {
      _timedOut = true;
      client.close();
    });
    var completed = false;
    var chars = 0;
    try {
      final request =
          http.Request(
              'POST',
              origin.resolve('/api/v1/ai-proxy/v1/chat/completions'),
            )
            ..followRedirects = false
            ..headers.addAll({
              'Authorization': 'Bearer $ticket',
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            })
            ..body = jsonEncode({
              'model': model,
              'messages': messages,
              'stream': true,
              'max_tokens': maxTokens,
            });
      final response = await client.send(request).timeout(idleTimeout);
      if (_aborted) {
        throw const GeneralChatTransportFailure('回复已停止。', code: 'stopped');
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final reason = await _safeError(response.stream, ticket);
        throw GeneralChatTransportFailure(
          '模型请求失败（${response.statusCode}）：$reason',
          code: 'http',
          status: response.statusCode,
        );
      }
      if (!(response.headers['content-type'] ?? '').toLowerCase().startsWith(
        'text/event-stream',
      )) {
        throw const GeneralChatTransportFailure(
          '模型未返回受支持的流式文本，请检查模型服务配置。',
          code: 'protocol',
        );
      }
      await for (final data in _events(response.stream.timeout(idleTimeout))) {
        if (_aborted) {
          throw const GeneralChatTransportFailure('回复已停止。', code: 'stopped');
        }
        if (_timedOut) {
          throw const GeneralChatTransportFailure(
            '回复超时，已保留收到的内容。',
            code: 'timeout',
            isNetwork: true,
          );
        }
        if (data.trim() == '[DONE]') {
          completed = true;
          break;
        }
        dynamic parsed;
        try {
          parsed = jsonDecode(data);
        } catch (_) {
          throw const GeneralChatTransportFailure(
            '流式回复格式无法识别，已停止接收。',
            code: 'protocol',
          );
        }
        if (parsed is! Map) {
          throw const GeneralChatTransportFailure(
            '流式回复格式无法识别。',
            code: 'protocol',
          );
        }
        if (parsed['error'] != null) {
          final error = parsed['error'];
          final reason = error is Map ? error['message'] : null;
          throw GeneralChatTransportFailure(
            '模型回复失败：${_redact(reason, ticket)}',
            code: 'upstream',
          );
        }
        final choices = parsed['choices'];
        if (choices is! List) {
          throw const GeneralChatTransportFailure(
            '流式回复缺少文本选项。',
            code: 'protocol',
          );
        }
        if (choices.isEmpty) {
          continue;
        } // Optional usage-only event.
        final first = choices.first;
        if (first is! Map) {
          throw const GeneralChatTransportFailure(
            '流式回复文本选项无法识别。',
            code: 'protocol',
          );
        }
        final terminal = first['finish_reason'];
        final delta =
            first['delta'] ?? (terminal != null ? <String, dynamic>{} : null);
        if (delta is! Map) {
          throw const GeneralChatTransportFailure(
            '模型未使用受支持的文本增量协议。',
            code: 'protocol',
          );
        }
        if (delta['tool_calls'] != null ||
            delta['function_call'] != null ||
            {'tool_calls', 'function_call'}.contains(first['finish_reason'])) {
          throw const GeneralChatTransportFailure(
            '普通聊天暂不执行工具调用，请使用已有工作执行入口。',
            code: 'tools',
          );
        }
        if (delta['refusal'] is String &&
            (delta['refusal'] as String).isNotEmpty) {
          throw const GeneralChatTransportFailure(
            '模型未能提供此请求的回复，请调整问题后重试。',
            code: 'refusal',
          );
        }
        final text = delta['content'];
        if (text != null && text is! String) {
          throw const GeneralChatTransportFailure(
            '普通聊天只支持文本回复。',
            code: 'protocol',
          );
        }
        if (text is String && text.isNotEmpty) {
          chars += text.length;
          if (chars > 200000) {
            throw const GeneralChatTransportFailure(
              '回复超过单条文字上限，已保留收到的内容。',
              code: 'limit',
            );
          }
          yield text;
        }
        final finish = first['finish_reason'];
        if (finish != null && finish != '') {
          if (finish == 'stop') {
            completed = true;
            break;
          }
          if (finish == 'length') {
            throw const GeneralChatTransportFailure(
              '回复达到本次输出上限，已保留部分内容。',
              code: 'limit',
            );
          }
          if (finish == 'content_filter') {
            throw const GeneralChatTransportFailure(
              '模型未能完成此回复，请调整问题。',
              code: 'refusal',
            );
          }
          throw const GeneralChatTransportFailure(
            '模型返回了未知的结束状态，回复尚未确认完成。',
            code: 'protocol',
          );
        }
      }
      if (_timedOut) {
        throw const GeneralChatTransportFailure(
          '回复超时，已保留收到的内容。',
          code: 'timeout',
          isNetwork: true,
        );
      }
      if (_aborted) {
        throw const GeneralChatTransportFailure('回复已停止。', code: 'stopped');
      }
      if (!completed) {
        throw const GeneralChatTransportFailure(
          '回复连接中断，已保留收到的内容。',
          code: 'interrupted',
          isNetwork: true,
        );
      }
      if (chars == 0) {
        throw const GeneralChatTransportFailure(
          '模型没有返回可显示的文字，请明确选择后重试。',
          code: 'empty',
        );
      }
    } on GeneralChatTransportFailure {
      rethrow;
    } on TimeoutException {
      throw const GeneralChatTransportFailure(
        '回复连接超时，已保留收到的内容。',
        code: 'timeout',
        isNetwork: true,
      );
    } catch (_) {
      if (_timedOut) {
        throw const GeneralChatTransportFailure(
          '回复超时，已保留收到的内容。',
          code: 'timeout',
          isNetwork: true,
        );
      }
      if (_aborted) {
        throw const GeneralChatTransportFailure('回复已停止。', code: 'stopped');
      }
      throw const GeneralChatTransportFailure(
        '模型连接暂时不可用，已保留收到的内容。',
        code: 'network',
        isNetwork: true,
      );
    } finally {
      deadline.cancel();
      client.close();
      _client = null;
    }
  }

  Stream<String> _events(Stream<List<int>> bytes) async* {
    var pending = '';
    final data = <String>[];
    var size = 0;
    await for (final text in bytes.transform(utf8.decoder)) {
      pending += text;
      var end = pending.indexOf('\n');
      while (end >= 0) {
        final line = pending.substring(0, end).replaceFirst(RegExp(r'\r$'), '');
        pending = pending.substring(end + 1);
        if (line.isEmpty) {
          if (data.isNotEmpty) {
            yield data.join('\n');
          }
          data.clear();
          size = 0;
        } else if (line.startsWith('data:')) {
          final value = line.substring(5).replaceFirst(RegExp(r'^ '), '');
          size += value.length;
          if (size > 512 * 1024) {
            throw const GeneralChatTransportFailure(
              '单次流式事件过大，已停止接收。',
              code: 'limit',
            );
          }
          data.add(value);
        }
        end = pending.indexOf('\n');
      }
      if (pending.length > 512 * 1024) {
        throw const GeneralChatTransportFailure('流式事件格式超出限制。', code: 'limit');
      }
    }
    if (pending.startsWith('data:')) data.add(pending.substring(5).trimLeft());
    if (data.isNotEmpty) {
      yield data.join('\n');
    }
  }

  Future<String> _safeError(Stream<List<int>> bytes, String ticket) async {
    final buffer = <int>[];
    try {
      await for (final chunk in bytes.timeout(idleTimeout)) {
        if (buffer.length + chunk.length > 65536) {
          break;
        }
        buffer.addAll(chunk);
      }
      final body = jsonDecode(utf8.decode(buffer));
      if (body is Map) {
        final detail = body['detail'];
        final error = body['error'];
        return _redact(
          detail is Map
              ? detail['message']
              : detail ?? (error is Map ? error['message'] : null),
          ticket,
        );
      }
    } catch (_) {
      /* Raw transport errors and HTML are never shown. */
    }
    return '请检查模型权限、额度与服务状态。';
  }
}

String _redact(dynamic value, String ticket) {
  var text = value is String ? value : '请检查模型权限、额度与服务状态。';
  if (ticket.isNotEmpty) text = text.replaceAll(ticket, '[已隐藏]');
  text = text.replaceAll(
    RegExp(
      r'Bearer\s+\S+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+',
      caseSensitive: false,
    ),
    '[已隐藏]',
  );
  return text.length > 240 ? '${text.substring(0, 240)}…' : text;
}

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'soduwork_api.dart';

/// A deliberately small, explicit connectivity check. Tickets remain in memory
/// for this operation and are never returned to the UI or saved in a store.
class ModelProbe {
  final SoduWorkApi api;
  const ModelProbe(this.api);

  Future<ModelProbeResult> run(
    String model, {
    required bool Function() isCurrent,
  }) async {
    final endpoint = api.baseUrl;
    final timer = Stopwatch()..start();
    var ticket = '';
    void check() {
      if (!isCurrent() || api.baseUrl != endpoint) {
        throw const ApiFailure('账号或服务已切换，本次检查已取消。', status: 409);
      }
    }

    try {
      check();
      if (model.trim().isEmpty) throw const ApiFailure('请先选择一个可用模型。');
      final headers = await api.authorizationHeaders();
      check();
      final config = await _request(
        'GET',
        Uri.parse(
          '$endpoint/api/v1/ai-proxy/config',
        ).replace(queryParameters: {'model': model, 'agent': 'pi'}),
        headers,
      );
      check();
      if (config['ok'] != true) {
        throw ApiFailure(_safe(config['reason'], ticket: ticket));
      }
      ticket = _text(config['key']);
      final resolvedModel = _text(config['model']);
      if (ticket.isEmpty || resolvedModel != model) {
        throw const ApiFailure('模型授权响应不完整或模型已变化，请刷新后重试。');
      }
      // Never trust a server-provided URL for forwarding a credential.
      final response = await _request(
        'POST',
        Uri.parse('$endpoint/api/v1/ai-proxy/v1/chat/completions'),
        {'Authorization': 'Bearer $ticket'},
        body: {
          'model': resolvedModel,
          'messages': [
            {'role': 'user', 'content': '连接测试，请只回复：连接正常。'},
          ],
          'stream': false,
          'max_tokens': 1024,
        },
        ticket: ticket,
      );
      check();
      final choices = response['choices'];
      final first = choices is List && choices.isNotEmpty
          ? _map(choices.first)
          : <String, dynamic>{};
      final message = _map(first['message']);
      if (_text(message['content']).isEmpty) {
        throw const ApiFailure('模型返回了空回复，连接尚未确认。请稍后重试或换一个模型。');
      }
      return ModelProbeResult(model, timer.elapsed);
    } on ApiFailure {
      rethrow;
    } on TimeoutException {
      throw const ApiFailure('模型检查超时，请稍后重试。', isNetwork: true);
    } on Exception {
      throw const ApiFailure('模型暂时无法连接，请检查网络后重试。', isNetwork: true);
    } finally {
      ticket = '';
      timer.stop();
    }
  }

  Future<Map<String, dynamic>> _request(
    String method,
    Uri uri,
    Map<String, String> headers, {
    Map<String, dynamic>? body,
    String ticket = '',
  }) async {
    final request = http.Request(method, uri)..followRedirects = false;
    request.headers.addAll({...headers, 'Accept': 'application/json'});
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final response = await (() async => http.Response.fromStream(
      await api.client.send(request),
    ))().timeout(const Duration(seconds: 75));
    Map<String, dynamic> decoded;
    try {
      decoded = _map(jsonDecode(utf8.decode(response.bodyBytes)));
    } on FormatException {
      throw ApiFailure('模型服务返回了无法识别的内容（${response.statusCode}）。');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final detail = decoded['detail'];
      final error = _map(decoded['error']);
      final reason = detail is Map
          ? detail['message']
          : detail ?? error['message'];
      throw ApiFailure(
        '检查失败（${response.statusCode}）：${_safe(reason, ticket: ticket)}',
        status: response.statusCode,
      );
    }
    return decoded;
  }
}

class ModelProbeResult {
  final String model;
  final Duration elapsed;
  const ModelProbeResult(this.model, this.elapsed);
}

Map<String, dynamic> _map(dynamic value) => value is Map
    ? value.map((key, value) => MapEntry(key.toString(), value))
    : <String, dynamic>{};
String _text(dynamic value) => value is String ? value.trim() : '';

String _safe(dynamic value, {required String ticket}) {
  var message = _text(value);
  if (message.isEmpty) return '当前模型不可用，请联系管理员检查模型配置或额度。';
  if (ticket.isNotEmpty) message = message.replaceAll(ticket, '[已隐藏]');
  message = message.replaceAll(
    RegExp(
      r'(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+)',
      caseSensitive: false,
    ),
    '[已隐藏]',
  );
  return message.length > 280 ? '${message.substring(0, 280)}…' : message;
}

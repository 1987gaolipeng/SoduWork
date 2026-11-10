import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/general_chat_transport.dart';

void main() {
  test(
    'SSE handles UTF8 boundaries, CRLF comments, multiline data and done',
    () async {
      http.BaseRequest? sent;
      final bytes = utf8.encode(
        ': heartbeat\r\n\r\ndata: {"choices":[{\r\ndata: "delta":{"content":"你好🌍"},"finish_reason":null}]}\r\n\r\ndata: [DONE]\r\n\r\n',
      );
      final transport = GeneralChatTransport(
        clientFactory: () => MockClient.streaming((request, _) async {
          sent = request;
          return http.StreamedResponse(
            Stream.fromIterable(bytes.map((byte) => [byte])),
            200,
            headers: {'content-type': 'text/event-stream; charset=utf-8'},
          );
        }),
      );
      expect(await _reply(transport).toList(), ['你好🌍']);
      expect(
        sent!.url.toString(),
        'https://hub.test/api/v1/ai-proxy/v1/chat/completions',
      );
      expect(sent!.headers['Authorization'], 'Bearer fixture-proxy-ticket');
      expect(sent!.followRedirects, isFalse);
      final body = jsonDecode((sent as http.Request).body) as Map;
      expect(body['stream'], isTrue);
      expect(body.containsKey('tools'), isFalse);
      await expectLater(_reply(transport).toList(), _code('busy'));
    },
  );

  test('finish reason stop completes even without a done sentinel', () async {
    final transport = _fixture(_delta('文本') + _delta('', finish: 'stop'));
    expect(await _reply(transport).toList(), ['文本']);
  });

  for (final entry in <(String, String)>[
    (
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"tool"}]}}]}\n\n',
      'tools',
    ),
    (
      'data: {"choices":[{"delta":{"function_call":{"name":"run"}}}]}\n\n',
      'tools',
    ),
    ('data: not-json\n\n', 'protocol'),
    ('data: [DONE]\n\n', 'empty'),
    (_delta('部分文字'), 'interrupted'),
    (_delta('部分文字') + _delta('', finish: 'length'), 'limit'),
    (
      'data: {"choices":[{"delta":{"refusal":"private server text"}}]}\n\n',
      'refusal',
    ),
  ]) {
    test('stream safely rejects ${entry.$2}', () async {
      await expectLater(_reply(_fixture(entry.$1)).toList(), _code(entry.$2));
    });
  }

  test(
    'HTTP errors redact the short ticket and unrelated Bearer values',
    () async {
      final transport = _fixture(
        jsonEncode({
          'detail': {
            'message':
                '额度不足 fixture-proxy-ticket Bearer fixture-other sk-fixture',
          },
        }),
        status: 429,
      );
      await expectLater(
        _reply(transport).toList(),
        throwsA(
          isA<GeneralChatTransportFailure>()
              .having((e) => e.status, 'status', 429)
              .having((e) => e.message, 'reason', contains('额度不足'))
              .having((e) => e.message, 'redacted', isNot(contains('fixture'))),
        ),
      );
    },
  );

  test(
    'redirects and nonstream responses are never followed or mistaken for success',
    () async {
      await expectLater(
        _reply(_fixture('{}', status: 302)).toList(),
        _code('http'),
      );
      await expectLater(
        _reply(_fixture('{}', contentType: 'application/json')).toList(),
        _code('protocol'),
      );
    },
  );

  test(
    'credential destinations reject non-TLS remote URLs and userinfo',
    () async {
      for (final endpoint in [
        'http://remote.test',
        'https://user:password@hub.test',
        'https://hub.test?next=private',
      ]) {
        final transport = _fixture('');
        await expectLater(
          transport
              .stream(
                endpoint: endpoint,
                ticket: 'fixture',
                model: 'model',
                messages: [
                  {'role': 'user', 'content': 'hi'},
                ],
              )
              .toList(),
          _code('endpoint'),
        );
      }
    },
  );

  test(
    'idle stream timeout remains explicit and performs no automatic second request',
    () async {
      final source = StreamController<List<int>>();
      var calls = 0;
      final transport = GeneralChatTransport(
        idleTimeout: const Duration(milliseconds: 5),
        clientFactory: () => MockClient.streaming((request, body) async {
          calls++;
          return http.StreamedResponse(
            source.stream,
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        }),
      );
      await expectLater(_reply(transport).toList(), _code('timeout'));
      await source.close();
      expect(calls, 1);
    },
  );

  test(
    'abort closes only the dedicated client and rejects buffered late text',
    () async {
      final source = StreamController<List<int>>();
      final opened = Completer<void>();
      final client = _ClosingClient(source, opened);
      final transport = GeneralChatTransport(clientFactory: () => client);
      final operation = _reply(transport).toList();
      final stopped = expectLater(operation, _code('stopped'));
      await opened.future;
      transport.abort();
      await stopped;
      expect(client.closed, isTrue);
    },
  );
}

Stream<String> _reply(GeneralChatTransport transport) => transport.stream(
  endpoint: 'https://hub.test',
  ticket: 'fixture-proxy-ticket',
  model: 'fixture-model',
  messages: [
    {'role': 'user', 'content': '测试'},
  ],
);
Matcher _code(String value) => throwsA(
  isA<GeneralChatTransportFailure>().having((e) => e.code, 'code', value),
);
String _delta(String content, {String? finish}) =>
    'data: ${jsonEncode({
      'choices': [
        {
          'delta': {'content': content},
          'finish_reason': finish,
        },
      ],
    })}\n\n';
GeneralChatTransport _fixture(
  String value, {
  int status = 200,
  String contentType = 'text/event-stream',
}) => GeneralChatTransport(
  clientFactory: () => MockClient.streaming(
    (request, body) async => http.StreamedResponse(
      Stream.value(utf8.encode(value)),
      status,
      headers: {'content-type': contentType},
    ),
  ),
);

class _ClosingClient extends http.BaseClient {
  final StreamController<List<int>> source;
  final Completer<void> opened;
  bool closed = false;
  _ClosingClient(this.source, this.opened);
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    opened.complete();
    return http.StreamedResponse(
      source.stream,
      200,
      headers: {'content-type': 'text/event-stream'},
    );
  }

  @override
  void close() {
    closed = true;
    unawaited(source.close());
  }
}

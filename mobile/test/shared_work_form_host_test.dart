import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/shared_work_form_host.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';

import 'memory_device_auth.dart';

http.Response _json(Object value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json'},
);

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
}

SoduWorkApi _api(Future<http.Response> Function(http.Request) handler) => SoduWorkApi(
  store: _Store(),
  endpoint: const EndpointSettings(
    environment: SoduWorkEnvironment.development,
    baseUrl: 'https://hub.test',
  ),
  client: MockClient(handler),
);

SharedWorkFormHost _host(
  SoduWorkApi api, {
  void Function()? check,
  bool Function(String)? sourceAllowed,
}) => SharedWorkFormHost(
  api: api,
  identity: 'owner:device',
  check: check ?? () {},
  sourceAllowed: sourceAllowed ?? (_) => false,
  open: (_, _) async {},
);

Map<String, dynamic> _create({
  String card = 'card-1',
  String id = 'req-001',
  String title = '季度报告',
  String? assignee,
}) => {
  'operation': 'createRequirement',
  'cardId': card,
  'body': <String, dynamic>{
    'id': id,
    'title': title,
    'note': '保留原始详细说明',
    'assigneeUserId': ?assignee,
  },
};

Map<String, dynamic> _upload({
  String card = 'card-1',
  String id = 'req-001',
  Map<String, dynamic>? file,
}) => {
  'operation': 'uploadRequirementAttachment',
  'cardId': card,
  'id': id,
  'file':
      file ?? {'name': 'brief.txt', 'data': base64Encode(utf8.encode('原始材料'))},
};

void main() {
  test('需求解析原样传递模型、修订指令和材料，不创建任务', () async {
    final calls = <String>[];
    final host = _host(
      _api((request) async {
        calls.add(request.url.path);
        expect(request.url.path, '/api/v1/tasks/parse');
        final body = jsonDecode(request.body) as Map;
        expect(body['text'], '原要求，改为周五交付');
        expect(body['model'], 'allowed-model');
        expect(body['instruction'], '只调整截止日期');
        expect(body['attachments'], [
          {'name': 'brief.txt', 'content': '资料'},
        ]);
        return _json({
          'ok': true,
          'fields': {'title': '季度报告', 'due': '2026-11-06'},
        });
      }),
    );
    expect(
      await host.handle({
        'operation': 'parseRequirement',
        'cardId': 'card-1',
        'text': '原要求，改为周五交付',
        'model': 'allowed-model',
        'instruction': '只调整截止日期',
        'attachments': [
          {'name': 'brief.txt', 'content': '资料'},
        ],
      }),
      {'title': '季度报告', 'due': '2026-11-06'},
    );
    expect(calls, ['/api/v1/tasks/parse']);
  });

  test('稳定编号先GET，只有404才能PUT，剔除身份和状态注入', () async {
    final calls = <String>[];
    final host = _host(
      _api((request) async {
        calls.add('${request.method} ${request.url.path}');
        expect(request.url.path, '/api/v1/tasks/req-001');
        if (request.method == 'GET') return _json({'detail': 'missing'}, 404);
        final body = jsonDecode(request.body) as Map;
        expect(body['status'], 'todo');
        expect(body['handler'], 'me');
        expect(body.containsKey('ownerUserId'), false);
        expect(body.containsKey('id'), false);
        expect(body.containsKey('due'), false);
        expect(body['note'], '保留原始详细说明');
        return _json({'id': 'req-001', ...body});
      }),
    );
    final args = _create();
    (args['body'] as Map<String, dynamic>).addAll(<String, dynamic>{
      'ownerUserId': 'another',
      'status': 'done',
      'handler': 'other',
      'due': '',
    });
    final result = await host.handle(args) as Map;
    expect(result['id'], 'req-001');
    expect(calls, ['GET /api/v1/tasks/req-001', 'PUT /api/v1/tasks/req-001']);
  });

  test('已存在需求仅GET，不能覆盖正在执行或已完成状态', () async {
    final calls = <String>[];
    final host = _host(
      _api((request) async {
        calls.add(request.method);
        return _json({'id': 'req-001', 'title': '已修改的原需求', 'status': 'done'});
      }),
    );
    expect(await host.handle(_create()), {
      'id': 'req-001',
      'title': '已修改的原需求',
      'status': 'done',
    });
    expect(calls, ['GET']);
  });

  test('GET403不能降级为PUT新建', () async {
    final methods = <String>[];
    final host = _host(
      _api((request) async {
        methods.add(request.method);
        return _json({'detail': '无权限'}, 403);
      }),
    );
    await expectLater(host.handle(_create()), throwsA(isA<ApiFailure>()));
    expect(methods, ['GET']);
  });

  test('同card/id/body并发及完成后重复保存只执行一次，改body被拒绝', () async {
    final response = Completer<http.Response>();
    var calls = 0;
    final host = _host(
      _api((_) {
        calls++;
        return response.future;
      }),
    );
    final first = host.handle(_create());
    final second = host.handle(_create());
    await Future<void>.delayed(Duration.zero);
    expect(calls, 1);
    await expectLater(
      host.handle(_create(title: '不可覆盖的新内容')),
      throwsA(isA<ApiFailure>()),
    );
    response.complete(_json({'id': 'req-001', 'status': 'doing'}));
    expect(await first, await second);
    expect(await host.handle(_create()), {'id': 'req-001', 'status': 'doing'});
    expect(calls, 1);
  });

  test('派给他人通过真实交办接口且核对匹配回执', () async {
    final calls = <String>[];
    final host = _host(
      _api((request) async {
        calls.add(request.url.path);
        final body = jsonDecode(request.body) as Map;
        expect(body['taskId'], 'req-001');
        expect(body['assigneeUserId'], 'colleague-1');
        return _json({
          'ok': true,
          'task': {'id': 'req-001'},
          'assignmentId': 'assignment-1',
        });
      }),
    );
    expect(await host.handle(_create(assignee: 'colleague-1')), {
      'ok': true,
      'task': {'id': 'req-001'},
      'assignmentId': 'assignment-1',
    });
    expect(calls, ['/api/v1/tasks/assigned']);
  });

  for (final receipt in [
    {
      'ok': false,
      'task': {'id': 'req-001'},
    },
    {
      'ok': true,
      'task': {'id': 'another-req'},
    },
  ]) {
    test('拒绝不匹配交办回执 ${jsonEncode(receipt)}', () async {
      var calls = 0;
      final host = _host(
        _api((_) async {
          calls++;
          return _json(receipt);
        }),
      );
      await expectLater(
        host.handle(_create(assignee: 'colleague-1')),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(host.handle(_upload()), throwsA(isA<ApiFailure>()));
      expect(calls, 1);
    });
  }

  test('账号切换后GET404不能继续创建，解析晚结果不能返回', () async {
    var current = true, writes = 0;
    final response = Completer<http.Response>();
    final host = _host(
      _api((request) {
        if (request.method == 'PUT') writes++;
        return response.future;
      }),
      check: () {
        if (!current) throw const ApiFailure('账号已切换');
      },
    );
    final pending = host.handle(_create());
    await Future<void>.delayed(Duration.zero);
    current = false;
    response.complete(_json({'detail': 'missing'}, 404));
    await expectLater(pending, throwsA(isA<ApiFailure>()));
    expect(writes, 0);

    current = true;
    final parsed = Completer<http.Response>();
    final parseHost = _host(
      _api((_) => parsed.future),
      check: () {
        if (!current) throw const ApiFailure('账号已切换');
      },
    );
    final parse = parseHost.handle({
      'operation': 'parseRequirement',
      'cardId': 'card',
      'text': '需求',
    });
    await Future<void>.delayed(Duration.zero);
    current = false;
    parsed.complete(
      _json({
        'ok': true,
        'fields': {'title': '旧账号资料'},
      }),
    );
    await expectLater(parse, throwsA(isA<ApiFailure>()));
  });

  test('未创建或恢复的需求不能上传，授权仅限原card和任务', () async {
    var calls = 0;
    final host = _host(
      _api((_) async {
        calls++;
        return _json({'id': 'req-001'});
      }),
    );
    await expectLater(host.handle(_upload()), throwsA(isA<ApiFailure>()));
    expect(calls, 0);
    await host.handle(_create());
    await expectLater(
      host.handle(_upload(card: 'another-card')),
      throwsA(isA<ApiFailure>()),
    );
    await expectLater(
      host.handle(_upload(id: 'another-req')),
      throwsA(isA<ApiFailure>()),
    );
    expect(calls, 1);
  });

  test('resume必须GET真实需求并核对编号才授予该card上传能力', () async {
    final calls = <String>[];
    final host = _host(
      _api((request) async {
        calls.add('${request.method} ${request.url.path}');
        if (request.method == 'GET') return _json({'id': 'req-001'});
        expect(request.url.path, '/api/v1/tasks/req-001/attachments');
        return _json({'id': 'attachment-1'});
      }),
    );
    await host.handle({
      'operation': 'resumeRequirement',
      'cardId': 'restored-card',
      'id': 'req-001',
    });
    expect(await host.handle(_upload(card: 'restored-card')), {
      'id': 'attachment-1',
    });
    expect(calls, [
      'GET /api/v1/tasks/req-001',
      'POST /api/v1/tasks/req-001/attachments',
    ]);
  });

  test('resume回执编号不匹配不能上传', () async {
    var calls = 0;
    final host = _host(
      _api((_) async {
        calls++;
        return _json({'id': 'wrong-id'});
      }),
    );
    await expectLater(
      host.handle({
        'operation': 'resumeRequirement',
        'cardId': 'card-1',
        'id': 'req-001',
      }),
      throwsA(isA<ApiFailure>()),
    );
    await expectLater(host.handle(_upload()), throwsA(isA<ApiFailure>()));
    expect(calls, 1);
  });

  test('引用材料sourceAllowed拒绝时不读取或下载来源', () async {
    final calls = <String>[];
    final host = _host(
      _api((request) async {
        calls.add(request.url.path);
        return _json({'id': 'req-001'});
      }),
      sourceAllowed: (source) => source == 'allowed-source',
    );
    await host.handle(_create());
    await expectLater(
      host.handle(
        _upload(
          file: {'sourceTaskId': 'other-account', 'attachmentId': 'material-1'},
        ),
      ),
      throwsA(isA<ApiFailure>().having((e) => e.status, 'status', 403)),
    );
    expect(calls, ['/api/v1/tasks/req-001']);
  });

  test('材料base64长度、空文件、路径名和编码不合法不上传', () async {
    var uploads = 0;
    final host = _host(
      _api((request) async {
        if (request.method == 'POST') uploads++;
        return _json({'id': 'req-001'});
      }),
    );
    await host.handle(_create());
    for (final file in [
      {'name': 'brief.txt', 'data': 'A' * (32 * 1024 * 1024 + 1)},
      {'name': 'brief.txt', 'data': ''},
      {'name': '../brief.txt', 'data': 'YQ=='},
      {'name': 'brief.txt', 'data': '!invalid!'},
    ]) {
      await expectLater(
        host.handle(_upload(file: file)),
        throwsA(isA<ApiFailure>()),
      );
    }
    expect(uploads, 0);
  });

  test('相同材料重复上传合并，相同文件名不同内容不能误合并', () async {
    var uploads = 0;
    final host = _host(
      _api((request) async {
        if (request.method == 'GET') return _json({'id': 'req-001'});
        uploads++;
        return _json({'id': 'attachment-$uploads'});
      }),
    );
    await host.handle(_create());
    final first = await host.handle(_upload());
    expect(await host.handle(_upload()), first);
    await host.handle(_upload(file: {'name': 'brief.txt', 'data': 'YQ=='}));
    expect(uploads, 2);
  });

  test('自动化每张card独立防重复，任何card均先预检再保存暂停计划', () async {
    final calls = <String>[];
    var created = 0;
    final host = _host(
      _api((request) async {
        calls.add(request.url.path);
        final body = jsonDecode(request.body) as Map;
        expect(body['enabled'], false);
        if (request.url.path.endsWith('/preflight')) {
          return _json({'state': 'ready'});
        }
        created++;
        return _json({'id': 'schedule-$created', ...body});
      }),
    );
    Map<String, dynamic> args(String card) => {
      'operation': 'createAutomation',
      'cardId': card,
      'body': {
        'title': '周报',
        'every': 'daily',
        'enabled': true,
        'assigneeId': 'runner:mine:pi',
      },
    };
    expect((await host.handle(args('auto-1')) as Map)['id'], 'schedule-1');
    await expectLater(host.handle(args('auto-1')), throwsA(isA<ApiFailure>()));
    expect((await host.handle(args('auto-2')) as Map)['id'], 'schedule-2');
    expect(calls, [
      '/api/v1/schedules/preflight',
      '/api/v1/schedules',
      '/api/v1/schedules/preflight',
      '/api/v1/schedules',
    ]);
  });
}

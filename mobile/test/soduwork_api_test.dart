import 'dart:typed_data';
import 'memory_device_auth.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:image_picker/image_picker.dart';

void main() {
  test(
    'cloud catalogs reject successful proxy pages and incompatible shapes',
    () async {
      for (final payload in [
        '<html>Sign in</html>',
        'null',
        '[]',
        '{}',
        jsonEncode({'environments': {}, 'targets': {}}),
        jsonEncode({
          'environments': [null],
          'targets': [null],
        }),
        jsonEncode({'ok': false, 'environments': [], 'targets': []}),
      ]) {
        var calls = 0;
        final api = _api(
          MockClient((request) async {
            calls++;
            expect(request.method, 'GET');
            return http.Response(payload, 200);
          }),
        );
        addTearDown(api.client.close);
        for (final read in [
          api.cloudEnvironments,
          api.cloudConversationTargets,
        ]) {
          await expectLater(
            read(),
            throwsA(
              isA<ApiFailure>().having(
                (e) => e.message,
                'protocol error',
                contains('目录格式不正确'),
              ),
            ),
          );
        }
        expect(calls, 2);
      }
      for (final header in [
        <String, dynamic>{},
        {'ok': true},
      ]) {
        final api = _api(
          MockClient(
            (_) async =>
                _jsonResponse({...header, 'environments': [], 'targets': []}),
          ),
        );
        addTearDown(api.client.close);
        expect((await api.cloudEnvironments())['environments'], isEmpty);
        expect((await api.cloudConversationTargets())['targets'], isEmpty);
      }
    },
  );

  test(
    'cloud receipt lookup authenticates a read and rejects invalid request ids',
    () async {
      var calls = 0;
      final api = _api(
        MockClient((request) async {
          calls++;
          expect(request.method, 'GET');
          expect(request.url.path, '/api/v1/conversation-handoffs/m123');
          expect(request.headers['Authorization'], 'Device mobile-session');
          expect(request.body, isEmpty);
          return _jsonResponse({'ok': true, 'transferId': 'm123'});
        }),
      );
      addTearDown(api.client.close);
      expect(
        (await api.cloudConversationReceipt('m123'))['transferId'],
        'm123',
      );
      await expectLater(
        api.cloudConversationReceipt('../other'),
        throwsA(isA<ApiFailure>()),
      );
      expect(calls, 1);
    },
  );

  test(
    'conversation requirement files use real multipart input materials',
    () async {
      final api = _api(
        MockClient.streaming((request, body) async {
          expect(request.url.path, '/api/v1/tasks/source-target/attachments');
          expect(request.headers['Authorization'], 'Device mobile-session');
          final upload = request as http.MultipartRequest;
          expect(upload.fields, {
            'purpose': 'requirement_input',
            'field': 'description',
            'sequence': '0',
          });
          expect(upload.files.single.filename, 'result.txt');
          expect(utf8.decode(await body.toBytes()), contains('real output'));
          return http.StreamedResponse(
            Stream.value(utf8.encode(jsonEncode({'id': 'material'}))),
            200,
          );
        }),
      );
      addTearDown(api.client.close);
      final result = await api.uploadRequirementMaterial(
        'source-target',
        XFile.fromData(
          utf8.encode('real output'),
          name: 'result.txt',
          path: 'result.txt',
        ),
      );
      expect(result['id'], 'material');
    },
  );
  test(
    'review and rework uploads retain original bytes on their dedicated authorized routes',
    () async {
      final paths = <String>[];
      final api = _api(
        MockClient.streaming((request, body) async {
          expect(request.headers['Authorization'], 'Device mobile-session');
          paths.add(request.url.path);
          final upload = request as http.MultipartRequest;
          expect(upload.files.single.field, 'file');
          expect(upload.files.single.filename, 'changes.txt');
          final bytes = await body.toBytes();
          expect(utf8.decode(bytes), contains('required change'));
          return http.StreamedResponse(
            Stream.value(
              utf8.encode(
                jsonEncode({
                  'ok': true,
                  'attachment': {'id': 'proof'},
                }),
              ),
            ),
            200,
          );
        }),
      );
      addTearDown(api.client.close);
      final file = XFile.fromData(
        utf8.encode('required change'),
        name: 'changes.txt',
        path: 'changes.txt',
      );
      await api.uploadApprovalEvidence('approval', file);
      expect(
        (await api.uploadTaskReworkMaterial('task', file))['attachment']['id'],
        'proof',
      );
      await api.uploadApprovalReworkMaterial('approval', file);
      expect(paths, [
        '/api/v1/approvals/approval/evidence',
        '/api/v1/tasks/task/rework-materials',
        '/api/v1/approvals/approval/rework-materials',
      ]);
    },
  );

  test(
    'requirement lifecycle and organization templates use existing authenticated routes',
    () async {
      final seen = <String>[];
      final api = _api(
        MockClient((request) async {
          expect(request.headers['Authorization'], 'Device mobile-session');
          seen.add('${request.method} ${request.url.path}');
          if (request.url.path.endsWith('/templates')) {
            return _jsonResponse([
              {'id': 'template'},
            ]);
          }
          if (request.url.path.endsWith('/reject-artifact')) {
            expect(jsonDecode(request.body), {
              'note': '补齐依据',
              'toAI': false,
              'reworkAttachmentIds': ['evidence'],
            });
          }
          if (request.url.path.endsWith('/review')) {
            expect(jsonDecode(request.body), {'note': '验收通过'});
          }
          return _jsonResponse({
            'id': 'task',
            'needsMe': true,
            'ai': {'attentionRaised': true},
          });
        }),
      );
      addTearDown(api.client.close);
      final row = await api.taskData('task');
      expect(WorkTask.fromJson(row).needsMe, true);
      expect(WorkTask.fromJson(row).aiAttentionRaised, true);
      await api.taskAcceptanceContext('task');
      await api.reviewTaskArtifact('task', '验收通过');
      await api.rejectTaskArtifact(
        'task',
        '补齐依据',
        toAi: false,
        reworkAttachmentIds: ['evidence'],
      );
      expect((await api.automationTemplates()).single['id'], 'template');
      expect(seen, [
        'GET /api/v1/tasks/task',
        'GET /api/v1/tasks/task/acceptance-context',
        'POST /api/v1/tasks/task/review',
        'POST /api/v1/tasks/task/reject-artifact',
        'GET /api/v1/schedules/templates',
      ]);
    },
  );

  test(
    'chat, work catalogs and teammate requests use authenticated existing contracts',
    () async {
      final seen = <String>[];
      final api = _api(
        MockClient((request) async {
          seen.add('${request.method} ${request.url.path}');
          expect(request.headers['Authorization'], 'Device mobile-session');
          if (request.url.path.endsWith('/team/mates')) {
            return _jsonResponse({
              'mates': [
                {'id': 'member', 'name': '测试同事', 'canReceive': true},
              ],
            });
          }
          if (request.url.path.endsWith('/message')) {
            expect(jsonDecode(request.body), {
              'text': '说明',
              'messageId': 'stable-id',
            });
          }
          if (request.url.path.endsWith('/config')) {
            expect(request.url.queryParameters['model'], '模型 a/b');
            expect(request.url.queryParameters['agent'], 'pi');
          }
          return _jsonResponse({'ok': true});
        }),
      );
      addTearDown(api.client.close);
      expect((await api.teammates()).single['id'], 'member');
      await api.chatModelCatalog();
      await api.chatModelConfiguration('模型 a/b');
      await api.workPluginBindings();
      await api.workSkillCatalog();
      await api.sendMateMessage('member', '说明', 'stable-id');
      await api.submitMobileWork('stable-id', {
        'bindingId': 'binding',
        'inputs': {'n': 0, 'b': false},
        'instruction': '说明',
      });
      await api.mobileWorkStatus('stable-id');
      expect(seen, [
        'GET /api/v1/team/mates',
        'GET /api/v1/my-models',
        'GET /api/v1/ai-proxy/config',
        'GET /api/v1/plugins/applicable',
        'GET /api/v1/skills',
        'POST /api/v1/team/mates/member/message',
        'POST /api/v1/mobile-work/stable-id',
        'GET /api/v1/mobile-work/stable-id',
      ]);
    },
  );

  test(
    'account continuation sends source revision and instruction without client transcript',
    () async {
      final frozen = CloudConversationRequest.accountBranch(
        conversationId: 'source-id',
        revision: 9,
        text: '继续完成',
        agentId: 'pi',
        model: 'fixture',
      );
      final api = _api(
        MockClient((request) async {
          expect(request.method, 'POST');
          expect(
            request.url.path,
            '/api/v1/account-conversations/branches/${frozen.id}',
          );
          expect(request.headers['Authorization'], 'Device mobile-session');
          expect(jsonDecode(request.body), {
            'accountConversationId': 'source-id',
            'expectedRevision': 9,
            'instruction': '继续完成',
            'agentId': 'pi',
            'model': 'fixture',
          });
          return _jsonResponse({
            'ok': true,
            'phase': 'committed',
            'taskId': 'branch-task',
            'ref': 'authorized-ref',
          });
        }),
      );
      addTearDown(api.client.close);
      final value = await api.createCloudConversation(
        text: 'ignored on retry',
        request: frozen,
      );
      expect(value['taskId'], 'branch-task');
    },
  );

  test(
    'inbox pagination and read receipt use existing device routes',
    () async {
      final calls = <String>[];
      final api = _api(
        MockClient((request) async {
          calls.add('${request.method} ${request.url.path}');
          expect(request.headers['Authorization'], 'Device mobile-session');
          if (request.method == 'GET') {
            expect(request.url.queryParameters['folder'], 'sent');
            expect(request.url.queryParameters['before'], 'cursor/with space');
            return _jsonResponse({
              'ok': true,
              'items': [],
              'nextCursor': '',
              'unreadCount': 2,
            });
          }
          return _jsonResponse({
            'ok': true,
            'messageId': 'message-id',
            'status': 'read',
          });
        }),
      );
      addTearDown(api.client.close);
      expect(
        (await api.teamMessages(
          folder: 'sent',
          before: 'cursor/with space',
        ))['unreadCount'],
        2,
      );
      await api.readTeamMessage('message-id');
      expect(calls, [
        'GET /api/v1/team/messages',
        'POST /api/v1/team/messages/message-id/read',
      ]);
    },
  );
  test(
    'cloud execution reads the authenticated personal target catalog',
    () async {
      final api = _api(
        MockClient((request) async {
          expect(request.method, 'GET');
          expect(request.url.path, '/api/v1/conversation-handoffs/targets');
          expect(request.headers['Authorization'], 'Device mobile-session');
          return http.Response(
            jsonEncode({
              'targets': [],
              'diagnostics': {'state': 'not_configured'},
            }),
            200,
          );
        }),
      );
      addTearDown(api.client.close);
      final result = await api.cloudConversationTargets();
      expect(result['targets'], isEmpty);
      expect(result['diagnostics']['state'], 'not_configured');
    },
  );

  test('reads only the authenticated device Agent roster', () async {
    late http.Request captured;
    final api = _api(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'provider': 'runner',
            'default': {'id': 'runner:desk:pi'},
            'agents': [
              {
                'id': 'runner:desk:pi',
                'name': '\u529e\u516c\u7535\u8111 \u00b7 Pi',
                'type': 'agent',
                'cli': 'pi',
                'cliName': 'Pi',
                'machineLabel': '\u529e\u516c\u7535\u8111',
                'online': true,
                'busy': false,
              },
            ],
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    addTearDown(api.client.close);

    final roster = await api.aiAgents();

    expect(captured.method, 'GET');
    expect(captured.url.path, '/api/v1/ai-agents');
    expect(captured.headers['Authorization'], 'Device mobile-session');
    expect(roster.recommended?.id, 'runner:desk:pi');
  });

  test(
    'dispatches to the selected Runner seat and accepts the returned task',
    () async {
      late Map<String, dynamic> payload;
      final api = _api(
        MockClient((request) async {
          payload = jsonDecode(request.body) as Map<String, dynamic>;
          expect(request.method, 'POST');
          expect(request.url.path, '/api/v1/tasks/task-mobile/ai-dispatch');
          return http.Response(
            jsonEncode({
              'ok': true,
              'task': {
                'id': 'task-mobile',
                'title': '\u6574\u7406\u98ce\u9669\u6e05\u5355',
                'status': 'doing',
                'handler': 'auto',
                'ai': {'state': 'running', 'name': 'Pi'},
              },
            }),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      addTearDown(api.client.close);
      final assignee = AiAssignee.fromJson({
        'id': 'runner:desk:pi',
        'name': '\u529e\u516c\u7535\u8111 \u00b7 Pi',
        'type': 'agent',
        'cli': 'pi',
        'cliName': 'Pi',
        'online': true,
      });

      final task = await api.dispatchTaskToAi(
        'task-mobile',
        assignee: assignee,
        brief: '\u6309\u9a8c\u6536\u6807\u51c6\u4ea4\u4ed8',
      );

      expect(payload['assigneeId'], 'runner:desk:pi');
      expect(payload['assigneeType'], 'agent');
      expect(payload['brief'], '\u6309\u9a8c\u6536\u6807\u51c6\u4ea4\u4ed8');
      expect(task.status, 'doing');
      expect(task.aiName, 'Pi');
      expect(task.isRunning, isTrue);
    },
  );
  test(
    'loads, controls and runs the authenticated device automations',
    () async {
      final calls = <String>[];
      Map<String, dynamic>? updateBody;
      final api = _api(
        MockClient((request) async {
          calls.add(
            '${request.method} ${request.url.path}?${request.url.query}',
          );
          expect(request.headers['Authorization'], 'Device mobile-session');
          if (request.method == 'GET' &&
              request.url.path == '/api/v1/schedules') {
            return _jsonResponse([
              {
                'id': 'schedule-1',
                'title': '\u6bcf\u65e5\u5de1\u68c0',
                'enabled': true,
                'executionMode': 'personal',
                'personalPluginKey': 'daily-inspection',
              },
            ]);
          }
          if (request.method == 'GET' &&
              request.url.path == '/api/v1/schedules/schedule-1/runs') {
            return _jsonResponse({
              'items': [
                {
                  'id': 'run-1',
                  'scheduleId': 'schedule-1',
                  'state': 'succeeded',
                  'trigger': 'timer',
                },
              ],
            });
          }
          if (request.method == 'PUT' &&
              request.url.path == '/api/v1/schedules/schedule-1') {
            updateBody = jsonDecode(request.body) as Map<String, dynamic>;
            return _jsonResponse({
              'id': 'schedule-1',
              'title': '\u6bcf\u65e5\u5de1\u68c0',
              'enabled': false,
            });
          }
          if (request.method == 'POST' &&
              request.url.path == '/api/v1/schedules/schedule-1/run') {
            return _jsonResponse({'ok': true, 'taskId': 'task-9'});
          }
          return _jsonResponse({'detail': 'not found'}, statusCode: 404);
        }),
      );
      addTearDown(api.client.close);

      final schedules = await api.automations();
      final runs = await api.automationRuns('schedule-1');
      final updated = await api.setAutomationEnabled('schedule-1', false);
      final receipt = await api.runAutomation('schedule-1');

      expect(schedules.single.personalPluginKey, 'daily-inspection');
      expect(runs.single.succeeded, isTrue);
      expect(updated.enabled, isFalse);
      expect(updateBody, {'enabled': false});
      expect(receipt['taskId'], 'task-9');
      expect(calls, contains('GET /api/v1/schedules/schedule-1/runs?limit=20'));
    },
  );
  test(
    'loginWithAccount posts device credentials and stores the session',
    () async {
      late http.Request captured;
      final api = _api(
        MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'ok': true,
              'created': true,
              'session': 'session-token-1',
              'expiresIn': 86400,
              'device': {'id': 'device-1', 'userRef': 'user-9'},
              'user': {'id': 'user-9', 'username': 'alex'},
            }),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      addTearDown(api.client.close);

      final enrollment = await api.loginWithAccount(
        account: 'alex',
        password: 'secret-1',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/v1/client-auth/login');
      expect(captured.headers['X-Device-Key'], isNotEmpty);
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['device'], isNotEmpty);
      expect(body['account'], 'alex');
      expect(body['password'], 'secret-1');
      expect(body['platform'], isNotEmpty);
      expect(enrollment.active, isTrue);
      expect(enrollment.authState, 'active');
      expect(enrollment.ownerUserId, 'user-9');
    },
  );

  test('cloudConversations keeps only cloud-originated tasks', () async {
    late http.Request captured;
    final api = _api(
      MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode([
            {
              'id': 'task-cloud-1',
              'title': '生成周报',
              'status': 'doing',
              'origin': 'cloud-conversation',
              'createdByName': 'Alex',
              'created': 1735600000000,
            },
            {'id': 'task-local', 'title': '本机任务', 'status': 'todo'},
          ]),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    addTearDown(api.client.close);

    final rows = await api.cloudConversations();

    expect(captured.method, 'GET');
    expect(captured.url.path, '/api/v1/tasks');
    expect(captured.headers['Authorization'], 'Device mobile-session');
    expect(rows, hasLength(1));
    expect(rows.single['id'], 'task-cloud-1');
    expect(rows.single['origin'], 'cloud-conversation');
  });

  test('conversationSession resumes with the ref and seq cursors', () async {
    final calls = <String>[];
    final api = _api(
      MockClient((request) async {
        calls.add('${request.url.path}?${request.url.query}');
        return http.Response(
          jsonEncode({
            'ok': true,
            'ref': 'conv-77',
            'status': 'running',
            'items': [
              {'seq': 3, 'kind': 'say', 'text': '已经完成排版检查。'},
            ],
            'last': 3,
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    addTearDown(api.client.close);

    final first = await api.conversationSession('task-cc');
    final resumed = await api.conversationSession(
      'task-cc',
      ref: 'conv-77',
      since: 3,
    );

    expect(calls[0], '/api/v1/tasks/task-cc/ai-session?');
    expect(calls[1], '/api/v1/tasks/task-cc/ai-session?ref=conv-77&since=3');
    expect(first['ref'], 'conv-77');
    expect(first['last'], 3);
    expect(resumed['items'].single['seq'], 3);
  });

  test(
    'ai-say posts an idempotent message and ai-stop stops the run',
    () async {
      final bodies = <Map<String, dynamic>>[];
      final paths = <String>[];
      final api = _api(
        MockClient((request) async {
          paths.add('${request.method} ${request.url.path}');
          bodies.add(
            request.body.isEmpty
                ? <String, dynamic>{}
                : jsonDecode(request.body) as Map<String, dynamic>,
          );
          if (request.url.path.endsWith('/ai-say')) {
            return http.Response(
              jsonEncode({'ok': true, 'queued': true}),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            );
          }
          return http.Response(
            jsonEncode({'ok': true, 'state': 'stopped'}),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      addTearDown(api.client.close);

      final say = await api.sayToConversation(
        'task-cc',
        text: '再检查一遍链接',
        messageId: 'mabc123',
      );
      final stopped = await api.stopConversation('task-cc');

      expect(paths[0], 'POST /api/v1/tasks/task-cc/ai-say');
      expect(paths[1], 'POST /api/v1/tasks/task-cc/ai-stop');
      expect(bodies[0]['text'], '再检查一遍链接');
      expect(bodies[0]['messageId'], 'mabc123');
      expect(say['ok'], isTrue);
      expect(stopped['state'], 'stopped');
    },
  );

  test(
    'createCloudConversation posts multipart options and files idempotently',
    () async {
      http.MultipartRequest? captured;
      final api = _api(
        MockClient.streaming((request, _) async {
          captured = request as http.MultipartRequest;
          return http.StreamedResponse(
            Stream.value(
              utf8.encode(
                jsonEncode({
                  'ok': true,
                  'transferId': 'xfer-1',
                  'taskId': 'task-cc-9',
                  'phase': 'accepted',
                  'status': 'queued',
                  'ref': 'conv-1',
                  'target': {'name': '办公电脑 · Pi'},
                  'canAbort': true,
                }),
              ),
            ),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }),
      );
      addTearDown(api.client.close);
      final tempDir = await Directory.systemTemp.createTemp('soduwork_cc');
      addTearDown(() => tempDir.delete(recursive: true));
      final image = File('${tempDir.path}/shot.png');
      await image.writeAsBytes(List<int>.generate(8, (i) => i));

      final receipt = await api.createCloudConversation(
        text: '整理这次发布清单',
        agentId: 'pi',
        title: '发布清单',
        files: [XFile(image.path)],
      );

      final sent = captured!;
      expect(sent.method, 'POST');
      expect(sent.url.path.startsWith('/api/v1/cloud-conversations/m'), isTrue);
      final options =
          jsonDecode(sent.fields['options']!) as Map<String, dynamic>;
      expect(options['sessionId'], startsWith('mobile:m'));
      final capture = Platform.environment['SODUWORK_MOBILE_REQUEST_CAPTURE'];
      if (capture != null) {
        File(capture).writeAsStringSync(
          jsonEncode({'path': sent.url.path, 'options': options}),
        );
      }
      expect(options['text'], '整理这次发布清单');
      expect(options['agentId'], 'pi');
      expect(options['title'], '发布清单');
      expect(sent.files.single.field, 'files');
      expect(sent.files.single.filename, 'shot.png');
      expect(receipt['taskId'], 'task-cc-9');
      expect(receipt['status'], 'queued');
    },
  );

  test('taskAttachments returns the delivered result files', () async {
    final api = _api(
      MockClient((request) async {
        expect(request.url.path, '/api/v1/tasks/task-cc-9/attachments');
        return http.Response(
          jsonEncode({
            'items': [
              {
                'id': 'att-1',
                'filename': 'release-checklist.md',
                'contentType': 'text/markdown',
                'size': 1024,
                'isImage': false,
                'url': '/api/v1/attachments/att-1?ticket=t',
                'role': 'output',
                'byAgent': true,
              },
            ],
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }),
    );
    addTearDown(api.client.close);

    final rows = await api.taskAttachments('task-cc-9');

    expect(rows, hasLength(1));
    expect(rows.single['filename'], 'release-checklist.md');
    expect(
      api.absoluteUrl(rows.single['url'] as String),
      'http://soduwork.test/api/v1/attachments/att-1?ticket=t',
    );
  });
  test(
    'retries the same prepared cloud request and frozen file bytes after network failure',
    () async {
      final captured = <_CloudMultipartCapture>[];
      final api = _api(
        MockClient.streaming((request, body) async {
          captured.add(await _captureCloudMultipart(request, body));
          if (captured.length == 1) {
            throw http.ClientException('fixture connection lost');
          }
          return _cloudReceipt();
        }),
      );
      addTearDown(api.client.close);
      final directory = await Directory.systemTemp.createTemp(
        'soduwork_request_retry',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/input.bin');
      final original = [0, 255, 128, 1];
      await file.writeAsBytes(original);
      final prepared = await CloudConversationRequest.prepare(
        text: '  整理报告  ',
        agentId: 'pi',
        title: '报告',
        files: [XFile(file.path)],
      );
      await expectLater(
        api.createCloudConversation(text: '整理报告', request: prepared),
        throwsA(
          isA<ApiFailure>().having(
            (error) => error.isNetwork,
            'isNetwork',
            isTrue,
          ),
        ),
      );
      await file.writeAsBytes([9, 8, 7]);
      final receipt = await api.createCloudConversation(
        text: '整理报告',
        request: prepared,
      );
      expect(receipt['taskId'], 'task-frozen');
      expect(captured, hasLength(2));
      expect(captured[1].url, captured[0].url);
      expect(
        captured[1].url.path,
        '/api/v1/cloud-conversations/${prepared.id}',
      );
      expect(captured[1].options, captured[0].options);
      expect(captured[1].body, captured[0].body);
      expect(captured[0].body, contains(latin1.decode(original)));
      expect(prepared.files.single.bytes, original);
    },
  );

  test(
    '401 refresh retains the prepared multipart identity options and attachment',
    () async {
      final captured = <_CloudMultipartCapture>[];
      var enrollments = 0;
      final api = _api(
        MockClient.streaming((request, body) async {
          if (request.url.path == '/api/v1/clients/enroll') {
            enrollments++;
            await body.toBytes();
            return http.StreamedResponse(
              Stream.value(
                utf8.encode(
                  jsonEncode({
                    'session': 'renewed-mobile-session',
                    'authState': 'active',
                  }),
                ),
              ),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          captured.add(await _captureCloudMultipart(request, body));
          return captured.length == 1
              ? http.StreamedResponse(const Stream<List<int>>.empty(), 401)
              : _cloudReceipt();
        }),
      );
      addTearDown(api.client.close);
      final directory = await Directory.systemTemp.createTemp(
        'soduwork_request_401',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/input.txt');
      await file.writeAsBytes(utf8.encode('input snapshot'));
      final prepared = await CloudConversationRequest.prepare(
        text: '复核报告',
        agentId: 'pi',
        files: [XFile(file.path)],
      );
      await api.createCloudConversation(text: '复核报告', request: prepared);
      expect(enrollments, 1);
      expect(captured, hasLength(2));
      expect(captured[0].authorization, 'Device mobile-session');
      expect(captured[1].authorization, 'Device renewed-mobile-session');
      expect(captured[1].url, captured[0].url);
      expect(captured[1].options, captured[0].options);
      expect(captured[1].body, captured[0].body);
      expect(captured[0].options['sessionId'], 'mobile:${prepared.id}');
    },
  );

  test(
    'cloud creation stops after one refresh when the second response is also 401',
    () async {
      var enrollments = 0;
      final captured = <_CloudMultipartCapture>[];
      final api = _api(
        MockClient.streaming((request, body) async {
          if (request.url.path == '/api/v1/clients/enroll') {
            enrollments++;
            await body.toBytes();
            return http.StreamedResponse(
              Stream.value(
                utf8.encode(
                  jsonEncode({
                    'session': 'renewed-mobile-session',
                    'authState': 'active',
                  }),
                ),
              ),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          captured.add(await _captureCloudMultipart(request, body));
          return http.StreamedResponse(const Stream<List<int>>.empty(), 401);
        }),
      );
      addTearDown(api.client.close);
      final prepared = await CloudConversationRequest.prepare(
        text: '报告',
        agentId: 'pi',
      );
      await expectLater(
        api.createCloudConversation(text: '报告', request: prepared),
        throwsA(
          isA<ApiFailure>().having((error) => error.status, 'status', 401),
        ),
      );
      expect(enrollments, 1);
      expect(captured, hasLength(2));
      expect(captured[1].url, captured[0].url);
      expect(captured[1].options, captured[0].options);
    },
  );

  test(
    'switching Hub while awaiting authentication never sends the old Device identity',
    () async {
      final store = _WaitingSessionStore();
      final outgoing = <Uri>[];
      final api = _api(
        MockClient((request) async {
          outgoing.add(request.url);
          return _jsonResponse({'ok': true, 'taskId': 'must-not-send'});
        }),
        store: store,
      );
      addTearDown(api.client.close);
      final prepared = await CloudConversationRequest.prepare(
        text: '报告',
        agentId: 'pi',
      );
      final operation = api.createCloudConversation(
        text: '报告',
        request: prepared,
      );
      final rejected = expectLater(
        operation,
        throwsA(
          isA<ApiFailure>().having((error) => error.status, 'status', 409),
        ),
      );
      await store.readStarted.future;
      api.setEndpoint(
        const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://new-hub.test',
        ),
      );
      store.release.complete('mobile-session');
      await rejected;
      expect(outgoing, isEmpty);
    },
  );

  test(
    'switching Hub during cloud creation rejects the late old-Hub receipt',
    () async {
      final sent = Completer<void>();
      final response = Completer<http.StreamedResponse>();
      final captured = <_CloudMultipartCapture>[];
      final api = _api(
        MockClient.streaming((request, body) async {
          captured.add(await _captureCloudMultipart(request, body));
          sent.complete();
          return response.future;
        }),
      );
      addTearDown(api.client.close);
      final prepared = await CloudConversationRequest.prepare(
        text: '报告',
        agentId: 'pi',
      );
      final operation = api.createCloudConversation(
        text: '报告',
        request: prepared,
      );
      final rejected = expectLater(
        operation,
        throwsA(
          isA<ApiFailure>().having((error) => error.status, 'status', 409),
        ),
      );
      await sent.future;
      api.setEndpoint(
        const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'http://new-hub.test',
        ),
      );
      response.complete(_cloudReceipt());
      await rejected;
      expect(captured, hasLength(1));
      expect(captured.single.url.host, 'soduwork.test');
      expect(captured.single.authorization, 'Device mobile-session');
    },
  );

  test(
    'rejects a Runner assignee ID before sending a cloud creation request',
    () async {
      var outgoing = 0;
      final api = _api(
        MockClient((request) async {
          outgoing++;
          return _jsonResponse({'ok': true});
        }),
      );
      addTearDown(api.client.close);
      await expectLater(
        api.createCloudConversation(text: '报告', agentId: 'runner:desk:pi'),
        throwsA(isA<ApiFailure>()),
      );
      expect(outgoing, 0);
    },
  );
  test(
    'plugin draft preflight and submission use the governed Hub routes',
    () async {
      final seen = <String>[];
      final api = _api(
        MockClient((request) async {
          seen.add('${request.method} ${request.url.path}');
          return _jsonResponse({
            'ok': true,
            'plugin': {'id': 'plugin-1'},
            'preview': {'name': '移动插件'},
          });
        }),
      );
      addTearDown(api.client.close);
      final draft = <String, dynamic>{
        'template': 'method',
        'name': '移动插件',
        'description': '用于测试',
        'instructions': '按步骤执行并交付结果',
        'version': '0.1.0',
      };
      await api.preflightPluginDraft(draft);
      await api.createPluginDraft(draft);
      expect(seen, [
        'POST /api/v1/plugins/drafts/preflight',
        'POST /api/v1/plugins/drafts',
      ]);
    },
  );
  test(
    'plugin installation freezes version and typed preferences and verifies receipt',
    () async {
      final requests = <http.Request>[];
      final api = _api(
        MockClient((request) async {
          requests.add(request);
          final body = jsonDecode(request.body) as Map;
          return _jsonResponse({
            'ok': true,
            'pluginId': 'plugin-1',
            'installation': {'installed': body['enabled']},
          });
        }),
      );
      addTearDown(api.client.close);
      await api.setPluginInstallation(
        'plugin-1',
        enabled: true,
        expectedVersionId: 'immutable-v1',
        config: {
          'count': 3,
          'enabled': false,
          'days': ['mon', 'fri'],
        },
      );
      expect(requests.single.method, 'PUT');
      expect(requests.single.url.path, '/api/v1/plugins/plugin-1/installation');
      expect(jsonDecode(requests.single.body), {
        'enabled': true,
        'expectedVersionId': 'immutable-v1',
        'config': {
          'count': 3,
          'enabled': false,
          'days': ['mon', 'fri'],
        },
      });
      await api.setPluginInstallation('plugin-1', enabled: false);
      expect(jsonDecode(requests.last.body), {'enabled': false});
    },
  );
  test(
    'empty or mismatched installation receipt cannot report success',
    () async {
      for (final result in [
        {},
        {
          'ok': true,
          'pluginId': 'other',
          'installation': {'installed': true},
        },
        {
          'ok': true,
          'pluginId': 'plugin-1',
          'installation': {'installed': false},
        },
      ]) {
        final api = _api(MockClient((_) async => _jsonResponse(result)));
        addTearDown(api.client.close);
        await expectLater(
          api.setPluginInstallation(
            'plugin-1',
            enabled: true,
            expectedVersionId: 'v1',
          ),
          throwsA(isA<ApiFailure>()),
        );
      }
    },
  );
  test(
    'plugin package multipart keeps filename and bytes and never follows redirects',
    () async {
      final api = _api(
        MockClient.streaming((request, body) async {
          expect(request.url.path, '/api/v1/plugins/preflight');
          expect(request.followRedirects, isFalse);
          final multipart = request as http.MultipartRequest;
          expect(multipart.files.single.filename, 'fixture.soduwork-plugin');
          final bytes = await body.toBytes();
          expect(latin1.decode(bytes), contains('PK-fixture-content'));
          return http.StreamedResponse(
            Stream.value(
              utf8.encode(
                jsonEncode({
                  'manifest': {'name': 'fixture'},
                  'personalDraft': {'name': 'fixture'},
                }),
              ),
            ),
            200,
          );
        }),
      );
      addTearDown(api.client.close);
      final result = await api.preflightPluginPackage(
        XFile.fromData(
          Uint8List.fromList(utf8.encode('PK-fixture-content')),
          name: 'fixture.soduwork-plugin',
          path: 'fixture.soduwork-plugin',
        ),
      );
      expect((result['manifest'] as Map)['name'], 'fixture');
    },
  );
  test(
    'invalid plugin package rejected before authentication or network',
    () async {
      var calls = 0;
      final api = _api(
        MockClient((_) async {
          calls++;
          return _jsonResponse({});
        }),
      );
      addTearDown(api.client.close);
      for (final file in [
        XFile.fromData(Uint8List(1), name: 'file.exe', path: 'file.exe'),
        XFile.fromData(Uint8List(0), name: 'empty.zip', path: 'empty.zip'),
        XFile.fromData(
          Uint8List(10 * 1024 * 1024 + 1),
          name: 'large.zip',
          path: 'large.zip',
        ),
      ]) {
        await expectLater(
          api.preflightPluginPackage(file),
          throwsA(isA<ApiFailure>()),
        );
      }
      expect(calls, 0);
    },
  );
}

http.Response _jsonResponse(Object body, {int statusCode = 200}) {
  return http.Response(
    jsonEncode(body),
    statusCode,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
}

SoduWorkApi _api(http.Client client, {DeviceStore? store}) {
  return SoduWorkApi(
    store: store ?? _SessionStore(),
    endpoint: const EndpointSettings(
      environment: SoduWorkEnvironment.development,
      baseUrl: 'http://soduwork.test',
    ),
    client: client,
  );
}

class _SessionStore extends DeviceStore with MemoryDeviceAuthentication {
  String session = 'mobile-session';
  @override
  Future<String?> readSession(String endpoint) async => session;

  @override
  Future<void> clearSession(String endpoint) async {
    session = '';
  }

  @override
  Future<void> writeSession(String endpoint, String value) async {
    session = value;
  }

  @override
  Future<DeviceCredentials> credentials(String endpoint) async =>
      const DeviceCredentials(
        id: 'device-1',
        secret: 'test-device-secret-for-unit-tests-000000',
        name: 'SoduWork Mobile',
        platform: 'Android',
      );
}

class _WaitingSessionStore extends _SessionStore {
  final readStarted = Completer<void>();
  final release = Completer<String>();

  @override
  Future<String?> readSession(String endpoint) async {
    readStarted.complete();
    return release.future;
  }
}

class _CloudMultipartCapture {
  final Uri url;
  final Map<String, dynamic> options;
  final String body;
  final String? authorization;

  const _CloudMultipartCapture(
    this.url,
    this.options,
    this.body,
    this.authorization,
  );
}

Future<_CloudMultipartCapture> _captureCloudMultipart(
  http.BaseRequest request,
  http.ByteStream body,
) async {
  final multipart = request as http.MultipartRequest;
  expect(request.followRedirects, isFalse);
  final boundary = RegExp(
    r'boundary=([^;]+)',
  ).firstMatch(request.headers['content-type']!)!.group(1)!;
  final bytes = await body.toBytes();
  return _CloudMultipartCapture(
    request.url,
    jsonDecode(multipart.fields['options']!) as Map<String, dynamic>,
    latin1.decode(bytes).replaceAll(boundary, 'STABLE_MULTIPART_BOUNDARY'),
    request.headers['Authorization'],
  );
}

http.StreamedResponse _cloudReceipt() => http.StreamedResponse(
  Stream.value(utf8.encode(jsonEncode({'ok': true, 'taskId': 'task-frozen'}))),
  200,
  headers: {'content-type': 'application/json'},
);

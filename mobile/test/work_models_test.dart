import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/models/work_models.dart';

void main() {
  group('EndpointSettings', () {
    test('normalizes server addresses without mixing API prefixes', () {
      expect(
        EndpointSettings.normalize('192.0.2.149:8989/api/v1/'),
        'http://192.0.2.149:8989',
      );
      expect(
        EndpointSettings.normalize(' https://soduwork.example.com/// '),
        'https://soduwork.example.com',
      );
      expect(EndpointSettings.normalize(''), isEmpty);
    });
  });

  group('WorkTask', () {
    test(
      'finished AI execution is not running while requirement awaits review',
      () {
        for (final stage in ['delivering', 'reviewing']) {
          final task = WorkTask.fromJson({
            'id': 'r3',
            'status': 'doing',
            'requirementStage': stage,
            'ai': {'state': 'done', 'executionState': 'done'},
          });
          expect(task.isRunning, isFalse);
          expect(task.isOpen, isTrue);
        }
      },
    );

    test('authoritative execution state wins over stale task summary', () {
      final task = WorkTask.fromJson({
        'id': 'r3',
        'status': 'doing',
        'ai': {'state': 'running', 'executionState': 'done'},
      });
      expect(task.isRunning, isFalse);
    });

    test('parses the real backend task shape', () {
      final task = WorkTask.fromJson({
        'id': 'task-1',
        'title': '\u68c0\u67e5\u751f\u4ea7\u6570\u636e',
        'status': 'doing',
        'priority': 'high',
        'created': 1723520000000,
        'due': 1723606400000,
        'handler': 'auto',
        'tags': ['data', 'daily'],
        'progress': [
          {'text': '\u5df2\u8bfb\u53d6\u6570\u636e', 'at': 1723520300000},
        ],
        'ai': {'state': 'running', 'name': 'Pi', 'error': ''},
      });

      expect(task.id, 'task-1');
      expect(task.isOpen, isTrue);
      expect(task.isRunning, isTrue);
      expect(task.isAi, isTrue);
      expect(task.needsAttention, isFalse);
      expect(task.tags, ['data', 'daily']);
      expect(task.latestProgress, '\u5df2\u8bfb\u53d6\u6570\u636e');
    });

    test('marks failed AI tasks as needing attention', () {
      final task = WorkTask.fromJson({
        'id': 'task-2',
        'title': '\u751f\u6210\u62a5\u8868',
        'status': 'doing',
        'ai': {'state': 'failed', 'error': 'timeout'},
      });

      expect(task.needsAttention, isTrue);
      expect(task.isRunning, isFalse);
    });
  });

  group('AiRoster', () {
    test(
      'parses the real Runner seat shape and recommends an available agent',
      () {
        final roster = AiRoster.fromJson({
          'default': {'id': 'runner:office-1:opencode'},
          'provider': 'runner',
          'agents': [
            {
              'id': 'runner:office-1:opencode',
              'name': '\u529e\u516c\u7535\u8111 \u00b7 OpenCode',
              'type': 'agent',
              'cli': 'opencode',
              'cliName': 'OpenCode',
              'machineLabel': '\u529e\u516c\u7535\u8111',
              'online': true,
              'busy': true,
              'remote': true,
            },
            {
              'id': 'runner:office-1:pi',
              'name': '\u529e\u516c\u7535\u8111 \u00b7 Pi',
              'type': 'agent',
              'cli': 'pi',
              'cliName': 'Pi',
              'machineLabel': '\u529e\u516c\u7535\u8111',
              'online': true,
              'busy': false,
              'remote': true,
            },
            {
              'id': 'runner:offline:pi',
              'name': '\u79bb\u7ebf\u7535\u8111 \u00b7 Pi',
              'cli': 'pi',
              'online': false,
            },
          ],
        });

        expect(roster.selectableAgents, hasLength(2));
        expect(roster.recommended?.cli, 'pi');
        expect(roster.recommended?.machineLabel, '\u529e\u516c\u7535\u8111');
        expect(roster.selectableAgents.first.foundationLabel, 'OpenCode');
      },
    );

    test('keeps dispatched, running and stalled states explicit', () {
      final running = AiExecutionStatus.fromJson({
        'dispatched': true,
        'runner': {'state': 'running', 'host': 'DESKTOP-SODUWORK', 'cliName': 'Pi'},
      });
      final stalled = AiExecutionStatus.fromJson({
        'dispatched': true,
        'stalled': true,
        'runner': {
          'done': true,
          'error': '\u6ca1\u6709\u6536\u5230\u4ea4\u4ed8\u7269',
        },
      });

      expect(running.running, isTrue);
      expect(running.host, 'DESKTOP-SODUWORK');
      expect(running.cliName, 'Pi');
      expect(stalled.running, isFalse);
      expect(stalled.stalled, isTrue);
    });
  });

  group('ApprovalItem', () {
    test('keeps task and evidence in a single gate model', () {
      final approval = ApprovalItem.fromJson({
        'id': 'gate-1',
        'action': 'uat',
        'status': 'pending',
        'createdAt': 1723520000000,
        'task': {'id': 'task-3', 'title': '\u9a8c\u6536\u767b\u5f55\u9875'},
        'gate': {
          'packet': {
            'evidence': [
              {'name': 'login.png'},
              {'name': 'health.json'},
            ],
          },
        },
      });

      expect(approval.task.id, 'task-3');
      expect(approval.actionLabel, '\u9a8c\u6536\u786e\u8ba4');
      expect(approval.evidenceCount, 2);
    });
  });

  group('PersonalBrief', () {
    test('parses personal report envelope', () {
      final brief = PersonalBrief.fromEnvelope({
        'period': {'type': 'daily', 'label': '\u4eca\u65e5\u7b80\u62a5'},
        'personal': {
          'hasMaterial': true,
          'doneCount': 3,
          'activeCount': 2,
          'progressCount': 4,
          'report': {
            'content': '\u4eca\u65e5\u5b8c\u6210\u4e09\u9879\u5de5\u4f5c\u3002',
          },
        },
      });

      expect(brief.hasMaterial, isTrue);
      expect(brief.doneCount, 3);
      expect(brief.activeCount, 2);
      expect(brief.progressCount, 4);
      expect(brief.content, contains('\u4e09\u9879\u5de5\u4f5c'));
    });
  });
  group('AutomationSchedule', () {
    test('keeps plugin pinning and recovery state explicit', () {
      final schedule = AutomationSchedule.fromJson({
        'id': 'schedule-1',
        'title': '\u6bcf\u65e5\u5de1\u68c0',
        'timeZone': 'Asia/Shanghai',
        'nextRunLocal': '2026-08-22T18:00:00',
        'executionMode': 'personal',
        'personalPluginKey': 'daily-inspection',
        'personalPluginVersionPolicy': 'fixed',
        'personalPluginVersion': '1.3.0',
        'lastError': 'runner offline',
        'retrying': false,
        'retryCount': 2,
        'retryLimit': 3,
        'requiredCapabilities': ['browser-use', 'mcp'],
      });

      expect(schedule.enabled, isTrue);
      expect(schedule.needsAttention, isTrue);
      expect(schedule.methodLabel, contains('daily-inspection v1.3.0'));
      expect(schedule.methodLabel, contains('\u56fa\u5b9a\u7248\u672c'));
      expect(schedule.requiredCapabilities, ['browser-use', 'mcp']);
    });
  });

  group('AutomationRun', () {
    test(
      'execution location uses the recorded kind rather than the host name',
      () {
        for (final sample in [
          ('cloud', '本机移动端执行器', '云端执行机 · 本机移动端执行器'),
          ('work-computer', 'Cloud office', '工作电脑 · Cloud office'),
          ('', 'Cloud office', 'Cloud office'),
        ]) {
          final run = AutomationRun.fromJson({
            'receipt': {
              'targetRunnerKind': sample.$1,
              'route': {
                'resolved': {'host': sample.$2},
              },
            },
          });
          expect(run.routeLabel, sample.$3);
        }
      },
    );
    test('parses plugin and Runner receipt into an auditable route', () {
      final run = AutomationRun.fromJson({
        'id': 'run-1',
        'scheduleId': 'schedule-1',
        'trigger': 'retry',
        'state': 'succeeded',
        'attempt': 0,
        'taskId': 'task-4',
        'durationSeconds': 42,
        'receipt': {
          'plugin': {
            'name': '\u9700\u6c42\u5230\u53d1\u5e03',
            'version': '2.1.0',
          },
          'route': {
            'resolved': {
              'host': 'DESKTOP-SODUWORK',
              'agent': 'Pi',
              'model': 'dev-coding-large-agent-soduwork',
            },
          },
        },
      });

      expect(run.succeeded, isTrue);
      expect(run.attempt, 1);
      expect(run.triggerLabel, '\u81ea\u52a8\u91cd\u8bd5');
      expect(run.pluginLabel, '\u9700\u6c42\u5230\u53d1\u5e03 v2.1.0');
      expect(run.routeLabel, contains('DESKTOP-SODUWORK \u00b7 Pi'));
      expect(run.routeLabel, contains('dev-coding-large-agent-soduwork'));
    });
  });
}

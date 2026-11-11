import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/conversation_models.dart';
import 'package:soduwork_mobile/models/work_models.dart';

void main() {
  test('cloud conversation parses the enriched task envelope', () {
    final conversation = CloudConversation.fromJson({
      'id': 'task-cc-1',
      'title': '生成上线检查清单',
      'status': 'doing',
      'created': 1735600000000,
      'origin': 'cloud-conversation',
      'createdByName': 'Alex',
      'ai': {'state': 'running', 'name': 'Pi'},
      'workRouting': {
        'cloudConversation': {
          'requestId': 'm123',
          'sessionId': 'sess-9',
        },
        'requiredSkills': ['release'],
        'suggestedSkills': ['docs'],
      },
    });

    expect(conversation.id, 'task-cc-1');
    expect(conversation.isCloudConversation, isTrue);
    expect(conversation.requestId, 'm123');
    expect(conversation.sessionId, 'sess-9');
    expect(conversation.requiredSkills, ['release']);
    expect(conversation.task.aiState, 'running');
    expect(conversation.running, isTrue);
    expect(conversation.finished, isFalse);
    expect(conversation.agentLabel, 'Pi');
    expect(
      conversation.createdDate,
      DateTime.fromMillisecondsSinceEpoch(1735600000000),
    );
  });

  test('agent label falls back to the requester name and then empty', () {
    final byAi = CloudConversation.fromJson({
      'id': 't1',
      'title': 'a',
      'status': 'todo',
      'created': 0,
      'ai': {'name': 'OpenCode'},
    });
    final byRequester = CloudConversation.fromJson({
      'id': 't2',
      'title': 'b',
      'status': 'todo',
      'created': 0,
      'createdByName': 'Sam',
    });
    final anonymous = CloudConversation.fromJson({
      'id': 't3',
      'title': 'c',
      'status': 'todo',
      'created': 0,
    });

    expect(byAi.agentLabel, 'OpenCode');
    expect(byRequester.agentLabel, 'Sam');
    expect(anonymous.agentLabel, '');
  });

  test('terminal states stop the live view, running states keep polling', () {
    for (final state in const ['done', 'failed', 'cancelled', 'stopped']) {
      expect(isTerminalConversationState(state), isTrue, reason: state);
      expect(isRunningConversationState(state), isFalse, reason: state);
    }
    for (final state in const [
      'dispatching',
      'queued',
      'running',
      'working',
      'streaming',
    ]) {
      expect(isRunningConversationState(state), isTrue, reason: state);
      expect(isTerminalConversationState(state), isFalse, reason: state);
    }
    expect(isTerminalConversationState('DONE '), isTrue);
    expect(
      conversationStateLabel('running'),
      '执行中',
    );
    expect(
      conversationStateLabel('cancelled'),
      '已停止',
    );
    expect(conversationStateLabel('unknown'), '');
  });

  test('conversation events dispatch by kind and prefer the full body', () {
    final say = ConversationEvent.fromJson({
      'seq': 4,
      'kind': 'say',
      'text': '前端检查完毕。',
      'full': '前端检查完毕，共核对 12 个页面，全部通过。',
      'at': '2026-02-11T09:30:00Z',
    });
    final step = ConversationEvent.fromJson({
      'seq': 5,
      'kind': 'do',
      'tool': 'bash',
      'text': 'flutter test',
      'isError': true,
    });
    final thinking = ConversationEvent.fromJson({
      'seq': 6,
      'kind': 'thinking',
      'text': '准备核对构建产物',
    });
    final withAttachments = ConversationEvent.fromJson({
      'seq': 7,
      'kind': 'out',
      'text': '已生成',
      'attachments': [
        {'name': 'report.md'},
        {'name': ''},
      ],
    });

    expect(say.isUser, isFalse);
    expect(say.displayText, '前端检查完毕，共核对 12 个页面，全部通过。');
    expect(DateTime.parse('2026-02-11T09:30:00Z'), isNotNull);
    expect(step.isStep, isTrue);
    expect(step.isError, isTrue);
    expect(step.stepLabel, 'bash');
    expect(step.displayText, 'flutter test');
    expect(thinking.isThinking, isTrue);
    expect(withAttachments.isSay, isTrue);
    expect(withAttachments.attachmentNames, ['report.md']);
  });

  test('attachments separate agent deliverables from uploaded inputs', () {
    final deliverable = ConversationAttachment.fromJson({
      'id': 'att-1',
      'filename': 'checklist.pdf',
      'contentType': 'application/pdf',
      'size': 20480,
      'isImage': false,
      'url': '/api/v1/attachments/att-1?ticket=t',
      'role': 'output',
      'byAgent': true,
      'createdAt': '2026-02-11T10:00:00Z',
    });
    final uploaded = ConversationAttachment.fromJson({
      'id': 'att-2',
      'filename': 'ref.png',
      'size': 512,
      'isImage': true,
      'url': '/api/v1/attachments/att-2?ticket=t',
      'role': 'input',
    });

    expect(deliverable.isDeliverable, isTrue);
    expect(deliverable.isInput, isFalse);
    expect(deliverable.size, 20480);
    expect(deliverable.createdAt, isNotNull);
    expect(uploaded.isInput, isTrue);
    expect(uploaded.isDeliverable, isFalse);
    expect(uploaded.isImage, isTrue);
  });

  test('work tasks carry the cloud origin through parsing', () {
    final task = WorkTask.fromJson({
      'id': 'task-cc-2',
      'title': '修复发布脚本',
      'status': 'doing',
      'created': 1735600000000,
      'origin': 'cloud-conversation',
      'createdByName': 'Jordan',
    });
    final legacy = WorkTask.fromJson({
      'id': 'task-old',
      'title': '旧任务',
      'status': 'todo',
      'created': 1735600000000,
    });

    expect(task.origin, 'cloud-conversation');
    expect(task.createdByName, 'Jordan');
    expect(legacy.origin, '');
    expect(legacy.createdByName, '');
    expect(task.isOpen, isTrue);
  });
}

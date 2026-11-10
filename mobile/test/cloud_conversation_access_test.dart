import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/cloud_conversation_access.dart';
import 'package:soduwork_mobile/models/work_models.dart';

void main() {
  test('automatic review is read-only with its own actionable reason', () {
    final access = cloudConversationAccess(null, {
      'canSend': false,
      'mobileAcceptance': {
        'binding': {'taskId': 'source'},
      },
    });
    expect(access['canSend'], false);
    expect(access['readOnlyReason'], contains('原需求'));
    expect(access['readOnlyReason'], isNot(contains('创建会话的设备')));
  });
  WorkTask task(String origin, {bool readOnly = true, bool canSend = false}) =>
      WorkTask.fromJson({
        'id': 'task',
        'origin': origin,
        'readOnly': readOnly,
        'canSend': canSend,
      });

  test('legacy cloud hint only denies; matching ownership grants nothing', () {
    expect(
      cloudConversationAccess(task('cloud-conversation'), {})['canSend'],
      false,
    );
    expect(
      cloudConversationAccess(task('cloud-conversation', readOnly: false), {}),
      isEmpty,
    );
    expect(
      cloudConversationAccess(
        task('cloud-conversation', canSend: true),
        {},
      )['canSend'],
      true,
    );
    expect(cloudConversationAccess(task('requirement'), {}), isEmpty);
    expect(cloudConversationAccess(null, {'canStop': false}), isEmpty);
  });

  test(
    'explicit session capabilities override hints without trusting strings',
    () {
      expect(
        cloudConversationAccess(task('cloud-conversation'), {
          'canSend': true,
        })['canSend'],
        true,
      );
      expect(
        cloudConversationAccess(null, {'canSend': false})['readOnlyReason'],
        contains('仅可查看'),
      );
      expect(
        cloudConversationAccess(task('cloud-conversation'), {
          'canSend': 'true',
        })['canSend'],
        false,
      );
      expect(cloudConversationAccess(null, {}), isEmpty);
    },
  );
}

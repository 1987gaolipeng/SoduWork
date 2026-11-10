import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/requirement_review_conversation.dart';
import 'package:soduwork_mobile/core/requirement_review_history.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'requirement_review_conversation_test.dart' show ReviewApi, packet;

final review = RequirementReviewConversation.fromPacket('source', packet());

Map<String, dynamic> stored(String id, int created) => {
  'id': id,
  'createdAt': created,
  'origin': 'cloud-conversation',
  'createdBy': 'user',
  'canSend': true,
  'canViewExecution': true,
  'workRouting': {
    'cloudConversation': {'sessionId': 'mobile:$id'},
  },
  'note':
      '【验收分析】\nInstructions\n固定版本材料：\n${jsonEncode({'taskId': review.taskId, 'approvalId': review.approvalId, 'artifactVersionId': review.artifactVersionId, 'requirementVersion': review.requirementVersion})}\n验收人补充说明：\nRead the delivered result.',
};

class HistoryApi extends ReviewApi {
  List<Map<String, dynamic>> rows = [];
  Map<String, dynamic>? refreshed;
  Object? failure;
  Map<String, dynamic> session = {};
  void Function()? onList;
  @override
  Future<Map<String, dynamic>> conversationSession(
    String id, {
    String ref = '',
    int since = 0,
  }) async => session;
  @override
  Future<List<Map<String, dynamic>>> cloudConversations() async {
    onList?.call();
    if (failure != null) throw failure!;
    return rows;
  }

  @override
  Future<Map<String, dynamic>> taskData(String id) async =>
      refreshed ?? rows.singleWhere((row) => row['id'] == id);
}

void main() {
  test(
    'automatic review reopens pending work but allows a new attempt after report failure',
    () async {
      final automatic = RequirementReviewConversation.fromPacket(
        'source',
        packet(),
        automatic: true,
      );
      final row = stored('auto', 1);
      row['note'] = (row['note'] as String).replaceFirst('【验收分析】', '【自动验收】');
      final api = HistoryApi()..rows = [row];
      api.session = {
        'mobileAcceptance': {'result': null},
      };
      expect(await findReviewHistory(api, automatic, 'user', () {}), 'auto');
      api.session = {
        'mobileAcceptance': {
          'result': {'error': 'No report'},
        },
      };
      expect(await findReviewHistory(api, automatic, 'user', () {}), isEmpty);
    },
  );
  test(
    'fresh navigation recovers the latest exact-version authorized analysis',
    () async {
      final api = HistoryApi()..rows = [stored('old', 1), stored('new', 2)];
      expect(await findReviewHistory(api, review, 'user', () {}), 'new');
      expect(api.reads, 1);
    },
  );
  test(
    'unrelated, archived, unproven and unauthorized rows are not associations',
    () {
      final base = stored('analysis', 1);
      for (final patch in [
        {'createdBy': 'other'},
        {'canSend': false},
        {'canViewExecution': false},
        {'origin': 'local'},
        {'archivedAt': 1},
        {'workRouting': {}},
        {'id': 'source'},
        {'note': 'same title only'},
        {
          'note': (base['note'] as String).replaceAll(
            'version-1',
            'other-version',
          ),
        },
        {
          'note': (base['note'] as String).replaceAll(
            'approval',
            'other-approval',
          ),
        },
        {'note': '【验收分析】\n固定版本材料：\n{bad}\n验收人补充说明：\n'},
      ]) {
        expect(
          matchesReviewHistory({...base, ...patch}, review, 'user'),
          isFalse,
        );
      }
      expect(matchesReviewHistory(base, review, ''), isFalse);
    },
  );
  test(
    'changed chat access or review version cannot be restored from the list',
    () async {
      final api = HistoryApi()..rows = [stored('analysis', 1)];
      api.refreshed = {...stored('analysis', 1), 'canSend': false};
      await expectLater(
        findReviewHistory(api, review, 'user', () {}),
        throwsA(isA<ApiFailure>()),
      );
      api.refreshed = null;
      api.value['artifactVersionId'] = 'changed';
      await expectLater(
        findReviewHistory(api, review, 'user', () {}),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'lookup errors and identity changes do not masquerade as a missing chat',
    () async {
      final api = HistoryApi()
        ..failure = const ApiFailure('offline', isNetwork: true);
      await expectLater(
        findReviewHistory(api, review, 'user', () {}),
        throwsA(isA<ApiFailure>()),
      );
      api.failure = null;
      var switched = false;
      api.onList = () => switched = true;
      await expectLater(
        findReviewHistory(api, review, 'user', () {
          if (switched) throw const ApiFailure('identity changed');
        }),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test(
    'an empty successful collection allows the first analysis draft',
    () async {
      expect(
        await findReviewHistory(HistoryApi(), review, 'user', () {}),
        isEmpty,
      );
    },
  );
}

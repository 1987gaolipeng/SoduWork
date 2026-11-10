import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/artifact_download.dart';
import 'package:soduwork_mobile/core/cloud_conversation_request.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/requirement_review_conversation.dart';
import 'package:soduwork_mobile/core/shared_conversation_host.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/state/work_conversation_navigation.dart';
import 'package:soduwork_mobile/ui/requirement_review_conversation_button.dart';

Map<String, dynamic> packet() => {
  'task': {
    'id': 'source',
    'title': 'Review R5',
    'status': 'doing',
    'requirementStage': 'reviewing',
  },
  'canDecide': true,
  'approvalId': 'approval',
  'artifactVersionId': 'version-1',
  'requirementVersion': 2,
  'criteria': [
    {'id': 'c1', 'label': 'Check the result'},
  ],
  'artifact': {'id': 'version-1'},
  'attachmentIds': ['file-a', 'file-b'],
  'attachments': [
    {'id': 'file-a', 'filename': 'result.txt'},
    {'id': 'file-b', 'filename': 'result.txt'},
  ],
};

class ReviewApi extends SoduWorkApi {
  Map<String, dynamic> value = packet();
  int reads = 0;
  @override
  Future<List<Map<String, dynamic>>> cloudConversations() async => [];
  ReviewApi()
    : super(
        store: DeviceStore(),
        endpoint: const EndpointSettings(
          environment: SoduWorkEnvironment.development,
          baseUrl: 'https://hub.test',
        ),
      );
  @override
  Future<Map<String, dynamic>> taskAcceptanceContext(String id) async {
    reads++;
    return value;
  }
}

class Files extends ArtifactDownloader {
  final ids = <String>[];
  final void Function()? afterDownload;
  Files(super.api, {this.afterDownload});
  @override
  Future<DownloadedArtifact> downloadAttachment(
    String id, {
    required String filename,
    String contentType = 'application/octet-stream',
    int byteLimit = ArtifactDownloader.maxBytes,
  }) async {
    ids.add(id);
    afterDownload?.call();
    return DownloadedArtifact(
      bytes: Uint8List.fromList(id.codeUnits),
      filename: filename,
      contentType: 'text/plain',
    );
  }
}

void main() {
  test(
    'automatic review sends pinned reference, reuses receipt and separates manual history',
    () async {
      final api = ReviewApi();
      final state = SendingState()..api = api;
      addTearDown(state.dispose);
      final review = RequirementReviewConversation.fromPacket(
        'source',
        packet(),
        automatic: true,
      );
      final manual = RequirementReviewConversation.fromPacket(
        'source',
        packet(),
      );
      expect(review.key, isNot(manual.key));
      final prepared = await review.prepare(api, 'Check all criteria', () {});
      expect(prepared.files, isEmpty);
      expect(prepared.text, startsWith('【自动验收】'));
      final host = SharedConversationHost(
        state: state,
        review: review,
        onDraft: (_) {},
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
      );
      final args = {
        'messageId': 'auto-send',
        'text': 'Check all criteria',
        'agentId': 'pi',
      };
      await host.call('send', args);
      await host.call('send', args);
      expect(state.posts, 1);
      expect(state.sentRequest!.options['acceptance'], review.binding);
      expect(state.workConversationNavigation.taskForReview(manual), isEmpty);
      api.value['criteria'] = [];
      await expectLater(
        review.prepare(api, 'Check', () {}),
        throwsA(isA<ApiFailure>()),
      );
    },
  );
  test('only the same unsent pinned review resumes the current composer', () {
    final review = RequirementReviewConversation.fromPacket('source', packet());
    final destination = WorkConversationDestination(
      taskId: '',
      title: 'Review',
      identity: 1,
      review: review,
    );
    expect(
      destination.resumesReviewDraft(activeTaskId: null, draft: review),
      isTrue,
    );
    expect(
      destination.resumesReviewDraft(activeTaskId: 'sent', draft: review),
      isFalse,
    );
    expect(
      destination.resumesReviewDraft(activeTaskId: null, draft: null),
      isFalse,
    );
    final changed = RequirementReviewConversation.fromPacket('source', {
      ...packet(),
      'artifactVersionId': 'version-2',
    });
    expect(
      destination.resumesReviewDraft(activeTaskId: null, draft: changed),
      isFalse,
    );
    final existing = WorkConversationDestination(
      taskId: 'sent',
      title: 'Review',
      identity: 1,
      review: review,
    );
    expect(
      existing.resumesReviewDraft(activeTaskId: null, draft: review),
      isFalse,
    );
  });
  test(
    'navigation preflight reports errors without replacing the open destination',
    () {
      final navigation = WorkConversationNavigation();
      navigation.addListener(() {});
      const original = WorkConversationDestination(
        taskId: 'original',
        title: '',
        identity: 1,
      );
      navigation.open(original);
      navigation.beforeOpen = (_) =>
          throw const ApiFailure('Keep the unsent draft');
      expect(
        () => navigation.open(
          const WorkConversationDestination(
            taskId: 'other',
            title: '',
            identity: 1,
          ),
        ),
        throwsA(isA<ApiFailure>()),
      );
      expect(navigation.destination, same(original));
    },
  );
  test(
    'review sends one separate conversation and reuses its pinned identity',
    () async {
      final api = ReviewApi()..value['attachmentIds'] = [];
      final state = SendingState()..api = api;
      addTearDown(state.dispose);
      final review = RequirementReviewConversation.fromPacket(
        'source',
        packet(),
      );
      final host = SharedConversationHost(
        state: state,
        review: review,
        onDraft: (_) {},
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
      );
      final args = {
        'messageId': 'send-review',
        'text': 'Analyze',
        'agentId': 'pi',
      };
      final first = await host.call('send', args);
      final second = await host.call('send', args);
      expect(first, second);
      expect(state.posts, 1);
      expect(state.sentText, contains('version-1'));
      expect(state.sentText, contains('不调用审批'));
      expect(
        state.workConversationNavigation.taskForReview(review),
        'review-chat',
      );
      api.value['canDecide'] = false;
      await expectLater(
        host.call('say', {
          'taskId': 'review-chat',
          'messageId': 'next',
          'text': 'More',
        }),
        throwsA(isA<ApiFailure>()),
      );
      expect(state.posts, 1);
    },
  );
  test(
    'review copies exactly pinned materials with distinct names and analysis instructions',
    () async {
      final api = ReviewApi(), files = Files(ReviewApi());
      final review = RequirementReviewConversation.fromPacket(
        'source',
        packet(),
      );
      final prepared = await review.prepare(
        api,
        'Check carefully',
        () {},
        downloader: files,
      );
      expect(files.ids, ['file-a', 'file-b']);
      expect(prepared.files.map((file) => file.name), [
        'file-a-result.txt',
        'file-b-result.txt',
      ]);
      expect(prepared.text, contains('version-1'));
      expect(prepared.text, contains('不重新执行原需求'));
      expect(prepared.text, contains('不调用审批'));
      expect(api.reads, 2);
    },
  );

  test(
    'denied reviewer, mismatched task, closed task and changed version are rejected',
    () async {
      final original = packet();
      for (final value in [
        {...original, 'canDecide': false},
        {
          ...original,
          'task': {
            'id': 'other',
            'status': 'doing',
            'requirementStage': 'reviewing',
          },
        },
        {
          ...original,
          'task': {'id': 'source', 'status': 'done', 'reviewedAt': 1},
        },
      ]) {
        expect(
          () => RequirementReviewConversation.fromPacket('source', value),
          throwsA(isA<ApiFailure>()),
        );
      }
      final api = ReviewApi()..value['artifactVersionId'] = 'version-2';
      final review = RequirementReviewConversation.fromPacket(
        'source',
        original,
      );
      await expectLater(
        review.validate(api, () {}),
        throwsA(isA<ApiFailure>()),
      );
    },
  );

  test(
    'version and identity are checked again after downloading materials',
    () async {
      final api = ReviewApi();
      final review = RequirementReviewConversation.fromPacket(
        'source',
        packet(),
      );
      await expectLater(
        review.prepare(
          api,
          '',
          () {},
          downloader: Files(
            api,
            afterDownload: () => api.value['artifactVersionId'] = 'new-version',
          ),
        ),
        throwsA(isA<ApiFailure>()),
      );
      api.value = packet();
      var switched = false;
      await expectLater(
        review.prepare(api, '', () {
          if (switched) throw const ApiFailure('Account changed');
        }, downloader: Files(api, afterDownload: () => switched = true)),
        throwsA(isA<ApiFailure>()),
      );
    },
  );

  test(
    'missing material cannot silently turn into a successful analysis',
    () async {
      final api = ReviewApi()..value['attachments'] = [];
      final review = RequirementReviewConversation.fromPacket(
        'source',
        packet(),
      );
      final files = Files(api);
      await expectLater(
        review.prepare(api, '', () {}, downloader: files),
        throwsA(isA<ApiFailure>()),
      );
      expect(files.ids, isEmpty);
    },
  );

  test(
    'review navigation reuses its conversation and clears account scope',
    () {
      final navigation = WorkConversationNavigation();
      final review = RequirementReviewConversation.fromPacket(
        'source',
        packet(),
      );
      navigation.bindReview('review-chat', review);
      expect(navigation.taskForReview(review), 'review-chat');
      navigation.bindReview('source', review);
      expect(navigation.reviewForTask('source'), isNull);
      navigation.clear();
      expect(navigation.taskForReview(review), isEmpty);
    },
  );

  testWidgets(
    'analysis opens a main conversation draft without executing or deciding',
    (tester) async {
      final api = ReviewApi();
      final state = MobileState()
        ..api = api
        ..phase = MobilePhase.ready
        ..enrollment = const EnrollmentState(
          deviceId: 'device',
          authState: 'active',
          ownerUserId: 'user',
          active: true,
          deviceName: 'Test',
        );
      addTearDown(state.dispose);
      state.workConversationNavigation.addListener(() {});
      await tester.pumpWidget(
        MobileScope(
          state: state,
          child: const MaterialApp(
            home: Scaffold(
              body: RequirementReviewConversationButton(taskId: 'source'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('在会话中分析'));
      await tester.pumpAndSettle();
      final destination = state.workConversationNavigation.destination!;
      expect(destination.taskId, isEmpty);
      expect(destination.review?.taskId, 'source');
      expect(api.reads, 1);
      expect(state.pendingCloudRequest, isNull);
      await tester.tap(find.text('自动验收'));
      await tester.pumpAndSettle();
      expect(
        state.workConversationNavigation.destination!.review!.automatic,
        isTrue,
      );
      expect(state.pendingCloudRequest, isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  test(
    'review host rejects stale sends and workflow execution before dispatch',
    () async {
      final api = ReviewApi()..value['canDecide'] = false;
      final state = MobileState()
        ..api = api
        ..phase = MobilePhase.ready;
      addTearDown(state.dispose);
      final host = SharedConversationHost(
        state: state,
        review: RequirementReviewConversation.fromPacket('source', packet()),
        onDraft: (_) {},
        onCreated: (_) {},
        onResource: (_) async {},
        onExternal: (_) async {},
      );
      await expectLater(
        host.call('send', {
          'messageId': 'one',
          'text': 'Analyze',
          'agentId': 'pi',
        }),
        throwsA(isA<ApiFailure>()),
      );
      await expectLater(
        host.call('workflowStart', {'requestId': 'two'}),
        throwsA(isA<ApiFailure>()),
      );
      expect(state.pendingCloudRequest, isNull);
    },
  );
}

class SendingState extends MobileState {
  int posts = 0;
  String sentText = '';
  CloudConversationRequest? sentRequest;
  SendingState() {
    phase = MobilePhase.ready;
  }
  @override
  Future<void> restorePendingBranch() async {}
  @override
  Future<void> rememberCloudRequest(CloudConversationRequest request) async {
    pendingCloudRequest = request;
  }

  @override
  Future<Map<String, dynamic>> cloudConversationTargets() async => {
    'targets': [
      {
        'type': 'agent',
        'agentId': 'pi',
        'online': true,
        'remote': true,
        'name': 'Pi',
        'modelPick': true,
        'runnerId': 'cloud-runner',
        'modelMode': 'managed',
      },
    ],
  };
  @override
  Future<Map<String, dynamic>> startCloudConversation({
    required String text,
    String agentId = '',
    String model = '',
    String title = '',
    List files = const [],
    CloudConversationRequest? request,
  }) async {
    posts++;
    sentRequest = request;
    sentText = text;
    pendingCloudRequest = null;
    return {'ok': true, 'taskId': 'review-chat'};
  }
}

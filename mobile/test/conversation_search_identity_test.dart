import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/conversation_search.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets('search opens the canonical cloud task and preserves namesakes', (
    tester,
  ) async {
    final state = MobileState();
    addTearDown(state.dispose);
    state.enrollment = const EnrollmentState(
      active: true,
      deviceId: 'phone',
      deviceName: 'Phone',
      authState: 'active',
      ownerUserId: 'alice',
    );
    state.tasks = [
      WorkTask.fromJson({
        'id': 'task-n2',
        'title': 'N2 shared title',
        'note': 'Live cloud conversation',
        'origin': 'cloud-conversation',
        'createdBy': 'alice',
        'workRouting': {
          'cloudConversation': {'sessionId': 'cloud-pc-session'},
        },
      }),
      WorkTask.fromJson({
        'id': 'foreign',
        'title': 'N2 private task',
        'origin': 'cloud-conversation',
        'createdBy': 'bob',
        'workRouting': {
          'cloudConversation': {'sessionId': 'different-visible-session'},
        },
      }),
    ];
    await state.accountConversations.refresh(
      isCurrent: () => true,
      load: ({required after, required limit}) async => {
        'items': [
          {
            'id': 'pc-copy',
            'sourceSessionId': 'cloud-pc-session',
            'title': 'N2 PC mirror',
            'revision': 1,
          },
          {
            'id': 'legacy-copy',
            'sourceSessionId': 'cloud-task:task-n2',
            'title': 'N2 legacy mirror',
            'revision': 2,
          },
          {
            'id': 'namesake',
            'sourceSessionId': 'different-visible-session',
            'title': 'N2 shared title',
            'sourceDeviceName': 'Other PC',
            'revision': 3,
          },
          {
            'id': 'archive',
            'sourceSessionId': 'cloud-pc-session',
            'title': 'N2 archived copy',
            'archived': true,
            'revision': 4,
          },
        ],
        'cursor': 4,
        'hasMore': false,
      },
    );
    ConversationSearchSelection? selected;
    await tester.pumpWidget(
      MaterialApp(
        theme: SoduWorkTheme.light(),
        home: MobileScope(
          state: state,
          child: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                selected = await showConversationSearch(context);
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    Future<void> search() async {
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('conversation-search-input')),
        'N2',
      );
      await tester.pumpAndSettle();
    }

    await search();
    expect(find.text('N2 PC mirror'), findsNothing);
    expect(find.text('N2 legacy mirror'), findsNothing);
    expect(find.text('N2 private task'), findsNothing);
    expect(find.text('N2 archived copy'), findsOneWidget);
    expect(find.text('N2 shared title'), findsNWidgets(2));
    await tester.tap(find.text('Live cloud conversation'));
    await tester.pumpAndSettle();
    expect(selected?.task?.task.id, 'task-n2');
    expect(selected?.account, isNull);
    await search();
    await tester.tap(find.text('Other PC'));
    await tester.pumpAndSettle();
    expect(selected?.account?.id, 'namesake');
    expect(selected?.task, isNull);
    expect(tester.takeException(), isNull);
  });
}

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/ai_assignment_sheet.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets('late executor directory cannot cross an account change', (
    tester,
  ) async {
    final state = _RosterState();
    addTearDown(state.dispose);
    AiAssignee? selected;
    await tester.pumpWidget(
      MobileScope(
        state: state,
        child: MaterialApp(
          theme: SoduWorkTheme.light(),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                child: const Text('选择执行机'),
                onPressed: () async =>
                    selected = await showAiAssigneeSheet(context),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('选择执行机'));
    await tester.pump();
    state.switchAccount();
    await tester.pump();
    state.pending.complete(
      AiRoster.fromJson({
        'agents': [
          {'id': 'old-pc', 'name': '旧账号电脑', 'online': true},
        ],
      }),
    );
    await tester.pumpAndSettle();
    expect(find.text('旧账号电脑'), findsNothing);
    expect(find.text('账号已变化，请关闭后重新选择执行机。'), findsOneWidget);
    expect(
      tester.widget<IconButton>(find.byType(IconButton)).onPressed,
      isNull,
    );
    expect(selected, isNull);
  });
}

class _RosterState extends MobileState {
  int revision = 1;
  final pending = Completer<AiRoster>();
  @override
  int get identityRevision => revision;
  void switchAccount() {
    revision++;
    notifyListeners();
  }

  @override
  Future<AiRoster> aiAgents({bool force = false}) => pending.future;
}

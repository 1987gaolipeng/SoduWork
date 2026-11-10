import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/automation_time_fields.dart';

void main() {
  test('Beijing wall time round trips across UTC day boundaries', () {
    final instant = DateTime.utc(2030, 11, 1, 16, 5);
    final shown = automationDisplayTime(instant, 'Asia/Shanghai');
    expect([shown.day, shown.hour, shown.minute], [2, 0, 5]);
    expect(automationParseDate('2030-11-02', 0, 5, 'Asia/Shanghai'), instant);
    expect(automationParseDate('2030-02-29', 12, 0, 'Asia/Shanghai'), isNull);
    expect(
      automationParseDate('2032-02-29', 12, 0, 'Asia/Shanghai'),
      isNotNull,
    );
    expect(automationParseDate('2030-11-02', 24, 0, 'Asia/Shanghai'), isNull);
  });

  testWidgets(
    'compact date and 24-hour controls fit a narrow phone and reject invalid dates',
    (tester) async {
      tester.view.physicalSize = const Size(320, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      DateTime? result;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(20),
              child: Form(
                child: AutomationDateTimeFields(
                  value: DateTime.utc(2030, 11, 2, 7, 29),
                  zone: 'Asia/Shanghai',
                  enabled: true,
                  onChanged: (value) => result = value,
                ),
              ),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('15'), findsOneWidget);
      expect(find.text('AM'), findsNothing);
      expect(find.text('PM'), findsNothing);
      await tester.enterText(
        find.byKey(const Key('automation-date')),
        '2030-02-30',
      );
      expect(result, isNull);
      await tester.enterText(
        find.byKey(const Key('automation-date')),
        '2030-11-03',
      );
      expect(result, DateTime.utc(2030, 11, 3, 7, 29));
      await tester.tap(find.byKey(const Key('automation-hour')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    },
  );
}

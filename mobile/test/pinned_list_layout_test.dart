import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/pinned_list_layout.dart';

void main() {
  testWidgets('dragging list rows keeps heading and filters fixed', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PinnedListLayout(
            header: const [
              Text('Heading'),
              TextField(),
              Chip(label: Text('Filter')),
            ],
            children: List.generate(40, (i) => ListTile(title: Text('Row $i'))),
          ),
        ),
      ),
    );
    final filter = find.text('Filter');
    final top = tester.getTopLeft(filter);
    final list = find.byType(ListView);
    expect(
      tester.getRect(list).top - tester.getRect(find.byType(Chip)).bottom,
      greaterThanOrEqualTo(16),
    );
    await tester.drag(list, const Offset(0, -320));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(filter), top);
    expect(find.text('Row 0').hitTestable(), findsNothing);
    expect(tester.takeException(), isNull);
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/ui/mobile_select_field.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  for (final scale in [1.0, 1.4]) {
    testWidgets(
      'field labels stay inside their containers at text scale $scale',
      (tester) async {
        tester.view.physicalSize = const Size(320, 820);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final controller = TextEditingController(text: '已有内容');
        addTearDown(controller.dispose);
        final form = GlobalKey<FormState>();
        await tester.pumpWidget(
          MaterialApp(
            theme: SoduWorkTheme.light(const SoduWorkBrandTheme()),
            home: MediaQuery(
              data: MediaQueryData(textScaler: TextScaler.linear(scale)),
              child: Scaffold(
                body: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Form(
                    key: form,
                    child: Column(
                      children: [
                        const Text('上一项说明'),
                        const SizedBox(height: 8),
                        TextFormField(
                          controller: controller,
                          decoration: const InputDecoration(labelText: '计划名称'),
                          validator: (_) => '请检查内容',
                        ),
                        const SizedBox(height: 12),
                        MobileSelectField<String>(
                          compact: true,
                          initialValue: 'once',
                          decoration: const InputDecoration(labelText: '执行频率'),
                          items: const [
                            DropdownMenuItem(value: 'once', child: Text('仅一次')),
                          ],
                          onChanged: (_) {},
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        void checkLabels() {
          for (final label in ['计划名称', '执行频率']) {
            final finder = find.text(label);
            final box = InputDecorator.containerOf(tester.element(finder))!;
            final container = box.localToGlobal(Offset.zero) & box.size;
            final bounds = tester.getRect(finder);
            expect(
              bounds.top,
              greaterThanOrEqualTo(container.top + 2),
              reason: label,
            );
            expect(bounds.bottom, lessThan(container.bottom), reason: label);
            expect(
              bounds.left,
              greaterThanOrEqualTo(container.left),
              reason: label,
            );
          }
          expect(
            tester.getBottomLeft(find.text('计划名称')).dy,
            lessThan(tester.getTopLeft(find.byType(EditableText)).dy),
          );
          expect(tester.takeException(), isNull);
        }

        checkLabels();
        await tester.tap(find.byType(TextFormField));
        await tester.pumpAndSettle();
        checkLabels();
        form.currentState!.validate();
        await tester.pumpAndSettle();
        checkLabels();
        expect(find.text('请检查内容'), findsOneWidget);
      },
    );
  }
}

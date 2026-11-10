import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/mobile_select_field.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';

void main() {
  testWidgets('choices preserve value on dismissal, skip disabled items and validate', (tester) async {
    final form = GlobalKey<FormState>();
    String? selection;
    await tester.pumpWidget(MaterialApp(theme: SoduWorkTheme.light(), home: Scaffold(
      body: Form(key: form, child: MobileSelectField<String>(
        decoration: const InputDecoration(labelText: '执行位置'),
        hint: const Text('请选择'),
        items: const [
          DropdownMenuItem(value: 'offline', enabled: false, child: Text('离线电脑')),
          DropdownMenuItem(value: 'pc', child: Text('我的电脑')),
          DropdownMenuItem(value: 'cloud', child: Text('云端')),
        ],
        validator: (value) => value == null ? '必须选择' : null,
        onChanged: (value) => selection = value,
      )),
    )));
    expect(form.currentState!.validate(), isFalse);
    await tester.pump();
    await tester.tap(find.text('请选择'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('离线电脑'));
    expect(selection, isNull);
    await tester.tapAt(const Offset(5, 500));
    await tester.pumpAndSettle();
    expect(selection, isNull);
    await tester.tap(find.text('请选择'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('我的电脑'));
    await tester.pumpAndSettle();
    expect(selection, 'pc');
    expect(form.currentState!.validate(), isTrue);
    form.currentState!.reset();
    await tester.pumpAndSettle();
    expect(find.text('请选择'), findsOneWidget);
  });

  testWidgets('long choices scroll within a narrow keyboard-safe menu', (tester) async {
    tester.view.physicalSize = const Size(320, 650);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    int? choice;
    await tester.pumpWidget(MaterialApp(theme: SoduWorkTheme.light(), home: Scaffold(
      body: MediaQuery(data: const MediaQueryData(size: Size(320, 650), viewInsets: EdgeInsets.only(bottom: 250)),
        child: Align(alignment: Alignment.topCenter, child: MobileSelectField<int>(
          decoration: const InputDecoration(labelText: '模型'),
          items: List.generate(30, (i) => DropdownMenuItem(value: i, child: Text('模型 $i · 很长的模型名称及说明'))),
          onChanged: (value) => choice = value,
        )),
      ),
    )));
    await tester.tap(find.text('模型'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('模型 29 · 很长的模型名称及说明'), 180,
      scrollable: find.byType(Scrollable).last);
    await tester.tap(find.text('模型 29 · 很长的模型名称及说明'));
    await tester.pumpAndSettle();
    expect(choice, 29);
    expect(tester.takeException(), isNull);
  });
}

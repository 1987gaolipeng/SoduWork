import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/work_capability.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/mobile_appearance.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/work_request_sheet.dart';

WorkCapability _cap(List<dynamic> inputs) => WorkCapability(
  kind: WorkCapabilityKind.workflow,
  id: 'binding',
  label: '整理团队报告',
  metadata: {'pluginId': 'plugin', 'version': '1', 'inputs': inputs},
);

void main() {
  test(
    'zero and false satisfy required fields while unknown keys never enter the output',
    () {
      final schema = WorkflowInputSchema.fromCapability(
        _cap([
          {'key': 'count', 'type': 'number', 'required': true, 'default': 0},
          {
            'key': 'include',
            'type': 'bool',
            'required': true,
            'default': false,
          },
          {'key': 'optional', 'type': 'text'},
        ]),
      );
      expect(schema.collect({'unknown': 'must not be sent'}), {
        'count': 0,
        'include': false,
      });
      expect(schema.collect({'count': '0', 'include': false, 'optional': ''}), {
        'count': 0,
        'include': false,
      });
      expect(() => schema.collect({'include': null}), throwsFormatException);
    },
  );

  test(
    'unsupported schemas and invalid defaults cannot become executable forms',
    () {
      for (final inputs in <List<dynamic>>[
        [
          {'key': 'field', 'type': 'file'},
        ],
        [
          {'key': '../path', 'type': 'text'},
        ],
        [
          {'key': 'field', 'type': 'text', 'required': 'true'},
        ],
        [
          {'key': 'same'},
          {'key': 'same'},
        ],
        [
          {'key': 'field', 'type': 'select', 'options': []},
        ],
        [
          {'key': 'field', 'type': 'boolean', 'default': 'false'},
        ],
        [
          {'key': 'field', 'type': 'number', 'default': double.infinity},
        ],
        [
          {
            'key': 'field',
            'type': 'select',
            'options': ['one'],
            'default': 'other',
          },
        ],
      ]) {
        expect(
          () => WorkflowInputSchema.fromCapability(_cap(inputs)),
          throwsFormatException,
        );
      }
      expect(
        () => WorkflowInputSchema.fromCapability(
          WorkCapability(
            kind: WorkCapabilityKind.workflow,
            id: 'binding',
            label: '坏格式',
            metadata: {
              'inputs': {'unexpected': true},
            },
          ),
        ),
        throwsFormatException,
      );
    },
  );

  test(
    'text validation is explicit at 8000 Unicode scalars and numbers must be finite',
    () {
      final schema = WorkflowInputSchema.fromCapability(
        _cap([
          {'key': 'note', 'type': 'textarea', 'required': true},
          {'key': 'number', 'type': 'number'},
        ]),
      );
      final full = List.filled(8000, '🧪').join();
      expect(schema.collect({'note': full})['note'], full);
      expect(() => schema.collect({'note': '$full🧪'}), throwsFormatException);
      expect(
        () => schema.collect({'note': ' ', 'number': 0}),
        throwsFormatException,
      );
      expect(
        () => schema.collect({'note': '正常', 'number': 'NaN'}),
        throwsFormatException,
      );
      expect(
        () => schema.collect({'note': '正常', 'number': false}),
        throwsFormatException,
      );
    },
  );

  test(
    'the complete returned input object also respects the existing workflow JSON limit',
    () {
      final schema = WorkflowInputSchema.fromCapability(
        _cap(
          List.generate(13, (index) => {'key': 'field$index', 'type': 'text'}),
        ),
      );
      expect(
        () => schema.collect({
          for (var index = 0; index < 13; index++)
            'field$index': List.filled(8000, '字').join(),
        }),
        throwsFormatException,
      );
    },
  );

  testWidgets(
    'natural-language instruction stays separate from optional prompt input',
    (tester) async {
      Map<String, dynamic>? result;
      await _show(
        tester,
        _cap([
          {'key': 'prompt', 'type': 'text'},
        ]),
        instruction: '用户的工作说明只在这里展示',
        returned: (value) => result = value,
      );
      expect(find.text('用户的工作说明只在这里展示'), findsOneWidget);
      expect(
        tester.widget<TextFormField>(find.byType(TextFormField)).initialValue,
        '',
      );
      await tester.tap(find.text('确认参数'));
      await tester.pumpAndSettle();
      expect(result, isEmpty);
    },
  );

  testWidgets(
    'required fields validate before returning only the declared values',
    (tester) async {
      Map<String, dynamic>? result;
      await _show(
        tester,
        _cap([
          {
            'key': 'subject',
            'label': '报告标题',
            'type': 'text',
            'required': true,
            'default': '',
          },
          {'key': 'count', 'type': 'number', 'default': 0},
          {
            'key': 'include',
            'type': 'boolean',
            'required': true,
            'default': false,
          },
        ]),
        returned: (value) => result = value,
      );
      await tester.tap(find.text('确认参数'));
      await tester.pumpAndSettle();
      expect(find.text('请填写报告标题'), findsOneWidget);
      expect(result, isNull);
      await tester.enterText(
        find.byKey(const ValueKey('work-input:subject')),
        '月度报告',
      );
      await tester.tap(find.text('确认参数'));
      await tester.pumpAndSettle();
      expect(result, {'subject': '月度报告', 'count': 0, 'include': false});
    },
  );

  testWidgets('unknown types show a reason and disable confirmation', (
    tester,
  ) async {
    await _show(
      tester,
      _cap([
        {'key': 'secret', 'type': 'unknown'},
      ]),
    );
    expect(find.textContaining('暂不支持的类型'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '确认参数'))
          .onPressed,
      isNull,
    );
  });

  testWidgets(
    'account changes remove the private instruction and disable the old form',
    (tester) async {
      final state = _FormIdentity();
      addTearDown(state.dispose);
      await _show(tester, _cap([]), instruction: '旧账号私有工作说明', state: state);
      expect(find.text('旧账号私有工作说明'), findsOneWidget);
      state.changeIdentity();
      await tester.pumpAndSettle();
      expect(find.text('旧账号私有工作说明'), findsNothing);
      expect(find.text('整理团队报告'), findsNothing);
      expect(find.text('账号已切换，请关闭后重新填写。'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '确认参数'))
            .onPressed,
        isNull,
      );
    },
  );

  for (final width in [320.0, 390.0]) {
    testWidgets(
      'large-text dark sheet keeps its footer above the keyboard at $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await _show(
          tester,
          _cap(
            List.generate(
              14,
              (index) => {
                'key': 'field$index',
                'label': '工作参数 $index',
                'type': 'textarea',
              },
            ),
          ),
          dark: true,
          scale: 1.8,
          keyboard: 260,
        );
        expect(
          tester.widget<BottomSheet>(find.byType(BottomSheet)).showDragHandle,
          isTrue,
        );
        final button = tester.getRect(
          find.widgetWithText(FilledButton, '确认参数'),
        );
        expect(button.bottom, lessThanOrEqualTo(844 - 260));
        expect(button.height, greaterThanOrEqualTo(44));
        await tester.scrollUntilVisible(
          find.byKey(const ValueKey('work-input:field13')),
          400,
          scrollable: find.byType(Scrollable).first,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }
}

Future<void> _show(
  WidgetTester tester,
  WorkCapability capability, {
  String instruction = '整理本周工作报告',
  ValueChanged<Map<String, dynamic>?>? returned,
  bool dark = false,
  double scale = 1,
  double keyboard = 0,
  MobileState? state,
}) async {
  final app = MaterialApp(
    theme: SoduWorkTheme.light(
      mobileAppearance(
        const SoduWorkBrandTheme(),
        dark ? Brightness.dark : Brightness.light,
      ),
    ),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(
        textScaler: TextScaler.linear(scale),
        viewInsets: EdgeInsets.only(bottom: keyboard),
      ),
      child: child!,
    ),
    home: Scaffold(
      body: Builder(
        builder: (context) => TextButton(
          onPressed: () async {
            final result = await showWorkflowInputs(
              context,
              capability: capability,
              instruction: instruction,
            );
            returned?.call(result);
          },
          child: const Text('填写参数'),
        ),
      ),
    ),
  );
  await tester.pumpWidget(
    state == null ? app : MobileScope(state: state, child: app),
  );
  await tester.tap(find.text('填写参数'));
  await tester.pumpAndSettle();
}

class _FormIdentity extends MobileState {
  int _revision = 0;
  @override
  int get identityRevision => _revision;
  void changeIdentity() {
    _revision++;
    notifyListeners();
  }
}

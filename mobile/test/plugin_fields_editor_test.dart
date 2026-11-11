import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/ui/plugin_fields_contract.dart';
import 'package:soduwork_mobile/ui/plugin_fields_editor.dart';

void main() {
  test('defaults use real option values and preserve primitive types', () {
    final field = <String, dynamic>{
      'key': 'choice',
      'label': '选择',
      'type': 'select',
      'options': [
        {'value': 7, 'label': '七'},
        {'value': false, 'label': '否'},
      ],
      'default': 7,
    };
    expect(validatePluginFields([field], {}), isEmpty);
    expect(
      validatePluginFields([
        {...field, 'default': '7'},
      ], {}),
      isNotEmpty,
    );
    expect(
      validatePluginFields([
        {...field, 'default': '七'},
      ], {}),
      isNotEmpty,
    );
    expect(
      validatePluginFields([], {
        'preferences': [
          {
            ...field,
            'type': 'multiselect',
            'default': [7, false],
          },
        ],
      }),
      isEmpty,
    );
    expect(
      validatePluginFields([], {
        'preferences': [
          {
            ...field,
            'type': 'multiselect',
            'default': [7, 'false'],
          },
        ],
      }),
      isNotEmpty,
    );
  });

  test(
    'bounds, duplicate keys, duplicate values and wrong primitive defaults are rejected',
    () {
      final number = <String, dynamic>{
        'key': 'amount',
        'type': 'number',
        'label': '数量',
        'default': 4,
      };
      expect(
        validatePluginFields([], {
          'preferences': [
            {...number, 'minimum': 5},
          ],
        }),
        isNotEmpty,
      );
      expect(
        validatePluginFields([], {
          'preferences': [
            {...number, 'minimum': 5, 'maximum': 3},
          ],
        }),
        isNotEmpty,
      );
      expect(validatePluginFields([number, number], {}), isNotEmpty);
      expect(
        validatePluginFields([
          {...number, 'default': 'four'},
        ], {}),
        isNotEmpty,
      );
      expect(
        validatePluginFields([
          {'key': 'flag', 'type': 'boolean', 'default': 'false'},
        ], {}),
        isNotEmpty,
      );
      expect(
        validatePluginFields([
          {
            'key': 'mode',
            'type': 'select',
            'options': ['a', 'a'],
          },
        ], {}),
        isNotEmpty,
      );
      expect(
        validatePluginFields([], {
          'preferences': [
            {'key': 'site', 'type': 'url', 'default': 'javascript:alert(1)'},
          ],
        }),
        isNotEmpty,
      );
    },
  );

  testWidgets(
    'editing preserves unknown fields and cancel never changes the draft',
    (tester) async {
      final original = <String, dynamic>{
        'key': 'topic',
        'label': '主题',
        'type': 'text',
        'default': '报告',
        'future': {'schema': 3},
        'required': true,
      };
      final harness = await _show(tester, inputs: [original]);
      await _open(tester, 'input', 0);
      await tester.enterText(find.byKey(const ValueKey('field-label')), '新的主题');
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      expect(harness.changes, 0);
      expect(harness.inputs.single, original);
      await _open(tester, 'input', 0);
      await tester.enterText(find.byKey(const ValueKey('field-label')), '新的主题');
      await tester.tap(find.byKey(const ValueKey('field-save')));
      await tester.pumpAndSettle();
      expect(harness.changes, 1);
      expect(harness.inputs.single['label'], '新的主题');
      expect(harness.inputs.single['future'], {'schema': 3});
      expect(harness.inputs.single['default'], '报告');
      expect(original['label'], '主题');
    },
  );

  testWidgets(
    'numeric select default keeps its value and option metadata after editing label',
    (tester) async {
      final harness = await _show(
        tester,
        inputs: [
          {
            'key': 'mode',
            'label': '模式',
            'type': 'select',
            'default': 12,
            'options': [
              {'value': 12, 'label': '十二', 'future': true},
              {'value': '12', 'label': '文本十二'},
            ],
          },
        ],
      );
      await _open(tester, 'input', 0);
      await tester.enterText(find.byKey(const ValueKey('field-label')), '执行模式');
      await tester.tap(find.byKey(const ValueKey('field-save')));
      await tester.pumpAndSettle();
      expect(harness.inputs.single['default'], 12);
      expect((harness.inputs.single['options'] as List).first['future'], true);
    },
  );

  testWidgets(
    'invalid selection default cannot be saved or silently replaced by its label',
    (tester) async {
      final harness = await _show(
        tester,
        inputs: [
          {
            'key': 'mode',
            'label': '模式',
            'type': 'select',
            'options': [
              {'value': 'auto', 'label': '自动'},
            ],
            'default': '自动',
          },
        ],
      );
      await _open(tester, 'input', 0);
      await tester.tap(find.byKey(const ValueKey('field-save')));
      await tester.pumpAndSettle();
      expect(harness.changes, 0);
      expect(find.text('「模式」默认值必须匹配选项的真实值'), findsOneWidget);
    },
  );

  testWidgets('add, reorder and delete remain controlled by the parent', (
    tester,
  ) async {
    final harness = await _show(
      tester,
      inputs: [
        {'key': 'a', 'label': '第一项', 'type': 'text'},
        {'key': 'b', 'label': '第二项', 'type': 'text'},
      ],
    );
    await tester.tap(find.text('启动参数'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('plugin-input-menu-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('上移'));
    await tester.pumpAndSettle();
    expect(harness.inputs.map((row) => row['key']), ['b', 'a']);
    await tester.tap(find.byKey(const ValueKey('plugin-input-menu-0')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();
    expect(harness.inputs.map((row) => row['key']), ['a']);
    await tester.tap(find.byKey(const ValueKey('plugin-input-add')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('field-label')), '新增参数');
    await tester.enterText(
      find.byKey(const ValueKey('field-key')),
      'new_field',
    );
    await tester.tap(find.byKey(const ValueKey('field-save')));
    await tester.pumpAndSettle();
    expect(harness.inputs.last['key'], 'new_field');
    expect(harness.changes, 3);
  });

  testWidgets(
    'duplicate edited parameter key remains in editor with no mutation',
    (tester) async {
      final harness = await _show(
        tester,
        inputs: [
          {'key': 'a', 'label': '第一项', 'type': 'text'},
          {'key': 'b', 'label': '第二项', 'type': 'text'},
        ],
      );
      await _open(tester, 'input', 1);
      await tester.enterText(find.byKey(const ValueKey('field-key')), 'a');
      await tester.tap(find.byKey(const ValueKey('field-save')));
      await tester.pumpAndSettle();
      expect(find.text('参数标识已经存在，请使用另一标识'), findsOneWidget);
      expect(harness.changes, 0);
      expect(harness.inputs.last['key'], 'b');
    },
  );

  testWidgets('installation metadata and typed multi defaults are retained', (
    tester,
  ) async {
    final harness = await _show(
      tester,
      setup: {
        'title': '我的偏好',
        'description': '只配置一次',
        'future': {'keep': true},
        'preferences': [
          {
            'key': 'channels',
            'label': '渠道',
            'type': 'multiselect',
            'options': [
              {'value': 1, 'label': '一'},
              {'value': 2, 'label': '二'},
            ],
            'default': [1],
            'group': '通知',
            'future': 'keep',
          },
        ],
      },
    );
    await _open(tester, 'setup', 0);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('field-default-multi-1')),
      250,
      scrollable: find
          .descendant(
            of: find.byType(ListView).last,
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.tap(find.byKey(const ValueKey('field-default-multi-1')));
    await tester.tap(find.byKey(const ValueKey('field-save')));
    await tester.pumpAndSettle();
    final preference = pluginPreferenceFields(harness.setup).single;
    expect(preference['default'], [1, 2]);
    expect(preference['group'], '通知');
    expect(preference['future'], 'keep');
    expect(harness.setup['future'], {'keep': true});
  });

  for (final width in [320.0, 390.0]) {
    testWidgets(
      'editor and fixed save remain usable at $width with a keyboard',
      (tester) async {
        final harness = await _show(
          tester,
          width: width,
          keyboard: 260,
          inputs: [
            {'key': 'topic', 'label': '较长的参数显示名称用于验证换行布局', 'type': 'textarea'},
          ],
        );
        await _open(tester, 'input', 0);
        await tester.enterText(
          find.byKey(const ValueKey('field-label')),
          '已编辑',
        );
        await tester.tap(find.byKey(const ValueKey('field-save')));
        await tester.pumpAndSettle();
        expect(harness.inputs.single['label'], '已编辑');
        expect(tester.takeException(), isNull);
      },
    );
  }
}

class _Harness {
  List<Map<String, dynamic>> inputs;
  Map<String, dynamic> setup;
  int changes = 0;
  _Harness(this.inputs, this.setup);
}

Future<_Harness> _show(
  WidgetTester tester, {
  List<Map<String, dynamic>> inputs = const [],
  Map<String, dynamic> setup = const {},
  double width = 390,
  double keyboard = 0,
}) async {
  tester.view.physicalSize = Size(width, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final harness = _Harness(
    inputs.map(copyPluginField).toList(),
    copyPluginField(setup),
  );
  await tester.pumpWidget(
    MaterialApp(
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          viewInsets: EdgeInsets.only(bottom: keyboard),
          textScaler: const TextScaler.linear(1.15),
        ),
        child: child!,
      ),
      home: Scaffold(
        body: SingleChildScrollView(
          child: StatefulBuilder(
            builder: (context, setState) => PluginFieldsEditor(
              inputs: harness.inputs,
              setup: harness.setup,
              onChanged: (inputs, setup) => setState(() {
                harness.inputs = inputs;
                harness.setup = setup;
                harness.changes++;
              }),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return harness;
}

Future<void> _open(WidgetTester tester, String kind, int index) async {
  final key = ValueKey('plugin-$kind-$index');
  if (find.byKey(key).evaluate().isEmpty) {
    await tester.tap(find.text(kind == 'input' ? '启动参数' : '安装设置'));
    await tester.pumpAndSettle();
  }
  await tester.ensureVisible(find.byKey(key));
  await tester.tap(find.byKey(key));
  await tester.pumpAndSettle();
}

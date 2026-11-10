import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/task_lifecycle.dart';

Future<void> pumpPanel(WidgetTester tester, Map<String, dynamic> trace) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: SoduWorkTheme.light(),
      home: Scaffold(
        body: TaskLifecyclePanel(
          task: WorkTask.fromJson({
            'id': 'task',
            'title': '验收任务',
            'handler': 'auto',
          }),
          trace: {
            'runs': [
              {'id': 'run'},
            ],
            ...trace,
          },
        ),
      ),
    ),
  );
}

void main() {
  setUp(() {
    TestWidgetsFlutterBinding.instance.platformDispatcher.views.first
      ..physicalSize = const Size(390, 844)
      ..devicePixelRatio = 1;
  });
  tearDown(() {
    TestWidgetsFlutterBinding.instance.platformDispatcher.views.first
      ..resetPhysicalSize()
      ..resetDevicePixelRatio();
  });

  testWidgets(
    'Hub phase counters resolve evidence from exact stage categories',
    (tester) async {
      await pumpPanel(tester, {
        'phases': [
          {
            'key': 'delivery',
            'name': '交付阶段',
            'state': 'succeeded',
            'stageCount': 2,
            'evidenceCount': 3,
          },
        ],
        'stages': [
          {
            'category': 'delivery',
            'name': '生成报告',
            'state': 'succeeded',
            'summary': '报告已生成',
            'sessions': [
              {'summary': '执行已完成'},
            ],
            'decisions': [
              {'note': '验收通过'},
            ],
            'evidence': [
              {'id': 'file-a', 'kind': 'file', 'title': '同名报告'},
            ],
          },
          {
            'category': 'delivery',
            'name': '复核报告',
            'state': 'succeeded',
            'evidence': [
              {'id': 'file-a', 'kind': 'file', 'title': '同名报告'},
              {'id': 'file-b', 'kind': 'file', 'title': '同名报告'},
              {
                'id': 'check',
                'kind': 'check',
                'title': '复核记录',
                'summary': '所有检查通过',
              },
            ],
          },
          {
            'category': 'build',
            'name': '不属于此阶段',
            'evidence': [
              {'id': 'private', 'title': '其他阶段文件'},
            ],
          },
        ],
      });
      expect(find.text('1/1'), findsOneWidget);
      await tester.tap(find.text('交付阶段'));
      await tester.pumpAndSettle();
      expect(find.text('证据与产出 3'), findsOneWidget);
      expect(find.text('同名报告'), findsNWidgets(2));
      expect(find.text('复核记录'), findsOneWidget);
      expect(find.text('所有检查通过'), findsOneWidget);
      expect(find.text('其他阶段文件'), findsNothing);
      expect(find.text('报告已生成'), findsOneWidget);
      expect(find.text('执行记录：执行已完成'), findsOneWidget);
      expect(find.text('确认记录：验收通过'), findsOneWidget);
      expect(find.text('生成报告 · 已完成'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'only succeeded phases count as complete and waiting labels remain truthful',
    (tester) async {
      await pumpPanel(tester, {
        'phases': [
          {'key': 'done', 'name': '已执行', 'state': 'succeeded'},
          {'key': 'failed', 'name': '失败阶段', 'state': 'failed'},
          {'key': 'waiting', 'name': '等待审批', 'state': 'waiting_human'},
          {'key': 'planned', 'name': '计划阶段', 'state': 'planned'},
        ],
      });
      expect(find.text('1/4'), findsOneWidget);
      await tester.tap(find.text('失败阶段'));
      await tester.pumpAndSettle();
      expect(find.text('需要处理'), findsOneWidget);
      Navigator.of(tester.element(find.text('证据与产出 0'))).pop();
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(-200, 0));
      await tester.pumpAndSettle();
      await tester.tap(find.text('等待审批'));
      await tester.pumpAndSettle();
      expect(find.text('等待确认'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  for (final key in [null, '']) {
    testWidgets(
      'missing phase key $key cannot expose uncategorized stage evidence',
      (tester) async {
        await pumpPanel(tester, {
          'phases': [
            {'key': key, 'name': '未分类', 'state': 'planned'},
          ],
          'stages': [
            {
              'category': key,
              'name': '无分类阶段',
              'evidence': [
                {'id': 'unrelated', 'title': '不应出现'},
              ],
            },
          ],
        });
        await tester.tap(find.text('未分类'));
        await tester.pumpAndSettle();
        expect(find.text('证据与产出 0'), findsOneWidget);
        expect(find.text('不应出现'), findsNothing);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'legacy embedded evidence and stage-only traces remain readable',
    (tester) async {
      for (final container in ['phases', 'stages']) {
        await pumpPanel(tester, {
          container: [
            {
              'name': '历史阶段',
              'state': 'completed',
              'evidence': [
                {'id': 'legacy', 'title': '历史证据'},
                {'title': '无标识证据'},
                {'title': '无标识证据'},
              ],
            },
          ],
        });
        await tester.tap(find.text('历史阶段'));
        await tester.pumpAndSettle();
        expect(find.text('证据与产出 3'), findsOneWidget);
        expect(find.text('历史证据'), findsOneWidget);
        expect(find.text('无标识证据'), findsNWidgets(2));
        Navigator.of(tester.element(find.text('证据与产出 3'))).pop();
        await tester.pumpAndSettle();
      }
    },
  );

  testWidgets('long phase details scroll to the final evidence on a phone', (
    tester,
  ) async {
    await pumpPanel(tester, {
      'phases': [
        {'key': 'delivery', 'name': '长详情', 'state': 'succeeded'},
      ],
      'stages': [
        {
          'category': 'delivery',
          'name': '详细执行记录',
          'state': 'succeeded',
          'summary': List.filled(30, '真实执行摘要。').join('\n'),
          'evidence': List.generate(
            25,
            (i) => {'id': 'e-$i', 'title': '交付证据 $i'},
          ),
        },
      ],
    });
    await tester.tap(find.text('长详情'));
    await tester.pumpAndSettle();
    final scrollable = find
        .descendant(
          of: find.byType(BottomSheet),
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(
      find.text('交付证据 24'),
      400,
      scrollable: scrollable,
      maxScrolls: 20,
    );
    expect(find.text('交付证据 24').hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

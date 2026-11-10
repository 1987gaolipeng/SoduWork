import 'package:soduwork_mobile/ui/mobile_select_field.dart';
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:soduwork_mobile/core/device_store.dart';
import 'package:soduwork_mobile/core/soduwork_api.dart';
import 'package:soduwork_mobile/models/work_models.dart';
import 'package:soduwork_mobile/screens/automations_screen.dart';
import 'package:soduwork_mobile/sdk/soduwork_brand.dart';
import 'package:soduwork_mobile/state/mobile_scope.dart';
import 'package:soduwork_mobile/state/mobile_state.dart';
import 'package:soduwork_mobile/ui/automation_editor.dart';
import 'package:soduwork_mobile/ui/automation_templates.dart';
import 'package:soduwork_mobile/ui/mobile_theme.dart';
import 'package:soduwork_mobile/ui/mobile_sheet.dart';

import 'memory_device_auth.dart';

void main() {
  WidgetController.hitTestWarningShouldBeFatal = true;
  testWidgets(
    'new plans select online personal PC without replacing saved targets',
    (tester) async {
      Map<String, dynamic>? saved;
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('task-execution-options')) {
            return _json({
              'substrates': [
                {
                  'key': 'runner:cloud:pi',
                  'name': 'Cloud Pi',
                  'available': true,
                  'runnerKind': 'cloud',
                },
                {
                  'key': 'runner:offline:pi',
                  'name': 'Offline PC',
                  'available': true,
                  'runnerKind': 'work-computer',
                  'online': false,
                },
                {
                  'key': 'runner:mine:pi',
                  'name': 'My PC Pi',
                  'available': true,
                  'runnerKind': 'work-computer',
                  'online': true,
                },
              ],
            });
          }
          if (request.url.path.endsWith('preflight')) {
            return _json({'state': 'ready'});
          }
          saved = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({'id': 'new-plan', ...saved!});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, const AutomationEditor()));
      await tester.pumpAndSettle();
      await _fill(tester);
      await _save(tester);
      expect(saved?['assigneeId'], 'runner:mine:pi');
      expect(saved?['enabled'], isFalse);

      saved = null;
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpWidget(
        _app(
          state,
          AutomationEditor(
            key: const ValueKey('saved-cloud-plan'),
            schedule: AutomationSchedule.fromJson({
              ..._plugin(),
              'executionMode': 'direct',
              'pluginBindingId': '',
              'pluginInputs': <String, dynamic>{},
              'assigneeId': 'runner:cloud:pi',
            }),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await _reveal(tester, find.text('Cloud Pi'));
      expect(find.text('Cloud Pi'), findsOneWidget);
      expect(saved, isNull);
    },
  );

  testWidgets(
    'creation uses existing contract, preflights, and saves paused without running',
    (tester) async {
      final calls = <String>[];
      Map<String, dynamic>? saved;
      final state = _State(
        MockClient((request) async {
          calls.add('${request.method} ${request.url.path}');
          if (request.url.path.endsWith('task-execution-options')) {
            return _catalog();
          }
          if (request.url.path.endsWith('preflight')) {
            return _json({'state': 'waiting', 'message': '等待执行机'});
          }
          saved = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({'id': 'new-plan', ...saved!});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, const AutomationEditor()));
      await tester.pumpAndSettle();
      await _fill(tester);
      await tester.scrollUntilVisible(
        find.text('执行底座'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(
        find.ancestor(
          of: find.text('执行底座'),
          matching: find.byType(MobileSelectField<String>),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Pi').last);
      await tester.pumpAndSettle();
      await _save(tester);
      expect(saved?['enabled'], isFalse);
      expect(saved?['every'], 'daily');
      expect(saved?['assigneeId'], 'local:pi');
      expect(saved?['retryLimit'], 2);
      expect(saved?['retryDelayMinutes'], 5);
      expect(saved?.containsKey('ownerClientId'), isFalse);
      expect(calls, [
        'POST /api/v1/task-execution-options',
        'POST /api/v1/schedules/preflight',
        'POST /api/v1/schedules',
      ]);
    },
  );

  testWidgets(
    'editing submits only changed fields and preserves hidden plugin configuration',
    (tester) async {
      final bodies = <Map<String, dynamic>>[];
      final schedule = AutomationSchedule.fromJson(_plugin());
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('task-execution-options')) {
            return _catalog();
          }
          bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
          if (request.url.path.endsWith('preflight')) {
            return _json({'state': 'ready'});
          }
          return _json({..._plugin(), 'title': '新标题'});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(state, AutomationEditor(schedule: schedule)),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('automation-title')), '新标题');
      await _save(tester, edit: true);
      expect(bodies, [
        {'title': '新标题', 'scheduleId': 'plan'},
        {'title': '新标题'},
      ]);
      expect(schedule.configuration['pluginInputs'], {
        'destination': 'existing',
      });
    },
  );

  testWidgets(
    'model selection sends only the changed model and keeps schedule settings',
    (tester) async {
      final bodies = <Map<String, dynamic>>[];
      final original = {
        ..._plugin(),
        'executionMode': 'direct',
        'pluginBindingId': '',
        'assigneeId': 'local:pi',
        'modelName': 'old-model',
      };
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('task-execution-options')) {
            return _catalog();
          }
          if (request.method == 'GET') {
            return _json({
              'usable': [
                {
                  'name': 'new-model',
                  'label': 'New model',
                  'kind': 'openai-compat',
                },
              ],
            });
          }
          bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
          if (request.url.path.endsWith('preflight')) {
            return _json({'state': 'ready'});
          }
          return _json({...original, 'modelName': 'new-model'});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(
          state,
          AutomationEditor(schedule: AutomationSchedule.fromJson(original)),
        ),
      );
      await tester.pumpAndSettle();
      await _reveal(tester, find.byKey(const Key('automation-model')));
      await tester.tap(find.byKey(const Key('automation-model')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('New model'));
      await tester.pumpAndSettle();
      await _save(tester, edit: true);
      expect(bodies, [
        {'modelName': 'new-model', 'scheduleId': 'plan'},
        {'modelName': 'new-model'},
      ]);
    },
  );

  testWidgets('retry policy edits retain unrelated execution configuration', (
    tester,
  ) async {
    final bodies = <Map<String, dynamic>>[];
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
        if (request.url.path.endsWith('preflight')) {
          return _json({'state': 'ready'});
        }
        return _json({..._plugin(), ...bodies.last});
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        AutomationEditor(schedule: AutomationSchedule.fromJson(_plugin())),
      ),
    );
    await tester.pumpAndSettle();
    await _reveal(tester, find.byKey(const Key('automation-advanced')));
    await tester.tap(find.byKey(const Key('automation-advanced')));
    await tester.pumpAndSettle();
    final limit = find.byKey(const Key('automation-retry-limit'));
    final delay = find.byKey(const Key('automation-retry-delay'));
    await _reveal(tester, limit);
    expect(find.text('4 次'), findsOneWidget);
    await tester.tap(limit);
    await tester.pumpAndSettle();
    await tester.tap(find.text('2 次').last);
    await tester.pumpAndSettle();
    await _reveal(tester, delay);
    expect(find.text('17 分钟'), findsOneWidget);
    await tester.tap(delay);
    await tester.pumpAndSettle();
    await tester.tap(find.text('10 分钟').last);
    await tester.pumpAndSettle();
    await _save(tester, edit: true);
    expect(bodies, [
      {'retryLimit': 2, 'retryDelayMinutes': 10, 'scheduleId': 'plan'},
      {'retryLimit': 2, 'retryDelayMinutes': 10},
    ]);
  });

  testWidgets('disabling retries preserves the existing delay', (tester) async {
    final bodies = <Map<String, dynamic>>[];
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
        if (request.url.path.endsWith('preflight')) {
          return _json({'state': 'ready'});
        }
        return _json({..._plugin(), 'retryLimit': 0});
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        AutomationEditor(schedule: AutomationSchedule.fromJson(_plugin())),
      ),
    );
    await tester.pumpAndSettle();
    await _reveal(tester, find.byKey(const Key('automation-advanced')));
    await tester.tap(find.byKey(const Key('automation-advanced')));
    await tester.pumpAndSettle();
    final limit = find.byKey(const Key('automation-retry-limit'));
    await _reveal(tester, limit);
    await tester.tap(limit);
    await tester.pumpAndSettle();
    await tester.tap(find.text('不重试').last);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('automation-retry-delay')), findsNothing);
    await _save(tester, edit: true);
    expect(bodies, [
      {'retryLimit': 0, 'scheduleId': 'plan'},
      {'retryLimit': 0},
    ]);
  });

  test(
    'template defaults localize content and exclude identity or activation',
    () {
      final values = automationTemplateValues({
        'name': '日报',
        'title': '日报整理',
        'note': '整理报告',
        'titleLocales': {'en-US': 'Daily report'},
        'noteLocales': {'en-US': 'Summarize progress'},
        'every': 'weekly',
        'weekday': 2,
        'pluginBindingId': 'org-plugin',
        'pluginInputs': {'topic': 'progress'},
        'requiredCapabilities': ['office'],
        'ownerClientId': 'foreign',
        'enabled': true,
        'personalPluginKey': 'private',
      }, 'en-US');
      expect(values, {
        'title': 'Daily report',
        'note': 'Summarize progress',
        'every': 'weekly',
        'weekday': 2,
        'pluginBindingId': 'org-plugin',
        'pluginInputs': {'topic': 'progress'},
        'requiredCapabilities': ['office'],
      });
    },
  );

  testWidgets('organization plugin template saves paused through preflight', (
    tester,
  ) async {
    final bodies = <Map<String, dynamic>>[];
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
        if (request.url.path.endsWith('preflight')) {
          return _json({'state': 'ready'});
        }
        return _json({'id': 'new-plan', ...bodies.last});
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        AutomationEditor(
          initialValues: {
            'title': '模板计划',
            'note': '执行组织工作流',
            'pluginBindingId': 'binding',
            'pluginInputs': {'topic': 'progress'},
            'requiredCapabilities': ['office'],
            'retryLimit': 3,
            'retryDelayMinutes': 10,
          },
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(bodies, isEmpty);
    await _save(tester);
    expect(bodies.length, 2);
    expect(bodies.first, bodies.last);
    expect(bodies.last['enabled'], isFalse);
    expect(bodies.last['pluginBindingId'], 'binding');
    expect(bodies.last['pluginInputs'], {'topic': 'progress'});
    expect(bodies.last['requiredCapabilities'], ['office']);
    expect(bodies.last['retryLimit'], 3);
    expect(bodies.last.containsKey('assigneeId'), isFalse);
  });

  testWidgets('template selection only prefills an editable draft', (
    tester,
  ) async {
    var writes = 0;
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('templates')) {
          return _json([
            {
              'id': 'team-report',
              'name': '团队周报',
              'title': '每周总结',
              'note': '汇总团队进展',
              'every': 'weekly',
              'weekday': 5,
            },
          ]);
        }
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        if (request.method != 'GET') writes++;
        return _json([]);
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(state, const AutomationsScreen()));
    await tester.pumpAndSettle();
    await _reveal(tester, find.text('使用组织模板'));
    await tester.tap(find.text('使用组织模板'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('团队周报'));
    await tester.pumpAndSettle();
    expect(find.byType(AutomationEditor), findsOneWidget);
    expect(find.text('每周总结'), findsOneWidget);
    expect(find.text('汇总团队进展'), findsOneWidget);
    expect(writes, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('run history discards previous account responses', (
    tester,
  ) async {
    final reply = Completer<http.Response>();
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('/runs')) return reply.future;
        if (request.url.path.endsWith('/templates')) return _json([]);
        return _json([_plugin()]);
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(state, const AutomationsScreen()));
    await tester.pumpAndSettle();
    await _reveal(tester, find.text('运行记录'));
    await tester.tap(find.text('运行记录'));
    await tester.pump();
    state.switchAccount();
    await tester.pump();
    reply.complete(
      _json({
        'items': [
          {'id': 'run-old', 'state': 'succeeded', 'taskTitle': '旧账号私有任务'},
        ],
      }),
    );
    await tester.pumpAndSettle();
    expect(find.text('旧账号私有任务'), findsNothing);
    expect(find.text('账号已变化，请关闭后重新打开运行记录。'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'missing execution directory preserves text and does not submit a fake agent',
    (tester) async {
      var calls = 0;
      final state = _State(
        MockClient((_) async {
          calls++;
          return _json({'substrates': []});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, const AutomationEditor()));
      await tester.pumpAndSettle();
      await _fill(tester);
      await _save(tester);
      expect(find.textContaining('没有执行底座时暂不能保存'), findsOneWidget);
      expect(calls, 1);
      await tester.scrollUntilVisible(
        find.byKey(const Key('automation-title')),
        -250,
        scrollable: find.byType(Scrollable).first,
      );
      expect(
        tester
            .widget<TextFormField>(find.byKey(const Key('automation-title')))
            .controller!
            .text,
        '每日报告',
      );
    },
  );

  testWidgets(
    'weekly cadence keeps weekday contract and submits a sparse change',
    (tester) async {
      final bodies = <Map<String, dynamic>>[];
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('task-execution-options')) {
            return _catalog();
          }
          bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
          if (request.url.path.endsWith('preflight')) {
            return _json({'state': 'ready'});
          }
          return _json({..._plugin(), 'every': 'weekly', 'weekday': 5});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(
          state,
          AutomationEditor(schedule: AutomationSchedule.fromJson(_plugin())),
        ),
      );
      await tester.pumpAndSettle();
      await _reveal(tester, find.byType(MobileSelectField<String>).first);
      await tester.tap(find.byType(MobileSelectField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('每周').last);
      await tester.pumpAndSettle();
      await _reveal(tester, find.byType(MobileSelectField<int>).first);
      await tester.tap(find.byType(MobileSelectField<int>).first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('星期五').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('星期五').last);
      await tester.pumpAndSettle();
      await _save(tester, edit: true);
      expect(bodies, [
        {'every': 'weekly', 'weekday': 5, 'scheduleId': 'plan'},
        {'every': 'weekly', 'weekday': 5},
      ]);
    },
  );

  testWidgets(
    'Beijing date editing saves the exact instant and preserves execution settings',
    (tester) async {
      final bodies = <Map<String, dynamic>>[];
      final original = {
        ..._plugin(),
        'every': 'once',
        'runAt': '2030-11-02T07:29:00Z',
      };
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('task-execution-options')) {
            return _catalog();
          }
          bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
          if (request.url.path.endsWith('preflight')) {
            return _json({'state': 'ready'});
          }
          return _json({...original, ...bodies.last});
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(
          state,
          AutomationEditor(schedule: AutomationSchedule.fromJson(original)),
        ),
      );
      await tester.pumpAndSettle();
      final date = find.byKey(const Key('automation-date'));
      await _reveal(tester, date);
      expect(find.text('2030-11-02'), findsOneWidget);
      expect(find.text('15'), findsOneWidget);
      expect(find.text('29'), findsOneWidget);
      await tester.enterText(date, '2030-11-03');
      await _save(tester, edit: true);
      expect(bodies, [
        {'runAt': '2030-11-03T07:29:00.000Z', 'scheduleId': 'plan'},
        {'runAt': '2030-11-03T07:29:00.000Z'},
      ]);
    },
  );

  testWidgets(
    'one-time cadence rejects missing execution date before preflight',
    (tester) async {
      var requests = 0;
      final state = _State(
        MockClient((request) async {
          requests++;
          return _catalog();
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(
        _app(
          state,
          AutomationEditor(schedule: AutomationSchedule.fromJson(_plugin())),
        ),
      );
      await tester.pumpAndSettle();
      await _reveal(tester, find.byType(MobileSelectField<String>).first);
      await tester.tap(find.byType(MobileSelectField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('仅一次').last);
      await tester.pumpAndSettle();
      await _save(tester, edit: true);
      expect(find.text('请输入有效日期，如 2026-11-02'), findsOneWidget);
      expect(requests, 1);
    },
  );

  testWidgets('blocked preflight never saves and preserves editable draft', (
    tester,
  ) async {
    var writes = 0;
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        if (request.url.path.endsWith('preflight')) {
          return _json({'state': 'blocked', 'message': '插件授权已失效'});
        }
        writes++;
        return _json(_plugin());
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        AutomationEditor(schedule: AutomationSchedule.fromJson(_plugin())),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('automation-title')), '修改');
    await _save(tester, edit: true);
    expect(find.text('插件授权已失效'), findsWidgets);
    expect(writes, 0);
    await _reveal(tester, find.text('保存更改'));
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNotNull,
    );
  });

  testWidgets('uncertain save blocks repetition until list verification', (
    tester,
  ) async {
    var writes = 0;
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        if (request.url.path.endsWith('preflight')) {
          return _json({'state': 'ready'});
        }
        writes++;
        throw http.ClientException('connection lost');
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        AutomationEditor(schedule: AutomationSchedule.fromJson(_plugin())),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('automation-title')), '修改');
    await _save(tester, edit: true);
    expect(find.textContaining('保存结果尚未确认'), findsOneWidget);
    await _reveal(tester, find.text('保存更改'));
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
    expect(writes, 1);
  });

  testWidgets('account switch during preflight prevents subsequent mutation', (
    tester,
  ) async {
    final reply = Completer<http.Response>();
    var preflightStarted = false;
    var writes = 0;
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('task-execution-options')) {
          return _catalog();
        }
        if (request.url.path.endsWith('preflight')) {
          preflightStarted = true;
          return reply.future;
        }
        writes++;
        return _json(_plugin());
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(
      _app(
        state,
        AutomationEditor(schedule: AutomationSchedule.fromJson(_plugin())),
      ),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('automation-title')), '修改');
    await _reveal(tester, find.text('保存更改'));
    await tester.tap(find.text('保存更改'));
    await tester.pump();
    expect(preflightStarted, isTrue);
    state.switchAccount();
    reply.complete(_json({'state': 'ready'}));
    await tester.pumpAndSettle();
    expect(writes, 0);
    expect(find.textContaining('账号已变化'), findsOneWidget);
  });

  for (final nested in [false, true]) {
    testWidgets('save closes only the automation editor (nested: $nested)', (
      tester,
    ) async {
      final state = _State(MockClient((request) async => _catalog()));
      addTearDown(state.dispose);
      Widget launcher(BuildContext context) => TextButton(
        onPressed: () => showAutomationEditor(
          context,
          schedule: AutomationSchedule.fromJson(_plugin()),
        ),
        child: const Text('打开编辑'),
      );
      await tester.pumpWidget(
        _app(
          state,
          Builder(
            builder: (context) => nested
                ? TextButton(
                    onPressed: () => showMobileSheet<void>(
                      context,
                      title: '父设置',
                      builder: (context, scroll) => launcher(context),
                    ),
                    child: const Text('打开设置'),
                  )
                : launcher(context),
          ),
        ),
      );
      await tester.pumpAndSettle();
      if (nested) {
        await tester.tap(find.text('打开设置'));
        await tester.pumpAndSettle();
      }
      await tester.tap(find.text('打开编辑'));
      await tester.pumpAndSettle();
      await _save(tester, edit: true);
      expect(find.byType(AutomationEditor), findsNothing);
      expect(find.text('打开编辑'), findsOneWidget);
      expect(find.text('父设置'), nested ? findsOneWidget : findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'consumed one-time schedule explains rearming without claiming completion',
    (tester) async {
      var writes = 0;
      final state = _State(
        MockClient((request) async {
          if (request.method != 'GET') writes++;
          return _json([
            {
              ..._plugin(),
              'every': 'once',
              'onceFired': true,
              'enabled': false,
            },
          ]);
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, const AutomationsScreen()));
      await tester.pumpAndSettle();
      expect(find.text('已触发一次'), findsOneWidget);
      expect(find.text('再次定时运行，请修改时间'), findsOneWidget);
      expect(find.text('本次定时已触发，进展请查看运行记录'), findsOneWidget);
      expect(tester.widget<Switch>(find.byType(Switch)).onChanged, isNull);
      expect(find.text('已完成'), findsNothing);
      expect(writes, 0);
    },
  );

  testWidgets('creation stays available while the list loads or fails', (
    tester,
  ) async {
    final response = Completer<http.Response>();
    final state = _State(MockClient((request) => response.future));
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(state, const AutomationsScreen()));
    await tester.pump();
    expect(find.text('新建自动化'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '新建自动化'))
          .onPressed,
      isNotNull,
    );
    response.complete(_json({'detail': '列表暂时不可用'}, 503));
    await tester.pumpAndSettle();
    expect(find.text('自动化暂时无法加载'), findsOneWidget);
    expect(find.text('新建自动化'), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '新建自动化'))
          .onPressed,
      isNotNull,
    );
  });

  testWidgets(
    'embedded automation page exposes creation and deletion requires confirmation',
    (tester) async {
      var deletes = 0;
      final state = _State(
        MockClient((request) async {
          if (request.method == 'DELETE') {
            deletes++;
            return _json({'ok': true});
          }
          return _json([_plugin()]);
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, const AutomationsScreen()));
      await tester.pumpAndSettle();
      expect(find.text('新建自动化'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.byTooltip('管理自动化'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byTooltip('管理自动化'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('删除计划'));
      await tester.pumpAndSettle();
      expect(deletes, 0);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(deletes, 0);
      await tester.tap(find.byTooltip('管理自动化'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('删除计划'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('删除').last);
      await tester.pumpAndSettle();
      expect(deletes, 1);
      expect(find.text('还没有个人自动化'), findsOneWidget);
    },
  );
  testWidgets('manual run opens live receipts and refreshes until settlement', (
    tester,
  ) async {
    var runs = 0;
    var histories = 0;
    final state = _State(
      MockClient((request) async {
        if (request.url.path.endsWith('/preflight')) {
          return _json({'state': 'ready'});
        }
        if (request.url.path.endsWith('/run')) {
          runs++;
          return _json({
            'ok': true,
            'scheduleRunId': 'run-1',
            'waitingForDevice': true,
          });
        }
        if (request.url.path.endsWith('/runs')) {
          histories++;
          return _json({
            'items': [
              {
                'id': 'run-1',
                'state': histories == 1 ? 'running' : 'succeeded',
                'taskTitle': '真实执行记录',
              },
            ],
          });
        }
        if (request.url.path.endsWith('/templates')) return _json([]);
        return _json([_plugin()]);
      }),
    );
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(state, const AutomationsScreen()));
    await tester.pumpAndSettle();
    await _reveal(tester, find.text('立即运行'));
    await tester.tap(find.text('立即运行'));
    await tester.pumpAndSettle();
    expect(runs, 1);
    expect(histories, 1);
    expect(find.text('真实执行记录'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(histories, 2);
    await tester.pump(const Duration(seconds: 10));
    expect(histories, 2);
    await tester.tap(find.byTooltip('关闭'));
    await tester.pumpAndSettle();
  });

  testWidgets(
    'empty manual run receipt does not report success or silently retry',
    (tester) async {
      var runs = 0;
      final state = _State(
        MockClient((request) async {
          if (request.url.path.endsWith('/preflight')) {
            return _json({'state': 'ready'});
          }
          if (request.url.path.endsWith('/run')) {
            runs++;
            return _json({});
          }
          if (request.url.path.endsWith('/runs')) return _json({'items': []});
          if (request.url.path.endsWith('/templates')) return _json([]);
          return _json([_plugin()]);
        }),
      );
      addTearDown(state.dispose);
      await tester.pumpWidget(_app(state, const AutomationsScreen()));
      await tester.pumpAndSettle();
      await _reveal(tester, find.text('立即运行'));
      await tester.tap(find.text('立即运行'));
      await tester.pumpAndSettle();
      expect(runs, 1);
      expect(find.text('已发起运行，可在运行记录中跟进'), findsNothing);
      await tester.tap(find.byTooltip('关闭'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('立即运行'));
      await tester.pumpAndSettle();
      expect(find.text('确认再次运行？'), findsOneWidget);
      expect(runs, 1);
      await tester.tap(find.text('返回核对'));
      await tester.pumpAndSettle();
      expect(runs, 1);
    },
  );
}

Future<void> _fill(WidgetTester tester) async {
  await tester.enterText(find.byKey(const Key('automation-title')), '每日报告');
  await tester.enterText(
    find.byKey(const Key('automation-note')),
    '整理项目进度，列出风险和下一步。',
  );
}

Future<void> _save(WidgetTester tester, {bool edit = false}) async {
  final label = edit ? '保存更改' : '保存为暂停计划';
  await _reveal(tester, find.text(label));
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

Future<void> _reveal(WidgetTester tester, Finder finder) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pumpAndSettle();
  await tester.scrollUntilVisible(
    finder,
    250,
    scrollable: find.byType(Scrollable).first,
  );
  await tester.pumpAndSettle();
  await Scrollable.ensureVisible(tester.element(finder), alignment: 0.5);
  await tester.pumpAndSettle();
}

Map<String, dynamic> _plugin() => {
  'id': 'plan',
  'title': '原计划',
  'note': '原始要求',
  'every': 'daily',
  'timeZone': 'Asia/Shanghai',
  'atHour': 9,
  'atMinute': 5,
  'weekday': 2,
  'assigneeId': '',
  'executionMode': 'plugin',
  'enabled': false,
  'pluginBindingId': 'binding',
  'pluginInputs': {'destination': 'existing'},
  'retryDelayMinutes': 17,
  'retryLimit': 4,
  'repoId': 'repo-original',
};

http.Response _catalog() => _json({
  'substrates': [
    {'key': 'local:pi', 'name': 'Pi', 'available': true},
  ],
});
http.Response _json(Object data, [int status = 200]) => http.Response(
  jsonEncode(data),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Widget _app(MobileState state, Widget child) => MobileScope(
  state: state,
  child: MaterialApp(
    theme: SoduWorkTheme.light(const SoduWorkBrandTheme()),
    home: Scaffold(body: child),
  ),
);

class _State extends MobileState {
  int revision = 1;
  _State(http.Client client) {
    api = _Api(
      store: _Store(),
      endpoint: const EndpointSettings(
        environment: SoduWorkEnvironment.development,
        baseUrl: 'https://hub.test',
      ),
      client: client,
    );
  }
  @override
  int get identityRevision => revision;
  void switchAccount() {
    revision++;
    notifyListeners();
  }
}

class _Store extends DeviceStore with MemoryDeviceAuthentication {
  @override
  Future<String?> readSession(String endpoint) async => 'fixture-session';
}

// Existing editor cases use a desktop-only directory; remote-seat behavior has
// separate regression coverage in automation_chat_host_test.dart.
class _Api extends SoduWorkApi {
  _Api({required super.store, required super.endpoint, required super.client});
  @override
  Future<Map<String, dynamic>> cloudConversationTargets() async => {
    'targets': [],
  };
}

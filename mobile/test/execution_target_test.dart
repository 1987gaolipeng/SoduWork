import 'package:flutter_test/flutter_test.dart';

import 'package:soduwork_mobile/core/execution_target.dart';

void main() {
  test('normalizes PC roster targets without changing explicit fields', () {
    final row = normalizeExecutionTarget({
      'id': 'runner:desk:opencode',
      'agentId': 'opencode',
      'type': 'agent',
      'online': true,
      'remote': true,
      'runnerId': 'desk',
      'modelPick': true,
    });
    expect(isUsableExecutionTarget(row), isTrue);
    expect(executionTargetAgentId(row), 'opencode');
    expect(row['modelPick'], isTrue);
  });

  test('marks a desktop Runner as a work computer target', () {
    final row = normalizeExecutionTarget({
      'id': 'runner:desk:codex',
      'runnerId': 'desk',
      'agentId': 'codex',
      'runnerKind': 'work-computer',
      'online': true,
      'remote': true,
    });
    expect(isUsableExecutionTarget(row), isTrue);
    expect(isWorkComputerExecutionTarget(row), isTrue);
    expect(executionTargetKind(row), 'work-computer');
  });

  test('accepts Hub handoff target shape missing UI-only flags', () {
    final row = normalizeExecutionTarget({
      'id': 'runner:desk:qwen',
      'runnerId': 'desk',
      'agentId': 'qwen',
      'name': '研发电脑 · Qwen',
      'modelMode': 'managed',
    });
    expect(isUsableExecutionTarget(row), isTrue);
    expect(row['online'], isTrue);
    expect(row['remote'], isTrue);
    expect(row['cliName'], '研发电脑 · Qwen');
    expect(row['modelPick'], isTrue);
  });

  test('derives the agent from a runner-qualified id only as a fallback', () {
    final row = normalizeExecutionTarget({
      'id': 'runner:desk:claude',
      'runnerId': 'desk',
    });
    expect(executionTargetAgentId(row), 'claude');
  });

  test('does not expose a local target as a cloud handoff target', () {
    expect(
      isUsableExecutionTarget({
        'id': 'local:pi',
        'agentId': 'pi',
        'type': 'agent',
        'online': true,
        'remote': false,
      }),
      isFalse,
    );
  });
}

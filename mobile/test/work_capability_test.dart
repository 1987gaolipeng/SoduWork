import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/models/work_capability.dart';

void main() {
  test('workflow identity is a runnable binding with an actual workflow', () {
    final row = {
      'bindingId': 'binding-1',
      'pluginId': 'plugin-1',
      'version': 'v3',
      'name': '整理报告',
      'runnable': true,
      'capabilities': {'hasWorkflow': true},
      'inputs': <dynamic>[],
    };
    final capability = WorkCapability.workflow(row);
    expect(capability.id, 'binding-1');
    expect(capability.metadata['pluginId'], 'plugin-1');
    expect(capability.metadata['version'], 'v3');
    expect(capability.enabled, isTrue);
    expect(
      WorkCapability.workflow({
        ...row,
        'capabilities': {'hasWorkflow': false},
      }).enabled,
      isFalse,
    );
    expect(
      WorkCapability.workflow({
        ...row,
        'runnable': false,
        'readiness': {
          'blockers': [
            {'message': '缺少已授权的执行环境'},
          ],
        },
      }).reason,
      contains('缺少已授权'),
    );
    expect(
      WorkCapability.workflow({
        'id': 'installed-version',
        'runnable': true,
      }).enabled,
      isFalse,
    );
  });

  test(
    'explicit skill selection does not confuse default preference with permission',
    () {
      final capability = WorkCapability.skill({
        'id': 'skill:report',
        'name': 'report',
        'enabled': false,
        'description': '整理报告',
        'downloadable': true,
      });
      expect(capability.id, 'report');
      expect(capability.enabled, isTrue);
      expect(capability.metadata['enabled'], isFalse);
      expect(capability.reason, isEmpty);
      expect(
        WorkCapability.skill({'name': 'report', 'localOnly': true}).enabled,
        isFalse,
      );
      for (final name in [
        'computer-use',
        'computer_use',
        'desktop',
        'local-desktop',
      ]) {
        expect(
          WorkCapability.skill({'name': name, 'enabled': true}).enabled,
          isFalse,
        );
      }
    },
  );

  test('teammates require an account and a receiving device', () {
    expect(
      WorkCapability.teammate({
        'id': 'user-1',
        'name': '同事',
        'canReceive': true,
      }).enabled,
      isTrue,
    );
    expect(
      WorkCapability.teammate({
        'userId': 'user-2',
        'canReceive': false,
      }).enabled,
      isFalse,
    );
    expect(WorkCapability.teammate({'canReceive': true}).enabled, isFalse);
  });

  test(
    'selected input metadata cannot be changed through the original catalog object',
    () {
      final input = {'key': 'text', 'type': 'text'};
      final capability = WorkCapability(
        kind: WorkCapabilityKind.workflow,
        id: 'binding',
        label: '工作流',
        metadata: {
          'inputs': [input],
        },
      );
      input['type'] = 'unsupported';
      final fields = capability.metadata['inputs'] as List;
      expect((fields.single as Map)['type'], 'text');
      expect(() => fields.add({}), throwsUnsupportedError);
      expect(
        () => (fields.single as Map)['type'] = 'number',
        throwsUnsupportedError,
      );
    },
  );
}

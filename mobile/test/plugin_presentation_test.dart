import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/plugin_presentation.dart';

void main() {
  test('classifies formal and legacy navigation apps without name rules', () {
    expect(isWorkspaceApplication({'template': 'app'}), isTrue);
    expect(
      isWorkspaceApplication({
        'name': 'Any name',
        'ui': {
          'contributions': [
            null,
            {'slot': 'workspace.navigation'},
          ],
        },
      }),
      isTrue,
    );
    expect(isWorkspaceApplication({'name': '示例业务应用'}), isFalse);
  });

  test(
    'retains method and workflow plugins with unrelated or malformed UI',
    () {
      for (final ui in [
        null,
        'invalid',
        {},
        {'contributions': 'invalid'},
        {
          'contributions': [
            null,
            3,
            {'slot': 'conversation.toolbar'},
          ],
        },
      ]) {
        expect(
          isWorkspaceApplication({'template': 'workflow', 'ui': ui}),
          isFalse,
        );
      }
      expect(isWorkspaceApplication({'template': 'method'}), isFalse);
    },
  );
}

import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/shared_conversation_selection.dart';

Map<String, dynamic> target(
  String agent, {
  String runner = 'runner-a',
  String mode = 'managed',
  bool online = true,
}) => {
  'runnerId': runner,
  'agentId': agent,
  'type': 'agent',
  'remote': true,
  'online': online,
  'modelMode': mode,
};

void main() {
  test('normalizes only public selection fields into an immutable packet', () {
    final selection = normalizeSharedExecutionSelection({
      'agentId': ' codex ',
      'modelName': ' model-x ',
      'reasoningEffort': ' HIGH ',
    });
    expect(selection, {
      'agentId': 'codex',
      'modelName': 'model-x',
      'reasoningEffort': 'high',
    });
    expect(() => selection['modelName'] = 'changed', throwsUnsupportedError);
    expect(normalizeSharedExecutionSelection({'agentId': 'pi'}), {
      'agentId': 'pi',
      'modelName': '',
      'reasoningEffort': '',
    });
  });

  test(
    'rejects extra fields, nulls, control characters and excessive values',
    () {
      for (final invalid in <Map<String, dynamic>>[
        {'agentId': 'pi', 'apiKey': 'not-allowed'},
        {'agentId': 'pi', 'modelName': null},
        {'agentId': 'pi', 'modelName': 1},
        {'agentId': ' '},
        {'agentId': 'pi', 'modelName': String.fromCharCode(0)},
        {'agentId': 'pi', 'modelName': List.filled(161, 'a').join()},
        {'agentId': 'pi', 'reasoningEffort': 'high'},
        {'agentId': 'codex', 'reasoningEffort': 'unlimited'},
      ]) {
        expect(
          () => normalizeSharedExecutionSelection(invalid),
          throwsFormatException,
        );
      }
    },
  );

  test(
    'restricts choices to original online Runner and unique authorized agents',
    () {
      final rows = sharedConversationTargetsForRunner([
        target('pi'),
        target('pi'),
        target('codex', mode: 'account'),
        target('qwen', runner: 'runner-b'),
        target('offline', online: false),
        {...target('local'), 'remote': false},
        {...target('human'), 'type': 'person'},
      ], 'runner-a');
      expect(rows.map((row) => row['agentId']), ['pi', 'codex']);
      expect(() => rows.add(target('new')), throwsUnsupportedError);
      expect(() => rows.first['runnerId'] = 'runner-b', throwsUnsupportedError);
      expect(sharedConversationTargetsForRunner([target('pi')], ''), isEmpty);
    },
  );

  test(
    'company model selection requires current usable catalog membership',
    () {
      final raw = {'agentId': 'pi', 'modelName': 'company/model'};
      expect(
        validateSharedExecutionSelection(
          raw,
          runnerId: 'runner-a',
          targets: [target('pi')],
          usableModels: [
            {'name': 'company/model'},
          ],
        ),
        {'agentId': 'pi', 'modelName': 'company/model', 'reasoningEffort': ''},
      );
      expect(
        () => validateSharedExecutionSelection(
          raw,
          runnerId: 'runner-a',
          targets: [target('pi')],
          usableModels: [
            {'name': 'removed-model'},
          ],
        ),
        throwsFormatException,
      );
    },
  );

  test('original Runner being unavailable must not select another machine', () {
    for (final runner in ['', 'runner-a']) {
      expect(
        () => validateSharedExecutionSelection(
          {'agentId': 'pi'},
          runnerId: runner,
          targets: [target('pi', runner: 'runner-b')],
          usableModels: [],
        ),
        throwsFormatException,
      );
    }
  });

  test('account-backed agents use their default without a company model', () {
    final rows = [target('claude', mode: 'account')];
    expect(
      validateSharedExecutionSelection(
        {'agentId': 'claude'},
        runnerId: 'runner-a',
        targets: rows,
        usableModels: [],
      )['modelName'],
      '',
    );
    expect(
      () => validateSharedExecutionSelection(
        {'agentId': 'claude', 'modelName': 'company-model'},
        runnerId: 'runner-a',
        targets: rows,
        usableModels: [
          {'name': 'company-model'},
        ],
      ),
      throwsFormatException,
    );
  });

  test(
    'Codex native selection validates syntax without pretending catalog discovery',
    () {
      final rows = [target('codex', mode: 'account')];
      expect(
        validateSharedExecutionSelection(
          {
            'agentId': 'codex',
            'modelName': 'native-model',
            'reasoningEffort': 'high',
          },
          runnerId: 'runner-a',
          targets: rows,
          usableModels: [],
        )['modelName'],
        'native-model',
      );
      expect(
        () => validateSharedExecutionSelection(
          {'agentId': 'codex', 'modelName': 'company/model'},
          runnerId: 'runner-a',
          targets: rows,
          usableModels: [
            {'name': 'company/model'},
          ],
        ),
        throwsFormatException,
      );
    },
  );

  test(
    'unknown model mode never silently accepts company credentials routing',
    () {
      expect(
        () => validateSharedExecutionSelection(
          {'agentId': 'new-agent', 'modelName': 'company-model'},
          runnerId: 'runner-a',
          targets: [target('new-agent', mode: '')],
          usableModels: [
            {'name': 'company-model'},
          ],
        ),
        throwsFormatException,
      );
    },
  );
}

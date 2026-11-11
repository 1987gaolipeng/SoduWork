import 'automation_execution_directory.dart';
import 'soduwork_api.dart';

/// Narrow host for the reused PC automation card. Credentials stay in Dart.
class AutomationChatHost {
  final SoduWorkApi api;
  final String identity;
  final bool dark;
  final void Function() checkCurrent;
  final void Function() onClose;
  Map<String, dynamic>? created;
  bool _creating = false;
  bool _uncertain = false;

  AutomationChatHost({
    required this.api,
    required this.identity,
    required this.dark,
    required this.checkCurrent,
    required this.onClose,
  });

  Future<Object?> handle(String method, Map<String, dynamic> args) async {
    checkCurrent();
    switch (method) {
      case 'ready':
        return {'identity': identity, 'dark': dark};
      case 'models':
        final result = await api.chatModelCatalog();
        checkCurrent();
        return {
          'usable': [
            for (final row in result['usable'] as List? ?? const [])
              if (row is Map) {'name': row['name'], 'label': row['label']},
          ],
        };
      case 'executionOptions':
        final result = await loadAutomationExecutionDirectory(api);
        checkCurrent();
        return result;
      case 'parse':
        final text = args['text'];
        if (text is! String || text.trim().isEmpty || text.length > 100000) {
          throw const ApiFailure('请描述自动化要求，内容不能超过 100000 个字符。');
        }
        final result = await api.parseAutomation(
          text,
          model: args['model'] is String ? args['model'] as String : '',
          instruction: args['instruction'] is String
              ? args['instruction'] as String
              : text,
          candidates: args['candidates'] is Map
              ? Map<String, dynamic>.from(args['candidates'] as Map)
              : const {},
        );
        checkCurrent();
        return result;
      case 'preflight':
        final result = await api.preflightAutomation(_body(args));
        checkCurrent();
        return result;
      case 'create':
        if (_creating || _uncertain || created != null) {
          throw const ApiFailure('保存已发起，请返回自动化列表核对，勿重复创建。');
        }
        _creating = true;
        var submitting = false;
        try {
          final body = _body(args);
          final check = await api.preflightAutomation(body);
          checkCurrent();
          if (!{'ready', 'waiting'}.contains(check['state'])) {
            throw ApiFailure(check['message']?.toString() ?? '执行条件尚未满足');
          }
          submitting = true;
          final result = await api.createAutomation(body);
          created = Map<String, dynamic>.from(result.configuration);
          checkCurrent();
          return created;
        } on ApiFailure catch (error) {
          _uncertain = submitting && (error.isNetwork || error.status >= 500);
          rethrow;
        } catch (_) {
          _uncertain = submitting;
          rethrow;
        } finally {
          _creating = false;
        }
      case 'close':
        onClose();
        return {'ok': true};
      default:
        throw const ApiFailure('此自动化操作不受支持。');
    }
  }

  Map<String, dynamic> _body(Map<String, dynamic> value) {
    const allowed = {
      'title',
      'note',
      'every',
      'runAt',
      'atHour',
      'atMinute',
      'weekday',
      'timeZone',
      'assigneeId',
      'modelName',
      'repoId',
      'flow',
      'pluginBindingId',
      'personalPluginKey',
      'personalPluginVersionPolicy',
      'personalPluginVersion',
      'personalPluginChecksum',
      'pluginInputs',
      'requiredCapabilities',
      'retryLimit',
      'retryDelayMinutes',
    };
    return {
      for (final item in value.entries)
        if (allowed.contains(item.key)) item.key: item.value,
      'enabled': false,
      'assigneeType': 'agent',
    };
  }
}

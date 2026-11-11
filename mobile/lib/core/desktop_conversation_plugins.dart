import '../models/account_conversation.dart';
import 'cloud_conversation_request.dart';
import 'soduwork_api.dart';

/// Adapts the selected PC's existing plugin service to the shared composer.
class DesktopConversationPlugins {
  final SoduWorkApi api;
  final void Function() check;
  final _selected = <String, Map<String, dynamic>>{};
  DesktopConversationPlugins(this.api, this.check);

  Future<String> _client(String runner) async {
    final targets = await api.desktopCapabilityTargets();
    check();
    final matches = (targets['items'] as List? ?? [])
        .whereType<Map>()
        .where((row) => row['runnerId'] == runner && row['ready'] == true)
        .toList();
    if (runner.isEmpty || matches.length != 1) {
      throw const ApiFailure('这台电脑暂不可用，请确认在线后刷新；不会切换到其他电脑。');
    }
    return matches.single['id'] as String;
  }

  Future<Map<String, dynamic>> catalog(String runner) async {
    final client = await _client(runner);
    final catalog = await api.desktopCapabilityRequest(
      client,
      'catalog',
      {},
      mobileRequestId(),
    );
    check();
    final items = <Map<String, dynamic>>[];
    for (final raw in (catalog['plugins'] as List? ?? []).whereType<Map>()) {
      if (raw['pluginId'] is! String || raw['checksum'] is! String) continue;
      final row = Map<String, dynamic>.from(raw);
      final id = 'desktop:$runner:${row['checksum']}:${row['pluginId']}';
      _selected[id] = {...row, 'runnerId': runner, 'clientId': client};
      items.add({
        ...row,
        'pluginId': id,
        'personal': true,
        'installed': true,
        'scope': '本人电脑',
        'capabilities': {'hasWorkflow': false},
        'entrypoints': {'conversation': true},
      });
    }
    return {'items': items};
  }

  Future<AccountConversation> send(Map<String, dynamic> args) async {
    final selections = args['plugins'];
    if (selections is! List ||
        selections.length != 1 ||
        selections.single is! Map) {
      throw const ApiFailure('每次选择一个本机插件，再发送工作内容。', status: 409);
    }
    if (args['agentId'] != 'pi') {
      throw const ApiFailure('本机插件使用 Pi 执行，请先切换底座。', status: 409);
    }
    if ((args['files'] as List? ?? []).isNotEmpty ||
        (args['skills'] as List? ?? []).isNotEmpty) {
      throw const ApiFailure(
        '本机插件会沿用电脑的能力；本次请先发送工作描述，附件和额外技能仍保留在草稿中。',
        status: 409,
      );
    }
    final runner = args['targetRunnerId'] as String? ?? '';
    final row = _selected[selections.single['pluginId']];
    if (args['targetRunnerKind'] != 'work-computer' ||
        row == null ||
        row['runnerId'] != runner) {
      throw const ApiFailure('执行电脑或插件已变化，请重新选择插件。', status: 409);
    }
    final client = await _client(runner);
    if (client != row['clientId']) {
      throw const ApiFailure('电脑连接已变化，请刷新插件目录。', status: 409);
    }
    final requestId = args['messageId'] as String;
    final body = <String, dynamic>{
      'pluginId': row['pluginId'],
      'expectedChecksum': row['checksum'],
      'text': args['text'],
      'modelName': args['model'] ?? '',
    };
    // Retrying the same ID reads the desktop's durable receipt; it never sends a second turn.
    final result = await api.desktopCapabilityRequest(
      client,
      'plugin.use',
      body,
      requestId,
    );
    check();
    if (result['ok'] != true || result['conversation'] is! Map) {
      throw const ApiFailure('电脑已接收，会话正在同步。请稍后重试原内容以读取回执，不会重复执行。', status: 503);
    }
    final conversation = AccountConversation.fromJson(
      Map<String, dynamic>.from(result['conversation'] as Map),
    );
    if (conversation.id.isEmpty ||
        conversation.sourceClientId != client ||
        conversation.sourceSessionId != result['sourceSessionId']) {
      throw const ApiFailure('会话回执不匹配，请在历史中核对。', status: 409);
    }
    return conversation;
  }
}

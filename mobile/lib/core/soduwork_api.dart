import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:image_picker/image_picker.dart';

import '../models/work_models.dart';
import 'device_store.dart';
import 'cloud_conversation_request.dart';

part 'device_auth_session.dart';
part 'client_email_auth.dart';
part 'library_api.dart';

class ApiFailure implements Exception {
  final int status;
  final String message;
  final bool isNetwork;
  final String code;
  final int retryAfter;

  const ApiFailure(
    this.message, {
    this.status = 0,
    this.isNetwork = false,
    this.code = '',
    this.retryAfter = 0,
  });

  bool get needsActivation => status == 403;

  @override
  String toString() => message;
}

class EnrollmentState {
  final bool active;
  final String deviceId;
  final String deviceName;
  final String authState;
  final String ownerUserId;

  const EnrollmentState({
    required this.active,
    required this.deviceId,
    required this.deviceName,
    required this.authState,
    required this.ownerUserId,
  });
}

class SoduWorkApi {
  final DeviceStore store;
  final http.Client client;
  EndpointSettings endpoint;
  final String deviceDisplayName;

  SoduWorkApi({
    required this.store,
    required this.endpoint,
    this.deviceDisplayName = 'SoduWork Mobile',
    http.Client? client,
  }) : client = client ?? http.Client();

  Future<void>? _localPreparation;
  int _localReadyRevision = -1;
  String? _localRunnerId;
  String? get localExecutionRunnerId =>
      isLocalDevelopment && _localReadyRevision == _authRevision
      ? _localRunnerId
      : null;
  int _authRevision = 0;
  Future<SignOutResult>? _signOutOperation;
  final _accountLogins = <String, Future<EnrollmentState>>{};
  String get baseUrl => endpoint.baseUrl;
  int get authRevision => _authRevision;
  void invalidateAuthentication() {
    _authRevision++;
  }

  Future<SignOutResult> signOut() {
    if (_signOutOperation != null) return _signOutOperation!;
    final operation = _signOut();
    _signOutOperation = operation;
    operation.whenComplete(() {
      if (identical(_signOutOperation, operation)) _signOutOperation = null;
    });
    return operation;
  }

  void setEndpoint(EndpointSettings value) {
    invalidateAuthentication();
    endpoint = value;
  }

  String absoluteUrl(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) return '';
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    return baseUrl + (trimmed.startsWith('/') ? '' : '/') + trimmed;
  }

  Future<Map<String, dynamic>> memoryRecords({
    String scope = '',
    String search = '',
    bool archived = false,
    int offset = 0,
  }) async {
    if (offset < 0 ||
        search.length > 120 ||
        !['', 'session', 'workspace', 'project'].contains(scope)) {
      throw const ApiFailure('记忆查询无效。');
    }
    final query = Uri(
      queryParameters: {
        'scope': scope,
        'search': search,
        'archived': '$archived',
        'offset': '$offset',
      },
    ).query;
    return _asMap(await _authorized('GET', '/api/v1/memories?$query'));
  }

  Future<Map<String, dynamic>> memoryRecord(String id) async => _asMap(
    await _authorized('GET', '/api/v1/memories/${Uri.encodeComponent(id)}'),
  );
  Future<Map<String, dynamic>> saveMemoryRecord(
    String? id,
    Map<String, dynamic> body,
  ) async => _asMap(
    await _authorized(
      id == null ? 'POST' : 'PUT',
      id == null
          ? '/api/v1/memories'
          : '/api/v1/memories/${Uri.encodeComponent(id)}',
      body: body,
    ),
  );
  Future<void> memoryRecordAction(String id, String action) async {
    if (!['archive', 'restore', 'delete'].contains(action)) {
      throw const ApiFailure('记忆操作无效。');
    }
    final path = '/api/v1/memories/${Uri.encodeComponent(id)}';
    await _authorized(
      action == 'delete' ? 'DELETE' : 'POST',
      action == 'delete' ? path : '$path/$action',
    );
  }

  Future<Map<String, dynamic>> currentAccount() async =>
      _asMap(await _authorized('GET', '/api/v1/client-auth/me'));

  Future<Map<String, dynamic>> remoteScreenRequest(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final read =
        method == 'GET' &&
        (path == '/api/v1/remote-screen/sources' ||
            RegExp(
              r'^/api/v1/remote-screen/requests/[A-Za-z0-9-]{1,80}$',
            ).hasMatch(path));
    final write =
        method == 'POST' &&
        (path == '/api/v1/remote-screen/requests' ||
            RegExp(
              r'^/api/v1/remote-screen/requests/[A-Za-z0-9-]{1,80}/(ticket|stop)$',
            ).hasMatch(path));
    if (!read && !write) throw const ApiFailure('远程查看请求无效。');
    return _asMap(
      await _authorized(
        method,
        path,
        body: body,
        timeout: const Duration(seconds: 20),
      ),
    );
  }

  Future<Map<String, dynamic>> teamMessages({
    String folder = 'received',
    String before = '',
  }) async {
    if (folder != 'received' && folder != 'sent') {
      throw const ApiFailure('消息目录无效。');
    }
    final query = Uri(
      queryParameters: {
        'folder': folder,
        'limit': '100',
        if (before.isNotEmpty) 'before': before,
      },
    ).query;
    return _asMap(await _authorized('GET', '/api/v1/team/messages?$query'));
  }

  Future<Map<String, dynamic>> readTeamMessage(String id) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/team/messages/${Uri.encodeComponent(id)}/read',
    ),
  );

  Future<Map<String, String>> authorizationHeaders() async {
    final revision = _authRevision;
    final token = await _session();
    _checkAuthentication(revision);
    return {'Authorization': 'Device $token'};
  }

  /// Returns the short-lived device session used by the first frame of the
  /// authenticated realtime channel. The token stays out of the WebSocket
  /// URL and follows the same renewal/revocation rules as REST requests.
  Future<String> realtimeSession() => _session();

  Future<EnrollmentState> enroll() => _enroll();

  Future<EnrollmentState> loginWithAccount({
    required String account,
    required String password,
  }) {
    final loginEndpoint = baseUrl;
    final overlapping = _accountLogins.containsKey(loginEndpoint);
    final operation = _performAccountLogin(
      account: account,
      password: password,
      replaceIdentity: overlapping,
    );
    _accountLogins[loginEndpoint] = operation;
    return operation.whenComplete(() {
      if (identical(_accountLogins[loginEndpoint], operation)) {
        _accountLogins.remove(loginEndpoint);
      }
    });
  }

  Future<List<WorkTask>> tasks() async {
    final body = await _authorized('GET', '/api/v1/tasks');
    return _asList(
      body,
    ).map((item) => WorkTask.fromJson(_asMap(item))).toList(growable: false);
  }

  Future<WorkTask> task(String id) async {
    final body = await _authorized('GET', '/api/v1/tasks/$id');
    return WorkTask.fromJson(_asMap(body));
  }

  Future<WorkTask> createTask(Map<String, dynamic> payload) async {
    final body = await _authorized('POST', '/api/v1/tasks', body: payload);
    return WorkTask.fromJson(_asMap(body));
  }

  Future<Map<String, dynamic>> putRequirement(
    String id,
    Map<String, dynamic> body,
  ) async => _asMap(
    await _authorized(
      'PUT',
      '/api/v1/tasks/${Uri.encodeComponent(id)}',
      body: body,
    ),
  );

  Future<Map<String, dynamic>> createAssignedRequirement(
    Map<String, dynamic> body,
  ) async =>
      _asMap(await _authorized('POST', '/api/v1/tasks/assigned', body: body));

  Future<Map<String, dynamic>> parseRequirement(
    String text, {
    String model = '',
    String instruction = '',
    List<Map<String, dynamic>> attachments = const [],
  }) async {
    final result = _asMap(
      await _authorized(
        'POST',
        '/api/v1/tasks/parse',
        body: {
          'text': text,
          if (model.isNotEmpty) 'model': model,
          if (instruction.isNotEmpty) 'instruction': instruction,
          if (attachments.isNotEmpty) 'attachments': attachments,
        },
        timeout: const Duration(seconds: 90),
      ),
    );
    final fields = _asMap(result['fields']);
    if (result['ok'] == false || fields.isEmpty) {
      throw const ApiFailure('没有生成可确认的需求草稿，请补充要求或编辑表单。');
    }
    return fields;
  }

  Future<Map<String, dynamic>> parseTask(String text) async {
    final body = await _authorized(
      'POST',
      '/api/v1/tasks/parse',
      body: {'text': text.trim()},
    );
    return _asMap(_asMap(body)['fields']);
  }

  Future<Map<String, dynamic>> parseAutomation(
    String text, {
    String model = '',
    String instruction = '',
    Map<String, dynamic> candidates = const {},
  }) async {
    final result = _asMap(
      await _authorized(
        'POST',
        '/api/v1/tasks/parse',
        body: {
          'text': text.trim(),
          'kind': 'automation',
          if (model.isNotEmpty) 'model': model,
          if (instruction.isNotEmpty) 'instruction': instruction,
          'candidates': candidates,
        },
        timeout: const Duration(seconds: 90),
      ),
    );
    final fields = _asMap(result['fields']);
    if (result['ok'] == false || fields.isEmpty) {
      throw const ApiFailure('没有生成可确认的自动化草稿，请补充工作要求或使用手动设置。');
    }
    return fields;
  }

  Future<Map<String, dynamic>> taskExecutionOptions(
    Map<String, dynamic> body,
  ) async {
    Future<Map<String, dynamic>> readOptions() async => _asMap(
      await _authorized('POST', '/api/v1/task-execution-options', body: body),
    );
    final options = await readOptions();
    // Discover authorized remote targets before preparing the optional device
    // helper. An available cloud Runner must not inherit that helper's delay.
    final remoteReady = _asList(options['substrates']).map(_asMap).any((agent) {
      if (agent['available'] != true) return false;
      final locations = _asList(agent['locations']).map(_asMap).toList();
      return locations.any((location) => location['mode'] == 'remote') ||
          (locations.isEmpty && agent['locationMode'] == 'remote');
    });
    if (!isLocalDevelopment || remoteReady) return options;
    await prepareLocalExecution();
    return readOptions();
  }

  Future<WorkTask> prepareRequirementExecution(String id) async =>
      WorkTask.fromJson(
        _asMap(
          await _authorized(
            'POST',
            '/api/v1/tasks/${Uri.encodeComponent(id)}/prepare-execution',
            body: {},
          ),
        ),
      );

  Future<WorkTask> dispatchRequirement(
    String id,
    Map<String, dynamic> body,
  ) async {
    final result = _asMap(
      await _authorized(
        'POST',
        '/api/v1/tasks/${Uri.encodeComponent(id)}/ai-dispatch',
        body: body,
        timeout: const Duration(seconds: 130),
      ),
    );
    final payload = _asMap(result['task']);
    return payload.isEmpty ? task(id) : WorkTask.fromJson(payload);
  }

  Future<WorkTask> submitTaskReview(String id, String note) async {
    final result = _asMap(
      await _authorized(
        'POST',
        '/api/v1/tasks/${Uri.encodeComponent(id)}/submit-review',
        body: {'note': note},
      ),
    );
    final payload = _asMap(result['task']);
    return payload.isEmpty ? task(id) : WorkTask.fromJson(payload);
  }

  Future<WorkTask> patchTask(String id, Map<String, dynamic> patch) async {
    final body = await _authorized('PATCH', '/api/v1/tasks/$id', body: patch);
    return WorkTask.fromJson(_asMap(body));
  }

  Future<Map<String, dynamic>> taskData(String id) async => _asMap(
    await _authorized('GET', '/api/v1/tasks/${Uri.encodeComponent(id)}'),
  );

  Future<Map<String, dynamic>> taskAcceptanceContext(String id) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/tasks/${Uri.encodeComponent(id)}/acceptance-context',
    ),
  );

  Future<Map<String, dynamic>> reviewTaskArtifact(
    String id,
    String note,
  ) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/tasks/${Uri.encodeComponent(id)}/review',
      body: {'note': note},
    ),
  );

  Future<Map<String, dynamic>> rejectTaskArtifact(
    String id,
    String note, {
    bool toAi = true,
    List<String> reworkAttachmentIds = const [],
  }) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/tasks/${Uri.encodeComponent(id)}/reject-artifact',
      body: {
        'note': note,
        'toAI': toAi,
        'reworkAttachmentIds': reworkAttachmentIds,
      },
    ),
  );

  Future<Map<String, dynamic>> retryWorkflowGate(
    String runId,
    String nodeKey, {
    bool resumeRework = false,
  }) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/plugin-runs/${Uri.encodeComponent(runId)}/retry-gate',
      body: {'nodeKey': nodeKey, 'resumeRework': resumeRework},
    ),
  );

  Future<Map<String, dynamic>> recoverWorkflowArtifacts(String runId) async =>
      _asMap(
        await _authorized(
          'POST',
          '/api/v1/plugin-runs/${Uri.encodeComponent(runId)}/recover-artifacts',
          body: const {},
        ),
      );

  Future<Map<String, dynamic>> taskTrace(String id) async {
    return _asMap(await _authorized('GET', '/api/v1/tasks/$id/trace'));
  }

  /// Cloud turns have one durable delivery status shared by desktop and
  /// mobile. A task may have no file bundle but still expose an online URL.
  Future<Map<String, dynamic>> taskDelivery(String id) async {
    return _asMap(
      await _authorized(
        'GET',
        '/api/v1/deliveries/from-task/${Uri.encodeComponent(id)}',
      ),
    );
  }

  Future<Map<String, dynamic>> syncTaskDelivery(String id) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/deliveries/from-task/${Uri.encodeComponent(id)}',
    ),
  );

  Future<List<Map<String, dynamic>>> taskEvents(String id) async {
    final body = _asMap(await _authorized('GET', '/api/v1/tasks/$id/events'));
    return _asList(body['events']).map(_asMap).toList(growable: false);
  }

  Future<Map<String, dynamic>> chatModelCatalog() async =>
      _asMap(await _authorized('GET', '/api/v1/my-models'));

  Future<Map<String, dynamic>> chatModelConfiguration(
    String model,
  ) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/ai-proxy/config?model=${Uri.encodeQueryComponent(model)}&agent=pi',
    ),
  );

  Future<Map<String, dynamic>> syncAccountConversation(
    Map<String, dynamic> body,
  ) async => _asMap(
    await _authorized('POST', '/api/v1/account-conversations/sync', body: body),
  );

  Future<Map<String, dynamic>> accountConversationSource(String id) async =>
      _asMap(
        await _authorized(
          'GET',
          '/api/v1/account-conversations/${Uri.encodeComponent(id)}/source',
        ),
      );

  Future<Map<String, dynamic>> personalRelayTarget(String id) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/personal-conversation-relay/targets/${Uri.encodeComponent(id)}',
    ),
  );

  Future<Map<String, dynamic>> personalRelayStatus(String id) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/personal-conversation-relay/requests/${Uri.encodeComponent(id)}',
    ),
  );

  Future<Map<String, dynamic>> sendPersonalRelay(
    String id,
    Map<String, dynamic> body,
  ) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/personal-conversation-relay/requests/${Uri.encodeComponent(id)}',
      body: body,
    ),
  );

  Future<Map<String, dynamic>> resolvePersonalRelay(String id) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/personal-conversation-relay/requests/${Uri.encodeComponent(id)}/resolve',
      body: {'checkedOnSourcePC': true},
    ),
  );

  Future<Map<String, dynamic>> workPluginBindings() async =>
      _asMap(await _authorized('GET', '/api/v1/plugins/applicable'));

  Future<Map<String, dynamic>> pluginCatalog() async =>
      _asMap(await _authorized('GET', '/api/v1/plugins/catalog'));

  Future<Map<String, dynamic>> preflightPluginPackage(XFile file) async {
    await _checkPluginPackage(file);
    return _uploadReviewMaterial('/api/v1/plugins/preflight', file);
  }

  Future<Map<String, dynamic>> submitPluginPackage(XFile file) async {
    await _checkPluginPackage(file);
    final result = await _uploadReviewMaterial(
      '/api/v1/plugins/submissions',
      file,
    );
    if (result['ok'] != true || _asMap(result['plugin'])['id'] == null) {
      throw const ApiFailure('服务没有返回有效的插件提交结果，请刷新目录确认。');
    }
    return result;
  }

  Future<void> _checkPluginPackage(XFile file) async {
    final name = file.name.toLowerCase();
    if (![
      '.zip',
      '.soduwork-plugin',
      '.soduwork-plugin',
      '.soduwork-plugin',
    ].any(name.endsWith)) {
      throw const ApiFailure('请选择插件包或 ZIP 文件。');
    }
    final length = await file.length();
    if (length == 0 || length > 10 * 1024 * 1024) {
      throw const ApiFailure('插件包不能为空，且不能超过 10 MB。');
    }
  }

  Future<Map<String, dynamic>> setPluginInstallation(
    String id, {
    required bool enabled,
    String? expectedVersionId,
    Map<String, dynamic>? config,
  }) async {
    final result = _asMap(
      await _authorized(
        'PUT',
        '/api/v1/plugins/${Uri.encodeComponent(id)}/installation',
        body: {
          'enabled': enabled,
          'expectedVersionId': ?expectedVersionId,
          'config': ?config,
        },
      ),
    );
    if (result['ok'] != true ||
        result['pluginId'] != id ||
        _asMap(result['installation'])['installed'] != enabled) {
      throw const ApiFailure('未收到有效的安装结果，请刷新目录确认后重试。');
    }
    return result;
  }

  Future<Map<String, dynamic>> probePluginInstallation(
    String id, {
    required String expectedVersionId,
    required Map<String, dynamic> config,
  }) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/plugins/${Uri.encodeComponent(id)}/installation/probe',
      body: {'expectedVersionId': expectedVersionId, 'config': config},
    ),
  );

  Future<Map<String, dynamic>> preflightPluginDraft(
    Map<String, dynamic> draft,
  ) async => _asMap(
    await _authorized('POST', '/api/v1/plugins/drafts/preflight', body: draft),
  );

  Future<Map<String, dynamic>> desktopCapabilityTargets() async => _asMap(
    await _authorized('GET', '/api/v1/desktop-capabilities/targets'),
  );

  Future<Map<String, dynamic>> desktopCapabilityRequest(
    String target, String operation, Map<String, dynamic> args, String requestId,
  ) async => _asMap(await _authorized(
    'POST', '/api/v1/desktop-capabilities/${Uri.encodeComponent(target)}/requests',
    body: {'operation': operation, 'args': args, 'requestId': requestId},
    timeout: const Duration(seconds: 100),
  ));

  Future<Map<String, dynamic>> createPluginDraft(
    Map<String, dynamic> draft,
  ) async =>
      _asMap(await _authorized('POST', '/api/v1/plugins/drafts', body: draft));

  Future<Map<String, dynamic>> conversationWorkflowBindings(
    String projectId,
  ) async => projectId.isEmpty
      ? workPluginBindings()
      : _asMap(
          await _authorized(
            'GET',
            '/api/v1/plugins/applicable?projectId=${Uri.encodeQueryComponent(projectId)}',
          ),
        );

  Future<Map<String, dynamic>> conversationWorkflowRuns(String taskId) async =>
      _asMap(
        await _authorized(
          'GET',
          '/api/v1/tasks/${Uri.encodeComponent(taskId)}/plugin-runs',
        ),
      );

  Future<Map<String, dynamic>> conversationWorkflowRun(String runId) async =>
      _asMap(
        await _authorized(
          'GET',
          '/api/v1/plugin-runs/${Uri.encodeComponent(runId)}',
        ),
      );

  Future<Map<String, dynamic>> cancelConversationWorkflow(String runId) async =>
      _asMap(
        await _authorized(
          'POST',
          '/api/v1/plugin-runs/${Uri.encodeComponent(runId)}/cancel',
          body: {'reason': '从移动端结束本次工作流'},
        ),
      );

  Future<Map<String, dynamic>> workSkillCatalog() async =>
      _asMap(await _authorized('GET', '/api/v1/skills'));

  Future<Map<String, dynamic>> library({
    String scope = 'recommended',
    String query = '',
    String folderId = '',
    String storage = '',
  }) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/library?${Uri(queryParameters: {'scope': scope, 'query': query, 'folderId': folderId, if (storage.isNotEmpty) 'storage': storage}).query}',
    ),
  );

  Future<Map<String, dynamic>> libraryContent(String id) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/library/items/${Uri.encodeComponent(id)}/content?preview=true',
    ),
  );

  Future<Map<String, dynamic>> createLibraryFolder(
    String name, {
    String parentId = '',
    String storage = '',
  }) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/library/folders',
      body: {
        'name': name,
        'parentId': parentId,
        if (storage.isNotEmpty) 'storage': storage,
      },
    ),
  );

  Future<Map<String, dynamic>> createLibraryNote(
    String title,
    String content, {
    String folderId = '',
    String storage = '',
    String format = 'md',
  }) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/library/items',
      body: {
        'kind': 'document',
        'format': format,
        'title': title,
        'content': content,
        'folderId': folderId,
        'sourceType': 'library',
        if (storage.isNotEmpty) 'storage': storage,
      },
    ),
  );

  Future<Map<String, dynamic>> updateLibraryItem(
    String id,
    Map<String, dynamic> changes,
  ) async => _asMap(
    await _authorized(
      'PATCH',
      '/api/v1/library/items/${Uri.encodeComponent(id)}',
      body: changes,
    ),
  );

  Future<Map<String, dynamic>> trashLibraryItem(String id) async => _asMap(
    await _authorized(
      'DELETE',
      '/api/v1/library/items/${Uri.encodeComponent(id)}',
    ),
  );

  Future<Map<String, dynamic>> restoreLibraryItem(String id) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/library/items/${Uri.encodeComponent(id)}/restore',
      body: {},
    ),
  );

  Future<Map<String, dynamic>> uploadLibraryItem(
    XFile file, {
    String folderId = '',
    String storage = '',
    Map<String, dynamic> source = const {},
  }) async {
    final size = await file.length();
    if (size <= 0 || size > 32 * 1024 * 1024) {
      throw const ApiFailure('手机单次上传支持非空文件，最大 32 MB。');
    }
    return _uploadReviewMaterial(
      '/api/v1/library/items/upload',
      file,
      fields: {
        'folderId': folderId,
        'sourceType': source['type'] == 'conversation'
            ? 'conversation'
            : 'upload',
        if (source['sessionId'] != null)
          'sessionId': source['sessionId'].toString(),
        if (source['conversationTitle'] != null)
          'conversationTitle': source['conversationTitle'].toString(),
        'rejectDuplicateName': 'true',
        if (storage.isNotEmpty) 'storage': storage,
      },
    );
  }

  Future<Map<String, dynamic>> capabilityCatalog() async =>
      _asMap(await _authorized('GET', '/api/v1/capabilities'));

  Future<Map<String, dynamic>> refreshSkills() async =>
      _asMap(await _authorized('POST', '/api/v1/skills/refresh', body: {}));

  Future<Map<String, dynamic>> saveSkillSelection(List<String> enabled) async =>
      _asMap(
        await _authorized('PUT', '/api/v1/skills', body: {'enabled': enabled}),
      );

  Future<Map<String, dynamic>> skillDetails(String name) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/skills/${Uri.encodeComponent(name)}/details',
    ),
  );

  Future<Map<String, dynamic>> skillContent(
    String name,
    String path,
    String checksum, {
    int offset = 0,
  }) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/skills/${Uri.encodeComponent(name)}/content?${Uri(queryParameters: {'path': path, 'checksum': checksum, 'offset': '$offset'}).query}',
    ),
  );

  Future<Map<String, dynamic>> createSkill(Map<String, dynamic> body) async =>
      _asMap(await _authorized('POST', '/api/v1/skills/create', body: body));

  Future<Map<String, dynamic>> preflightSkill(XFile file) async {
    await _checkSkillFile(file);
    return _uploadReviewMaterial('/api/v1/skills/preflight', file);
  }

  Future<Map<String, dynamic>> importSkill(XFile file) async {
    await _checkSkillFile(file);
    return _uploadReviewMaterial('/api/v1/skills/import', file);
  }

  Future<void> _checkSkillFile(XFile file) async {
    final size = await file.length();
    if (size == 0 || size > 10 * 1024 * 1024) {
      throw const ApiFailure('技能文件不能为空，且不能超过 10 MB。');
    }
  }

  Future<Map<String, dynamic>> removeSkill(
    String name,
    String checksum,
  ) async => _asMap(
    await _authorized(
      'DELETE',
      '/api/v1/skills/${Uri.encodeComponent(name)}',
      body: {'checksum': checksum},
    ),
  );

  Future<Map<String, dynamic>> connectorCatalog() async =>
      _asMap(await _authorized('GET', '/api/v1/mcp-servers'));

  // Send selection intent, never replace the server's whole configuration list.
  Future<Map<String, dynamic>> selectConnector(
    String kind,
    String id,
    bool enabled,
  ) async => _asMap(
    await _authorized(
      'PATCH',
      '/api/v1/mcp-servers/selection',
      body: {
        'changes': [
          {'kind': kind, 'id': id, 'enabled': enabled},
        ],
      },
    ),
  );

  Future<Map<String, dynamic>> preflightConnector(
    Map<String, dynamic> server,
  ) async => _asMap(
    await _authorized('POST', '/api/v1/mcp-servers/preflight', body: server),
  );

  Future<Map<String, dynamic>> saveConnector(
    Map<String, dynamic> server, {
    Map<String, dynamic>? original,
  }) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/mcp-servers/upsert',
      body: {'server': server, 'original': ?original},
    ),
  );

  Future<Map<String, dynamic>> probeConnector(
    Map<String, dynamic> server, {
    bool company = false,
  }) async => _asMap(
    await _authorized(
      'POST',
      company
          ? '/api/v1/mcp-servers/company/${Uri.encodeComponent(server['id'].toString())}/probe'
          : '/api/v1/mcp-servers/probe',
      body: company ? {} : server,
    ),
  );

  Future<Map<String, dynamic>> removeConnector(String id) async => _asMap(
    await _authorized(
      'DELETE',
      '/api/v1/mcp-servers/${Uri.encodeComponent(id)}',
    ),
  );

  Future<Map<String, dynamic>> conversationTeammates() async =>
      _asMap(await _authorized('GET', '/api/v1/team/mates'));

  Future<Map<String, dynamic>> draftMateMessage(
    Map<String, dynamic> body,
  ) async => _asMap(
    await _authorized('POST', '/api/v1/team/message-draft', body: body),
  );

  Future<Map<String, dynamic>> sendConversationMateMessage(
    String id,
    Map<String, dynamic> body,
  ) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/team/mates/ID/message'.replaceFirst(
        'ID',
        Uri.encodeComponent(id),
      ),
      body: body,
    ),
  );

  Future<Map<String, dynamic>> sendMateMessage(
    String id,
    String text,
    String messageId,
  ) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/team/mates/${Uri.encodeComponent(id)}/message',
      body: {'text': text, 'messageId': messageId},
    ),
  );

  Future<Map<String, dynamic>> submitMobileWork(
    String requestId,
    Map<String, dynamic> body,
  ) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/mobile-work/${Uri.encodeComponent(requestId)}',
      body: body,
      timeout: const Duration(seconds: 130),
    ),
  );

  Future<Map<String, dynamic>> mobileWorkStatus(String requestId) async =>
      _asMap(
        await _authorized(
          'GET',
          '/api/v1/mobile-work/${Uri.encodeComponent(requestId)}',
        ),
      );

  Future<Map<String, dynamic>> modelResourceCatalog() async =>
      _asMap(await _authorized('GET', '/api/v1/ai-agents'));

  Future<Map<String, dynamic>> cloudEnvironments() async {
    final body = await _authorized('GET', '/api/v1/cloud-environments');
    return _requireCloudCatalog(body, 'environments');
  }

  Map<String, dynamic> _requireCloudCatalog(dynamic body, String key) {
    // A proxy login page or incompatible response must not look like an empty
    // authorized catalog. Never provision a local executor after this failure.
    if (body is! Map ||
        body['ok'] == false ||
        body[key] is! List ||
        (body[key] as List).any((row) => row is! Map)) {
      throw const ApiFailure('云服务返回的目录格式不正确，请联系管理员核对服务地址和版本；这不代表账号未配置环境。');
    }
    return _asMap(body);
  }

  Future<Map<String, dynamic>> executionRepositories() async =>
      _asMap(await _authorized('GET', '/api/v1/repos'));

  Future<Map<String, dynamic>> cloudConversationTargets() async {
    Future<Map<String, dynamic>> readTargets() async => _requireCloudCatalog(
      await _authorized('GET', '/api/v1/conversation-handoffs/targets'),
      'targets',
    );
    final catalog = await readTargets();
    // Ordinary cloud conversations use the Hub-authorized personal Runner,
    // not the device Runner needed by task/automation consumers. An already
    // online destination must not wait for that unrelated helper to start.
    final ready = _asList(catalog['targets']).any(
      (row) =>
          row is Map &&
          row['type'] == 'agent' &&
          row['remote'] == true &&
          row['online'] == true &&
          row['agentId'] is String &&
          (row['agentId'] as String).isNotEmpty,
    );
    if (!isLocalDevelopment || ready) return catalog;
    await prepareLocalExecution();
    return readTargets();
  }

  bool get isLocalDevelopment =>
      deviceDisplayName == 'SoduWork Web 联调' &&
      Uri.tryParse(baseUrl)?.scheme == 'http' &&
      {18893, 18899}.contains(Uri.tryParse(baseUrl)?.port);

  /// Only the explicitly named Web development host provisions test executors.
  /// Production clients retain the Hub's existing enrollment and access rules.
  Future<List<Map<String, dynamic>>> localPluginInspections() async {
    if (!isLocalDevelopment) return const [];
    final response = _asMap(
      await _authorized('GET', '/api/v1/mobile-local/plugin-inspections'),
    );
    return _asList(response['items']).map(_asMap).toList();
  }

  Future<void> prepareLocalExecution() async {
    if (!isLocalDevelopment || _localReadyRevision == _authRevision) return;
    if (_localPreparation != null) return _localPreparation;
    final revision = _authRevision, endpoint = baseUrl;
    var active = true;
    void checkPreparation() {
      _checkEndpoint(endpoint, revision);
      if (!active) throw const ApiFailure('执行器准备已超时，请重新打开底座列表重试；输入内容已保留。');
    }

    final operation =
        () async {
          final marker = await client
              .get(_uri('/__mobile_local__/preview-version'))
              .timeout(const Duration(seconds: 5));
          checkPreparation();
          if (marker.statusCode != 200 ||
              marker.headers['x-soduwork-local-only'] != 'true') {
            throw const ApiFailure('当前地址不是已确认的本地测试入口，未登记执行器。');
          }
          final credentials = await store.credentials(endpoint);
          checkPreparation();
          for (var attempt = 0; attempt < 30; attempt++) {
            final result = _asMap(
              await _authorized(
                'POST',
                '/api/v1/mobile-local/execution',
                body: {'device': credentials.id, 'secret': credentials.secret},
              ),
            );
            checkPreparation();
            if (result['ready'] == true) {
              _localRunnerId = result['runnerId'] as String?;
              _localReadyRevision = revision;
              return;
            }
            if (result['error'] is String &&
                (result['error'] as String).isNotEmpty) {
              throw ApiFailure(result['error'] as String);
            }
            await Future<void>.delayed(const Duration(seconds: 1));
            checkPreparation();
          }
          throw const ApiFailure('本地执行器正在准备，请稍后刷新底座；不需要在手机安装环境。');
        }().timeout(
          const Duration(seconds: 30),
          onTimeout: () {
            active = false;
            throw const ApiFailure('执行器准备已超时，请重新打开底座列表重试；输入内容已保留。');
          },
        );
    _localPreparation = operation;
    try {
      await operation;
    } finally {
      active = false;
      if (identical(_localPreparation, operation)) _localPreparation = null;
    }
  }

  Future<AiRoster> aiAgents() async {
    final body = _asMap(await _authorized('GET', '/api/v1/ai-agents'));
    return AiRoster.fromJson(body);
  }

  Future<WorkTask> dispatchTaskToAi(
    String taskId, {
    required AiAssignee assignee,
    String brief = '',
  }) async {
    final payload = <String, dynamic>{
      'assigneeId': assignee.id,
      'assigneeType': assignee.type,
      if (brief.trim().isNotEmpty) 'brief': brief.trim(),
    };
    final body = _asMap(
      await _authorized(
        'POST',
        '/api/v1/tasks/$taskId/ai-dispatch',
        body: payload,
        timeout: const Duration(seconds: 130),
      ),
    );
    final taskPayload = _asMap(body['task']);
    return taskPayload.isEmpty ? task(taskId) : WorkTask.fromJson(taskPayload);
  }

  Future<AiExecutionStatus> aiStatus(String taskId) async {
    final body = _asMap(
      await _authorized(
        'GET',
        '/api/v1/tasks/$taskId/ai-status',
        timeout: const Duration(seconds: 35),
      ),
    );
    return AiExecutionStatus.fromJson(body);
  }

  Future<Map<String, dynamic>> conversationProjects() async => _asMap(
    await _authorized('GET', '/api/v1/conversation-projects'));

  Future<Map<String, dynamic>> saveConversationProject(String id, Map<String, dynamic> body) async => _asMap(
    await _authorized('PUT', '/api/v1/conversation-projects/${Uri.encodeComponent(id)}', body: body));

  Future<Map<String, dynamic>> accountConversations({
    required int after,
    int limit = 100,
  }) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/account-conversations?after=$after&limit=$limit',
    ),
  );

  Future<Map<String, dynamic>> accountConversationMessages(
    String conversationId, {
    required int after,
    int limit = 100,
  }) async => _asMap(
    await _authorized(
      'GET',
      '/api/v1/account-conversations/${Uri.encodeComponent(conversationId)}/messages?after=$after&limit=$limit',
    ),
  );

  Future<Map<String, dynamic>> branchCloudConversation(
    String taskId, {
    required String requestId,
    required String instruction,
    required String targetRunnerId,
    String targetRunnerKind = '',
    String agentId = '',
    String model = '',
  }) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/cloud-conversations/${Uri.encodeComponent(taskId)}/branch',
      body: {
        'requestId': requestId,
        'instruction': instruction.trim(),
        'targetRunnerId': targetRunnerId,
        if (targetRunnerKind.trim().isNotEmpty)
          'targetRunnerKind': targetRunnerKind.trim(),
        if (agentId.trim().isNotEmpty) 'agentId': agentId.trim(),
        if (model.trim().isNotEmpty) 'model': model.trim(),
      },
      timeout: const Duration(seconds: 50),
    ),
  );

  Future<List<Map<String, dynamic>>> cloudConversations() async {
    final body = await _authorized('GET', '/api/v1/tasks');
    return _asList(body)
        .map(_asMap)
        .where((item) => _text(item['origin']) == 'cloud-conversation')
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> createCloudConversation({
    required String text,
    String agentId = '',
    String targetRunnerId = '',
    String targetRunnerKind = '',
    String model = '',
    String title = '',
    List<XFile> files = const [],
    CloudConversationRequest? request,
  }) async {
    final requestEndpoint = baseUrl;
    final requestEpoch = _authRevision;
    try {
      final draft =
          request ??
          await CloudConversationRequest.prepare(
            text: text,
            agentId: agentId,
            targetRunnerId: targetRunnerId,
            targetRunnerKind: targetRunnerKind,
            model: model,
            title: title,
            files: files,
          );
      if (draft.isAccountBranch) {
        _checkEndpoint(requestEndpoint, requestEpoch);
        return _asMap(
          await _authorized(
            'POST',
            '/api/v1/account-conversations/branches/${draft.id}',
            body: {
              'accountConversationId': draft.options['accountConversationId'],
              'expectedRevision': draft.options['expectedRevision'],
              'instruction': draft.options['text'],
              'agentId': draft.options['agentId'],
              if (draft.options.containsKey('model'))
                'model': draft.options['model'],
              if (draft.options.containsKey('targetRunnerId'))
                'targetRunnerId': draft.options['targetRunnerId'],
              if (draft.options.containsKey('targetRunnerKind'))
                'targetRunnerKind': draft.options['targetRunnerKind'],
            },
            timeout: const Duration(seconds: 40),
          ),
        );
      }
      var session = await _session();
      _checkEndpoint(requestEndpoint, requestEpoch);
      Future<http.Response> send(String token) async {
        _checkEndpoint(requestEndpoint, requestEpoch);
        final outgoing = http.MultipartRequest(
          'POST',
          _uri('/api/v1/cloud-conversations/${draft.id}'),
        )..followRedirects = false;
        outgoing.headers['Authorization'] = 'Device $token';
        outgoing.fields['options'] = jsonEncode(draft.options);
        for (final file in draft.files) {
          outgoing.files.add(
            http.MultipartFile.fromBytes(
              'files',
              file.bytes,
              filename: file.name,
              contentType: _mediaType(file.name),
            ),
          );
        }
        return http.Response.fromStream(await client.send(outgoing));
      }

      var response = await send(session).timeout(const Duration(seconds: 40));
      _checkEndpoint(requestEndpoint, requestEpoch);
      if (response.statusCode == 401) {
        await store.authenticationMutation(requestEndpoint, () async {
          _checkAuthentication(requestEpoch);
          await store.clearSession(requestEndpoint);
        });
        _checkAuthentication(requestEpoch);
        session = await _session(force: true);
        _checkEndpoint(requestEndpoint, requestEpoch);
        response = await send(session).timeout(const Duration(seconds: 40));
        _checkEndpoint(requestEndpoint, requestEpoch);
      }
      final body = _decode(response);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw ApiFailure(
          _error(body, response.statusCode),
          status: response.statusCode,
        );
      }
      return _asMap(body);
    } on ApiFailure {
      rethrow;
    } on FormatException catch (error) {
      throw ApiFailure(error.message);
    } on TimeoutException {
      throw const ApiFailure('结果尚未确认，请重试核对同一次派发。', isNetwork: true);
    } on Exception {
      throw const ApiFailure('结果尚未确认，请检查网络后重试。', isNetwork: true);
    }
  }

  Future<Map<String, dynamic>> conversationSession(
    String taskId, {
    String ref = '',
    int since = 0,
  }) async {
    final query = <String>[
      if (ref.isNotEmpty) 'ref=${Uri.encodeQueryComponent(ref)}',
      if (since > 0) 'since=$since',
    ].join('&');
    final path = query.isEmpty
        ? '/api/v1/tasks/$taskId/ai-session'
        : '/api/v1/tasks/$taskId/ai-session?$query';
    return _asMap(
      await _authorized('GET', path, timeout: const Duration(seconds: 25)),
    );
  }

  Future<Map<String, dynamic>> sayToConversation(
    String taskId, {
    required String text,
    required String messageId,
    Map<String, String>? executionSelection,
  }) async {
    return _asMap(
      await _authorized(
        'POST',
        '/api/v1/tasks/$taskId/ai-say',
        body: {
          'text': text.trim(),
          'messageId': messageId,
          'executionSelection': ?executionSelection,
        },
        timeout: const Duration(seconds: 25),
      ),
    );
  }

  Future<Map<String, dynamic>> sayWithFiles(
    String taskId, {
    required String text,
    required String messageId,
    required List<Map<String, dynamic>> files,
    Map<String, String>? executionSelection,
  }) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/tasks/$taskId/ai-say',
      body: {
        'text': text.trim(),
        'messageId': messageId,
        'files': files,
        'executionSelection': ?executionSelection,
      },
      timeout: const Duration(seconds: 60),
    ),
  );

  Future<Map<String, dynamic>> stopConversation(String taskId) async {
    return _asMap(
      await _authorized(
        'POST',
        '/api/v1/tasks/$taskId/ai-stop',
        timeout: const Duration(seconds: 20),
      ),
    );
  }

  Future<List<Map<String, dynamic>>> taskAttachments(String taskId) async {
    final body = await _authorized('GET', '/api/v1/tasks/$taskId/attachments');
    if (body is List) return body.map(_asMap).toList(growable: false);
    return _asList(_asMap(body)['items']).map(_asMap).toList(growable: false);
  }

  Future<Map<String, dynamic>> automationExecutionOptions() async => _asMap(
    // Catalog discovery must not depend on the local automation consumer.
    // Enabling or running a schedule still checks that consumer separately.
    await _authorized('POST', '/api/v1/task-execution-options', body: {}),
  );

  Future<List<Map<String, dynamic>>> automationPlugins({
    String projectId = '',
  }) async {
    final suffix = projectId.trim().isEmpty
        ? ''
        : '?projectId=${Uri.encodeQueryComponent(projectId.trim())}';
    final body = _asMap(
      await _authorized('GET', '/api/v1/plugins/automation-options$suffix'),
    );
    return _asList(body['items']).map(_asMap).toList(growable: false);
  }

  Future<Map<String, dynamic>> preflightAutomation(
    Map<String, dynamic> body,
  ) async => _asMap(
    await _authorized('POST', '/api/v1/schedules/preflight', body: body),
  );

  Future<AutomationSchedule> createAutomation(Map<String, dynamic> body) async {
    final result = _asMap(
      await _authorized('POST', '/api/v1/schedules', body: body),
    );
    if (result['id'] is! String || (result['id'] as String).isEmpty) {
      throw const ApiFailure('创建结果尚未确认，请返回列表核对，避免重复创建。', isNetwork: true);
    }
    return AutomationSchedule.fromJson(result);
  }

  Future<AutomationSchedule> updateAutomation(
    String id,
    Map<String, dynamic> changes,
  ) async => AutomationSchedule.fromJson(
    _asMap(
      await _authorized(
        'PUT',
        '/api/v1/schedules/${Uri.encodeComponent(id)}',
        body: changes,
      ),
    ),
  );

  Future<void> deleteAutomation(String id) async {
    await _authorized('DELETE', '/api/v1/schedules/${Uri.encodeComponent(id)}');
  }

  Future<List<Map<String, dynamic>>> automationTemplates() async => _asList(
    await _authorized('GET', '/api/v1/schedules/templates'),
  ).map(_asMap).toList(growable: false);

  Future<List<AutomationSchedule>> automations() async {
    final body = await _authorized('GET', '/api/v1/schedules');
    return _asList(body)
        .map((item) => AutomationSchedule.fromJson(_asMap(item)))
        .toList(growable: false);
  }

  /// Readiness of the persistent local helper, never a browser timer.
  Future<Map<String, dynamic>> automationConsumerStatus() async {
    if (!isLocalDevelopment) {
      return {
        'ready': false,
        'state': 'unsupported',
        'reason': '当前连接尚未提供持续运行的自动化助手，请在 PC 客户端运行。',
      };
    }
    await prepareLocalExecution();
    return _asMap(
      await _authorized('GET', '/api/v1/mobile-local/automation-status'),
    );
  }

  /// Only a fully initialized consumer may call this capability registration.
  Future<Map<String, dynamic>> automationConversationInbox() async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/automation-conversations/inbox',
      body: {},
    ),
  );

  Future<Map<String, dynamic>> claimAutomationConversation(
    String runId,
    String instanceId,
  ) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/automation-conversations/${Uri.encodeComponent(runId)}/claim',
      body: {'instanceId': instanceId},
    ),
  );

  Future<Map<String, dynamic>> acknowledgeAutomationConversation(
    String runId,
    Map<String, dynamic> receipt,
  ) async => _asMap(
    await _authorized(
      'POST',
      '/api/v1/automation-conversations/${Uri.encodeComponent(runId)}/state',
      body: receipt,
    ),
  );

  /// Query an existing handoff without resubmitting its payload.
  Future<Map<String, dynamic>> cloudConversationReceipt(
    String requestId,
  ) async {
    if (!RegExp(r'^[a-zA-Z0-9_-]{1,128}$').hasMatch(requestId)) {
      throw const ApiFailure('待核对请求编号无效。');
    }
    return _asMap(
      await _authorized(
        'GET',
        '/api/v1/conversation-handoffs/${Uri.encodeComponent(requestId)}',
      ),
    );
  }

  Future<Map<String, dynamic>> automationConversationReceipt(
    String conversationId,
  ) async {
    const prefix = 'mobile-automation:';
    if (!conversationId.startsWith(prefix) ||
        !RegExp(
          r'^[a-f0-9-]{36}$',
        ).hasMatch(conversationId.substring(prefix.length))) {
      throw const ApiFailure('这条自动化会话由 PC 创建，请在原客户端查看。');
    }
    final requestId = 'automation-${conversationId.substring(prefix.length)}';
    return _asMap(
      await _authorized(
        'GET',
        '/api/v1/conversation-handoffs/${Uri.encodeComponent(requestId)}',
      ),
    );
  }

  Future<List<AutomationRun>> automationRuns(
    String scheduleId, {
    int limit = 20,
  }) async {
    final id = Uri.encodeComponent(scheduleId);
    final count = limit.clamp(1, 100);
    final body = _asMap(
      await _authorized('GET', '/api/v1/schedules/$id/runs?limit=$count'),
    );
    return _asList(body['items'])
        .map((item) => AutomationRun.fromJson(_asMap(item)))
        .toList(growable: false);
  }

  Future<AutomationSchedule> setAutomationEnabled(
    String scheduleId,
    bool enabled,
  ) async {
    final id = Uri.encodeComponent(scheduleId);
    final body = await _authorized(
      'PUT',
      '/api/v1/schedules/$id',
      body: {'enabled': enabled},
    );
    return AutomationSchedule.fromJson(_asMap(body));
  }

  Future<Map<String, dynamic>> runAutomation(String scheduleId) async {
    final id = Uri.encodeComponent(scheduleId);
    return _asMap(
      await _authorized(
        'POST',
        '/api/v1/schedules/$id/run',
        timeout: const Duration(seconds: 130),
      ),
    );
  }

  Future<List<ApprovalItem>> approvals({String view = 'pending'}) async {
    final path =
        '/api/v1/approvals?view=${Uri.encodeQueryComponent(view)}&limit=80';
    final body = _asMap(await _authorized('GET', path));
    return _asList(body['items'])
        .map((item) => ApprovalItem.fromJson(_asMap(item)))
        .toList(growable: false);
  }

  Future<Map<String, dynamic>> approvalDetail(String id) async {
    return _asMap(await _authorized('GET', '/api/v1/approvals/$id'));
  }

  Future<Map<String, dynamic>> decideApproval(
    String id, {
    required String decision,
    String note = '',
    List<String> reworkAttachmentIds = const [],
  }) async {
    return _asMap(
      await _authorized(
        'POST',
        '/api/v1/approvals/$id/decision',
        body: {
          'decision': decision,
          'note': note,
          if (reworkAttachmentIds.isNotEmpty)
            'reworkAttachmentIds': reworkAttachmentIds,
        },
      ),
    );
  }

  Future<Map<String, dynamic>> uploadRequirementMaterial(
    String taskId,
    XFile file,
  ) => _uploadReviewMaterial(
    '/api/v1/tasks/${Uri.encodeComponent(taskId)}/attachments',
    file,
    fields: {
      'purpose': 'requirement_input',
      'field': 'description',
      'sequence': '0',
    },
  );

  Future<Map<String, dynamic>> uploadApprovalEvidence(String id, XFile file) =>
      _uploadReviewMaterial(
        '/api/v1/approvals/${Uri.encodeComponent(id)}/evidence',
        file,
      );

  Future<Map<String, dynamic>> uploadTaskReworkMaterial(
    String id,
    XFile file,
  ) => _uploadReviewMaterial(
    '/api/v1/tasks/${Uri.encodeComponent(id)}/rework-materials',
    file,
  );

  Future<Map<String, dynamic>> uploadApprovalReworkMaterial(
    String id,
    XFile file,
  ) => _uploadReviewMaterial(
    '/api/v1/approvals/${Uri.encodeComponent(id)}/rework-materials',
    file,
  );

  Future<Map<String, dynamic>> _uploadReviewMaterial(
    String path,
    XFile file, {
    Map<String, String> fields = const {},
  }) async {
    final requestEndpoint = baseUrl;
    final requestEpoch = _authRevision;
    var session = await _session();
    _checkEndpoint(requestEndpoint, requestEpoch);

    Future<http.StreamedResponse> send(String token) async {
      _checkEndpoint(requestEndpoint, requestEpoch);
      final request = http.MultipartRequest('POST', _uri(path))
        ..followRedirects = false;
      request.headers['Authorization'] = 'Device $token';
      request.fields.addAll(fields);
      request.files.add(
        http.MultipartFile.fromBytes(
          'file',
          await file.readAsBytes(),
          filename: file.name,
          contentType: _mediaType(file.name),
        ),
      );
      _checkEndpoint(requestEndpoint, requestEpoch);
      return client.send(request).timeout(const Duration(seconds: 25));
    }

    try {
      var response = await send(session);
      _checkEndpoint(requestEndpoint, requestEpoch);
      if (response.statusCode == 401) {
        await store.authenticationMutation(requestEndpoint, () async {
          _checkAuthentication(requestEpoch);
          await store.clearSession(requestEndpoint);
        });
        _checkAuthentication(requestEpoch);
        session = await _session(force: true);
        response = await send(session);
      }
      final text = await response.stream.bytesToString().timeout(
        const Duration(seconds: 25),
      );
      _checkEndpoint(requestEndpoint, requestEpoch);
      final dynamic body = text.trim().isEmpty
          ? <String, dynamic>{}
          : jsonDecode(text);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw ApiFailure(
          _error(body, response.statusCode),
          status: response.statusCode,
        );
      }
      return _asMap(body);
    } on ApiFailure {
      rethrow;
    } on TimeoutException {
      throw const ApiFailure(
        '\u8bc1\u636e\u4e0a\u4f20\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\u3002',
        isNetwork: true,
      );
    } on Exception {
      throw const ApiFailure(
        '\u8bc1\u636e\u672a\u80fd\u4e0a\u4f20\u6210\u529f\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
        isNetwork: true,
      );
    }
  }

  Future<PersonalBrief> personalBrief({String period = 'daily'}) async {
    final path =
        '/api/v1/reports?period=${Uri.encodeQueryComponent(period)}&scope=mine';
    final body = _asMap(await _authorized('GET', path));
    return PersonalBrief.fromEnvelope(body);
  }

  Future<void> generateBrief({String period = 'daily'}) async {
    await _authorized(
      'POST',
      '/api/v1/reports/generate',
      body: {'period': period, 'scope': 'mine'},
    );
  }

  Future<List<Map<String, dynamic>>> teammates() async {
    final body = await _authorized('GET', '/api/v1/team/mates');
    if (body is List) {
      return body.map(_asMap).toList(growable: false);
    }
    final data = _asMap(body);
    return _asList(
      data['mates'] ?? data['items'],
    ).map(_asMap).toList(growable: false);
  }

  Future<void> handoffTask(
    String taskId, {
    required String assigneeUserId,
    String note = '',
  }) async {
    await _authorized(
      'POST',
      '/api/v1/tasks/$taskId/handoff',
      body: {'assigneeUserId': assigneeUserId, 'note': note},
    );
  }

  Future<dynamic> _authorized(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool retry = true,
    Duration timeout = const Duration(seconds: 18),
  }) async {
    final requestEndpoint = baseUrl;
    final requestEpoch = _authRevision;
    final session = await _session();
    _checkEndpoint(requestEndpoint, requestEpoch);
    late http.Response response;
    try {
      final headers = {
        'Accept': 'application/json',
        'Authorization': 'Device $session',
        // These methods always serialize a JSON object, including empty actions.
        if (method == 'POST' || method == 'PATCH' || method == 'PUT')
          'Content-Type': 'application/json',
      };
      final uri = _uri(path);
      response = switch (method) {
        'POST' =>
          await client
              .post(uri, headers: headers, body: jsonEncode(body ?? const {}))
              .timeout(timeout),
        'PATCH' =>
          await client
              .patch(uri, headers: headers, body: jsonEncode(body ?? const {}))
              .timeout(timeout),
        'PUT' =>
          await client
              .put(uri, headers: headers, body: jsonEncode(body ?? const {}))
              .timeout(timeout),
        'DELETE' => await client.delete(uri, headers: headers).timeout(timeout),
        _ => await client.get(uri, headers: headers).timeout(timeout),
      };
    } on TimeoutException {
      throw const ApiFailure(
        '\u8bf7\u6c42\u8d85\u65f6\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
        isNetwork: true,
      );
    } on Exception {
      throw const ApiFailure(
        '\u7f51\u7edc\u4e0d\u53ef\u7528\uff0c\u8bf7\u68c0\u67e5\u8fde\u63a5\u540e\u91cd\u8bd5\u3002',
        isNetwork: true,
      );
    }
    _checkEndpoint(requestEndpoint, requestEpoch);
    final decoded = _decode(response);
    if (response.statusCode == 401 && retry) {
      await store.authenticationMutation(requestEndpoint, () async {
        _checkAuthentication(requestEpoch);
        await store.clearSession(requestEndpoint);
      });
      _checkAuthentication(requestEpoch);
      await _session(force: true);
      return _authorized(
        method,
        path,
        body: body,
        retry: false,
        timeout: timeout,
      );
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiFailure(
        _error(decoded, response.statusCode),
        status: response.statusCode,
      );
    }
    return decoded;
  }

  void _checkEndpoint(String expected, [int? revision]) {
    if (revision != null) _checkAuthentication(revision);
    if (baseUrl != expected) {
      throw const ApiFailure('服务地址已切换，本次结果未应用。', status: 409);
    }
  }

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  dynamic _decode(http.Response response) {
    if (response.bodyBytes.isEmpty) return <String, dynamic>{};
    try {
      return jsonDecode(utf8.decode(response.bodyBytes));
    } catch (_) {
      return {
        'detail':
            '\u670d\u52a1\u8fd4\u56de\u4e86\u65e0\u6cd5\u8bc6\u522b\u7684\u5185\u5bb9',
      };
    }
  }

  static String _error(dynamic value, int status) {
    final body = _asMap(value);
    final detail = body['detail'];
    if (detail is String && detail.trim().isNotEmpty) return detail.trim();
    if (detail is Map) {
      final message = _text(detail['message'] ?? detail['detail']);
      if (message.isNotEmpty) return message;
    }
    return switch (status) {
      401 =>
        '\u767b\u5f55\u72b6\u6001\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u8fde\u63a5\u3002',
      403 =>
        '\u5f53\u524d\u8d26\u53f7\u6ca1\u6709\u6267\u884c\u8fd9\u9879\u64cd\u4f5c\u7684\u6743\u9650\u3002',
      404 =>
        '\u8981\u67e5\u770b\u7684\u5185\u5bb9\u5df2\u4e0d\u5b58\u5728\u3002',
      409 =>
        '\u6570\u636e\u5df2\u7ecf\u53d1\u751f\u53d8\u5316\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5\u3002',
      422 => '请求内容未通过校验，请检查配置后重试（422）。',
      _ => '\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528\uff08$status\uff09',
    };
  }

  static MediaType _mediaType(String name) {
    final extension = name.toLowerCase().split('.').last;
    // Unknown attachments are binary files, never assumed to be photographs.
    const types = {
      'png': 'image/png',
      'webp': 'image/webp',
      'gif': 'image/gif',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'txt': 'text/plain',
      'md': 'text/markdown',
      'csv': 'text/csv',
      'json': 'application/json',
      'pdf': 'application/pdf',
      'zip': 'application/zip',
      'doc': 'application/msword',
      'docx':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint',
      'pptx':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return MediaType.parse(types[extension] ?? 'application/octet-stream');
  }
}

Map<String, dynamic> _asMap(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map((key, item) => MapEntry(key.toString(), item));
  }
  return <String, dynamic>{};
}

List<dynamic> _asList(dynamic value) => value is List ? value : const [];

String _text(dynamic value, {String fallback = ''}) {
  final result = value == null ? '' : value.toString().trim();
  return result.isEmpty ? fallback : result;
}

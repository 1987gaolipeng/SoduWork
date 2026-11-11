import 'package:image_picker/image_picker.dart' show XFile;
import '../models/account_conversation.dart';
import 'personal_conversation_host.dart';
import 'desktop_conversation_plugins.dart';
import 'conversation_acceptance.dart';
import 'dart:convert';
import 'package:image_picker/image_picker.dart';
import '../state/mobile_state.dart';
import 'direct_work_sender.dart';
import 'soduwork_api.dart';
import 'shared_conversation_artifacts.dart';
import 'shared_conversation_delivery.dart';
import 'shared_conversation_selection.dart';
import 'shared_conversation_team.dart';
import 'shared_conversation_share_guard.dart';
import 'shared_conversation_workflow.dart';
import 'shared_work_form_host.dart';
import 'cloud_conversation_access.dart';
import 'requirement_review_conversation.dart';
import 'artifact_download.dart';

/// A view adapter, not another executor or task store. Existing MobileState,
/// immutable submission receipts and Hub permissions remain authoritative.
class SharedConversationHost {
  final MobileState state;
  final AccountConversation? accountConversation;
  late final _personal = accountConversation == null
      ? null
      : PersonalConversationHost(state, accountConversation!, _check);
  final RequirementReviewConversation? review;
  String? taskId;
  final String title;
  final bool dark;
  String initialDraft;
  final List<XFile> initialFiles;
  bool _draftReported = false;
  String initialAction;
  final bool pluginAuthoring;
  final Future<Map<String, dynamic>?> Function(Map<String, dynamic>)?
  onPluginDraft;
  bool clearNewDraft;
  final void Function(String) onDraft;
  final void Function(String)? onDraftAction;
  final void Function(bool dirty, bool busy)? onWorkCardDraft;
  final void Function(List<Map<String, dynamic>>)? onWorkCardHistory;
  final String workCardHistoryId;
  final void Function(String) onCreated;
  final void Function(AccountConversation)? onAccountCreated;
  late final _desktopPlugins = DesktopConversationPlugins(state.api, _check);
  AccountConversation? _desktopReceipt;
  final Future<void> Function(String) onResource;
  final Future<void> Function(String) onExternal;
  final Future<void> Function(Map<String, dynamic>)? onArtifact;
  final Future<DownloadedArtifact?> Function()? onLibraryPick;
  final Future<bool> Function(DownloadedArtifact, Map<String, dynamic>)?
  onLibrarySave;
  final Future<Map<String, dynamic>?> Function(String, Map<String, dynamic>)?
  onHandoff;
  final Future<Map<String, dynamic>?> Function(String, Map<String, dynamic>)?
  onWorkAction;
  final Future<void> Function(String kind, String id)? onWorkFormOpen;
  late final _workForms = SharedWorkFormHost(
    api: state.api,
    identity: [
      state.endpoint.baseUrl,
      state.enrollment?.ownerUserId,
      state.enrollment?.deviceId,
    ].join(':'),
    check: _check,
    sourceAllowed: (id) => _tasks.contains(id),
    open: (kind, id) async {
      if (onWorkFormOpen == null) throw const ApiFailure('请从需求池或自动化列表查看已保存内容。');
      await onWorkFormOpen!(kind, id);
    },
  );
  bool _handoffOpen = false;
  final int _identity;
  final Set<String> _tasks;
  late final _workflow = SharedConversationWorkflow(
    scope: [
      state.endpoint.baseUrl,
      state.enrollment?.ownerUserId,
      state.enrollment?.deviceId,
    ].join(':'),
    check: _check,
    catalog: (projectId) => state.api.conversationWorkflowBindings(projectId),
    submit: (id, body) => state.api.submitMobileWork(id, body),
    status: (id) => state.api.mobileWorkStatus(id),
    listRuns: (id) => state.api.conversationWorkflowRuns(id),
    getRun: (id) => state.api.conversationWorkflowRun(id),
    pollSession: (task, ref, since) =>
        state.loadConversationSession(task, ref: ref, since: since),
    cancelRun: (id) => state.api.cancelConversationWorkflow(id),
  );
  late final _shareGuard = SharedConversationShareGuard(state.api, _check);
  late final _team = SharedConversationTeam(
    check: _check,
    loadMates: () => state.api.conversationTeammates(),
    loadAttachments: (id) => state.api.taskAttachments(id),
    draftMessage: (body) => state.api.draftMateMessage(body),
    sendMessage: (id, body) => state.api.sendConversationMateMessage(id, body),
    allowedTaskIds: _tasks,
    validateUploads: _shareGuard.validateUploads,
  );
  final _sendReceipts = <String, (String, Future<Object?>)>{};
  final _sessionAccess = <String, Map<String, dynamic>>{};
  late final _acceptance = ConversationAcceptance(state, _check);

  Map<String, dynamic> _access(String id, Map<String, dynamic> session) =>
      cloudConversationAccess(
        state.tasks.where((task) => task.id == id).firstOrNull,
        session,
      );

  SharedConversationHost({
    required this.state,
    this.accountConversation,
    this.review,
    this.taskId,
    this.title = '',
    this.dark = false,
    this.initialDraft = '',
    this.initialFiles = const [],
    this.initialAction = '',
    this.pluginAuthoring = false,
    this.onPluginDraft,
    this.clearNewDraft = false,
    required this.onDraft,
    this.onDraftAction,
    this.onWorkCardDraft,
    this.onWorkCardHistory,
    this.workCardHistoryId = '',
    required this.onCreated,
    this.onAccountCreated,
    required this.onResource,
    required this.onExternal,
    this.onArtifact,
    this.onLibraryPick,
    this.onLibrarySave,
    this.onHandoff,
    this.onWorkAction,
    this.onWorkFormOpen,
  }) : _identity = state.identityRevision,
       _tasks = {if (taskId != null && taskId.isNotEmpty) taskId};

  void _check() {
    if (state.identityRevision != _identity ||
        state.phase != MobilePhase.ready) {
      throw const ApiFailure('账号或服务已切换，请重新打开对话。', status: 409);
    }
  }

  String _task(Map<String, dynamic> args) {
    final value = args['taskId'];
    if (value is! String || !_tasks.contains(value)) {
      throw const ApiFailure('此对话不能访问该任务。', status: 403);
    }
    return value;
  }

  Future<Object?> call(String method, Map<String, dynamic> args) async {
    _check();
    if (_personal != null &&
        !const {
          'ready',
          'draft',
          'external',
          'workCardDraft',
          'workCardHistory',
          'acceptance',
        }.contains(method)) {
      if (method == 'catalog') {
        return {
          'targets': {'targets': []},
          'models': {'usable': []},
        };
      }
      if (method == 'models') return {'usable': []};
      if (method == 'skills') return {'skills': []};
      if (method == 'plugins') return {'items': []};
      return _personal.call(method, args);
    }
    final result =
        await ((method == 'send' ||
                method == 'desktopPluginSend' ||
                method == 'workflowStart')
            ? _sendOnce(args, method)
            : _call(method, args));
    _check();
    return result;
  }

  Future<Object?> _sendOnce(Map<String, dynamic> args, String method) async {
    final id =
        args[method == 'send' || method == 'desktopPluginSend'
            ? 'messageId'
            : 'requestId'];
    if (id is! String || !RegExp(r'^[A-Za-z0-9-]{1,80}$').hasMatch(id)) {
      throw const ApiFailure('发送编号无效，请重新打开对话。');
    }
    final fingerprint = jsonEncode([method, args]);
    final previous = _sendReceipts[id];
    if (previous != null) {
      if (previous.$1 != fingerprint) {
        throw const ApiFailure('相同发送编号不能用于不同内容。', status: 409);
      }
      return previous.$2;
    }
    if (_sendReceipts.isNotEmpty || taskId != null) {
      throw const ApiFailure('请先核对当前会话的发送回执。', status: 409);
    }
    final operation = _call(method, args);
    _sendReceipts[id] = (fingerprint, operation);
    try {
      return await operation;
    } catch (_) {
      _sendReceipts.remove(id);
      rethrow;
    }
  }

  List<Map<String, dynamic>> _publicRows(dynamic rows, Set<String> fields) =>
      rows is List
      ? rows
            .whereType<Map>()
            .map(
              (row) => <String, dynamic>{
                for (final key in fields)
                  if (row.containsKey(key)) key: row[key],
              },
            )
            .toList(growable: false)
      : const [];

  Map<String, dynamic> _publicModels(Map<String, dynamic> models) => {
    'error': models['error'],
    'usable': _publicRows(models['usable'], {'name', 'label'}),
    if (models['defaultModel'] is String)
      'defaultModel': models['defaultModel'],
    'defaultModels': {
      if (models['defaultModels'] is Map)
        for (final entry in (models['defaultModels'] as Map).entries)
          if (entry.key is String && entry.value is String)
            entry.key as String: entry.value as String,
    },
  };

  Future<Object?> _call(String method, Map<String, dynamic> args) async {
    switch (method) {
      case 'initialLibraryFile':
        final index = args['index'];
        if (taskId != null ||
            accountConversation != null ||
            index is! int ||
            index < 0 ||
            index >= initialFiles.length) {
          throw const ApiFailure('资料来源已失效');
        }
        final file = initialFiles[index];
        final bytes = await file.readAsBytes();
        _check();
        return {
          'name': file.name,
          'contentType': file.mimeType,
          'data': base64Encode(bytes),
        };
      case 'libraryPick':
        if (onLibraryPick == null) throw const ApiFailure('请从资料库页面选择资料');
        final picked = await onLibraryPick!();
        _check();
        if (picked == null) return {'cancelled': true};
        return {
          'name': picked.filename,
          'contentType': picked.contentType,
          'data': base64Encode(picked.bytes),
        };
      case 'saveDelivery':
        final saveTask = _task(args);
        if (onLibrarySave == null) throw const ApiFailure('当前页面无法保存资料');
        final file = await SharedConversationDelivery(
          state.api,
          _check,
        ).download(saveTask, args['deliveryId'] as String);
        _check();
        final saved = await onLibrarySave!(file, {
          'type': 'conversation',
          'sessionId': saveTask,
          'conversationTitle': title,
        });
        _check();
        return {'ok': true, 'saved': saved};
      case 'libraryList':
        final result = await state.api.library(
          scope: 'recommended',
          query: args['query'] as String? ?? '',
        );
        if (result['ok'] != true) throw const ApiFailure('资料库读取失败，请重试。');
        return {
          'items': _publicRows(result['items'], {
            'id',
            'title',
            'filename',
            'contentType',
            'size',
            'kind',
          }),
        };
      case 'libraryFile':
        final file = await ArtifactDownloader(state.api).downloadLibrary(
          args['id'] as String,
          filename: '资料',
          byteLimit: 16 * 1024 * 1024,
        );
        _check();
        return {
          'name': file.filename,
          'contentType': file.contentType,
          'data': base64Encode(file.bytes),
        };
      case 'acceptance':
        if (_personal != null) {
          final source = accountConversation!;
          if (args['taskId'] != source.id) {
            throw const ApiFailure('不能访问其他聊天。', status: 403);
          }
          final matches = state.tasks
              .where(
                (task) =>
                    source.sourceSessionId == 'cloud-task:${task.id}' ||
                    source.sourceSessionId == 'requirement-${task.id}' ||
                    (source.sourceSessionId.isNotEmpty &&
                        source.sourceSessionId == task.cloudSessionId),
              )
              .toList();
          if (matches.length != 1) return {'available': false};
          return _acceptance.call(matches.single.id, args);
        }
        return _acceptance.call(_task(args), args);
      case 'workCardDraft':
        onWorkCardDraft?.call(args['dirty'] == true, args['busy'] == true);
        return {'ok': true};
      case 'workCardHistory':
        final rows = args['entries'];
        if (rows is! List || rows.length > 50) {
          throw const ApiFailure('工作记录目录不正确。');
        }
        final entries = <Map<String, dynamic>>[];
        for (final row in rows.whereType<Map>()) {
          final id = row['id'], title = row['title'];
          if (id is! String ||
              id.isEmpty ||
              id.length > 160 ||
              title is! String ||
              title.length > 200) {
            continue;
          }
          entries.add({
            'id': id,
            'title': title,
            'taskId': row['taskId'] is String ? row['taskId'] : '',
            'saved': row['saved'] == true,
            'updatedAt': row['updatedAt'] is num
                ? (row['updatedAt'] as num).toInt()
                : 0,
          });
        }
        onWorkCardHistory?.call(entries);
        return {'ok': true};
      case 'workForm':
        final result = await _workForms.handle(args);
        _check();
        if (args['operation'] == 'createRequirement' && result is Map) {
          final receipt = result['task'] is Map
              ? result['task'] as Map
              : result;
          state.applyRequirementReceipt(Map<String, dynamic>.from(receipt));
        }
        return result;
      case 'ready':
        final discard = clearNewDraft;
        clearNewDraft = false;
        return {
          'identity': [
            state.endpoint.baseUrl,
            state.enrollment?.ownerUserId,
            state.enrollment?.deviceId,
          ].join(':'),
          'workCardHistoryId': workCardHistoryId,
          'scope': '${state.endpoint.baseUrl}:${state.enrollment?.ownerUserId}',
          'taskId': accountConversation?.id ?? taskId ?? '',
          if (accountConversation != null) 'personalConversation': true,
          'title': title,
          'dark': dark,
          'executionMode': state.api.isLocalDevelopment
              ? 'local-test'
              : 'cloud',
          'clearNewDraft': discard,
          if (discard && initialFiles.isNotEmpty)
            'initialLibraryCount': initialFiles.length,
          if (_draftReported ||
              (accountConversation == null &&
                  taskId == null &&
                  initialDraft.isNotEmpty))
            'initialDraft': initialDraft,
          if (accountConversation == null &&
              taskId == null &&
              initialAction.isNotEmpty)
            'initialAction': initialAction,
          if (pluginAuthoring && accountConversation == null)
            'pluginAuthoring': true,
        };
      case 'models':
        // Model selection must remain usable while a new device prepares its Runner.
        return _publicModels(await state.api.chatModelCatalog());
      case 'catalog':
        Future<Map<String, dynamic>> directory(
          Future<Map<String, dynamic>> Function() load,
        ) async {
          try {
            return await load();
          } on ApiFailure catch (error) {
            return {'error': error.message};
          }
        }
        final results = await Future.wait([
          directory(state.cloudConversationTargets),
          directory(state.api.chatModelCatalog),
        ]);
        return {
          'localTest': state.api.isLocalDevelopment,
          'targets': {
            'error': results[0]['error'],
            'summary': (results[0]['diagnostics'] as Map?)?['summary'],
            'targets': _publicRows(results[0]['targets'], {
              'type',
              'remote',
              'online',
              'agentId',
              'name',
              'modelPick',
              'runnerId',
              'runnerKind',
              'runnerName',
              'machineLabel',
              'modelMode',
              'model',
            }),
          },
          'models': _publicModels(results[1]),
        };
      case 'plugins':
        if (args['targetRunnerKind'] == 'work-computer' &&
            taskId == null &&
            review == null) {
          return _desktopPlugins.catalog(
            args['targetRunnerId'] as String? ?? '',
          );
        }
        final catalog = await state.api.workPluginBindings();
        return {
          'items': _publicRows(catalog['items'], {
            'pluginId',
            'bindingId',
            'name',
            'description',
            'icon',
            'version',
            'runnable',
            'readiness',
            'inputs',
            'workflow',
            'capabilities',
            'entrypoints',
          }),
        };
      case 'desktopPluginSend':
        if (taskId != null || review != null || onAccountCreated == null) {
          throw const ApiFailure('请在新对话中选择本机插件。');
        }
        _desktopReceipt = await _desktopPlugins.send(args);
        return {'ok': true, 'conversationId': _desktopReceipt!.id};
      case 'desktopPluginCreated':
        final receipt = _desktopReceipt;
        if (receipt == null || receipt.id != args['conversationId']) {
          throw const ApiFailure('会话回执尚未确认，请保留原内容重试。');
        }
        onDraft('');
        onAccountCreated?.call(receipt);
        return {'ok': true};
      case 'skills':
        final catalog = await state.api.workSkillCatalog();
        return {
          'skills': _publicRows(catalog['skills'] ?? catalog['items'], {
            'name',
            'label',
            'description',
            'source',
            'scope',
            'version',
            'checksum',
            'downloadable',
            'runtimeAvailable',
            'localOnly',
            'enabled',
          }),
        };
      case 'workflowStart':
        if (review != null) throw const ApiFailure('验收分析请直接发送给 AI，不启动新的执行工作流。');
        if (taskId != null) throw const ApiFailure('请新建对话发起工作流。');
        final result = await _workflow.start(
          requestId: args['requestId'] as String,
          instruction: args['instruction'] as String,
          plugins: (args['plugins'] as List)
              .map((row) => Map<String, dynamic>.from(row as Map))
              .toList(),
          projectId: args['projectId'] as String? ?? '',
        );
        _check();
        final created = result['taskId'] as String;
        _tasks.add(created);
        taskId = created;
        return result;
      case 'workflowPoll':
        final workflowTaskId = _task(args);
        if ((args['runId'] as String? ?? '').isEmpty &&
            (args['requestId'] as String? ?? '').isEmpty) {
          // Direct AI dispatches and confirmed cloud conversations have no
          // plugin workflow. Read the authorized source before probing the
          // device-owned workflow API; its 404 is not a lost execution state.
          final task = await state.api.task(workflowTaskId);
          _check();
          if (task.id != workflowTaskId) {
            throw const ApiFailure('会话来源不匹配，请重新打开。', status: 409);
          }
          if ((task.isDirectExecution ||
                  (task.origin == 'cloud-conversation' &&
                      task.cloudSessionId.isNotEmpty)) &&
              !task.isStandaloneWorkflow &&
              task.canViewExecution != false) {
            return {'ok': true, 'workflow': false, 'taskId': workflowTaskId};
          }
        }
        return _workflow.poll(
          taskId: workflowTaskId,
          runId: args['runId'] as String? ?? '',
          requestId: args['requestId'] as String? ?? '',
          since: Map<String, int>.from(args['since'] as Map? ?? const {}),
        );
      case 'workflowCancel':
        return _workflow.cancel(
          taskId: _task(args),
          runId: args['runId'] as String,
        );
      case 'mates':
        return _team.mates();
      case 'draftMate':
        return _team.draft(args);
      case 'sendMate':
        return _team.send(args);
      case 'workAction':
        final actionId = args['actionId'];
        if (actionId is! String ||
            !const {
              'work.requirement.create',
              'work.automation.create',
              'work.plugin.create',
              'work.plugin.debug',
            }.contains(actionId) ||
            onWorkAction == null) {
          throw const ApiFailure('此工作动作暂未接入移动端。');
        }
        final text = args['text'];
        if (text is! String || text.length > 10000) {
          throw const ApiFailure('工作动作内容过长，请精简后重试。');
        }
        return await onWorkAction!(actionId, {
          'text': text,
          'ref': args['ref'] as String? ?? '',
          'contextText': args['contextText'] as String? ?? '',
          'pluginId': args['pluginId'] as String? ?? '',
        });
      case 'handoff':
        final id = _task(args);
        final kind = args['kind'];
        if (!const {'requirement', 'automation'}.contains(kind) ||
            onHandoff == null) {
          throw const ApiFailure('此流转入口暂不可用。');
        }
        if (_handoffOpen) throw const ApiFailure('请先完成当前填写。');
        final contextText = args['contextText'];
        final instruction = args['instruction'];
        if (contextText is! String ||
            instruction is! String ||
            contextText.length > 40000 ||
            instruction.length > 10000) {
          throw const ApiFailure('带入的对话过长，请精简当前输入后重试。');
        }
        _handoffOpen = true;
        try {
          final task = await state.api.task(id);
          final files = await SharedConversationArtifacts(
            state.api,
            _check,
            onArtifact,
          ).list(id);
          _check();
          return await onHandoff!(kind as String, {
                'taskId': id,
                'title': task.title,
                'contextText': contextText,
                'instruction': instruction,
                'attachments': files,
              }) ??
              {'cancelled': true};
        } finally {
          _handoffOpen = false;
        }
      case 'pluginDeliveryDraft':
      case 'pluginDraft':
        final draftTask = _task(args);
        if (onPluginDraft == null) throw const ApiFailure('插件确认入口尚未就绪。');
        if (_handoffOpen) throw const ApiFailure('请先完成当前填写。');
        _handoffOpen = true;
        try {
          final decoded = method == 'pluginDeliveryDraft'
              ? await SharedConversationDelivery(
                  state.api,
                  _check,
                ).pluginDraft(draftTask, args['deliveryId'] as String)
              : jsonDecode(
                  (await SharedConversationArtifacts(
                        state.api,
                        _check,
                        onArtifact,
                      ).action(
                        draftTask,
                        args['attachmentId'] as String,
                        'read',
                      ))['text']
                      as String,
                );
          if (decoded is! Map<String, dynamic> ||
              decoded['name'] is! String ||
              !const {
                'method',
                'connector',
                'workflow',
                'app',
              }.contains(decoded['template'])) {
            throw const ApiFailure('插件草稿格式无效，请在对话中修正后重新生成。');
          }
          _check();
          return await onPluginDraft!(decoded) ?? {'cancelled': true};
        } on FormatException {
          throw const ApiFailure('插件草稿不是有效的 JSON，请在对话中修正。');
        } finally {
          _handoffOpen = false;
        }
      case 'artifacts':
        return SharedConversationArtifacts(
          state.api,
          _check,
          onArtifact,
        ).list(_task(args));
      case 'artifactAction':
        final artifactTask = _task(args);
        final attachmentId = args['attachmentId'] as String;
        final artifactAction = args['action'] as String;
        final artifactResult = await SharedConversationArtifacts(
          state.api,
          _check,
          onArtifact,
        ).action(artifactTask, attachmentId, artifactAction);
        if (artifactAction == 'share') {
          await _shareGuard.recordArtifact(
            artifactTask,
            attachmentId,
            artifactResult,
          );
        }
        return artifactResult;
      case 'delivery':
        return state.api.taskDelivery(_task(args));
      case 'shareDelivery':
        final deliveryTask = _task(args);
        final deliveryId = args['deliveryId'] as String;
        final shared = await SharedConversationDelivery(
          state.api,
          _check,
        ).share(deliveryTask, deliveryId);
        await _shareGuard.recordDelivery(deliveryTask, deliveryId, shared);
        return shared;
      case 'previewDelivery':
        return SharedConversationDelivery(
          state.api,
          _check,
        ).preview(_task(args), args['deliveryId'] as String);
      case 'previewDeliveryFile':
      case 'openDelivery':
        final delivery = await state.api.taskDelivery(_task(args));
        _check();
        final row = delivery['delivery'];
        if (row is! Map ||
            row['id'] != args['deliveryId'] ||
            onArtifact == null) {
          throw const ApiFailure('成果已变化，请重新打开会话。');
        }
        await onArtifact!({
          'url':
              '/api/v1/deliveries/${Uri.encodeComponent(row['id'] as String)}/download',
          if (method == 'previewDeliveryFile') ...{
            'action': 'preview',
            'entryPath': row['entryPath'],
          },
          'filename': row['filename'] ?? '成果包',
        });
        return {'ok': true};
      case 'syncDelivery':
        return state.api.syncTaskDelivery(_task(args));
      case 'poll':
        final id = _task(args);
        final page = await state.loadConversationSession(
          id,
          ref: args['ref'] as String? ?? '',
          since: args['since'] as int? ?? 0,
        );
        _check();
        if (page['ok'] == true) _sessionAccess[id] = _access(id, page);
        return {...page, ...?_sessionAccess[id]};
      case 'send':
        final files = <XFile>[];
        final rows = args['files'] as List? ?? const [];
        if (rows.length > 20) throw const ApiFailure('最多附加20个文件。');
        var size = 0;
        for (final raw in rows) {
          final row = Map<String, dynamic>.from(raw as Map);
          final bytes = base64Decode(row['data'] as String);
          size += bytes.length;
          if (bytes.isEmpty || size > 90 * 1024 * 1024) {
            throw const ApiFailure('附件不能为空，合计不能超过90MB。');
          }
          files.add(
            LibraryMaterialFile(
              DownloadedArtifact(
                bytes: bytes,
                filename: row['name'] as String,
                contentType:
                    row['contentType'] as String? ?? 'application/octet-stream',
              ),
            ),
          );
        }
        final prepared = await review?.prepare(
          state.api,
          args['text'] as String,
          _check,
        );
        if (review?.automatic == true && files.isNotEmpty) {
          throw const ApiFailure('自动验收只读取本轮固定成果，请先在原需求补充证据。');
        }
        if ((prepared?.files.length ?? 0) + files.length > 20) {
          throw const ApiFailure('验收材料与补充附件合计不能超过20份。');
        }
        final receipt = await sendWorkDirectly(
          state,
          text: prepared?.text ?? args['text'] as String,
          userText: prepared == null
              ? args['userText'] as String?
              : args['text'] as String,
          agentId: args['agentId'] as String,
          targetRunnerId: args['targetRunnerId'] as String? ?? '',
          targetRunnerKind: args['targetRunnerKind'] as String? ?? '',
          model: args['model'] as String? ?? '',
          files: [...?prepared?.files, ...files],
          skills: (args['skills'] as List? ?? const []).cast<String>(),
          acceptance: review?.automatic == true ? review!.binding : null,
        );
        _check();
        final created = receipt['taskId'] as String? ?? '';
        if (created.isEmpty) throw const ApiFailure('服务没有返回任务回执。');
        if (review != null) {
          state.workConversationNavigation.bindReview(created, review!);
        }
        _tasks.add(created);
        taskId = created;
        return receipt;
      case 'say':
        await review?.validate(state.api, _check);
        final access = _sessionAccess[_task(args)] ?? _access(_task(args), {});
        if (access['canSend'] == false) {
          throw const ApiFailure(cloudConversationReadOnlyReason, status: 403);
        }
        final turnFiles = (args['files'] as List? ?? const [])
            .map((row) => Map<String, dynamic>.from(row as Map))
            .toList();
        Future<Map<String, dynamic>> sendTurn(Map<String, String>? selection) =>
            turnFiles.isEmpty
            ? state.sayToConversation(
                _task(args),
                text: args['text'] as String,
                messageId: args['messageId'] as String,
                executionSelection: selection,
              )
            : state.api.sayWithFiles(
                _task(args),
                text: args['text'] as String,
                messageId: args['messageId'] as String,
                files: turnFiles,
                executionSelection: selection,
              );
        if (args['executionSelection'] is Map) {
          final id = _task(args);
          final session = await state.loadConversationSession(id);
          _check();
          final targets = await state.cloudConversationTargets();
          final models = await state.api.chatModelCatalog();
          _check();
          Map<String, String> selection;
          try {
            selection = validateSharedExecutionSelection(
              Map<String, dynamic>.from(args['executionSelection'] as Map),
              runnerId: session['runnerId'] as String? ?? '',
              targets: (targets['targets'] as List? ?? const [])
                  .whereType<Map>()
                  .map((row) => Map<String, dynamic>.from(row)),
              usableModels: (models['usable'] as List? ?? const [])
                  .whereType<Map>()
                  .map((row) => Map<String, dynamic>.from(row)),
            );
          } on FormatException catch (error) {
            throw ApiFailure(error.message);
          }
          return sendTurn(selection);
        }
        return sendTurn(null);
      case 'stop':
        return state.stopConversation(_task(args));
      case 'created':
        onCreated(_task(args));
        return null;
      case 'refresh':
        await state.loadConversations();
        return null;
      case 'draft':
        // A remounted conversation must restore the latest edit, including empty.
        initialDraft = args['text'] as String;
        _draftReported = true;
        final action = args['actionId'];
        initialAction =
            const {
              'work.requirement.create',
              'work.automation.create',
              'work.plugin.create',
            }.contains(action)
            ? action as String
            : '';
        onDraftAction?.call(initialAction);
        onDraft(initialDraft);
        return null;
      case 'resource':
        final key = args['key'] as String;
        if (!const {'projects', 'plugins', 'skills', 'cloud'}.contains(key)) {
          throw const ApiFailure('此入口暂不可用。');
        }
        await onResource(key);
        return null;
      case 'external':
        final url = Uri.tryParse(args['url'] as String);
        if (url == null ||
            !const {'https', 'http'}.contains(url.scheme) ||
            url.userInfo.isNotEmpty ||
            url.host.isEmpty) {
          throw const ApiFailure('链接无效。');
        }
        await onExternal(url.toString());
        return null;
      default:
        throw const ApiFailure('此能力尚未接入移动端。');
    }
  }
}

class WorkTask {
  final String runnerKind;
  final String id;
  final String title;
  final String note;
  final String source;
  final String status;
  final String priority;
  final String handler;
  final bool needsMe;
  final bool aiAttentionRaised;
  final bool urgent;
  final bool important;
  final int createdAt;
  final int? startAt;
  final int? dueAt;
  final String projectId;
  final String repoId;
  final String artifactUrl;
  final List<String> tags;
  final List<Map<String, dynamic>> progress;
  final String aiState;
  final String aiName;
  final String aiError;
  final String origin;
  final String cloudSessionId;
  final String createdByName;
  final String ownerClientId;
  final String createdBy;
  final bool? canViewExecution;
  final bool hasExecutionHistory;
  final bool canSend;
  final bool canReview;
  final bool readOnly;
  final bool canClaimExecution;
  final bool canEditRequirement;
  final bool? canArchiveRequirement;
  final bool? maintenanceBlocked;
  final String maintenanceBlockReason;
  final String requirementStage;
  final String triageStage;
  final int requirementVersion;
  final bool archived;
  final bool reviewed;
  final String assigneeName;
  final List<String> acceptanceCriteria;
  final List<String> myRoles;
  final String conversationTurnState;
  final String aiExecutionState;
  final bool isStandaloneWorkflow;
  final bool isDirectExecution;

  const WorkTask({
    this.runnerKind = '',
    required this.id,
    required this.title,
    required this.note,
    required this.source,
    required this.status,
    required this.priority,
    required this.handler,
    this.needsMe = false,
    this.aiAttentionRaised = false,
    required this.urgent,
    required this.important,
    required this.createdAt,
    required this.startAt,
    required this.dueAt,
    required this.projectId,
    required this.repoId,
    required this.artifactUrl,
    required this.tags,
    required this.progress,
    required this.aiState,
    required this.aiName,
    required this.aiError,
    this.origin = '',
    this.cloudSessionId = '',
    this.createdByName = '',
    this.ownerClientId = '',
    this.createdBy = '',
    this.canViewExecution,
    this.hasExecutionHistory = false,
    this.canSend = false,
    this.canReview = false,
    this.readOnly = false,
    this.canClaimExecution = false,
    this.canEditRequirement = false,
    this.canArchiveRequirement,
    this.maintenanceBlocked,
    this.maintenanceBlockReason = '',
    this.requirementStage = '',
    this.triageStage = 'ready',
    this.requirementVersion = 1,
    this.archived = false,
    this.reviewed = false,
    this.assigneeName = '',
    this.acceptanceCriteria = const [],
    this.myRoles = const [],
    this.conversationTurnState = '',
    this.aiExecutionState = '',
    this.isStandaloneWorkflow = false,
    this.isDirectExecution = false,
  });

  factory WorkTask.fromJson(Map<String, dynamic> json) {
    final ai = _map(json['ai']);
    final runner = _map(
      _map(_map(json['workRouting'])['executionContext'])['runner'],
    );
    return WorkTask(
      runnerKind:
          runner['clientId'] != null && runner['clientId'].toString().isNotEmpty
          ? 'work-computer'
          : runner['mode'] == 'remote'
          ? 'cloud'
          : '',
      id: _text(json['id']),
      title: _text(json['title'], fallback: '\u672a\u547d\u540d\u4efb\u52a1'),
      note: _text(json['note']),
      source: _text(json['source']),
      status: _text(json['status'], fallback: 'todo'),
      priority: _text(json['priority'], fallback: 'normal'),
      handler: _text(json['handler'], fallback: 'me'),
      needsMe: json['needsMe'] == true,
      aiAttentionRaised: ai['attentionRaised'] == true,
      urgent: json['urgent'] == true,
      important: json['important'] == true,
      createdAt: _number(json['created'] ?? json['createdAt']),
      startAt: _nullableNumber(json['start'] ?? json['startAt']),
      dueAt: _nullableNumber(json['due'] ?? json['dueAt']),
      projectId: _text(json['projectId']),
      repoId: _text(json['repoId']),
      artifactUrl: _text(json['artifactUrl']),
      tags: _list(
        json['tags'],
      ).map(_text).where((value) => value.isNotEmpty).toList(growable: false),
      progress: _list(json['progress']).map(_map).toList(growable: false),
      aiState: _text(ai['state'] ?? json['aiState']),
      aiName: _text(ai['name'] ?? json['aiName']),
      aiError: _text(ai['error'] ?? json['aiError']),
      origin: _text(json['origin']),
      cloudSessionId: _text(
        _map(_map(json['workRouting'])['cloudConversation'])['sessionId'],
      ),
      createdByName: _text(json['createdByName']),
      ownerClientId: _text(json['ownerClientId']),
      createdBy: _text(json['createdBy']),
      canSend: json['canSend'] == true,
      hasExecutionHistory: json['hasExecutionHistory'] == true,
      canReview: json['canReview'] == true,
      readOnly: json['readOnly'] == true,
      canClaimExecution: json['canClaimExecution'] == true,
      canEditRequirement: json['canEditRequirement'] == true,
      canArchiveRequirement: json['canArchiveRequirement'] as bool?,
      maintenanceBlocked: json['maintenanceBlocked'] as bool?,
      maintenanceBlockReason: _text(json['maintenanceBlockReason']),
      requirementStage: _text(json['requirementStage']),
      triageStage: _text(json['triageStage'], fallback: 'ready'),
      requirementVersion: _number(json['requirementVersion'] ?? 1),
      archived: json['archivedAt'] != null,
      reviewed: json['reviewedAt'] != null,
      assigneeName: _text(json['assigneeName']),
      acceptanceCriteria: _list(
        json['acceptanceCriteria'],
      ).map(_text).toList(growable: false),
      myRoles: _list(json['myRoles']).map(_text).toList(growable: false),
      conversationTurnState: _text(
        _map(_map(json['workRouting'])['conversationTurn'])['state'],
      ),
      aiExecutionState: _text(ai['executionState']),
      isStandaloneWorkflow: _mobileWorkSubmission(_map(json['workRouting'])),
      isDirectExecution: _directExecution(_map(json['workRouting'])),
      canViewExecution: json['canViewExecution'] is bool
          ? json['canViewExecution'] as bool
          : null,
    );
  }

  /// Hub also stores conversation and scheduled-run execution receipts as Tasks.
  /// Those records keep their identity for logs/artifacts, but are not demands.
  /// Match protocol provenance only; titles, handlers and AI state are not types.
  bool get isRequirement =>
      !isStandaloneWorkflow &&
      !const {
        'cloud-conversation',
        'conversation-handoff',
        'automation',
      }.contains(origin) &&
      source != '定时派活';

  // mobile_work.submit persists this fence on its own execution Task. A normal
  // requirement may also select a workflow, so strategy/binding alone is not enough.
  static bool _mobileWorkSubmission(Map<String, dynamic> routing) {
    final marker = _map(routing['mobileWorkSubmission']);
    final request = marker['requestId'], hash = marker['payloadHash'];
    final owner = marker['ownerUserId'], binding = marker['bindingId'];
    return routing['selectedStrategy'] == 'workflow' &&
        request is String &&
        RegExp(r'^[A-Za-z0-9._:-]{1,80}$').hasMatch(request) &&
        hash is String &&
        RegExp(r'^[a-f0-9]{64}$').hasMatch(hash) &&
        owner is String &&
        owner.isNotEmpty &&
        binding is String &&
        binding.isNotEmpty &&
        routing['workflowBindingId'] == binding &&
        marker['phase'] == 'starting';
  }

  // Require the saved dispatch contract, not a title, origin or an absent run.
  // Unknown/legacy records still need the workflow lookup.
  static bool _directExecution(Map<String, dynamic> routing) =>
      routing['selectedStrategy'] == 'direct' &&
      routing['workflowBindingId'] == '' &&
      _map(routing['executionContext'])['strategy'] == 'direct' &&
      _map(routing['mobileWorkSubmission']).isEmpty;

  bool get isOpen => status != 'done' && status != 'cancel';

  /// Mirrors the PC requirement stage projection; execution remains Hub-owned.
  String get boardStage {
    if (archived || status == 'cancel') return 'closed';
    if (status == 'done') return reviewed ? 'delivered' : 'reviewing';
    if (requirementStage == 'reviewing') return 'reviewing';
    if (status == 'doing' || status == 'paused') return 'delivering';
    if (requirementStage.isNotEmpty) return requirementStage;
    return {'intake', 'clarifying', 'ready'}.contains(triageStage)
        ? triageStage
        : 'ready';
  }

  bool get canArrange {
    const idle = {
      '',
      'failed',
      'cancelled',
      'canceled',
      'stopped',
      'interrupted',
    };
    return (!readOnly || canClaimExecution) &&
        maintenanceBlocked != true &&
        canViewExecution != false &&
        !archived &&
        boardStage == 'ready' &&
        status == 'todo' &&
        idle.contains(aiState) &&
        idle.contains(aiExecutionState) &&
        idle.contains(conversationTurnState);
  }

  bool get canTriage =>
      canEditRequirement &&
      status == 'todo' &&
      !archived &&
      !{
        'queued',
        'running',
        'starting',
        'waiting',
      }.contains(conversationTurnState) &&
      !{'running', 'dispatching', 'done'}.contains(aiState) &&
      boardStage != 'reviewing';

  bool get isRunning {
    if (needsAttention) return false;
    const active = {'queued', 'starting', 'dispatching', 'running', 'waiting'};
    // Execution state is independent of a requirement awaiting human review.
    if (aiExecutionState.isNotEmpty) return active.contains(aiExecutionState);
    if (aiState.isNotEmpty) {
      return active.contains(aiState) || aiState == 'rework';
    }
    if (conversationTurnState.isNotEmpty) {
      return active.contains(conversationTurnState);
    }
    return status == 'doing' && !isAi;
  }

  bool get needsAttention => {'failed', 'stuck', 'blocked'}.contains(aiState);

  bool get isAi => aiState.isNotEmpty || handler == 'auto';

  String get latestProgress {
    if (progress.isEmpty) return '';
    final value = progress.last;
    return _text(value['text'] ?? value['content'] ?? value['note']);
  }
}

class AiAssignee {
  final String id;
  final String runnerId;
  final String runnerKind;
  final String name;
  final String type;
  final String cli;
  final String cliName;
  final String model;
  final String host;
  final String machineLabel;
  final bool online;
  final bool busy;
  final bool remote;

  const AiAssignee({
    required this.id,
    this.runnerId = '',
    this.runnerKind = '',
    required this.name,
    required this.type,
    required this.cli,
    required this.cliName,
    required this.model,
    required this.host,
    required this.machineLabel,
    required this.online,
    required this.busy,
    required this.remote,
  });

  factory AiAssignee.fromJson(Map<String, dynamic> json) {
    return AiAssignee(
      id: _text(json['id']),
      runnerId: _text(json['runnerId']),
      runnerKind: _text(json['runnerKind']),
      name: _text(
        json['name'],
        fallback: _text(json['cliName'], fallback: 'AI'),
      ),
      type: _text(json['type'], fallback: 'agent'),
      cli: _text(json['cli']),
      cliName: _text(json['cliName'], fallback: _text(json['cli'])),
      model: _text(json['model']),
      host: _text(json['host']),
      machineLabel: _text(
        json['machineLabel'],
        fallback: _text(
          json['host'],
          fallback: '\u5728\u7ebf\u6267\u884c\u673a',
        ),
      ),
      online: json['online'] != false,
      busy: json['busy'] == true,
      remote: json['remote'] == true,
    );
  }

  bool get available => id.isNotEmpty && online;

  String get foundationLabel {
    final value = cliName.isNotEmpty ? cliName : cli;
    if (value.isEmpty) return 'Agent';
    return switch (value.toLowerCase()) {
      'pi' => 'Pi',
      'opencode' => 'OpenCode',
      'claude' || 'claude code' => 'Claude Code',
      'codex' => 'Codex',
      _ => value,
    };
  }
}

class AiRoster {
  final List<AiAssignee> agents;
  final String reason;
  final String provider;
  final String defaultId;
  final List<String> modelNames;

  const AiRoster({
    required this.agents,
    required this.reason,
    required this.provider,
    required this.defaultId,
    this.modelNames = const [],
  });

  factory AiRoster.fromJson(Map<String, dynamic> json) {
    final defaultAgent = _map(json['default']);
    final modelNames = {
      for (final value in _list(json['modelOptions']).map(_map))
        if (_text(value['name']).isNotEmpty) _text(value['name']),
    }.toList();
    final preferred = _text(json['defaultModel']);
    if (modelNames.remove(preferred)) modelNames.insert(0, preferred);
    return AiRoster(
      agents: _list(json['agents'])
          .map(_map)
          .map(AiAssignee.fromJson)
          .where((item) => item.id.isNotEmpty)
          .toList(growable: false),
      reason: _text(json['reason']),
      provider: _text(json['provider']),
      defaultId: _text(defaultAgent['id'] ?? json['defaultId']),
      modelNames: List<String>.unmodifiable(modelNames),
    );
  }

  List<AiAssignee> get selectableAgents {
    final rows = agents.where((item) => item.available).toList(growable: true);
    rows.sort((a, b) {
      final preferredA = a.id == defaultId ? 0 : 1;
      final preferredB = b.id == defaultId ? 0 : 1;
      if (preferredA != preferredB) return preferredA - preferredB;
      final busyOrder = (a.busy ? 1 : 0) - (b.busy ? 1 : 0);
      if (busyOrder != 0) return busyOrder;
      const order = {'pi': 0, 'opencode': 1, 'claude': 2, 'codex': 3};
      final cliOrder =
          (order[a.cli.toLowerCase()] ?? 99) -
          (order[b.cli.toLowerCase()] ?? 99);
      if (cliOrder != 0) return cliOrder;
      return a.name.compareTo(b.name);
    });
    return rows;
  }

  List<AiAssignee> get cloudAgents {
    final seen = <String>{};
    final result = <AiAssignee>[];
    for (final seat in selectableAgents) {
      if (!seat.remote || seat.type != 'agent' || seat.cli.isEmpty) continue;
      // Models come from the authenticated Hub catalog. The runtime remains
      // authoritative for admission and protocol support at dispatch time.
      for (final model in modelNames.isEmpty ? [seat.model] : modelNames) {
        if (!seen.add(
          '${seat.runnerKind}:${seat.runnerId}:${seat.cli}:$model',
        )) {
          continue;
        }
        result.add(
          AiAssignee(
            id: seat.id,
            runnerId: seat.runnerId,
            runnerKind: seat.runnerKind,
            name: seat.name,
            type: seat.type,
            cli: seat.cli,
            cliName: seat.cliName,
            model: model,
            host: seat.host,
            machineLabel: seat.machineLabel,
            online: seat.online,
            busy: seat.busy,
            remote: seat.remote,
          ),
        );
      }
    }
    return result;
  }

  AiAssignee? get recommended {
    final rows = selectableAgents;
    if (rows.isEmpty) return null;
    return rows.firstWhere((item) => !item.busy, orElse: () => rows.first);
  }
}

class AiExecutionStatus {
  final bool dispatched;
  final bool done;
  final bool stalled;
  final String state;
  final String host;
  final String cliName;
  final String error;

  const AiExecutionStatus({
    required this.dispatched,
    required this.done,
    required this.stalled,
    required this.state,
    required this.host,
    required this.cliName,
    required this.error,
  });

  factory AiExecutionStatus.fromJson(Map<String, dynamic> json) {
    final runner = _map(json['runner']);
    return AiExecutionStatus(
      dispatched: json['dispatched'] == true,
      done: json['done'] == true || runner['done'] == true,
      stalled: json['stalled'] == true,
      state: _text(runner['state']),
      host: _text(runner['machineLabel'] ?? runner['host']),
      cliName: _text(runner['cliName'] ?? runner['cli']),
      error: _text(runner['error'] ?? json['error']),
    );
  }

  bool get running => dispatched && !done && !stalled;

  String get refreshToken =>
      '$dispatched|$done|$stalled|$state|$host|$cliName|$error';
}

class AutomationSchedule {
  /// Original server configuration, retained so partial edits never reset plugins.
  final Map<String, dynamic> configuration;
  final String id;
  final String title;
  final String note;
  final String every;
  final String timeZone;
  final String nextRunLocal;
  final String lastRunAt;
  final String nextRetryAt;
  final String lastTaskId;
  final String lastError;
  final String executionMode;
  final String pluginBindingId;
  final String personalPluginKey;
  final String personalPluginVersionPolicy;
  final String personalPluginVersion;
  final bool enabled;
  final bool retrying;
  final int retryCount;
  final int retryLimit;
  final List<String> requiredCapabilities;

  const AutomationSchedule({
    this.configuration = const {},
    required this.id,
    required this.title,
    required this.note,
    required this.every,
    required this.timeZone,
    required this.nextRunLocal,
    required this.lastRunAt,
    required this.nextRetryAt,
    required this.lastTaskId,
    required this.lastError,
    required this.executionMode,
    required this.pluginBindingId,
    required this.personalPluginKey,
    required this.personalPluginVersionPolicy,
    required this.personalPluginVersion,
    required this.enabled,
    required this.retrying,
    required this.retryCount,
    required this.retryLimit,
    required this.requiredCapabilities,
  });

  factory AutomationSchedule.fromJson(Map<String, dynamic> json) {
    return AutomationSchedule(
      configuration: Map<String, dynamic>.unmodifiable(json),
      id: _text(json['id']),
      title: _text(
        json['title'],
        fallback: '\u672a\u547d\u540d\u81ea\u52a8\u5316',
      ),
      note: _text(json['note']),
      every: _text(json['every'], fallback: 'daily'),
      timeZone: _text(json['timeZone'], fallback: 'Asia/Shanghai'),
      nextRunLocal: _text(json['nextRunLocal']),
      lastRunAt: _text(json['lastRunAt']),
      nextRetryAt: _text(json['nextRetryAt']),
      lastTaskId: _text(json['lastTaskId']),
      lastError: _text(json['lastError']),
      executionMode: _text(json['executionMode'], fallback: 'direct'),
      pluginBindingId: _text(json['pluginBindingId']),
      personalPluginKey: _text(json['personalPluginKey']),
      personalPluginVersionPolicy: _text(
        json['personalPluginVersionPolicy'],
        fallback: 'latest',
      ),
      personalPluginVersion: _text(json['personalPluginVersion']),
      enabled: json['enabled'] != false,
      retrying: json['retrying'] == true,
      retryCount: _number(json['retryCount']),
      retryLimit: _number(json['retryLimit']),
      requiredCapabilities: _list(
        json['requiredCapabilities'],
      ).map(_text).where((value) => value.isNotEmpty).toList(growable: false),
    );
  }

  bool get needsAttention => lastError.isNotEmpty && !retrying;

  String get methodLabel {
    if (executionMode == 'personal' && personalPluginKey.isNotEmpty) {
      final version = personalPluginVersion.isEmpty
          ? ''
          : ' v$personalPluginVersion';
      final policy = personalPluginVersionPolicy == 'latest'
          ? ' \u00b7 \u8ddf\u968f\u6700\u65b0\u7248'
          : ' \u00b7 \u56fa\u5b9a\u7248\u672c';
      return '$personalPluginKey$version$policy';
    }
    if (executionMode == 'plugin') {
      return '\u4f01\u4e1a\u5de5\u4f5c\u6d41\u63d2\u4ef6';
    }
    return 'Agent \u76f4\u63a5\u6267\u884c';
  }
}

class AutomationRun {
  final String id;
  final String scheduleId;
  final String trigger;
  final String state;
  final int attempt;
  final String taskId;
  final String taskTitle;
  final String taskStatus;
  final String conversationId;
  final String conversationTitle;
  final String startedAt;
  final String finishedAt;
  final int? durationSeconds;
  final String error;
  final Map<String, dynamic> receipt;

  const AutomationRun({
    required this.id,
    required this.scheduleId,
    required this.trigger,
    required this.state,
    required this.attempt,
    required this.taskId,
    required this.taskTitle,
    required this.taskStatus,
    this.conversationId = '',
    this.conversationTitle = '',
    required this.startedAt,
    required this.finishedAt,
    required this.durationSeconds,
    required this.error,
    required this.receipt,
  });

  factory AutomationRun.fromJson(Map<String, dynamic> json) {
    return AutomationRun(
      id: _text(json['id']),
      scheduleId: _text(json['scheduleId']),
      trigger: _text(json['trigger'], fallback: 'timer'),
      state: _text(json['state'], fallback: 'starting'),
      attempt: _number(json['attempt']).clamp(1, 999).toInt(),
      taskId: _text(json['taskId']),
      taskTitle: _text(json['taskTitle']),
      taskStatus: _text(json['taskStatus']),
      conversationId: _text(
        json['conversationId'] ?? _map(json['receipt'])['conversationId'],
      ),
      conversationTitle: _text(
        json['conversationTitle'] ?? _map(json['receipt'])['conversationTitle'],
      ),
      startedAt: _text(json['startedAt']),
      finishedAt: _text(json['finishedAt']),
      durationSeconds: _nullableNumber(json['durationSeconds']),
      error: _text(json['error']),
      receipt: _map(json['receipt']),
    );
  }

  bool get active => {'starting', 'running', 'waiting'}.contains(state);
  bool get succeeded => state == 'succeeded';
  bool get conversationMode =>
      receipt['executionMode'] == 'soduwork.automation-conversation/v1' ||
      receipt['executionMode'] == 'soduwork.cloud-automation/v1';
  bool get hasResult => taskId.isNotEmpty || conversationId.isNotEmpty;
  String get resultTitle =>
      conversationTitle.isNotEmpty ? conversationTitle : taskTitle;

  String get stateLabel => switch (state) {
    'starting' => '\u51c6\u5907\u4e2d',
    'running' => '\u6267\u884c\u4e2d',
    'waiting' => '\u5f85\u786e\u8ba4',
    'succeeded' => '\u5df2\u5b8c\u6210',
    'failed' => '\u5931\u8d25',
    'cancelled' => '\u5df2\u53d6\u6d88',
    _ => state,
  };

  String get triggerLabel => switch (trigger) {
    'manual' => '\u624b\u52a8\u8fd0\u884c',
    'retry' => '\u81ea\u52a8\u91cd\u8bd5',
    _ => '\u6309\u65f6\u89e6\u53d1',
  };

  String get pluginLabel {
    final plugin = _map(receipt['plugin']);
    final name = _text(plugin['name'] ?? plugin['key']);
    if (name.isEmpty) return '';
    final version = _text(plugin['version']);
    return version.isEmpty ? name : '$name v$version';
  }

  String get routeLabel {
    final route = _map(receipt['route']);
    final resolved = _map(route['resolved']);
    // Execution kind comes from the receipt, never from a machine's name.
    final locationType = switch (_text(receipt['targetRunnerKind'])) {
      'cloud' => '云端执行机',
      'work-computer' => '工作电脑',
      _ => '',
    };
    return <String>[
      locationType,
      _text(resolved['host']),
      _text(resolved['agent'] ?? resolved['assigneeName']),
      _text(resolved['model']),
    ].where((value) => value.isNotEmpty).toSet().join(' \u00b7 ');
  }
}

class ApprovalItem {
  final String id;
  final String action;
  final String status;
  final int createdAt;
  final WorkTask task;
  final Map<String, dynamic> artifact;
  final Map<String, dynamic> gate;
  final Map<String, dynamic> myDecision;

  const ApprovalItem({
    required this.id,
    required this.action,
    required this.status,
    required this.createdAt,
    required this.task,
    required this.artifact,
    required this.gate,
    required this.myDecision,
  });

  factory ApprovalItem.fromJson(Map<String, dynamic> json) {
    final taskJson = _map(json['task']);
    return ApprovalItem(
      id: _text(json['id']),
      action: _text(json['action'], fallback: 'review'),
      status: _text(json['status'], fallback: 'pending'),
      createdAt: _number(json['createdAt'] ?? json['created']),
      task: WorkTask.fromJson({
        ...taskJson,
        'created': taskJson['created'] ?? json['createdAt'],
      }),
      artifact: _map(json['artifact']),
      gate: _map(json['gate']),
      myDecision: _map(json['myDecision']),
    );
  }

  String get actionLabel => switch (action) {
    'baseline' => '\u786e\u8ba4\u9700\u6c42',
    'review' => '\u5ba1\u9605\u6210\u679c',
    'merge' => '\u5408\u5e76\u6388\u6743',
    'uat' => '\u9a8c\u6536\u786e\u8ba4',
    'deploy' => '\u53d1\u5e03\u6388\u6743',
    _ => '\u4eba\u5de5\u786e\u8ba4',
  };

  bool get hasGateContract => gate.isNotEmpty;

  Map<String, dynamic> get readiness => _map(gate['readiness']);

  bool get canApprove {
    final value = readiness;
    return value.isEmpty || value['canApprove'] != false;
  }

  List<String> get blockers => _list(
    readiness['blockers'],
  ).map(_text).where((value) => value.isNotEmpty).toList(growable: false);

  int get evidenceCount {
    final direct = _list(gate['evidence']).length;
    if (direct > 0) return direct;
    final packet = _list(_map(gate['packet'])['evidence']).length;
    if (packet > 0) return packet;
    return _number(readiness['evidenceCount']);
  }
}

class PersonalBrief {
  final String label;
  final String period;
  final String content;
  final bool hasMaterial;
  final int doneCount;
  final int activeCount;
  final int progressCount;

  const PersonalBrief({
    required this.label,
    required this.period,
    required this.content,
    required this.hasMaterial,
    required this.doneCount,
    required this.activeCount,
    required this.progressCount,
  });

  factory PersonalBrief.fromEnvelope(Map<String, dynamic> json) {
    final period = _map(json['period']);
    final personal = _map(json['personal']);
    final report = _map(personal['report']);
    final content = _text(
      report['content'] ?? report['summary'] ?? report['body'],
    );
    return PersonalBrief(
      label: _text(period['label'], fallback: '\u4eca\u65e5\u7b80\u62a5'),
      period: _text(period['type'], fallback: 'daily'),
      content: content,
      hasMaterial: personal['hasMaterial'] == true,
      doneCount: _number(personal['doneCount']),
      activeCount: _number(personal['activeCount']),
      progressCount: _number(personal['progressCount']),
    );
  }
}

Map<String, dynamic> jsonMap(dynamic value) => _map(value);
List<dynamic> jsonList(dynamic value) => _list(value);

String _text(dynamic value, {String fallback = ''}) {
  final result = value == null ? '' : value.toString().trim();
  return result.isEmpty ? fallback : result;
}

int _number(dynamic value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

int? _nullableNumber(dynamic value) {
  final result = _number(value);
  return result == 0 ? null : result;
}

Map<String, dynamic> _map(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) {
    return value.map((key, item) => MapEntry(key.toString(), item));
  }
  return <String, dynamic>{};
}

List<dynamic> _list(dynamic value) => value is List ? value : const [];

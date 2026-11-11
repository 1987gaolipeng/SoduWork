import '../ui/mobile_display_preferences.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import '../core/cloud_conversation_request.dart';
import '../core/cloud_conversation_pending_store.dart';
import '../core/soduwork_api.dart';
import '../ui/work_execution_picker.dart';
import '../ui/artifact_actions.dart';
import '../ui/task_detail_sections.dart';

import '../models/conversation_models.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';
import '../ui/cloud_conversation_controls.dart';
import '../ui/cloud_conversation_acceptance.dart';
import '../ui/cloud_conversation_deliverables.dart';
import '../ui/cloud_conversation_timeline.dart';

/// Live view of one cloud conversation: incremental transcript, follow-ups,
/// stop control and delivered results.
class CloudConversationScreen extends StatefulWidget {
  final String taskId;
  final String title;
  final String agentLabel;
  final String ref;
  final bool embedded;
  final String modelLabel;
  final VoidCallback? onExecutionOptions;

  const CloudConversationScreen({
    super.key,
    required this.taskId,
    required this.title,
    this.agentLabel = '',
    this.ref = '',
    this.embedded = false,
    this.modelLabel = '',
    this.onExecutionOptions,
  });

  @override
  State<CloudConversationScreen> createState() =>
      _CloudConversationScreenState();
}

class _CloudConversationScreenState extends State<CloudConversationScreen>
    with WidgetsBindingObserver {
  final Map<int, ConversationEvent> _eventsBySeq = {};
  final Map<String, _PendingSend> _pendingSends = {};
  final _pendingStore = CloudConversationPendingStore();
  final TextEditingController _input = TextEditingController();
  final FocusNode _inputFocus = FocusNode();
  final ScrollController _scroll = ScrollController();
  bool _following = true;

  String _ref = '';
  int _since = 0;
  String _status = 'queued';
  String _engineLabel = '';
  bool _loading = true;
  bool _sending = false;
  bool _stopping = false;
  bool _appActive = true;
  bool _inFlight = false;
  bool _attachmentsLoaded = false;
  String _fatalError = '';
  String _sessionError = '';
  String _actionError = '';
  String _runnerId = '';
  String _runnerKind = 'cloud';
  String _conversationTaskId = '';
  Map<String, String> _activeSelection = const {};
  Map<String, String>? _nextSelection;
  bool _pendingHydrated = false;
  int? _awaitingRoundAfterSeq;
  String _resumeFromStatus = '';
  Map<String, dynamic> _delivery = const {};
  bool _openingArtifact = false;
  List<ConversationAttachment> _attachments = const [];
  Timer? _poller;

  bool get _running => isRunningConversationState(_status);
  bool get _terminal => isTerminalConversationState(_status);

  @override
  void initState() {
    super.initState();
    _conversationTaskId = widget.taskId;
    _ref = widget.ref.trim();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(() {
      if (_scroll.hasClients) _following = _scroll.position.extentAfter < 100;
    });
    Future.microtask(_initialize);
  }

  String _pendingScope(MobileState state) {
    final device = state.enrollment?.deviceId.trim() ?? '';
    return '${state.endpoint.baseUrl}|${device.isEmpty ? state.identityRevision : device}|$_conversationTaskId';
  }

  Future<void> _initialize() async {
    // Do not make the first transcript fetch wait for platform storage.
    unawaited(_load());
    final state = MobileScope.read(context);
    try {
      final stored = await _pendingStore.load(_pendingScope(state));
      if (!mounted) return;
      setState(() {
        for (final item in stored) {
          _pendingSends[item.id] = _PendingSend.fromStored(item);
        }
        _pendingHydrated = true;
        if (_pendingSends.values.any((item) => item.retryable)) {
          _actionError = '有消息尚未确认送达，可重试同一条消息。';
        }
      });
    } catch (_) {
      if (mounted) setState(() => _pendingHydrated = true);
    }
  }

  Future<void> _persistPending() async {
    if (!_pendingHydrated || !mounted) return;
    final state = MobileScope.read(context);
    final items = _pendingSends.entries
        .map((entry) => entry.value.toStored(entry.key))
        .toList(growable: false);
    try {
      if (items.isEmpty) {
        await _pendingStore.clear(_pendingScope(state));
      } else {
        await _pendingStore.save(_pendingScope(state), items);
      }
    } catch (_) {
      // The Hub receipt still fences retries if platform storage is unavailable.
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final active = state == AppLifecycleState.resumed;
    if (_appActive == active) return;
    _appActive = active;
    if (active) {
      _load(silent: true);
    } else {
      _poller?.cancel();
      _poller = null;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poller?.cancel();
    _scroll.dispose();
    _input.dispose();
    _inputFocus.dispose();
    super.dispose();
  }

  void _syncPolling() {
    final shouldPoll =
        _appActive &&
        (!_terminal ||
            _fatalError.isNotEmpty ||
            _pendingSends.values.any((item) => !item.accepted) ||
            _awaitingRoundAfterSeq != null);
    if (!shouldPoll) {
      _poller?.cancel();
      _poller = null;
      return;
    }
    if (_poller?.isActive == true) return;
    _poller = Timer.periodic(
      const Duration(seconds: 3),
      (_) => _load(silent: true),
    );
  }

  Future<void> _load({bool silent = false}) async {
    if (_inFlight) return;
    if (silent && !_appActive) return;
    final state = MobileScope.read(context);
    if (state.phase != MobilePhase.ready) return;
    _inFlight = true;
    if (!silent) {
      setState(() {
        _loading = true;
        _fatalError = '';
      });
    }
    try {
      final body = await state.loadConversationSession(
        _conversationTaskId,
        ref: _ref,
        since: _since,
      );
      if (!mounted) return;
      if (body['ok'] != true) {
        final message = (body['error'] ?? '').toString();
        // A freshly created conversation may briefly report "not dispatched
        // yet" while the cloud start receipt settles — queue, don't error.
        final dispatchPending =
            message.contains('还没交给') && _eventsBySeq.isEmpty;
        setState(() {
          _loading = false;
          if (dispatchPending) {
            _status = 'dispatching';
            _fatalError = '';
            _sessionError = '';
          } else {
            _fatalError = _eventsBySeq.isEmpty && message.isNotEmpty
                ? message
                : '';
            _sessionError = _eventsBySeq.isNotEmpty ? message : '';
          }
        });
        _syncPolling();
        return;
      }
      final newRef = (body['ref'] ?? '').toString().trim();
      if (newRef.isNotEmpty && newRef != _ref) _ref = newRef;
      final items = ((body['items'] as List?) ?? const [])
          .whereType<Map>()
          .map(
            (item) => ConversationEvent.fromJson(
              item.map((key, value) => MapEntry(key.toString(), value)),
            ),
          )
          .toList(growable: false);
      final last = (body['last'] as num?)?.toInt() ?? _since;
      final status = (body['status'] ?? _status).toString();
      final engine = [
        if (widget.agentLabel.isNotEmpty) widget.agentLabel,
        if (widget.modelLabel.isNotEmpty) widget.modelLabel,
      ].join(' · ');
      setState(() {
        _loading = false;
        _status = status;
        _runnerId = (body['runnerId'] ?? _runnerId).toString();
        _runnerKind = (body['runnerKind'] ?? _runnerKind).toString();
        final active = body['activeExecutionSelection'];
        if (active is Map) {
          _activeSelection = active.map(
            (key, value) => MapEntry(key.toString(), value.toString()),
          );
        }
        if (engine.isNotEmpty) _engineLabel = engine;
        for (final event in items) {
          _eventsBySeq[event.seq] = event;
        }
        if (last > _since) _since = last;
        _reflectPending();
        if (!_pendingSends.values.any((item) => item.retryable)) {
          _sessionError = '';
        }
        final after = _awaitingRoundAfterSeq;
        if (after != null &&
            (isRunningConversationState(status) ||
                items.any((item) => item.seq > after && item.isSay) ||
                (status != _resumeFromStatus &&
                    isTerminalConversationState(status)))) {
          _awaitingRoundAfterSeq = null;
        }
      });
      _scrollToLatest();
      if (_terminal && _awaitingRoundAfterSeq == null && !_attachmentsLoaded) {
        _attachmentsLoaded = true;
        await _loadAttachments(state);
      }
      _syncPolling();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (_eventsBySeq.isEmpty) _fatalError = '$error';
      });
      _syncPolling();
    } finally {
      _inFlight = false;
    }
  }

  void _scrollToLatest() {
    if (!_following) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients && _following) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  Future<void> _loadAttachments(MobileState state) async {
    final endpoint = state.endpoint;
    try {
      // Existing Hub status performs the authorized, idempotent Runner artifact pull.
      await state.loadAiStatus(_conversationTaskId);
    } catch (_) {
      _attachmentsLoaded = false;
      if (mounted) setState(() => _sessionError = '成果暂未同步，向下拉动可重试。');
    }
    if (!mounted || endpoint != state.endpoint) return;
    try {
      final rows = await state.loadConversationAttachments(_conversationTaskId);
      if (!mounted || endpoint != state.endpoint) return;
      setState(() => _attachments = rows);
    } catch (_) {
      _attachmentsLoaded = false;
      if (mounted) setState(() => _sessionError = '成果暂未同步，向下拉动可重试。');
    }
    try {
      final delivery = await state.loadConversationDelivery(
        _conversationTaskId,
      );
      if (!mounted || endpoint != state.endpoint) return;
      if (delivery['delivery'] is Map ||
          (delivery['artifactUrl'] ?? '').toString().isNotEmpty) {
        setState(() => _delivery = delivery);
      }
    } catch (_) {
      // The transcript and individual files remain available independently.
    }
  }

  /// Sends resolve server-side before the transcript shows them; drop the
  /// optimistic bubble once the same text arrives as a user event.
  void _reflectPending() {
    final wasUncertain = _pendingSends.values.any((item) => item.retryable);
    final done = _pendingSends.entries
        .where(
          (entry) => _eventsBySeq.values.any(
            (event) =>
                event.isUser &&
                event.seq > entry.value.afterSeq &&
                (event.displayText.trim() == entry.value.text ||
                    (entry.value.accepted &&
                        entry.value.text.length > 4000 &&
                        event.text.trim() ==
                            entry.value.text.substring(0, 4000))),
          ),
        )
        .map((entry) => entry.key)
        .toList(growable: false);
    if (wasUncertain && done.isNotEmpty) _actionError = '';
    for (final key in done) {
      _pendingSends.remove(key);
    }
    if (done.isNotEmpty) unawaited(_persistPending());
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty ||
        _sending ||
        _stopping ||
        _pendingSends.values.any((item) => !item.accepted)) {
      return;
    }
    final id = mobileRequestId();
    final pending = _PendingSend(
      text: text,
      afterSeq: _since,
      resume: _terminal,
      executionSelection: _nextSelection,
    );
    _following = true;
    _input.clear();
    _inputFocus.unfocus();
    setState(() {
      _pendingSends[id] = pending;
      if (pending.resume) {
        _attachmentsLoaded = false;
        _awaitingRoundAfterSeq ??= pending.afterSeq;
        _resumeFromStatus = _status;
      }
      _nextSelection = null;
    });
    _scrollToLatest();
    unawaited(_persistPending());
    await _transmit(id, pending);
  }

  Future<void> _retryPending() async {
    if (_sending || _pendingSends.isEmpty) return;
    final entry = _pendingSends.entries
        .where((item) => item.value.retryable)
        .firstOrNull;
    if (entry != null) await _transmit(entry.key, entry.value);
  }

  Future<void> _transmit(String id, _PendingSend pending) async {
    setState(() {
      _sending = true;
      _actionError = '';
    });
    try {
      final state = MobileScope.read(context);
      final targetRunnerId =
          pending.executionSelection?['targetRunnerId']?.trim() ?? '';
      if (targetRunnerId.isNotEmpty && targetRunnerId != _runnerId) {
        final branch = await state.api.branchCloudConversation(
          _conversationTaskId,
          requestId: 'mobile-branch-$id',
          instruction: pending.text,
          targetRunnerId: targetRunnerId,
          targetRunnerKind:
              pending.executionSelection?['targetRunnerKind']?.trim() ?? '',
          agentId: pending.executionSelection?['agentId'] ?? '',
          model: pending.executionSelection?['modelName'] ?? '',
        );
        final nextTaskId = (branch['taskId'] ?? '').toString().trim();
        if (nextTaskId.isEmpty) {
          throw const ApiFailure(
            'Runner migration was not confirmed; retry the same message.',
          );
        }
        if (!mounted) return;
        setState(() {
          _conversationTaskId = nextTaskId;
          _runnerId = targetRunnerId;
          _runnerKind =
              pending.executionSelection?['targetRunnerKind']?.trim() ??
              'cloud';
          _ref = (branch['ref'] ?? '').toString();
          _eventsBySeq.clear();
          _since = 0;
          _status = 'queued';
          _fatalError = '';
          _sessionError = '';
          _activeSelection = {
            'agentId': (pending.executionSelection?['agentId'] ?? '')
                .toString(),
            'modelName': (pending.executionSelection?['modelName'] ?? '')
                .toString(),
            'targetRunnerKind': _runnerKind,
          };
          _pendingSends.remove(id);
          pending.retryable = false;
          pending.accepted = true;
          unawaited(_persistPending());
        });
        await _load(silent: true);
        return;
      }
      final receipt = await state.sayToConversation(
        _conversationTaskId,
        text: pending.text,
        messageId: id,
        executionSelection: pending.executionSelection,
      );
      if (!mounted) return;
      setState(() {
        if (receipt['ok'] == false) {
          pending.retryable =
              receipt['pending'] == true || receipt['uncertain'] == true;
          _actionError = (receipt['error'] ?? '这条消息没有送达。').toString();
          if (!pending.retryable) {
            _pendingSends.remove(id);
            if (pending.resume && _pendingSends.isEmpty) {
              _awaitingRoundAfterSeq = null;
            }
            _input.text = pending.text;
          }
        } else {
          pending.retryable = false;
          pending.accepted = true;
          if (pending.resume) {
            _awaitingRoundAfterSeq = pending.afterSeq;
            _resumeFromStatus = _status;
          }
          _attachmentsLoaded = false;
          final accepted = receipt['acceptedSelection'];
          if (accepted is Map) {
            _activeSelection = accepted.map(
              (key, value) => MapEntry(key.toString(), value.toString()),
            );
          }
        }
        unawaited(_persistPending());
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        final rejected =
            error is ApiFailure &&
            !error.isNetwork &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status != 408;
        pending.retryable = !rejected;
        if (rejected) {
          _pendingSends.remove(id);
          if (pending.resume && _pendingSends.isEmpty) {
            _awaitingRoundAfterSeq = null;
          }
          _input.text = pending.text;
        }
        _actionError = rejected ? '$error' : '消息送达结果尚未确认，请重试核对同一条消息。';
        unawaited(_persistPending());
      });
    } finally {
      if (mounted) {
        setState(() => _sending = false);
        _syncPolling();
        unawaited(_load(silent: true));
      }
    }
  }

  Future<void> _confirmStop() async {
    final theme = context.soduWorkTheme;
    final state = MobileScope.read(context);
    final agreed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(mobileText(context, '叫停这次会话？')),
        content: Text(mobileText(context, '执行会被中断，已产生的进度和成果会保留。')),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(mobileText(context, '继续执行')),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: theme.danger),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(mobileText(context, '叫停')),
          ),
        ],
      ),
    );
    if (agreed != true || _stopping) return;
    setState(() => _stopping = true);
    try {
      await state.stopConversation(_conversationTaskId);
      if (!mounted) return;
      setState(() => _status = 'stopped');
      await _load(silent: true);
    } catch (error) {
      if (mounted) {
        setState(() => _sessionError = '暂时没能叫停：$error');
      }
    } finally {
      if (mounted) setState(() => _stopping = false);
    }
  }

  Future<void> _openAttachment(ConversationAttachment attachment) =>
      _openResult(
        id: attachment.id,
        url: attachment.url,
        filename: attachment.filename,
        contentType: attachment.contentType,
      );

  Future<void> _openResult({
    String id = '',
    required String url,
    String filename = '成果',
    bool previewDelivery = false,
    String? entry,
    String contentType = 'application/octet-stream',
  }) async {
    if (_openingArtifact) return;
    setState(() => _openingArtifact = true);
    try {
      await openMobileArtifact(
        context,
        MobileScope.read(context).api,
        id: id,
        url: url,
        filename: filename,
        contentType: contentType,
        previewDelivery: previewDelivery,
        entry: entry,
      );
    } finally {
      if (mounted) setState(() => _openingArtifact = false);
    }
  }

  Future<void> _selectExecution() async {
    if (_runnerId.isEmpty) {
      widget.onExecutionOptions?.call();
      return;
    }
    final state = MobileScope.read(context);
    final choice = await showWorkExecutionPicker(
      context,
      selectedAgent: _activeSelection['agentId'] ?? widget.agentLabel,
      selectedRunnerId: _runnerId,
      locked: _running || _sending || _pendingSends.isNotEmpty,
    );
    if (!mounted || choice == null) return;
    final movingRunner =
        choice.runnerId.isNotEmpty && choice.runnerId != _runnerId;
    if (state.identityRevision != MobileScope.read(context).identityRevision) {
      return;
    }
    setState(() {
      _nextSelection = {
        'agentId': choice.id,
        'modelName': '',
        'reasoningEffort': '',
        if (movingRunner) 'targetRunnerId': choice.runnerId,
        if (movingRunner) 'targetRunnerKind': choice.runnerKind,
      };
      _actionError = '';
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final events = _orderedEvents;
    final pendingRows = _pendingSends.values.toList(growable: false);
    final thinking = _running && _fatalError.isEmpty && pendingRows.isEmpty;
    return Scaffold(
      backgroundColor: theme.surface,
      appBar: widget.embedded
          ? null
          : CloudConversationHeader(
              title: widget.title.isEmpty ? '云端会话' : widget.title,
              agentLabel: widget.agentLabel,
              engineLabel: _engineLabel,
              status: _status,
              running: _running,
              stopping: _stopping,
              onStop: _running ? _confirmStop : null,
            ),
      body: _buildBody(context, events, pendingRows, thinking),
    );
  }

  /// The pending confirmation bound to this conversation, if any.
  dynamic _pendingApproval() {
    final state = MobileScope.maybeOf(context);
    if (state == null) return null;
    for (final item in state.pendingApprovals) {
      if (item.task.id == _conversationTaskId) return item;
    }
    return null;
  }

  List<ConversationEvent> get _orderedEvents =>
      _eventsBySeq.values.toList(growable: false)
        ..sort((a, b) => a.seq.compareTo(b.seq));

  Widget _buildBody(
    BuildContext context,
    List<ConversationEvent> events,
    List<_PendingSend> pendingRows,
    bool thinking,
  ) {
    if (_loading && events.isEmpty && pendingRows.isEmpty) {
      return LoadingPane(label: mobileText(context, '正在读取会话…'));
    }
    if (_fatalError.isNotEmpty && events.isEmpty) {
      return EmptyPane(
        icon: Icons.cloud_off_rounded,
        title: '会话暂时无法读取',
        message: mobileText(context, _fatalError),
        actionLabel: '重新加载',
        onAction: () => _load(),
      );
    }
    final showDeliverables = _terminal && _attachments.isNotEmpty;
    final approval = _pendingApproval();
    return Column(
      children: [
        if (_actionError.isNotEmpty)
          InlineError(
            message: mobileText(context, _actionError),
            onRetry: _pendingSends.values.any((item) => item.retryable)
                ? _retryPending
                : null,
          ),
        if (_sessionError.isNotEmpty)
          InlineError(
            message: mobileText(context, _sessionError),
            onRetry: () => _load(silent: true),
          ),
        if (_openingArtifact) const LinearProgressIndicator(minHeight: 2),
        if (_delivery.isNotEmpty)
          TaskDeliverySummary(
            delivery: _delivery,
            onOpen: (item) => _openResult(
              url: item['url']?.toString() ?? '',
              filename: item['filename']?.toString() ?? '成果包.zip',
              previewDelivery: true,
              entry: item['entryPath']?.toString(),
            ),
          ),
        if (_awaitingRoundAfterSeq != null)
          Padding(
            padding: EdgeInsets.all(8),
            child: Text(mobileText(context, '等待新一轮执行回执…')),
          ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () => _load(silent: true),
            child: CloudConversationTimeline(
              controller: _scroll,
              events: events,
              pending: pendingRows.map((row) => row.text).toList(),
              thinking: thinking,
            ),
          ),
        ),
        if (showDeliverables)
          CloudConversationDeliverables(
            attachments: _attachments,
            onOpen: _openAttachment,
          ),
        // Acceptance docks right above the composer, only when work is done.
        if (approval != null)
          CloudConversationAcceptanceCard(
            approval: approval,
            taskId: _conversationTaskId,
          ),
        CloudConversationComposer(
          controller: _input,
          focusNode: _inputFocus,
          enabled:
              !_stopping && !_pendingSends.values.any((item) => !item.accepted),
          busy: _sending,
          hint: '与 SoduWork 协作',
          scopeKey:
              '${MobileScope.read(context).identityRevision}:$_conversationTaskId',
          modelLabel: _nextSelection == null
              ? widget.modelLabel
              : '下一轮：${_nextSelection!['agentId']}',
          onOptions: _selectExecution,
          running: _running,
          onStop: _confirmStop,
          onSend: _send,
        ),
      ],
    );
  }
}

class _PendingSend {
  final String text;
  final int afterSeq;
  final bool resume;
  final Map<String, String>? executionSelection;
  bool retryable = false;
  bool accepted = false;
  _PendingSend({
    required this.text,
    required this.afterSeq,
    required this.resume,
    this.executionSelection,
  });

  factory _PendingSend.fromStored(CloudConversationPendingMessage item) =>
      _PendingSend(
          text: item.text,
          afterSeq: item.afterSeq,
          resume: item.resume,
          executionSelection: item.executionSelection,
        )
        ..retryable = true
        ..accepted = item.accepted;

  CloudConversationPendingMessage toStored(String id) =>
      CloudConversationPendingMessage(
        id: id,
        text: text,
        afterSeq: afterSeq,
        resume: resume,
        retryable: retryable,
        accepted: accepted,
        executionSelection: executionSelection,
      );
}

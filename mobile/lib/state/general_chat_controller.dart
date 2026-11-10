import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../core/general_chat_store.dart';
import '../core/general_chat_transport.dart';
import '../core/soduwork_api.dart';
import '../models/general_chat.dart';

typedef GeneralChatLoader = Future<Map<String, dynamic>> Function();
typedef GeneralChatConfigLoader =
    Future<Map<String, dynamic>> Function(String model);
typedef GeneralChatPublisher =
    Future<Map<String, dynamic>> Function(Map<String, dynamic> body);
typedef GeneralChatSourceLoader =
    Future<Map<String, dynamic>> Function(String id);
typedef GeneralChatMessagesLoader =
    Future<Map<String, dynamic>> Function(String id, int after);

/// This device is a producer of the existing account transcript, never a second
/// conversation database or an execution queue. Normally the Hub must receipt
/// the user's message first. A legacy Hub that explicitly lacks the projection
/// endpoint (404/405) uses the same durable outbox for device-only chat. Network
/// failures, denied access and revision conflicts never activate that mode.
/// Replaying the outbox never calls a model.
class GeneralChatController extends ChangeNotifier {
  final GeneralChatScope scope;
  final Object scopeKey;
  final bool Function() isCurrent;
  final GeneralChatLoader loadModels;
  final GeneralChatConfigLoader loadConfig;
  final GeneralChatPublisher publish;
  final GeneralChatSourceLoader loadSource;
  final GeneralChatMessagesLoader loadMessages;
  final GeneralChatStore store;
  final ValueChanged<String> onConversationSaved;
  final GeneralChatTransport Function() transportFactory;
  final Duration checkpointInterval;
  final _history = <String, GeneralChatMessage>{};
  final _pending = <GeneralChatBatch>[];
  List<GeneralChatModel> models = const [];
  List<String> recoverableSessions = const [];
  Map<String, String> recoverableTitles = const {};
  String selectedModel = '';
  String conversationId = '';
  String sourceSessionId = '';
  String sourceEpoch = '';
  String title = '新对话';
  String error = '';
  String _modelError = '';
  String get modelError => _modelError;
  bool loading = false;
  bool streaming = false;
  bool saving = false;
  bool conflict = false;
  bool interrupted = false;
  bool _sendBusy = false;
  bool _ready = false;
  bool _disposed = false;
  bool _stopRequested = false;
  bool _syncFailed = false;
  bool syncUnavailable = false;
  int _generation = 0;
  int _modelRequest = 0;
  int _sourceRevision = 0;
  GeneralChatMessage? _live;
  GeneralChatTransport? _transport;
  Timer? _checkpointTimer;
  Future<void> _syncTail = Future.value();
  Future<void>? _replyFuture;
  String _lastCheckpoint = '';

  GeneralChatController({
    required this.scope,
    required this.scopeKey,
    required this.isCurrent,
    required this.loadModels,
    required this.loadConfig,
    required this.publish,
    required this.loadSource,
    required this.loadMessages,
    required this.onConversationSaved,
    GeneralChatStore? store,
    GeneralChatTransport Function()? transportFactory,
    this.checkpointInterval = const Duration(seconds: 1),
  }) : store = store ?? GeneralChatStore(),
       transportFactory = transportFactory ?? GeneralChatTransport.new;

  bool get hasPending => _pending.isNotEmpty;
  int? get pendingRevision => _pending.isEmpty ? null : _pending.first.revision;
  String get liveText => _current ? _live?.text ?? '' : '';
  bool get busy =>
      loading || streaming || saving || _sendBusy || _replyFuture != null;
  List<GeneralChatMessage> get messages {
    if (!_current) {
      return const [];
    }
    final rows = {..._history};
    for (final batch in _pending) {
      for (final row in batch.messages) {
        rows[row.id] = row;
      }
    }
    if (_live != null && _live!.text.isNotEmpty) rows[_live!.id] = _live!;
    return rows.values.where((row) => !row.deleted).toList()
      ..sort((a, b) => a.position.compareTo(b.position));
  }

  GeneralChatModel? get model {
    for (final option in models) {
      if (option.name == selectedModel) {
        return option;
      }
    }
    return null;
  }

  bool get canSend =>
      _ready &&
      _current &&
      !busy &&
      (!hasPending || syncUnavailable) &&
      !conflict &&
      model?.supported == true;
  bool get canAnswer =>
      canSend && messages.isNotEmpty && messages.last.role == 'user';
  bool get _current {
    if (_disposed) {
      return false;
    }
    try {
      return isCurrent();
    } catch (_) {
      return false;
    }
  }

  void _check() {
    if (!_current) {
      throw const ApiFailure('账号或会话已切换，本次结果未应用。', status: 409);
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> initialize({
    String conversationId = '',
    String sourceSessionId = '',
    bool recoverPending = true,
  }) async {
    if (loading || streaming || saving || !_current) {
      return;
    }
    final generation = ++_generation;
    loading = true;
    error = '';
    conflict = false;
    _ready = false;
    recoverableSessions = const [];
    recoverableTitles = const {};
    if (conversationId.isEmpty) conversationId = this.conversationId;
    if (sourceSessionId.isEmpty) sourceSessionId = this.sourceSessionId;
    _notify();
    final modelFuture = scope.valid ? refreshModels() : Future<void>.value();
    try {
      if (!scope.valid) {
        throw const ApiFailure('聊天账号身份不完整，请重新登录。');
      }
      if (recoverPending && conversationId.isEmpty && sourceSessionId.isEmpty) {
        final sessions = await store.pendingSessions(scope);
        _check();
        final pending = <String>[];
        final labels = <String, String>{};
        for (final session in sessions) {
          final box = await store.read(scope, session);
          if (box != null) {
            pending.add(session);
            final label = box.batches.first.body['title'];
            labels[session] = label is String && label.isNotEmpty
                ? label
                : '待同步聊天';
          }
          _check();
        }
        recoverableSessions = List.unmodifiable(pending);
        recoverableTitles = Map.unmodifiable(labels);
        if (pending.length > 1) {
          throw const ApiFailure('发现多条待同步聊天，请选择需要恢复的会话，或明确新建会话。');
        }
        if (pending.length == 1) sourceSessionId = pending.single;
      }
      await _restore(conversationId, sourceSessionId);
      _check();
      _ready = true;
      if (generation != _generation) {
        return;
      }
    } catch (failure) {
      if (_current && generation == _generation) _setError(failure);
    }
    try {
      await modelFuture;
    } finally {
      if (_current && generation == _generation) {
        loading = false;
        _notify();
      }
    }
  }

  Future<void> refreshModels() async {
    if (!_current) {
      return;
    }
    final request = ++_modelRequest;
    if (error == _modelError) error = '';
    _modelError = '';
    try {
      final body = await loadModels();
      _check();
      if (request != _modelRequest) {
        return;
      }
      models = GeneralChatModel.fromCatalog(body);
      if (selectedModel.isEmpty) {
        final preferred = body['defaultModel'];
        final available = models.where((row) => row.supported).toList();
        if (available.isNotEmpty) {
          selectedModel = available.any((row) => row.name == preferred)
              ? preferred as String
              : available.first.name;
        }
      }
      if (!models.any((row) => row.supported)) {
        _modelError = '当前账号暂无支持普通聊天的模型，请检查模型服务协议与授权。';
        if (error.isEmpty) error = _modelError;
      }
    } catch (failure) {
      if (_current && request == _modelRequest) {
        _modelError = failure is ApiFailure
            ? failure.message
            : '暂时无法读取模型目录，请重试。';
        if (error.isEmpty) error = _modelError;
      }
    }
    _notify();
  }

  void selectModel(String name) {
    if (busy || (hasPending && !syncUnavailable) || !_current) {
      return;
    }
    GeneralChatModel? selected;
    for (final row in models) {
      if (row.name == name) selected = row;
    }
    if (selected == null || !selected.supported) {
      error = selected?.unavailableReason ?? '所选模型已不可用，请重新选择。';
    } else {
      selectedModel = name;
      error = '';
    }
    _notify();
  }

  Future<void> _restore(String cid, String sid) async {
    GeneralChatOutbox? box;
    if (sid.isNotEmpty) {
      box = await store.read(scope, sid);
      _check();
    } else if (cid.isNotEmpty) {
      final sessions = await store.pendingSessions(scope);
      _check();
      for (final session in sessions) {
        final value = await store.read(scope, session);
        _check();
        if (value?.conversationId == cid) {
          box = value;
          break;
        }
      }
    }
    _history.clear();
    _live = null;
    if (box != null) {
      if (cid.isNotEmpty &&
          box.conversationId.isNotEmpty &&
          box.conversationId != cid) {
        throw const ApiFailure('待同步内容与当前会话不匹配，已停止恢复。', status: 409);
      }
      sourceSessionId = box.sourceSessionId;
      sourceEpoch = box.sourceEpoch;
      conversationId = box.conversationId;
      selectedModel = box.selectedModel;
      _sourceRevision = box.batches.first.revision - 1;
      _pending
        ..clear()
        ..addAll(box.batches);
      await _serial(_flush);
      _check();
      cid = conversationId;
    }
    if (cid.isEmpty) {
      if (sid.isNotEmpty && box == null && sid != sourceSessionId) {
        throw const ApiFailure('请从会话目录打开已有聊天，不能重建未知来源。', status: 409);
      }
      if (sourceSessionId.isEmpty) {
        sourceSessionId = 'mobile-chat:${generalChatId()}';
        sourceEpoch = generalChatId();
      }
      return;
    }
    final head = await loadSource(cid);
    _check();
    final metadata = _source(head, cid);
    final epoch = head['sourceEpoch'] as String;
    final revision = head['sourceRevision'] as int;
    if (sourceEpoch.isNotEmpty && sourceEpoch != epoch ||
        _sourceRevision > 0 && _sourceRevision != revision) {
      throw const ApiFailure('会话来源版本已变化，请保留待同步内容并重新打开。', status: 409);
    }
    sourceSessionId = metadata['sourceSessionId'] as String;
    sourceEpoch = epoch;
    conversationId = cid;
    _sourceRevision = revision;
    title = metadata['title'] is String ? metadata['title'] as String : '新对话';
    var cursor = 0;
    while (true) {
      final page = await loadMessages(cid, cursor);
      _check();
      if (page['items'] is! List ||
          page['cursor'] is! int ||
          page['hasMore'] is! bool ||
          page['conversation'] is! Map ||
          (page['conversation'] as Map)['id'] != cid) {
        throw const ApiFailure('聊天记录响应不完整，请刷新重试。');
      }
      var previous = cursor;
      for (final raw in page['items'] as List) {
        final row = Map<String, dynamic>.from(raw as Map);
        if (row['revision'] is! int || (row['revision'] as int) <= previous) {
          throw const ApiFailure('聊天记录版本顺序异常。');
        }
        previous = row['revision'] as int;
        final message = GeneralChatMessage.fromJson(row);
        _history[message.id] = message;
      }
      if (page['cursor'] != previous ||
          page['hasMore'] == true && previous == cursor) {
        throw const ApiFailure('聊天记录分页未前进。');
      }
      cursor = previous;
      _validateHistory();
      if (page['hasMore'] != true) {
        break;
      }
    }
    final latest = await loadSource(cid);
    _check();
    _source(latest, cid);
    if (latest['sourceEpoch'] != epoch ||
        latest['sourceRevision'] != revision) {
      throw const ApiFailure('读取期间会话已被其他页面修改，请重新打开。', status: 409);
    }
    interrupted = {
      'responding',
      'interrupted',
      'stopped',
      'failed',
    }.contains(metadata['state']);
    if (interrupted && error.isEmpty) error = '上次回复已停止或中断，已保留收到的文字，不会自动重新请求模型。';
  }

  Map<String, dynamic> _source(Map<String, dynamic> body, String cid) {
    final raw = body['conversation'];
    if (raw is! Map ||
        raw['id'] != cid ||
        raw['sourceClientId'] != scope.deviceId ||
        raw['deleted'] == true ||
        raw['sourceSessionId'] is! String ||
        !(raw['sourceSessionId'] as String).startsWith('mobile-chat:') ||
        body['sourceEpoch'] is! String ||
        (body['sourceEpoch'] as String).isEmpty ||
        body['sourceRevision'] is! int ||
        (body['sourceRevision'] as int) < 1) {
      throw const ApiFailure('这条会话不是当前手机创建的普通聊天，不能从这里继续写入。', status: 409);
    }
    return Map<String, dynamic>.from(raw);
  }

  void _validateHistory([GeneralChatMessage? addition]) {
    final rows = [..._contextRows, ?addition];
    if (rows.length > 1000 ||
        rows.fold<int>(0, (n, row) => n + utf8.encode(row.text).length) >
            4 * 1024 * 1024) {
      throw const ApiFailure('会话正文超过移动端读取上限，请在来源设备查看完整记录。');
    }
    if (rows.map((row) => row.position).toSet().length != rows.length) {
      throw const ApiFailure('聊天消息位置重复，已停止写入。', status: 409);
    }
  }

  void _validateContext([GeneralChatMessage? addition]) {
    final rows = [..._contextRows.where((row) => !row.deleted), ?addition];
    if (rows.length > 200 ||
        utf8
                .encode(jsonEncode(rows.map((row) => row.toModel()).toList()))
                .length >
            128 * 1024) {
      throw const ApiFailure('聊天上下文超过200条或128KiB，请新建会话；历史内容未截断。');
    }
  }

  int get _nextPosition =>
      _contextRows.fold<int>(
        -1,
        (n, row) => row.position > n ? row.position : n,
      ) +
      1;

  Future<bool> send(String text) async {
    if (!canSend || text.trim().isEmpty) {
      return false;
    }
    error = '';
    _sendBusy = true;
    _notify();
    final row = GeneralChatMessage(
      id: '$sourceSessionId:user:${generalChatId()}',
      position: _nextPosition,
      role: 'user',
      text: text.trim(),
      createdAt: DateTime.now().toUtc().toIso8601String(),
    );
    var durable = false;
    try {
      if (row.text.length > 200000) {
        throw const ApiFailure('单条消息超过文字上限，请拆分后发送。');
      }
      if (syncUnavailable && _contextRows.length >= 98) {
        throw const ApiFailure('这段聊天尚未同步，记录较多，请新建会话继续；已有记录仍保存在此设备。');
      }
      _validateContext(row);
      _validateHistory(row);
      if (_contextRows.isEmpty) {
        title = String.fromCharCodes(row.text.runes.take(80));
      }
      await _serial(() async {
        await _stage('user', 'awaiting_reply', [row]);
        durable = true;
        await _flush();
      });
    } catch (failure) {
      if (_current) _setError(failure);
    } finally {
      _sendBusy = false;
      // Reserve the reply synchronously before notifying the host that the
      // user's draft was accepted; no listener can enqueue a second user turn
      // between the durable receipt and the streaming state.
      if (durable &&
          (!hasPending || syncUnavailable) &&
          !conflict &&
          _current) {
        unawaited(
          answer().catchError((Object failure) {
            if (_current) _setError(failure);
          }),
        );
      }
      _notify();
    }
    return durable;
  }

  Future<void> get replyCompleted => _replyFuture ?? Future.value();

  Future<void> answer() {
    if (!canAnswer) {
      return Future.value();
    }
    final operation = _runReply();
    _replyFuture = operation;
    return operation.whenComplete(() {
      if (identical(_replyFuture, operation)) {
        _replyFuture = null;
        _notify();
      }
    });
  }

  Future<void> _runReply() async {
    final chosen = selectedModel;
    streaming = true;
    interrupted = false;
    _stopRequested = false;
    _syncFailed = false;
    error = '';
    _lastCheckpoint = '';
    _live = GeneralChatMessage(
      id: '$sourceSessionId:assistant:${generalChatId()}',
      position: _nextPosition,
      role: 'assistant',
      text: '',
      createdAt: DateTime.now().toUtc().toIso8601String(),
    );
    _notify();
    var state = 'completed';
    try {
      _validateContext();
      final config = await loadConfig(chosen);
      _check();
      if (_stopRequested) {
        throw const GeneralChatTransportFailure('回复已停止。', code: 'stopped');
      }
      if (config['ok'] != true ||
          config['key'] is! String ||
          (config['key'] as String).isEmpty ||
          config['model'] != chosen) {
        throw const ApiFailure('所选模型授权不可用或模型已变化，请重新检查模型配置。');
      }
      _transport = transportFactory();
      final context = _contextRows.where((row) => !row.deleted).toList()
        ..sort((a, b) => a.position.compareTo(b.position));
      final maximum = config['maxOutputTokens'];
      final tokens = maximum is int && maximum > 0 && maximum < 4096
          ? maximum
          : 4096;
      await for (final delta in _transport!.stream(
        endpoint: scope.endpoint,
        ticket: config['key'] as String,
        model: chosen,
        messages: context.map((row) => row.toModel()).toList(),
        maxTokens: tokens,
      )) {
        _check();
        _live = _live!.withText(_live!.text + delta);
        _notify();
        _scheduleCheckpoint();
      }
    } catch (failure) {
      if (!_current) {
        return;
      }
      state = _stopRequested ? 'stopped' : 'interrupted';
      interrupted = true;
      if (!_stopRequested && !_syncFailed) _setError(failure);
    } finally {
      _checkpointTimer?.cancel();
      _checkpointTimer = null;
      _transport?.abort();
      _transport = null;
      streaming = false;
      if (_current) {
        try {
          await _serial(() async {
            final row = _live;
            await _stage(
              'final',
              state,
              row != null && row.text.isNotEmpty ? [row] : [],
            );
            if (!_syncFailed) await _flush();
          });
        } catch (failure) {
          if (_current) _setError(failure);
        }
      }
      _notify();
    }
  }

  void _scheduleCheckpoint() {
    if (_checkpointTimer != null ||
        saving ||
        (hasPending && !syncUnavailable) ||
        !streaming) {
      return;
    }
    _checkpointTimer = Timer(checkpointInterval, () {
      _checkpointTimer = null;
      if (!_current ||
          !streaming ||
          saving ||
          (hasPending && !syncUnavailable) ||
          _live == null ||
          _live!.text == _lastCheckpoint) {
        return;
      }
      final row = _live!;
      unawaited(
        _serial(() async {
          try {
            await _stage('checkpoint', 'responding', [row]);
            await _flush();
            _lastCheckpoint = row.text;
          } catch (failure) {
            if (_current) {
              _setError(failure);
              _transport?.abort();
            }
          }
        }),
      );
    });
  }

  Future<void> stop() async {
    _stopRequested = true;
    _transport?.abort();
    await _replyFuture;
  }

  Future<void> retryPending() async {
    if (!_current || busy || conflict || !hasPending) {
      return;
    }
    error = '';
    _syncFailed = false;
    syncUnavailable = false;
    try {
      await _serial(_flush);
    } catch (failure) {
      if (_current) _setError(failure);
    }
    _notify();
  }

  Future<T> _serial<T>(Future<T> Function() action) {
    final next = _syncTail.then((_) => action());
    _syncTail = next.then<void>(
      (_) {},
      onError: (Object error, StackTrace stack) {},
    );
    return next;
  }

  GeneralChatOutbox _box([List<GeneralChatBatch>? rows, String? cid]) =>
      GeneralChatOutbox(
        sourceSessionId: sourceSessionId,
        sourceEpoch: sourceEpoch,
        conversationId: cid ?? conversationId,
        selectedModel: selectedModel,
        batches: List.unmodifiable(rows ?? _pending),
      );

  List<GeneralChatMessage> get _contextRows {
    final rows = {..._history};
    for (final batch in _pending) {
      for (final row in batch.messages) {
        rows[row.id] = row;
      }
    }
    return rows.values.toList()
      ..sort((a, b) => a.position.compareTo(b.position));
  }

  Future<void> _stage(
    String purpose,
    String state,
    List<GeneralChatMessage> rows,
  ) async {
    _check();
    if (syncUnavailable) {
      final all = {
        for (final row in _contextRows) row.id: row,
        for (final row in rows) row.id: row,
      };
      if (all.length > 100) throw const ApiFailure('待同步记录较多，请新建会话继续。');
      final combined = all.values.toList()
        ..sort((a, b) => a.position.compareTo(b.position));
      final batch = GeneralChatBatch(
        purpose: purpose,
        body: {
          'sourceSessionId': sourceSessionId,
          'sourceEpoch': sourceEpoch,
          'sourceRevision': _sourceRevision + 1,
          'title': title,
          'state': state,
          'archived': false,
          'deleted': false,
          'messages': combined.map((row) => row.toSync()).toList(),
        },
      );
      // Save before accepting the new stage. Failed persistence leaves the old
      // queue intact and prevents the model call, exactly as online mode does.
      await store.write(scope, _box([batch]));
      _check();
      _pending
        ..clear()
        ..add(batch);
      return;
    }
    if (_pending.length >= 2) {
      throw const ApiFailure('已有待确认回复，请先重试原同步批次。');
    }
    final batch = GeneralChatBatch(
      purpose: purpose,
      body: {
        'sourceSessionId': sourceSessionId,
        'sourceEpoch': sourceEpoch,
        'sourceRevision': _sourceRevision + _pending.length + 1,
        'title': title,
        'state': state,
        'archived': false,
        'deleted': false,
        'messages': rows.map((row) => row.toSync()).toList(),
      },
    );
    _pending.add(batch);
    saving = true;
    _notify();
    try {
      await store.write(scope, _box());
      _check();
    } catch (_) {
      _pending.remove(batch);
      rethrow;
    } finally {
      saving = false;
      _notify();
    }
  }

  Future<void> _flush() async {
    if (syncUnavailable) return;
    saving = true;
    _notify();
    try {
      while (_pending.isNotEmpty) {
        _check();
        final batch = _pending.first;
        Map<String, dynamic> receipt;
        try {
          receipt = await publish(batch.body);
        } on ApiFailure catch (failure) {
          if ((failure.status == 404 || failure.status == 405) &&
              conversationId.isEmpty &&
              _sourceRevision == 0) {
            _check();
            syncUnavailable = true;
            _syncFailed = false;
            return;
          }
          rethrow;
        }
        _check();
        final cid = receipt['conversationId'];
        if (receipt['ok'] != true ||
            receipt['sourceRevision'] != batch.revision ||
            cid is! String ||
            cid.isEmpty ||
            conversationId.isNotEmpty && cid != conversationId) {
          throw const ApiFailure('会话同步回执未确认，请重试原批次。');
        }
        final remaining = _pending.skip(1).toList();
        if (remaining.isEmpty) {
          await store.remove(scope, sourceSessionId);
        } else {
          await store.write(scope, _box(remaining, cid));
        }
        _check();
        _pending.removeAt(0);
        _sourceRevision = batch.revision;
        conversationId = cid;
        for (final row in batch.messages) {
          _history[row.id] = row;
        }
        try {
          onConversationSaved(cid);
        } catch (_) {
          /* Hub save is still confirmed. */
        }
      }
      _syncFailed = false;
    } catch (_) {
      _syncFailed = true;
      rethrow;
    } finally {
      saving = false;
      _notify();
    }
  }

  void _setError(Object failure) {
    if (failure is ApiFailure) {
      error = failure.message;
      if (failure.status == 409) conflict = true;
    } else if (failure is FormatException) {
      error = failure.message;
    } else {
      error = '聊天内容未能安全保存或连接中断，请保留当前页面并重试同步。';
    }
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _checkpointTimer?.cancel();
    _transport?.abort();
    super.dispose();
  }
}

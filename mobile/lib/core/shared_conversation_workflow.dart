import 'dart:convert';
import 'work_submission_store.dart';
import 'soduwork_api.dart' show ApiFailure;

typedef WorkflowMap = Map<String, dynamic>;
typedef WorkflowLookup = Future<WorkflowMap> Function(String id);

/// Existing Task/run receipts remain authoritative; a node is not a whole run.
class SharedConversationWorkflow {
  final String scope;
  final void Function() check;
  final WorkflowLookup catalog, status, listRuns, getRun, cancelRun;
  final Future<WorkflowMap> Function(String id, WorkflowMap body) submit;
  final Future<WorkflowMap> Function(String taskId, String ref, int since)
  pollSession;
  final WorkSubmissionStore store;
  final Map<String, String> _runs = {};
  Future<WorkflowMap>? _starting;
  String _startFingerprint = '';
  SharedConversationWorkflow({
    required this.scope,
    required this.check,
    required this.catalog,
    required this.submit,
    required this.status,
    required this.listRuns,
    required this.getRun,
    required this.pollSession,
    required this.cancelRun,
    WorkSubmissionStore? store,
  }) : store = store ?? WorkSubmissionStore();

  static WorkflowMap _map(Object? value) =>
      value is Map ? Map<String, dynamic>.from(value) : <String, dynamic>{};
  static String _text(Object? value) => value is String ? value : '';
  static List<WorkflowMap> _rows(Object? value) => value is List
      ? value
            .whereType<Map>()
            .map((row) => Map<String, dynamic>.from(row))
            .toList()
      : [];
  static String _canonical(Object? value) {
    Object? ordered(Object? item) {
      if (item is Map) {
        final keys = item.keys.cast<String>().toList()..sort();
        return {for (final key in keys) key: ordered(item[key])};
      }
      if (item is List) return item.map(ordered).toList();
      return item;
    }

    return jsonEncode(ordered(value));
  }

  static Object? _publicValue(Object? value, [int depth = 0]) {
    if (depth > 6) return '[内容过深，已省略]';
    if (value is String) {
      return value.length > 20000 ? '${value.substring(0, 20000)}…' : value;
    }
    if (value is List) {
      return value
          .take(100)
          .map((item) => _publicValue(item, depth + 1))
          .toList();
    }
    if (value is Map) {
      final out = <String, dynamic>{};
      for (final entry in value.entries.take(100)) {
        final key = entry.key.toString();
        final normalized = key.toLowerCase().replaceAll(RegExp('[^a-z]'), '');
        if ([
          'authorization',
          'password',
          'secret',
          'token',
          'apikey',
          'credential',
          'mcpgrant',
        ].any(normalized.contains)) {
          continue;
        }
        out[key] = _publicValue(entry.value, depth + 1);
      }
      return out;
    }
    return value == null || value is bool || value is num ? value : null;
  }

  static WorkflowMap _publicRun(WorkflowMap run) => {
    for (final key in [
      'id',
      'taskId',
      'state',
      'name',
      'error',
      'createdAt',
      'startedAt',
      'finishedAt',
    ])
      if (run.containsKey(key)) key: _publicValue(run[key]),
    'output': _publicValue(run['output']),
    'input': {
      if (_map(run['input'])['instruction'] is String)
        'instruction': _map(run['input'])['instruction'],
    },
    'nodes': _rows(run['nodes'])
        .take(100)
        .map(
          (node) => <String, dynamic>{
            for (final key in [
              'id',
              'key',
              'name',
              'type',
              'state',
              'attempt',
              'error',
              'createdAt',
              'startedAt',
              'finishedAt',
            ])
              if (node.containsKey(key)) key: _publicValue(node[key]),
            'output': _publicValue(node['output']),
            'executor': {
              'ref': _text(_map(node['executor'])['ref']),
              'resolved': {
                for (final key in ['agentKind', 'model'])
                  if (_map(_map(node['executor'])['resolved']).containsKey(key))
                    key: _map(_map(node['executor'])['resolved'])[key],
              },
            },
          },
        )
        .toList(),
  };

  Future<WorkflowMap> start({
    required String requestId,
    required String instruction,
    required List<WorkflowMap> plugins,
    String projectId = '',
  }) {
    check();
    final fingerprint = _canonical({
      'instruction': instruction,
      'plugins': plugins,
      'projectId': projectId,
    });
    if (_starting != null) {
      if (_startFingerprint != fingerprint) {
        throw const FormatException('上一笔工作尚未确认，请保留原内容核对。');
      }
      return _starting!;
    }
    _startFingerprint = fingerprint;
    final operation = _start(requestId, instruction, plugins, projectId);
    _starting = operation;
    return operation.whenComplete(() {
      _starting = null;
    });
  }

  Future<WorkflowMap> _start(
    String requestId,
    String instruction,
    List<WorkflowMap> plugins,
    String projectId,
  ) async {
    if (scope.isEmpty ||
        !RegExp(r'^[A-Za-z0-9-]{1,80}$').hasMatch(requestId) ||
        instruction.trim().isEmpty ||
        instruction.length > 100000 ||
        instruction.contains(String.fromCharCode(0)) ||
        projectId.length > 64 ||
        plugins.length != 1) {
      throw const FormatException('请选择一个工作流并填写有效需求。');
    }
    final selected = plugins.single;
    final pluginId = _text(selected['pluginId']),
        version = _text(selected['version']);
    if (pluginId.isEmpty || pluginId.length > 64 || version.isEmpty) {
      throw const FormatException('插件信息不完整，请刷新目录后选择。');
    }
    if (selected['inputValues'] != null && selected['inputValues'] is! Map) {
      throw const FormatException('工作流参数必须是结构化字段。');
    }
    final input = _map(selected['inputValues']);
    if (input.length > 50 ||
        input.entries.any(
          (entry) =>
              !RegExp(r'^[A-Za-z][A-Za-z0-9_-]{0,63}$').hasMatch(entry.key) ||
              !(entry.value == null ||
                  entry.value is String ||
                  entry.value is bool ||
                  entry.value is num) ||
              entry.value is num && !(entry.value as num).isFinite ||
              entry.value is String &&
                  ((entry.value as String).length > 8000 ||
                      (entry.value as String).contains(String.fromCharCode(0))),
        )) {
      throw const FormatException('工作流参数格式或大小不正确。');
    }
    final pending = await store.load(scope);
    check();
    if (pending != null &&
        (pending.kind != 'workflow' ||
            pending.payload['instruction'] != instruction ||
            pending.payload['projectId'] != projectId ||
            _canonical(pending.payload['inputs']) != _canonical(input))) {
      throw const FormatException('还有一笔工作待核对，请保留原内容。');
    }
    final directory = await catalog(projectId);
    check();
    final matches = _rows(
      directory['items'],
    ).where((row) => row['pluginId'] == pluginId).toList();
    if (matches.length != 1) {
      throw const FormatException('插件绑定不唯一或已不可用，请刷新目录后核对。');
    }
    final binding = matches.single;
    if (binding['runnable'] != true ||
        _map(binding['capabilities'])['hasWorkflow'] != true ||
        _text(binding['bindingId']).isEmpty ||
        binding['version'] != version) {
      throw const FormatException('工作流已更新或暂不可执行，请重新查看目录。');
    }
    final body = <String, dynamic>{
      'bindingId': binding['bindingId'],
      'inputs': input,
      'instruction': instruction,
      'projectId': projectId,
    };
    if (pending != null && _canonical(pending.payload) != _canonical(body)) {
      throw const FormatException('插件或参数已变化，不能覆盖待确认提交。');
    }
    final submission =
        pending ??
        WorkSubmission(
          id: requestId,
          kind: 'workflow',
          label: _text(binding['name']),
          payload: body,
        );
    if (pending != null) {
      try {
        final known = await status(pending.id);
        check();
        return await _receipt(pending.id, known);
      } on ApiFailure catch (failure) {
        check();
        if (failure.status != 404) rethrow;
      }
    }
    await store.save(scope, submission);
    check();
    final receipt = await submit(submission.id, submission.payload);
    check();
    return _receipt(submission.id, receipt);
  }

  Future<WorkflowMap> _receipt(String requestId, WorkflowMap receipt) async {
    final taskId = _text(receipt['taskId']), runId = _text(receipt['runId']);
    if (receipt['ok'] != true ||
        receipt['requestId'] != requestId ||
        taskId.isEmpty ||
        !{'started', 'pending'}.contains(receipt['phase'])) {
      throw const FormatException('工作回执尚未核实，请使用原请求核对。');
    }
    if (receipt['phase'] == 'started') {
      if (runId.isEmpty) throw const FormatException('工作流缺少运行回执。');
      final run = _map(receipt['run']);
      if (run.isNotEmpty) _verifyRun(run, taskId, runId);
      _runs[taskId] = runId;
      await store.clear(scope, requestId);
      check();
    }
    return {
      'ok': true,
      'workflow': true,
      'requestId': requestId,
      'taskId': taskId,
      'runId': runId,
      'phase': receipt['phase'],
      'run': _map(receipt['run']).isEmpty
          ? null
          : _publicRun(_map(receipt['run'])),
    };
  }

  void _verifyRun(WorkflowMap run, String taskId, String runId) {
    if (runId.isEmpty ||
        run['id'] != runId ||
        run['taskId'] != taskId ||
        _text(run['state']).isEmpty) {
      throw const FormatException('工作流记录与当前对话不一致。');
    }
  }

  Future<WorkflowMap> poll({
    required String taskId,
    String runId = '',
    String requestId = '',
    Map<String, int> since = const {},
  }) async {
    check();
    if (taskId.isEmpty) throw const FormatException('请先确认本次工作的任务回执。');
    if (runId.isEmpty && requestId.isNotEmpty) {
      final receipt = await status(requestId);
      check();
      if (receipt['taskId'] != taskId) {
        throw const FormatException('工作回执归属不一致。');
      }
      final confirmed = await _receipt(requestId, receipt);
      runId = _text(confirmed['runId']);
      if (runId.isEmpty) {
        return {...confirmed, 'run': null, 'sessions': <Object>[]};
      }
    }
    runId = runId.isEmpty ? (_runs[taskId] ?? '') : runId;
    if (runId.isEmpty) {
      final listed = await listRuns(taskId);
      check();
      if (listed['items'] is! List) {
        throw const FormatException('工作流列表返回格式不正确，请稍后重试。');
      }
      final rows = _rows(listed['items']);
      if (rows.isEmpty) {
        return {'ok': true, 'workflow': false, 'taskId': taskId};
      }
      final latest = rows.first;
      runId = _text(latest['id']);
      _verifyRun(latest, taskId, runId);
    }
    final run = await getRun(runId);
    check();
    _verifyRun(run, taskId, runId);
    if (run['nodes'] is! List) {
      throw const FormatException('工作流节点返回格式不正确，请稍后重试。');
    }
    _runs[taskId] = runId;
    final nodes = _rows(run['nodes'])
        .take(100)
        .where(
          (node) =>
              _text(node['id']).isNotEmpty &&
              _text(_map(node['executor'])['ref']).isNotEmpty,
        )
        .toList();
    final sessions = <WorkflowMap>[];
    for (var start = 0; start < nodes.length && start < 100; start += 4) {
      final replies = await Future.wait(
        nodes.skip(start).take(4).map((node) async {
          final ref = _text(_map(node['executor'])['ref']);
          final key = '${_text(node['id'])}:$ref';
          try {
            final page = await pollSession(
              taskId,
              ref,
              (since[key] ?? 0).clamp(0, 1 << 53),
            );
            check();
            if (page['ok'] == false) {
              throw FormatException(
                _text(page['error']).isEmpty
                    ? '节点日志暂不可用'
                    : _text(page['error']),
              );
            }
            if (page['ref'] != null && page['ref'] != ref ||
                page['taskId'] != null && page['taskId'] != taskId) {
              throw const FormatException('节点执行记录归属不一致。');
            }
            return <String, dynamic>{
              'key': key,
              'nodeId': node['id'],
              'ref': ref,
              'page': {
                for (final key in [
                  'ok',
                  'ref',
                  'taskId',
                  'engine',
                  'model',
                  'status',
                  'last',
                  'items',
                ])
                  if (page.containsKey(key))
                    key: key == 'items'
                        ? _rows(page[key]).map(_publicValue).toList()
                        : _publicValue(page[key]),
              },
            };
          } catch (error) {
            check();
            return <String, dynamic>{
              'key': key,
              'nodeId': node['id'],
              'ref': ref,
              'error': error is FormatException
                  ? error.message
                  : error.toString(),
            };
          }
        }),
      );
      check();
      sessions.addAll(replies);
    }
    return {
      'ok': true,
      'workflow': true,
      'taskId': taskId,
      'runId': runId,
      'requestId': requestId,
      'phase': 'started',
      'run': _publicRun(run),
      'sessions': sessions,
      'sessionsTruncated': _rows(run['nodes']).length > 100,
    };
  }

  Future<WorkflowMap> cancel({
    required String taskId,
    required String runId,
  }) async {
    check();
    if (taskId.isEmpty || runId.isEmpty) {
      throw const FormatException('工作回执尚未确认，暂不能结束流程。');
    }
    final before = await getRun(runId);
    check();
    _verifyRun(before, taskId, runId);
    final reply = await cancelRun(runId);
    check();
    if (reply['ok'] != true) {
      throw FormatException(
        _text(reply['reason']).isEmpty ? '流程未能结束' : _text(reply['reason']),
      );
    }
    final run = _map(reply['run']);
    if (run.isNotEmpty) _verifyRun(run, taskId, runId);
    return {
      'ok': true,
      'workflow': true,
      'taskId': taskId,
      'runId': runId,
      'run': _publicRun(run),
    };
  }
}

import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:image_picker/image_picker.dart';
import 'artifact_download.dart';
import 'automation_chat_host.dart';
import 'automation_execution_directory.dart';
import 'soduwork_api.dart';

/// Hosts the unmodified desktop confirmation forms. Only Hub receipts authorize
/// completion; a local card identifier never grants access to another task.
class SharedWorkFormHost {
  final SoduWorkApi api;
  final String identity;
  final void Function() check;
  final bool Function(String) sourceAllowed;
  final Future<void> Function(String kind, String id) open;
  final _automations = <String, AutomationChatHost>{};
  final _requests = <String, (String, Future<Map<String, dynamic>>)>{};
  final _createdRequirements = <String>{};
  final _uploads = <String, Future<Map<String, dynamic>>>{};

  SharedWorkFormHost({
    required this.api,
    required this.identity,
    required this.check,
    required this.sourceAllowed,
    required this.open,
  });

  String _string(dynamic value) => value is String ? value : '';
  Map<String, dynamic> _map(dynamic value) =>
      value is Map ? Map<String, dynamic>.from(value) : {};
  String _id(dynamic value) {
    final id = _string(value);
    if (!RegExp(r'^[A-Za-z0-9_-]{3,36}$').hasMatch(id)) {
      throw const ApiFailure('需求编号不正确，请重新打开表单。');
    }
    return id;
  }

  Future<Object?> handle(Map<String, dynamic> args) async {
    check();
    final cardId = _string(args['cardId']);
    if (cardId.isEmpty || cardId.length > 160) {
      throw const ApiFailure('表单编号不正确，请重新打开。');
    }
    final operation = _string(args['operation']);
    Object? result;
    switch (operation) {
      case 'parseRequirement':
        final text = _string(args['text']);
        if (text.trim().isEmpty || text.length > 100000) {
          throw const ApiFailure('请描述需求，内容不能超过 100000 个字符。');
        }
        final attachments = args['attachments'];
        if (attachments != null &&
            (attachments is! List || attachments.length > 16)) {
          throw const ApiFailure('需求材料不正确，每次最多 16 个文件。');
        }
        result = await api.parseRequirement(
          text,
          model: _string(args['model']),
          instruction: _string(args['instruction']),
          attachments: attachments is List
              ? attachments
                    .whereType<Map>()
                    .map((v) => Map<String, dynamic>.from(v))
                    .toList()
              : const [],
        );
      case 'executionOptions':
        result = await loadAutomationExecutionDirectory(api);
      case 'parseAutomation':
      case 'preflightAutomation':
      case 'createAutomation':
        final host = _automations.putIfAbsent(
          cardId,
          () => AutomationChatHost(
            api: api,
            identity: identity,
            dark: false,
            checkCurrent: check,
            onClose: () {},
          ),
        );
        final method = {
          'parseAutomation': 'parse',
          'preflightAutomation': 'preflight',
          'createAutomation': 'create',
        }[operation]!;
        result = await host.handle(
          method,
          operation == 'parseAutomation' ? args : _map(args['body']),
        );
      case 'createRequirement':
        result = await _create(cardId, _map(args['body']));
      case 'resumeRequirement':
        final id = _id(args['id']);
        final task = await api.taskData(id);
        check();
        if (task['id'] != id) throw const ApiFailure('需求回执编号不匹配，请重新打开。');
        _createdRequirements.add('$cardId:$id');
        result = task;
      case 'uploadRequirementAttachment':
        result = await _upload(cardId, args);
      case 'openRequirement':
        final id = _id(args['id']);
        await api.taskData(id);
        check();
        await open('requirement', id);
        result = {'ok': true};
      case 'openAutomation':
        final id = _id(args['id']);
        final schedules = await api.automations();
        if (!schedules.any((item) => item.id == id)) {
          throw const ApiFailure('此自动化已不可用，请刷新列表。', status: 404);
        }
        check();
        await open('automation', id);
        result = {'ok': true};
      default:
        throw const ApiFailure('此表单操作尚不支持。');
    }
    check();
    return result;
  }

  Future<Map<String, dynamic>> _create(
    String cardId,
    Map<String, dynamic> input,
  ) async {
    final id = _id(input['id'] ?? input['taskId']);
    final title = _string(input['title']).trim(), note = _string(input['note']);
    if (title.isEmpty || title.length > 200 || note.length > 50000) {
      throw const ApiFailure('标题需为 1 至 200 字，详细说明最多 50000 字。');
    }
    const allowed = {
      'title',
      'note',
      'priority',
      'due',
      'start',
      'kind',
      'acceptanceCriteria',
      'tags',
      'visibility',
      'triageStage',
      'projectId',
      'repoId',
      'source',
    };
    final body = <String, dynamic>{
      for (final entry in input.entries)
        if (allowed.contains(entry.key)) entry.key: entry.value,
      'title': title,
      'note': note,
      'status': 'todo',
      'handler': 'me',
    };
    for (final key in ['start', 'due']) {
      if (body[key] == '' || body[key] == null) body.remove(key);
    }
    final assignee = _string(input['assigneeUserId']);
    final fingerprint = jsonEncode([body, assignee]);
    final key = '$cardId:$id';
    final previous = _requests[key];
    if (previous != null) {
      if (previous.$1 != fingerprint) {
        throw const ApiFailure('这次保存已发起，请先核对原需求，不能用同一编号提交不同内容。');
      }
      return previous.$2;
    }
    Future<Map<String, dynamic>> send() async {
      Map<String, dynamic> task;
      Map<String, dynamic>? assigned;
      if (assignee.isNotEmpty) {
        assigned = await api.createAssignedRequirement({
          ...body,
          'taskId': id,
          'assigneeUserId': assignee,
        });
        if (assigned['ok'] != true) {
          throw const ApiFailure('未收到有效的交办回执，请保留表单并核对。');
        }
        task = _map(assigned['task']);
      } else {
        try {
          // A retry must not reset an already started/completed requirement.
          task = await api.taskData(id);
        } on ApiFailure catch (error) {
          if (error.status != 404) rethrow;
          check();
          task = await api.putRequirement(id, body);
        }
      }
      check();
      if (task['id'] != id) throw const ApiFailure('需求保存回执不匹配，请在需求池核对。');
      _createdRequirements.add(key);
      return assigned == null ? task : {...assigned, 'task': task};
    }

    final pending = send();
    _requests[key] = (fingerprint, pending);
    try {
      return await pending;
    } catch (_) {
      _requests.remove(key);
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _upload(
    String cardId,
    Map<String, dynamic> args,
  ) async {
    final id = _id(args['id']);
    if (!_createdRequirements.contains('$cardId:$id')) {
      throw const ApiFailure('请先核对已保存的需求，再继续上传材料。');
    }
    final file = _map(args['file']);
    final source = _string(file['sourceTaskId']);
    final attachmentId = _string(file['attachmentId']);
    late XFile upload;
    if (source.isNotEmpty || attachmentId.isNotEmpty) {
      if (!sourceAllowed(source) || attachmentId.isEmpty) {
        throw const ApiFailure('此对话不能读取这份材料。', status: 403);
      }
      final rows = await api.taskAttachments(source);
      check();
      final matches = rows.where((row) => row['id'] == attachmentId);
      if (matches.length != 1) throw const ApiFailure('原材料已不可用，请重新选择。');
      final row = matches.single;
      final name = _string(row['filename']);
      final value = await ArtifactDownloader(api).downloadAttachment(
        attachmentId,
        filename: name,
        contentType: _string(row['contentType']),
        byteLimit: 24 * 1024 * 1024,
      );
      check();
      upload = XFile.fromData(value.bytes, name: name, path: name);
    } else {
      final name = _string(file['name']);
      final data = _string(file['data']);
      if (name.isEmpty ||
          name.length > 200 ||
          RegExp(r'[\\/\x00-\x1f]').hasMatch(name) ||
          data.length > 32 * 1024 * 1024) {
        throw const ApiFailure('文件名称或大小不正确。');
      }
      late final Uint8List bytes;
      try {
        bytes = base64Decode(data);
      } catch (_) {
        throw const ApiFailure('文件内容不完整，请重新选择。');
      }
      if (bytes.isEmpty || bytes.length > 24 * 1024 * 1024) {
        throw const ApiFailure('材料不能为空，且不能超过 24 MB。');
      }
      upload = XFile.fromData(bytes, name: name, path: name);
    }
    check();
    // A digest of full bytes prevents duplicate taps, including a retry after
    // another material failed; files with equal names but different bytes differ.
    final uploadKey = jsonEncode([
      cardId,
      id,
      upload.name,
      sha256.convert(await upload.readAsBytes()).toString(),
    ]);
    check();
    final old = _uploads[uploadKey];
    if (old != null) return old;
    final pending = api.uploadRequirementMaterial(id, upload);
    _uploads[uploadKey] = pending;
    try {
      final value = await pending;
      check();
      if (_string(value['id']).isEmpty) throw const ApiFailure('材料上传未收到有效回执。');
      return value;
    } catch (_) {
      _uploads.remove(uploadKey);
      rethrow;
    }
  }
}

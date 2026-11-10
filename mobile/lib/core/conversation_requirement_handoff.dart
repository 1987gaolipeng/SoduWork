import 'dart:async';
import 'dart:convert';

import 'package:image_picker/image_picker.dart';

import '../models/work_models.dart';
import 'soduwork_api.dart';

/// The exact, authorized result version selected by the user.
class ConversationRequirementSource {
  final String id;
  final String name;
  final int size;
  final num at;

  const ConversationRequirementSource({
    required this.id,
    required this.name,
    required this.size,
    required this.at,
  });
}

/// Owns one creation attempt and its confirmed material receipts.
/// The caller supplies an account/service guard and an authorized share reader.
/// It never dispatches a task or claims to synchronize PC working-card drafts.
class ConversationRequirementHandoff {
  final Future<WorkTask> Function(Map<String, dynamic>) createTask;
  final Future<Map<String, dynamic>> Function(String) readSource;
  final Future<Map<String, dynamic>> Function(String, XFile) upload;
  final void Function() check;
  final List<ConversationRequirementSource> sources;
  final Map<String, Map<String, dynamic>> _receipts = {};
  Future<WorkTask>? _running;
  WorkTask? _task;
  bool _uncertain = false;

  ConversationRequirementHandoff({
    required this.createTask,
    required this.readSource,
    required this.upload,
    required this.check,
    List<ConversationRequirementSource> sources = const [],
  }) : sources = List.unmodifiable(sources);

  WorkTask? get task => _task;
  bool get uncertain => _uncertain;
  bool get complete => _task != null && _receipts.length == sources.length;
  List<Map<String, dynamic>> get receipts => List.unmodifiable(
    _receipts.values.map((row) => Map<String, dynamic>.unmodifiable(row)),
  );

  Future<WorkTask> submit(Map<String, dynamic> payload) {
    if (_running != null) return _running!;
    final pending = _submit(payload);
    _running = pending;
    return pending.whenComplete(() => _running = null);
  }

  Future<WorkTask> _submit(Map<String, dynamic> payload) async {
    check();
    if (_uncertain) {
      throw const ApiFailure('创建结果尚未确认，请先到需求池核对，避免重复创建。');
    }
    _validateSelection();
    // Resolve every selected file before creating an otherwise empty task.
    // Retry fetches only remaining files and always rechecks their authorization.
    for (final source in sources) {
      if (_receipts.containsKey(source.id)) continue;
      check();
      final value = await readSource(source.id);
      check();
      _decode(source, value);
    }
    if (_task == null) {
      check();
      try {
        final saved = await createTask(Map<String, dynamic>.from(payload));
        if (saved.id.trim().isEmpty) {
          throw const ApiFailure('服务未确认需求编号。');
        }
        // Save evidence before the guard: an account switch cannot erase a
        // successful server write and turn retry into a second creation.
        _task = saved;
      } catch (error) {
        _uncertain = !_definiteRejection(error);
        rethrow;
      }
      check();
    }
    for (final source in sources) {
      if (_receipts.containsKey(source.id)) continue;
      check();
      // Recheck permission and version after creating the target task.
      final current = await readSource(source.id);
      check();
      final file = _decode(source, current);
      final value = await upload(_task!.id, file);
      if (value['ok'] == false ||
          value['id'] is! String ||
          (value['id'] as String).trim().isEmpty) {
        throw const ApiFailure('需求已保存，但服务未确认材料上传成功，请重试材料上传。');
      }
      _receipts[source.id] = Map<String, dynamic>.from(value);
      check();
    }
    check();
    return _task!;
  }

  void _validateSelection() {
    final ids = <String>{};
    var total = 0;
    if (sources.length > 32) throw const ApiFailure('一次最多带入 32 个成果。');
    for (final source in sources) {
      if (source.id.trim().isEmpty ||
          !ids.add(source.id) ||
          source.name.trim().isEmpty ||
          source.size <= 0 ||
          source.size > 20 * 1024 * 1024) {
        throw const ApiFailure('选中的成果信息不完整，请重新选择。');
      }
      total += source.size;
    }
    if (total > 24 * 1024 * 1024) {
      throw const ApiFailure('选中的成果合计不能超过 24 MB。');
    }
  }

  XFile _decode(
    ConversationRequirementSource source,
    Map<String, dynamic> value,
  ) {
    final data = value['data'];
    if (value['ok'] == false ||
        value['name'] != source.name ||
        value['size'] != source.size ||
        value['at'] != source.at ||
        data is! String ||
        data.length != ((source.size + 2) ~/ 3) * 4) {
      throw const ApiFailure('成果版本或访问权限已变化，请重新选择后创建需求。');
    }
    try {
      final bytes = base64Decode(data);
      if (bytes.length != source.size) throw const FormatException();
      // Native XFile derives name from path; bytes remain in memory.
      return XFile.fromData(bytes, name: source.name, path: source.name);
    } on FormatException {
      throw const ApiFailure('成果内容不完整，请重新读取。');
    }
  }

  bool _definiteRejection(Object error) =>
      error is ApiFailure &&
      const {400, 401, 403, 404, 422}.contains(error.status);
}

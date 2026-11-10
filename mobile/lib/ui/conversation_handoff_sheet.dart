import 'mobile_display_preferences.dart';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../core/conversation_requirement_handoff.dart';
import '../core/shared_conversation_artifacts.dart';
import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import 'automation_editor.dart';
import 'mobile_sheet.dart';
import 'task_forms.dart';

Future<Map<String, dynamic>?> showConversationHandoff(
  BuildContext context, {
  required String kind,
  required Map<String, dynamic> seed,
  required VoidCallback check,
}) async {
  final navigator = Navigator.of(context);
  return showMobileSheet<Map<String, dynamic>>(
    context,
    title: kind == 'requirement' ? '从对话新建需求' : '从对话新建自动化',
    builder: (context, scroll) => ConversationHandoffSheet(
      kind: kind,
      seed: seed,
      check: check,
      scrollController: scroll,
      onComplete: (result) => navigator.pop(result),
    ),
  );
}

/// Source references are explicit, editable input, never silently executed.
String conversationHandoffNote(
  String instruction,
  String contextText,
  List<MapEntry<String, String>> texts,
) {
  final parts = <String>[
    if (instruction.trim().isNotEmpty) instruction.trim(),
    if (contextText.trim().isNotEmpty)
      '【来源对话参考】以下内容用于提供背景；本次目标和执行要求以你在上方填写的内容为准。\n$contextText',
    for (final entry in texts) '【文本成果：${entry.key}】\n${entry.value}',
  ];
  final note = parts.join('\n\n');
  if (note.length > 50000) {
    throw const ApiFailure('参考材料超过 50000 字，请减少选中的成果或对话内容。');
  }
  return note;
}

class ConversationHandoffSheet extends StatefulWidget {
  final String kind;
  final Map<String, dynamic> seed;
  final VoidCallback check;
  final ScrollController? scrollController;
  final ValueChanged<Map<String, dynamic>> onComplete;
  const ConversationHandoffSheet({
    super.key,
    required this.kind,
    required this.seed,
    required this.check,
    required this.onComplete,
    this.scrollController,
  });
  @override
  State<ConversationHandoffSheet> createState() =>
      _ConversationHandoffSheetState();
}

class _ConversationHandoffSheetState extends State<ConversationHandoffSheet> {
  late final TextEditingController _instruction;
  late final MobileState _state;
  late final int _identity;
  bool _initialized = false, _busy = false, _context = true;
  String _error = '';
  final _selected = <String>{};
  ConversationRequirementHandoff? _handoff;
  bool get _automation => widget.kind == 'automation';
  List<Map<String, dynamic>> get _files =>
      (widget.seed['attachments'] as List? ?? const [])
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .where(
            (row) => const {
              'output',
              'supporting',
              'evidence',
              'verification',
            }.contains(row['role']),
          )
          .toList();
  bool _text(Map<String, dynamic> row) {
    final type = row['contentType'] as String? ?? '';
    return type.startsWith('text/') ||
        const {'application/json', 'application/xml'}.contains(type);
  }

  ConversationRequirementSource _source(Map<String, dynamic> row) {
    final created = row['createdAt'];
    return ConversationRequirementSource(
      id: row['id'] as String,
      name: (row['filename'] as String? ?? '')
          .replaceAll('\\', '/')
          .split('/')
          .last,
      size: row['size'] as int? ?? 0,
      at: created is num
          ? created
          : num.tryParse(created?.toString() ?? '') ??
                DateTime.tryParse(
                  created?.toString() ?? '',
                )?.millisecondsSinceEpoch ??
                0,
    );
  }

  @override
  void initState() {
    super.initState();
    _instruction = TextEditingController(
      text: widget.seed['instruction'] as String? ?? '',
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (!_initialized) {
      _state = state;
      _identity = state.identityRevision;
      _initialized = true;
    }
  }

  void _check() {
    widget.check();
    if (!mounted ||
        _state.identityRevision != _identity ||
        _state.phase != MobilePhase.ready) {
      throw const ApiFailure('账号或会话已变化，请关闭后重新打开。', status: 409);
    }
  }

  @override
  void dispose() {
    _instruction.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      _check();
      final reader = SharedConversationArtifacts(_state.api, _check, null);
      final taskId = widget.seed['taskId'] as String;
      final selected = _files
          .where((row) => _selected.contains(row['id']))
          .toList();
      final texts = <MapEntry<String, String>>[];
      if (_automation) {
        var bytes = 0;
        for (final row in selected) {
          final source = _source(row);
          if (!_text(row) ||
              source.size > 150000 ||
              (bytes += source.size) > 150000) {
            throw const ApiFailure('自动化只支持带入合计不超过 150 KB 的文本成果。');
          }
          final data = await reader.action(taskId, source.id, 'share');
          _check();
          if (data['name'] != source.name ||
              data['size'] != source.size ||
              data['at'] != source.at) {
            throw const ApiFailure('成果已变化，请关闭后重新选择。');
          }
          try {
            texts.add(
              MapEntry(
                source.name,
                utf8.decode(base64Decode(data['data'] as String)),
              ),
            );
          } on FormatException {
            throw const ApiFailure('此成果不是 UTF-8 文本，不能直接带入自动化。');
          }
        }
      }
      final note = conversationHandoffNote(
        _instruction.text,
        _context ? widget.seed['contextText'] as String? ?? '' : '',
        texts,
      );
      _check();
      if (!mounted) return;
      final title = widget.seed['title'] as String? ?? '';
      if (_automation) {
        final saved = await showAutomationEditor(
          context,
          initialValues: {'title': title, 'note': note, 'enabled': false},
        );
        _check();
        if (saved != null) {
          widget.onComplete({
            'ok': true,
            'id': saved.id,
            'title': saved.title,
            'message': '自动化已保存为暂停状态，可在自动化中检查并启用。',
          });
          await _state.refreshAll();
        }
      } else {
        final handoff = _handoff ??= ConversationRequirementHandoff(
          createTask: _state.api.createTask,
          readSource: (id) => reader.action(taskId, id, 'share'),
          upload: _state.api.uploadRequirementMaterial,
          check: _check,
          sources: selected.map(_source).toList(),
        );
        final task = await showMobileSheet<WorkTask>(
          context,
          title: '填写需求',
          builder: (context, scroll) => CreateTaskSheet(
            initialTitle: title,
            initialNote: note,
            onSubmit: handoff.submit,
            pendingTask: () => handoff.task,
            locked: () => handoff.uncertain,
            statusBuilder: (_) => Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                handoff.task == null
                    ? mobileText(context, '仅创建需求，不会自动派活。选中的成果将作为真实需求材料上传。')
                    : mobileText(
                        context,
                        "需求已保存，材料已上传 {0}/{1} 份。失败后继续只补传未确认的材料。",
                        values: [
                          handoff.receipts.length,
                          handoff.sources.length,
                        ],
                      ),
              ),
            ),
          ),
        );
        _check();
        final saved = task ?? handoff.task;
        if (saved != null) {
          widget.onComplete({
            'ok': true,
            'id': saved.id,
            'title': saved.title,
            'partial': !handoff.complete,
            'message': handoff.complete
                ? '需求已保存，可在需求池安排执行。'
                : '需求已保存，但材料未齐，请在需求池核对并补充。',
          });
          await _state.refreshAll();
        } else if (!handoff.uncertain) {
          _handoff = null;
        }
      }
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = '未能完成，请检查连接后重试。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    if (_state.identityRevision != _identity) {
      return Center(child: Text(mobileText(context, '账号已变化，请关闭后重新打开。')));
    }
    final locked =
        _busy || _handoff?.task != null || _handoff?.uncertain == true;
    return Material(
      type: MaterialType.transparency,
      child: ListView(
        controller: widget.scrollController,
        padding: EdgeInsets.fromLTRB(
          20,
          8,
          20,
          24 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        children: [
          Text(
            widget.seed['title'] as String? ?? mobileText(context, '当前对话'),
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          Text(
            _automation
                ? mobileText(context, '把这次工作的要求带入执行计划。保存后默认为暂停，不会立即运行。')
                : mobileText(context, '把对话中的工作转为需求；填写完成后再由你安排执行。'),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _instruction,
            enabled: !locked,
            minLines: 2,
            maxLines: 5,
            maxLength: 10000,
            decoration: InputDecoration(
              labelText: mobileText(context, '本次要求'),
              hintText: mobileText(context, '说明要继续完成什么，可在下一步完善'),
            ),
          ),
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            title: Text(mobileText(context, '带入最近对话')),
            subtitle: Text(mobileText(context, '仅包含可见的用户与助手正文，不包含内部执行日志')),
            value: _context,
            onChanged: locked
                ? null
                : (value) => setState(() => _context = value),
          ),
          if (_context)
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text(mobileText(context, '查看参考内容')),
              children: [
                SelectableText(widget.seed['contextText'] as String? ?? ''),
              ],
            ),
          const SizedBox(height: 16),
          Text(
            mobileText(context, '选择成果'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 6),
          Text(
            _automation
                ? mobileText(context, '文本内容会带入可编辑的工作要求。图片、表格、压缩包等暂不能随自动化附加。')
                : mobileText(context, '仅带入你勾选的文件，创建时会重新核对访问权限与文件版本。'),
          ),
          if (_files.isEmpty)
            Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text(mobileText(context, '此对话暂无可带入的成果。')),
            ),
          for (final row in _files)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(
                row['filename'] as String? ?? mobileText(context, '成果'),
              ),
              subtitle: Text(
                _automation && !_text(row)
                    ? mobileText(context, '此类文件不能随自动化附加')
                    : mobileText(context, "{0} 字节", values: [row['size'] ?? 0]),
              ),
              value: _selected.contains(row['id']),
              onChanged: locked || _automation && !_text(row)
                  ? null
                  : (value) => setState(() {
                      if (value == true) {
                        _selected.add(row['id'] as String);
                      } else {
                        _selected.remove(row['id']);
                      }
                    }),
            ),
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(mobileText(context, _error)),
            ),
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _busy ? null : _continue,
            child: Text(
              _busy
                  ? mobileText(context, '正在读取…')
                  : mobileText(context, '继续填写'),
            ),
          ),
        ],
      ),
    );
  }
}

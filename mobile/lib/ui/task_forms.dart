import 'mobile_select_field.dart';
import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import 'mobile_theme.dart';
import 'mobile_sheet.dart';

class CreateTaskSheet extends StatefulWidget {
  final String initialTitle;
  final String initialNote;
  final Future<WorkTask> Function(Map<String, dynamic>)? onSubmit;
  final WorkTask? Function()? pendingTask;
  final Widget Function(BuildContext)? statusBuilder;
  final bool Function()? locked;
  const CreateTaskSheet({
    super.key,
    this.initialTitle = '',
    this.initialNote = '',
    this.onSubmit,
    this.pendingTask,
    this.statusBuilder,
    this.locked,
  });

  @override
  State<CreateTaskSheet> createState() => _CreateTaskSheetState();
}

class _CreateTaskSheetState extends State<CreateTaskSheet> {
  late final TextEditingController _title;
  late final TextEditingController _note;
  late final TextEditingController _criteria;
  late final TextEditingController _tags;
  String _priority = 'normal';
  String _kind = 'requirement';
  String _visibility = 'related';
  String _triage = 'intake';
  late DateTime _start;
  late DateTime _due;
  bool _saving = false;
  String _error = '';
  MobileState? _state;
  int? _identity;
  bool _uncertain = false;
  bool get _current =>
      mounted &&
      identical(MobileScope.maybeOf(context), _state) &&
      _state?.identityRevision == _identity;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state == null) {
      _state = state;
      _identity = state.identityRevision;
    }
  }

  @override
  void initState() {
    super.initState();
    _title = TextEditingController(text: widget.initialTitle);
    _note = TextEditingController(text: widget.initialNote);
    _criteria = TextEditingController();
    _tags = TextEditingController();
    final now = DateTime.now();
    _start = DateTime(now.year, now.month, now.day);
    _due = DateTime(now.year, now.month, now.day, 23, 59, 59);
  }

  @override
  void dispose() {
    _title.dispose();
    _note.dispose();
    _criteria.dispose();
    _tags.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving || _uncertain || !_current || widget.locked?.call() == true) {
      return;
    }
    if (_title.text.trim().isEmpty) {
      setState(() {
        _error =
            '\u8bf7\u5199\u6e05\u695a\u9700\u8981\u5b8c\u6210\u4ec0\u4e48\u3002';
      });
      return;
    }
    if (_title.text.trim().length > 200 || _note.text.trim().length > 50000) {
      setState(() => _error = '标题最多 200 字，详细说明最多 50000 字，请精简后再创建。');
      return;
    }
    final criteria = _criteria.text
        .split('\n')
        .map((value) => value.trim())
        .where((value) => value.isNotEmpty)
        .toList(growable: false);
    final tags = _tags.text
        .split(RegExp(r'[,，\n]'))
        .map((value) => value.trim())
        .where((value) => value.isNotEmpty)
        .toSet()
        .toList(growable: false);
    if (criteria.length > 50 || tags.length > 20) {
      setState(() => _error = '完成标准最多 50 条，标签最多 20 个，请精简后再创建。');
      return;
    }
    if (_due.isBefore(_start)) {
      setState(() => _error = '截止日期不能早于开始日期。');
      return;
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    try {
      final state = _state!;
      final task = widget.onSubmit != null
          ? await widget.onSubmit!({
              'title': _title.text.trim(),
              'note': _note.text.trim(),
              'priority': _priority,
              'status': 'todo',
              'handler': 'me',
              'kind': _kind,
              'visibility': _visibility,
              'triageStage': _triage,
              'acceptanceCriteria': criteria,
              'tags': tags,
              'start': _start.millisecondsSinceEpoch,
              'due': _due.millisecondsSinceEpoch,
            })
          : await state.createTask(
              title: _title.text,
              note: _note.text,
              priority: _priority,
              kind: _kind,
              visibility: _visibility,
              triageStage: _triage,
              acceptanceCriteria: criteria,
              tags: tags,
              start: _start,
              due: _due,
            );
      if (!mounted || !_current) return;
      if (task.id.trim().isEmpty) {
        throw const ApiFailure('创建回执缺少需求编号。', isNetwork: true);
      }
      Navigator.of(context).pop<WorkTask>(task);
    } on ApiFailure catch (error) {
      if (_current) {
        setState(() {
          _uncertain =
              widget.pendingTask?.call() == null &&
              (error.isNetwork || error.status >= 500);
          _error = _uncertain
              ? '创建结果尚未确认，请返回需求池核对，避免重复创建。填写内容已保留。'
              : error.message;
        });
      }
    } catch (_) {
      if (_current) {
        setState(() {
          _uncertain = widget.pendingTask?.call() == null;
          _error = '创建结果尚未确认，请返回需求池核对，避免重复创建。填写内容已保留。';
        });
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _pickDate({required bool start}) async {
    final selected = await showDatePicker(
      context: context,
      initialDate: start ? _start : _due,
      firstDate: DateTime.now().subtract(const Duration(days: 365)),
      lastDate: DateTime.now().add(const Duration(days: 3650)),
    );
    if (selected == null || !_current) return;
    setState(() {
      if (start) {
        _start = DateTime(selected.year, selected.month, selected.day);
        if (_due.isBefore(_start)) {
          _due = DateTime(
            selected.year,
            selected.month,
            selected.day,
            23,
            59,
            59,
          );
        }
      } else {
        _due = DateTime(
          selected.year,
          selected.month,
          selected.day,
          23,
          59,
          59,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    final locked =
        _saving ||
        _uncertain ||
        !_current ||
        widget.pendingTask?.call() != null ||
        widget.locked?.call() == true;
    return PopScope(
      canPop: !_saving,
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          controller: MobileSheetScope.maybeOf(context)?.scrollController,
          padding: EdgeInsets.fromLTRB(20, 4, 20, 20 + bottom),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!_current)
                Text(
                  '账号或会话已变化，请关闭后重新打开。',
                  style: TextStyle(color: context.soduWorkTheme.danger),
                ),
              Text(
                mobileText(context, '新建需求'),
                style: Theme.of(context).textTheme.headlineMedium,
              ),
              const SizedBox(height: 5),
              Text(
                mobileText(context, '先登记需求，保存后再安排执行。'),
                style: TextStyle(
                  color: context.soduWorkTheme.inkMuted,
                  fontSize: 13,
                ),
              ),
              const SizedBox(height: 20),
              TextField(
                controller: _title,
                enabled: !locked,
                maxLength: 200,
                autofocus: true,
                textInputAction: TextInputAction.next,
                decoration: InputDecoration(
                  labelText: mobileText(context, '\u4efb\u52a1\u76ee\u6807'),
                  hintText: mobileText(
                    context,
                    '\u4f8b\uff1a\u786e\u8ba4\u767b\u5f55\u9875\u4fee\u590d\u8303\u56f4\u5e76\u7ed9\u51fa\u9a8c\u6536\u6e05\u5355',
                  ),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _criteria,
                enabled: !locked,
                minLines: 2,
                maxLines: 5,
                maxLength: 5000,
                decoration: InputDecoration(
                  labelText: mobileText(context, '完成标准'),
                  alignLabelWithHint: true,
                  hintText: mobileText(context, '每行一条，明确做到什么算完成'),
                ),
              ),
              const SizedBox(height: 18),
              Text(
                mobileText(context, '基本信息'),
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: context.soduWorkTheme.ink,
                ),
              ),
              const SizedBox(height: 10),
              InputDecorator(
                decoration: InputDecoration(
                  labelText: mobileText(context, '负责人'),
                  prefixIcon: const Icon(Icons.person_outline_rounded),
                ),
                child: Text(mobileText(context, '自己')),
              ),
              const SizedBox(height: 12),
              MobileSelectField<String>(
                initialValue: _kind,
                decoration: InputDecoration(
                  labelText: mobileText(context, '类型'),
                ),
                items: [
                  for (final item in const [
                    ('requirement', '需求'),
                    ('bug', 'Bug'),
                    ('ticket', '工单'),
                    ('improvement', '优化'),
                    ('other', '其它'),
                  ])
                    DropdownMenuItem(
                      value: item.$1,
                      child: Text(mobileText(context, item.$2)),
                    ),
                ],
                onChanged: locked
                    ? null
                    : (value) => setState(() => _kind = value ?? 'requirement'),
              ),
              const SizedBox(height: 12),
              MobileSelectField<String>(
                initialValue: _visibility,
                decoration: InputDecoration(
                  labelText: mobileText(context, '可见范围'),
                ),
                items: [
                  DropdownMenuItem(
                    value: 'related',
                    child: Text(mobileText(context, '仅相关人')),
                  ),
                  DropdownMenuItem(
                    value: 'organization',
                    child: Text(mobileText(context, '团队可见')),
                  ),
                ],
                onChanged: locked
                    ? null
                    : (value) =>
                          setState(() => _visibility = value ?? 'related'),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _tags,
                enabled: !locked,
                decoration: InputDecoration(
                  labelText: mobileText(context, '标签'),
                  hintText: mobileText(context, '输入标签，用逗号或回车分隔'),
                  prefixIcon: const Icon(Icons.sell_outlined),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _note,
                enabled: !locked,
                maxLength: 50000,
                minLines: 5,
                maxLines: 8,
                decoration: InputDecoration(
                  labelText: mobileText(context, '\u8be6\u7ec6\u8bf4\u660e'),
                  alignLabelWithHint: true,
                  hintText: mobileText(
                    context,
                    '\u80cc\u666f\u3001\u8981\u6c42\u3001\u5b8c\u6210\u6807\u51c6\u548c\u9700\u8981\u6ce8\u610f\u7684\u4e8b\u9879\u2026',
                  ),
                ),
              ),
              const SizedBox(height: 12),
              MobileSelectField<String>(
                initialValue: _triage,
                decoration: InputDecoration(
                  labelText: mobileText(context, '加入阶段'),
                ),
                items: [
                  DropdownMenuItem(
                    value: 'intake',
                    child: Text(mobileText(context, '收集箱')),
                  ),
                  DropdownMenuItem(
                    value: 'clarifying',
                    child: Text(mobileText(context, '收集箱 · 待补充')),
                  ),
                  DropdownMenuItem(
                    value: 'ready',
                    child: Text(mobileText(context, '待开始')),
                  ),
                ],
                onChanged: locked
                    ? null
                    : (value) => setState(() => _triage = value ?? 'intake'),
              ),
              const SizedBox(height: 18),
              Text(
                mobileText(context, '\u4f18\u5148\u7ea7'),
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: context.soduWorkTheme.inkSecondary,
                ),
              ),
              const SizedBox(height: 9),
              SizedBox(
                width: double.infinity,
                child: SegmentedButton<String>(
                  showSelectedIcon: false,
                  segments: [
                    ButtonSegment(
                      value: 'low',
                      label: Text(mobileText(context, '\u4f4e')),
                    ),
                    ButtonSegment(
                      value: 'normal',
                      label: Text(mobileText(context, '\u666e\u901a')),
                    ),
                    ButtonSegment(
                      value: 'high',
                      label: Text(mobileText(context, '\u9ad8')),
                    ),
                    ButtonSegment(
                      value: 'critical',
                      label: Text(mobileText(context, '\u7d27\u6025')),
                    ),
                  ],
                  selected: {_priority},
                  onSelectionChanged: locked
                      ? null
                      : (value) {
                          setState(() => _priority = value.first);
                        },
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: _DateField(
                      label: '\u5f00\u59cb',
                      date: _start,
                      onTap: () {
                        if (!locked) _pickDate(start: true);
                      },
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _DateField(
                      label: '\u622a\u6b62',
                      date: _due,
                      onTap: () {
                        if (!locked) _pickDate(start: false);
                      },
                    ),
                  ),
                ],
              ),
              if (widget.statusBuilder != null) widget.statusBuilder!(context),
              if (_error.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  _error,
                  style: TextStyle(
                    color: context.soduWorkTheme.primary,
                    fontSize: 13,
                  ),
                ),
              ],
              const SizedBox(height: 22),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _saving
                          ? null
                          : () => Navigator.of(
                              context,
                            ).pop<WorkTask>(widget.pendingTask?.call()),
                      child: Text(
                        widget.pendingTask?.call() == null
                            ? mobileText(context, '取消')
                            : mobileText(context, '稍后补齐'),
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      onPressed:
                          _saving ||
                              _uncertain ||
                              !_current ||
                              widget.locked?.call() == true
                          ? null
                          : _save,
                      child: Text(
                        _saving
                            ? (widget.onSubmit == null ? '正在创建…' : '正在保存…')
                            : widget.pendingTask?.call() != null
                            ? mobileText(context, '继续上传材料')
                            : mobileText(context, '创建需求'),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DateField extends StatelessWidget {
  final String label;
  final DateTime date;
  final VoidCallback onTap;

  const _DateField({
    required this.label,
    required this.date,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: context.soduWorkTheme.surface,
      shape: RoundedRectangleBorder(
        side: BorderSide(color: context.soduWorkTheme.line),
        borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusMedium),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusMedium),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
          child: Row(
            children: [
              Icon(
                Icons.calendar_today_outlined,
                size: 17,
                color: context.soduWorkTheme.inkMuted,
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: TextStyle(
                        color: context.soduWorkTheme.inkMuted,
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${date.month}/${date.day}',
                      style: TextStyle(
                        color: context.soduWorkTheme.ink,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Requirement metadata changes use the same versioned PATCH as the PC board.
class RequirementEditSheet extends StatefulWidget {
  final WorkTask task;
  const RequirementEditSheet({super.key, required this.task});
  @override
  State<RequirementEditSheet> createState() => _RequirementEditSheetState();
}

class _RequirementEditSheetState extends State<RequirementEditSheet> {
  late final TextEditingController _title, _note, _criteria;
  late String _priority, _triage;
  bool _saving = false;
  String _error = '';
  MobileState? _state;
  int? _identity;
  bool _saved = false;
  bool _uncertain = false;
  bool get _current =>
      mounted &&
      identical(MobileScope.maybeOf(context), _state) &&
      _state?.identityRevision == _identity;
  bool get _locked => _saving || _saved || _uncertain || !_current;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state == null) {
      _state = state;
      _identity = state.identityRevision;
    }
  }

  bool get _contentEditable =>
      !widget.task.readOnly || widget.task.status == 'todo';

  @override
  void initState() {
    super.initState();
    _title = TextEditingController(text: widget.task.title);
    _note = TextEditingController(text: widget.task.note);
    _criteria = TextEditingController(
      text: widget.task.acceptanceCriteria.join('\n'),
    );
    _priority = widget.task.priority;
    _triage = widget.task.triageStage;
  }

  @override
  void dispose() {
    _title.dispose();
    _note.dispose();
    _criteria.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving || _uncertain || !_current || !widget.task.canEditRequirement) {
      return;
    }
    if (_saved) {
      await _refreshSaved();
      return;
    }
    if (_title.text.trim().isEmpty) {
      setState(() => _error = '请写清楚需要完成什么。');
      return;
    }
    if (_title.text.trim().length > 200 || _note.text.trim().length > 50000) {
      setState(() => _error = '标题最多 200 字，详细说明最多 50000 字，请精简后再保存。');
      return;
    }
    final task = widget.task;
    final patch = <String, dynamic>{
      'requirementVersion': task.requirementVersion,
    };
    if (_contentEditable) {
      if (_title.text.trim() != task.title) patch['title'] = _title.text.trim();
      if (_note.text.trim() != task.note) patch['note'] = _note.text.trim();
      if (_priority != task.priority) patch['priority'] = _priority;
    }
    if (task.status == 'todo') {
      final criteria = _criteria.text
          .split('\n')
          .map((value) => value.trim())
          .where((value) => value.isNotEmpty)
          .toList();
      if (criteria.length > 50) {
        setState(() => _error = '完成标准最多 50 条，请精简后再保存。');
        return;
      }
      if (criteria.join('\n') != task.acceptanceCriteria.join('\n')) {
        patch['acceptanceCriteria'] = criteria;
      }
    }
    if (task.canTriage && _triage != task.triageStage) {
      patch['triageStage'] = _triage;
    }
    if (patch.length == 1) {
      Navigator.of(context).pop(false);
      return;
    }
    setState(() {
      _saving = true;
      _error = '';
    });
    final state = _state!;
    try {
      final updated = await state.api.patchTask(task.id, patch);
      if (!_current) return;
      if (updated.id != task.id) {
        throw const ApiFailure('保存回执与当前需求不一致。', isNetwork: true);
      }
      _saved = true;
      await _refreshSaved();
    } on ApiFailure catch (error) {
      if (_current) {
        setState(() {
          _uncertain = error.isNetwork || error.status >= 500;
          _error = _uncertain ? '保存结果尚未确认，请关闭后刷新需求核对。填写内容已保留。' : error.message;
        });
      }
    } catch (_) {
      if (_current) {
        setState(() {
          _uncertain = true;
          _error = '保存结果尚未确认，请关闭后刷新需求核对。填写内容已保留。';
        });
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _refreshSaved() async {
    if (!_current) return;
    setState(() => _saving = true);
    try {
      await _state!.loadTask(widget.task.id);
      if (mounted && _current) Navigator.of(context).pop(true);
    } catch (_) {
      if (_current) setState(() => _error = '修改已保存，最新内容暂未加载。可以重试刷新，不会重复保存。');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_saving,
    child: Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .85,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 12, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      mobileText(context, '编辑需求'),
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                  ),
                  IconButton(
                    tooltip: mobileText(context, '关闭'),
                    onPressed: _saving
                        ? null
                        : () => Navigator.of(context).pop(_saved),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                children: [
                  if (!_current)
                    Text(
                      '账号或会话已变化，请关闭后重新打开。',
                      style: TextStyle(color: context.soduWorkTheme.danger),
                    ),
                  TextField(
                    controller: _title,
                    enabled: !_locked && _contentEditable,
                    maxLength: 200,
                    decoration: InputDecoration(
                      labelText: mobileText(context, '需求标题'),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _note,
                    enabled: !_saving && _contentEditable,
                    minLines: 3,
                    maxLines: 6,
                    decoration: InputDecoration(
                      labelText: mobileText(context, '需求内容'),
                    ),
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _criteria,
                    enabled: !_saving && widget.task.status == 'todo',
                    minLines: 2,
                    maxLines: 5,
                    decoration: InputDecoration(
                      labelText: mobileText(context, '完成标准'),
                      hintText: mobileText(context, '每行一条，写清做到什么算完成'),
                    ),
                  ),
                  const SizedBox(height: 16),
                  MobileSelectField<String>(
                    initialValue: _priority,
                    decoration: InputDecoration(
                      labelText: mobileText(context, '优先级'),
                    ),
                    items: [
                      DropdownMenuItem(
                        value: 'low',
                        child: Text(mobileText(context, '低')),
                      ),
                      DropdownMenuItem(
                        value: 'normal',
                        child: Text(mobileText(context, '普通')),
                      ),
                      DropdownMenuItem(
                        value: 'high',
                        child: Text(mobileText(context, '高')),
                      ),
                      DropdownMenuItem(
                        value: 'critical',
                        child: Text(mobileText(context, '紧急')),
                      ),
                    ],
                    onChanged: _locked || !_contentEditable
                        ? null
                        : (value) =>
                              setState(() => _priority = value ?? 'normal'),
                  ),
                  if (widget.task.canTriage) ...[
                    const SizedBox(height: 16),
                    MobileSelectField<String>(
                      initialValue: _triage,
                      decoration: InputDecoration(
                        labelText: mobileText(context, '准备阶段'),
                      ),
                      items: [
                        DropdownMenuItem(
                          value: 'intake',
                          child: Text(mobileText(context, '待梳理')),
                        ),
                        DropdownMenuItem(
                          value: 'clarifying',
                          child: Text(mobileText(context, '待补充')),
                        ),
                        DropdownMenuItem(
                          value: 'ready',
                          child: Text(mobileText(context, '待开始')),
                        ),
                      ],
                      onChanged: _locked
                          ? null
                          : (value) =>
                                setState(() => _triage = value ?? 'ready'),
                    ),
                  ],
                  if (_error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 14),
                      child: Text(
                        _error,
                        style: TextStyle(color: context.soduWorkTheme.danger),
                      ),
                    ),
                  const SizedBox(height: 18),
                ],
              ),
            ),
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 10, 20, 16),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: _saving || _uncertain || !_current
                        ? null
                        : _save,
                    child: Text(
                      _saving
                          ? mobileText(context, '正在保存…')
                          : mobileText(context, _saved ? '刷新已保存的需求' : '保存修改'),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

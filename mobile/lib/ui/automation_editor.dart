import 'automation_time_fields.dart';
import 'mobile_select_field.dart';
import '../core/automation_readiness.dart';
import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../core/soduwork_api.dart';
import '../core/automation_execution_directory.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import 'mobile_sheet.dart';
import 'work_model_picker.dart';
import 'mobile_sheet_pages.dart';

bool _sameAutomationValue(Object? a, Object? b) {
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final key in a.keys) {
      if (!b.containsKey(key) || !_sameAutomationValue(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  if (a is List && b is List) {
    return a.length == b.length &&
        List.generate(
          a.length,
          (index) => _sameAutomationValue(a[index], b[index]),
        ).every((value) => value);
  }
  return a == b;
}

Future<AutomationSchedule?> showAutomationEditor(
  BuildContext context, {
  AutomationSchedule? schedule,
  Map<String, dynamic>? initialValues,
}) {
  final nested = MobileSheetPages.maybeOf(context) != null;
  final presentationNavigator = Navigator.of(context);
  return showMobileSheet<AutomationSchedule>(
    context,
    title: schedule == null ? '新建自动化' : '编辑自动化',
    builder: (editorContext, scroll) => AutomationEditor(
      schedule: schedule,
      initialValues: initialValues,
      scrollController: scroll,
      onSaved: (saved) {
        final navigator = nested
            ? Navigator.of(editorContext)
            : presentationNavigator;
        navigator.pop(saved);
      },
    ),
  );
}

/// Uses the desktop schedule contract; execution policy remains on the Hub.
class AutomationEditor extends StatefulWidget {
  final AutomationSchedule? schedule;
  final Map<String, dynamic>? initialValues;
  final ScrollController? scrollController;
  final ValueChanged<AutomationSchedule>? onSaved;
  const AutomationEditor({
    super.key,
    this.schedule,
    this.initialValues,
    this.scrollController,
    this.onSaved,
  });

  @override
  State<AutomationEditor> createState() => _AutomationEditorState();
}

class _AutomationEditorState extends State<AutomationEditor> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _title;
  late final TextEditingController _note;
  late final TextEditingController _zone;
  late final Map<String, dynamic> _initial;
  MobileState? _state;
  int? _identity;
  bool _busy = false;
  bool _loading = true;
  bool _uncertain = false;
  String _error = '';
  String _directoryError = '';
  String _preflightMessage = '';
  List<Map<String, dynamic>> _agents = const [];
  List<Map<String, dynamic>> _plugins = const [];
  bool _pluginMode = false;
  String _pluginBinding = '';
  Map<String, dynamic> _pluginInputs = {};
  late String _every;
  late String _agent;
  late String _modelName;
  late int _hour;
  late int _minute;
  late int _weekday;
  late int _retryLimit;
  late int _retryDelay;
  DateTime? _once;

  bool get _current =>
      mounted &&
      identical(MobileScope.maybeOf(context), _state) &&
      _state?.identityRevision == _identity;
  bool get _plugin => _pluginMode;
  bool get _personalPlugin =>
      (_initial['personalPluginKey']?.toString() ?? '').isNotEmpty &&
      _pluginBinding.isEmpty;
  bool get _locked => _busy || _uncertain || !_current;

  @override
  void initState() {
    super.initState();
    final old = widget.schedule;
    _initial = {
      'title': old?.title ?? '',
      'note': old?.note ?? '',
      'every': old?.every ?? 'daily',
      'timeZone': old?.timeZone ?? 'Asia/Shanghai',
      'atHour': 9,
      'atMinute': 0,
      'weekday': 1,
      'assigneeId': '',
      'modelName': '',
      'retryLimit': 2,
      'retryDelayMinutes': 5,
      ...?widget.initialValues,
      ...?old?.configuration,
    };
    _title = TextEditingController(text: _initial['title'] as String? ?? '');
    _note = TextEditingController(text: _initial['note'] as String? ?? '');
    _zone = TextEditingController(
      text: _initial['timeZone'] as String? ?? 'Asia/Shanghai',
    );
    _every = _initial['every'] as String? ?? 'daily';
    _agent = _initial['assigneeId'] as String? ?? '';
    _modelName = _initial['modelName']?.toString() ?? '';
    _hour = (_initial['atHour'] as num? ?? 9).toInt().clamp(0, 23);
    _minute = (_initial['atMinute'] as num? ?? 0).toInt().clamp(0, 59);
    _weekday = (_initial['weekday'] as num? ?? 1).toInt().clamp(1, 7);
    _retryLimit = (_initial['retryLimit'] as num? ?? 2).toInt();
    _retryDelay = (_initial['retryDelayMinutes'] as num? ?? 5).toInt();
    _once = DateTime.tryParse(_initial['runAt']?.toString() ?? '')?.toLocal();
    _pluginBinding = _initial['pluginBindingId']?.toString() ?? '';
    final savedInputs = _initial['pluginInputs'];
    _pluginInputs = savedInputs is Map
        ? Map<String, dynamic>.from(savedInputs)
        : <String, dynamic>{};
    _pluginMode =
        (widget.schedule != null &&
            widget.schedule!.executionMode != 'direct') ||
        _pluginBinding.isNotEmpty;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state == null) {
      _state = state;
      _identity = state.identityRevision;
      _loadAgents();
    }
  }

  Future<void> _loadAgents() async {
    if (!_current || _busy) return;
    setState(() {
      _loading = true;
      _directoryError = '';
    });
    try {
      final result = await loadAutomationExecutionDirectory(_state!.api);
      if (!_current) return;
      final seen = <String>{};
      final rows = (result['substrates'] as List? ?? const [])
          .whereType<Map>()
          .where(
            (row) =>
                row['key'] is String &&
                (row['key'] as String).isNotEmpty &&
                seen.add(row['key']),
          )
          .map((row) => Map<String, dynamic>.from(row))
          .toList();
      setState(() {
        _agents = rows;
        if (widget.schedule == null && _agent.isEmpty) {
          _agent =
              rows
                  .where(
                    (row) =>
                        row['runnerKind'] == 'work-computer' &&
                        row['available'] != false &&
                        row['online'] != false,
                  )
                  .firstOrNull?['key']
                  ?.toString() ??
              '';
        }
        final availability = result['availability'];
        if (availability is Map) {
          _directoryError = availability['agentReason']?.toString() ?? '';
        }
        if (rows.isEmpty && _directoryError.isEmpty) {
          _directoryError = '当前设备没有可用于自动化的执行底座。填写内容会保留，执行条件就绪后再保存。';
        }
      });
    } on ApiFailure catch (error) {
      if (_current) setState(() => _directoryError = error.message);
    } finally {
      if (_current) setState(() => _loading = false);
    }
  }

  Future<void> _loadPlugins() async {
    if (!_current || _busy) return;
    try {
      final rows = await _state!.api.automationPlugins();
      if (!_current) return;
      final seen = <String>{};
      final plugins = rows
          .where(
            (row) =>
                row['bindingId'] is String &&
                (row['bindingId'] as String).isNotEmpty &&
                seen.add(row['bindingId']),
          )
          .toList(growable: false);
      setState(() => _plugins = plugins);
    } on ApiFailure catch (error) {
      if (_current && _pluginBinding.isEmpty) {
        setState(() => _directoryError = error.message);
      }
    }
  }

  Map<String, dynamic> _changes() {
    final values = <String, dynamic>{
      'title': _title.text.trim(),
      'note': _note.text.trim(),
      'every': _every,
      'timeZone': _zone.text.trim(),
      'atHour': _hour,
      'atMinute': _minute,
      'weekday': _weekday,
      'retryLimit': _retryLimit,
      'retryDelayMinutes': _retryDelay,
      if (!_plugin) 'assigneeId': _agent,
      if (!_plugin) 'modelName': _modelName,
      if (_plugin && _pluginBinding.isNotEmpty) ...{
        'pluginBindingId': _pluginBinding,
        'pluginInputs': Map<String, dynamic>.from(_pluginInputs),
      },
    };
    if (_every == 'once') {
      final previous = DateTime.tryParse(_initial['runAt']?.toString() ?? '');
      if (_once != null &&
          (widget.schedule == null || previous != _once!.toUtc())) {
        values['runAt'] = _once!.toUtc().toIso8601String();
      }
    }
    if (widget.schedule == null) {
      return {
        ...values,
        for (final key in [
          'requiredCapabilities',
          'pluginBindingId',
          'pluginInputs',
        ])
          if (_initial.containsKey(key) && !values.containsKey(key))
            key: _initial[key],
        'enabled': false,
        'assigneeType': 'agent',
        if (!_plugin && _initial.containsKey('pluginBindingId'))
          'pluginBindingId': '',
        if (!_plugin && _initial.containsKey('pluginInputs'))
          'pluginInputs': <String, dynamic>{},
      };
    }
    return {
      for (final entry in values.entries)
        if (!_sameAutomationValue(_initial[entry.key], entry.value))
          entry.key: entry.value,
    };
  }

  Future<void> _save() async {
    if (_locked || !(_form.currentState?.validate() ?? false)) return;
    if (_plugin && !_personalPlugin && _pluginBinding.trim().isEmpty) {
      setState(() => _error = '请选择一个可用于自动化的插件。');
      return;
    }
    if (_plugin && !_personalPlugin && widget.schedule == null) {
      final selected = _plugins.firstWhere(
        (row) => row['bindingId'] == _pluginBinding,
        orElse: () => <String, dynamic>{},
      );
      if ((_plugins.isNotEmpty && selected.isEmpty) ||
          selected['runnable'] == false) {
        setState(() => _error = '当前插件暂不可运行，请刷新插件配置后重试。');
        return;
      }
      final missing = _pluginFields(selected)
          .where(
            (field) =>
                field['required'] == true &&
                !field.containsKey('default') &&
                (_pluginInputs[field['key']] == null ||
                    _pluginInputs[field['key']].toString().isEmpty),
          )
          .map((field) => field['label']?.toString() ?? field['key'])
          .toList(growable: false);
      if (missing.isNotEmpty) {
        setState(() => _error = '请填写插件必填参数：${missing.join('、')}');
        return;
      }
    }
    if (!_plugin &&
        widget.schedule == null &&
        !_agents.any(
          (row) =>
              row['key'] == _agent &&
              row['available'] != false &&
              row['online'] != false,
        )) {
      setState(() => _error = '请选择当前服务提供的可用执行底座；没有执行底座时暂不能保存。');
      return;
    }
    if (_every == 'once' &&
        (_once == null ||
            (!_once!.isAfter(DateTime.now()) &&
                _once!.toUtc() !=
                    DateTime.tryParse(_initial['runAt']?.toString() ?? '')))) {
      setState(() => _error = '请选择未来的执行日期和时间。');
      return;
    }
    final changes = _changes();
    if (changes.isEmpty) {
      _complete(widget.schedule!);
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
      _preflightMessage = '';
    });
    var submitting = false;
    try {
      final check = await _state!.api.preflightAutomation({
        ...changes,
        if (widget.schedule != null) 'scheduleId': widget.schedule!.id,
      });
      if (!_current) return;
      final status = check['state'];
      final message = check['message']?.toString() ?? '执行条件尚未确认';
      setState(() => _preflightMessage = message);
      if (status == 'blocked' || !{'ready', 'waiting'}.contains(status)) {
        throw ApiFailure(message);
      }
      if (status != 'ready' && widget.schedule?.enabled == true) {
        throw ApiFailure('执行条件尚未就绪，请先暂停计划后再编辑。$message');
      }
      if (widget.schedule?.enabled == true) {
        await ensureAutomationExecutionReady(
          _state!.api,
          configuration: {..._initial, ...changes},
          preflight: check,
          checkCurrent: () {
            if (!_current) throw const ApiFailure('账号已变化，请重新打开自动化。');
          },
        );
      }
      submitting = true;
      final saved = widget.schedule == null
          ? await _state!.api.createAutomation(changes)
          : await _state!.api.updateAutomation(widget.schedule!.id, changes);
      if (!_current) return;
      if (saved.id.isEmpty ||
          (widget.schedule != null && saved.id != widget.schedule!.id)) {
        throw const ApiFailure('保存回执缺少计划编号。', isNetwork: true);
      }
      _complete(saved);
    } on ApiFailure catch (error) {
      if (!_current) return;
      setState(() {
        _uncertain = submitting && (error.isNetwork || error.status >= 500);
        _error = _uncertain
            ? '保存结果尚未确认。请返回自动化列表刷新核对，勿重复创建；本页已停止再次提交。'
            : error.message;
      });
    } catch (_) {
      if (!_current) return;
      setState(() {
        _uncertain = submitting;
        _error = submitting
            ? '保存结果尚未确认。请返回自动化列表刷新核对，勿重复创建；本页已停止再次提交。'
            : '暂时无法检查执行条件，请重试。填写内容已保留。';
      });
    } finally {
      if (_current) setState(() => _busy = false);
    }
  }

  void _complete(AutomationSchedule saved) {
    if (widget.onSaved != null) {
      widget.onSaved!(saved);
    } else {
      Navigator.pop(context, saved);
    }
  }

  @override
  void dispose() {
    _title.dispose();
    _note.dispose();
    _zone.dispose();
    super.dispose();
  }

  List<Map<String, dynamic>> _pluginFields(Map<String, dynamic> plugin) {
    final fields = plugin['inputs'];
    return fields is List
        ? fields.whereType<Map>().map(Map<String, dynamic>.from).toList()
        : const <Map<String, dynamic>>[];
  }

  Map<String, dynamic>? _selectedPlugin() {
    for (final row in _plugins) {
      if (row['bindingId'] == _pluginBinding) return row;
    }
    return null;
  }

  Widget _pluginEditor() {
    final selected = _selectedPlugin();
    final fields = selected == null
        ? const <Map<String, dynamic>>[]
        : _pluginFields(selected);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_loading) const LinearProgressIndicator(),
        MobileSelectField<String>(
          compact: true,
          key: ValueKey('automation-plugin-$_pluginBinding-${_plugins.length}'),
          initialValue: selected == null ? null : _pluginBinding,
          decoration: InputDecoration(labelText: mobileText(context, '自动化插件')),
          items: [
            if (_pluginBinding.isNotEmpty && selected == null)
              DropdownMenuItem(
                value: _pluginBinding,
                child: Text(mobileText(context, '原插件已停用或无权使用')),
              ),
            for (final plugin in _plugins)
              DropdownMenuItem(
                value: plugin['bindingId'] as String,
                enabled: plugin['runnable'] != false,
                child: Text(
                  (plugin['name'] ?? plugin['key']).toString() +
                      (plugin['runnable'] == false ? ' · 暂不可用' : ''),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: _locked || _loading
              ? null
              : (value) => setState(() {
                  _pluginBinding = value ?? '';
                  _pluginInputs = <String, dynamic>{};
                }),
        ),
        if (selected != null &&
            (selected['description']?.toString() ?? '').isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(selected['description'].toString()),
          ),
        for (final field in fields) _pluginField(field),
        TextButton.icon(
          onPressed: _locked || _loading ? null : _loadPlugins,
          icon: const Icon(Icons.refresh),
          label: Text(mobileText(context, '刷新插件配置')),
        ),
      ],
    );
  }

  Widget _pluginField(Map<String, dynamic> field) {
    final key = field['key']?.toString() ?? '';
    final type = field['type']?.toString() ?? 'text';
    final label = field['label']?.toString() ?? key;
    final required = field['required'] == true;
    final current = _pluginInputs[key];
    final help = field['description']?.toString() ?? '';
    if (type == 'boolean') {
      return SwitchListTile.adaptive(
        contentPadding: EdgeInsets.zero,
        title: Text(label + (required ? ' *' : '')),
        subtitle: help.isEmpty ? null : Text(help),
        value: current == true,
        onChanged: _locked
            ? null
            : (value) => setState(() => _pluginInputs[key] = value),
      );
    }
    if (type == 'select') {
      final options = (field['options'] as List? ?? const [])
          .whereType<Map>()
          .map((item) => Map<String, dynamic>.from(item))
          .toList(growable: false);
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: MobileSelectField<String>(
          compact: true,
          initialValue: current?.toString().isEmpty == true
              ? null
              : current?.toString(),
          decoration: InputDecoration(
            labelText: label + (required ? ' *' : ''),
          ),
          items: [
            for (final option in options)
              DropdownMenuItem(
                value: option['value'].toString(),
                child: Text(
                  option['label']?.toString() ?? option['value'].toString(),
                ),
              ),
          ],
          onChanged: _locked
              ? null
              : (value) => setState(() => _pluginInputs[key] = value ?? ''),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: TextFormField(
        initialValue: current?.toString() ?? field['default']?.toString() ?? '',
        enabled: !_locked,
        minLines: type == 'textarea' ? 3 : 1,
        maxLines: type == 'textarea' ? 6 : 1,
        keyboardType: type == 'number'
            ? const TextInputType.numberWithOptions(decimal: true)
            : null,
        decoration: InputDecoration(
          labelText: label + (required ? ' *' : ''),
          hintText: field['placeholder']?.toString(),
          helperText: help.isEmpty ? null : help,
        ),
        onChanged: (value) =>
            _pluginInputs[key] = type == 'number' && value.isNotEmpty
            ? num.tryParse(value) ?? value
            : value,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    if (!_current) {
      return Center(child: Text(mobileText(context, '账号已变化，请关闭后重新打开自动化。')));
    }
    final selectedKnown = _agents.any((row) => row['key'] == _agent);
    return Material(
      type: MaterialType.transparency,
      child: PopScope(
        canPop: !_busy,
        child: Form(
          key: _form,
          child: SingleChildScrollView(
            controller: widget.scrollController,
            padding: EdgeInsets.fromLTRB(
              20,
              12,
              20,
              24 + MediaQuery.viewInsetsOf(context).bottom,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  widget.schedule == null
                      ? mobileText(context, '先填写工作要求和时间。新计划保存为暂停状态，检查执行条件后再启用。')
                      : mobileText(context, '调整触发方式和执行条件，保存后按新设置生效。'),
                ),
                const SizedBox(height: 20),
                TextFormField(
                  key: const Key('automation-title'),
                  controller: _title,
                  enabled: !_locked,
                  maxLength: 200,
                  decoration: InputDecoration(
                    labelText: mobileText(context, '计划名称'),
                    counterText: '',
                    isDense: true,
                  ),
                  validator: (value) => value == null || value.trim().isEmpty
                      ? mobileText(context, '请填写计划名称')
                      : null,
                ),
                const SizedBox(height: 12),
                TextFormField(
                  key: const Key('automation-note'),
                  controller: _note,
                  enabled: !_locked,
                  minLines: 3,
                  maxLines: 8,
                  maxLength: 50000,
                  decoration: InputDecoration(
                    labelText: mobileText(context, '每次需要完成什么'),
                    hintText: mobileText(context, '说明目标、资料来源和完成标准'),
                    counterText: '',
                    isDense: true,
                  ),
                  validator: (value) => value == null || value.trim().isEmpty
                      ? mobileText(context, '请填写执行要求')
                      : null,
                ),
                const SizedBox(height: 16),
                Text(
                  mobileText(context, '什么时候跑'),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 12),
                MobileSelectField<String>(
                  compact: true,
                  key: ValueKey('automation-frequency-$_every'),
                  initialValue: _every,

                  decoration: InputDecoration(
                    labelText: mobileText(context, '执行频率'),
                  ),
                  items: [
                    for (final item in const [
                      ('daily', '每天'),
                      ('hourly', '每小时'),
                      ('weekly', '每周'),
                      ('once', '仅一次'),
                    ])
                      DropdownMenuItem(
                        value: item.$1,
                        child: Text(mobileText(context, item.$2)),
                      ),
                    if (!{'daily', 'weekly', 'hourly', 'once'}.contains(_every))
                      DropdownMenuItem(value: _every, child: Text(_every)),
                  ],
                  onChanged: _locked
                      ? null
                      : (value) => setState(() => _every = value!),
                ),
                if (_every == 'weekly') ...[
                  const SizedBox(height: 12),
                  MobileSelectField<int>(
                    compact: true,
                    initialValue: _weekday,
                    decoration: InputDecoration(
                      labelText: mobileText(context, '星期'),
                    ),
                    items: [
                      for (var day = 1; day <= 7; day++)
                        DropdownMenuItem(
                          value: day,
                          child: Text(
                            mobileText(
                              context,
                              const [
                                '星期一',
                                '星期二',
                                '星期三',
                                '星期四',
                                '星期五',
                                '星期六',
                                '星期日',
                              ][day - 1],
                            ),
                          ),
                        ),
                    ],
                    onChanged: _locked
                        ? null
                        : (value) => setState(() => _weekday = value!),
                  ),
                ],
                const SizedBox(height: 12),
                if (_every == 'once')
                  AutomationDateTimeFields(
                    value: _once,
                    zone: _zone.text,
                    enabled: !_locked,
                    onChanged: (value) => setState(() => _once = value),
                  )
                else
                  AutomationClockFields(
                    hour: _hour,
                    minute: _minute,
                    hourly: _every == 'hourly',
                    enabled: !_locked,
                    onChanged: (hour, minute) => setState(() {
                      _hour = hour;
                      _minute = minute;
                    }),
                  ),
                const SizedBox(height: 10),
                Text(
                  mobileText(
                    context,
                    '按 {0} 执行，到点后通常在 2 分钟内开始',
                    values: [
                      _zone.text == 'Asia/Shanghai'
                          ? mobileText(context, '北京时间')
                          : _zone.text,
                    ],
                  ),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 16),
                ExpansionTile(
                  key: const Key('automation-advanced'),
                  tilePadding: EdgeInsets.zero,
                  childrenPadding: const EdgeInsets.only(top: 8, bottom: 12),
                  title: Text(
                    mobileText(context, '更多设置'),
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                  subtitle: Text(mobileText(context, '时区与失败重试')),
                  children: [
                    TextFormField(
                      controller: _zone,
                      enabled: !_locked,
                      onChanged: (_) => setState(() {}),
                      decoration: InputDecoration(
                        labelText: mobileText(context, '计划时区'),
                        helperText: mobileText(context, '例如 Asia/Shanghai'),
                        isDense: true,
                      ),
                      validator: (value) =>
                          value == null || value.trim().isEmpty
                          ? mobileText(context, '请填写计划时区')
                          : null,
                    ),
                    const SizedBox(height: 20),
                    Text(
                      mobileText(context, '失败恢复'),
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 8),
                    MobileSelectField<int>(
                      compact: true,
                      key: const Key('automation-retry-limit'),
                      initialValue: _retryLimit,

                      decoration: InputDecoration(
                        labelText: mobileText(context, '失败后自动重试'),
                      ),
                      items: [
                        for (final count in {
                          0,
                          1,
                          2,
                          3,
                          _retryLimit,
                        }.toList()..sort())
                          DropdownMenuItem(
                            value: count,
                            child: Text(
                              count == 0
                                  ? mobileText(context, '不重试')
                                  : mobileText(
                                      context,
                                      "{0} 次",
                                      values: [count],
                                    ),
                            ),
                          ),
                      ],
                      onChanged: _locked
                          ? null
                          : (value) => setState(() => _retryLimit = value!),
                    ),
                    if (_retryLimit > 0) ...[
                      const SizedBox(height: 12),
                      MobileSelectField<int>(
                        compact: true,
                        key: const Key('automation-retry-delay'),
                        initialValue: _retryDelay,
                        decoration: InputDecoration(
                          labelText: mobileText(context, '重试间隔'),
                        ),
                        items: [
                          for (final minutes in {
                            2,
                            5,
                            10,
                            _retryDelay,
                          }.toList()..sort())
                            DropdownMenuItem(
                              value: minutes,
                              child: Text(
                                mobileText(
                                  context,
                                  "{0} 分钟",
                                  values: [minutes],
                                ),
                              ),
                            ),
                        ],
                        onChanged: _locked
                            ? null
                            : (value) => setState(() => _retryDelay = value!),
                      ),
                    ],
                    const SizedBox(height: 8),
                  ],
                ),
                const SizedBox(height: 20),
                Text(
                  mobileText(context, '怎么执行'),
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const SizedBox(height: 12),
                if (widget.schedule == null) ...[
                  SegmentedButton<String>(
                    segments: [
                      ButtonSegment(
                        value: 'direct',
                        label: Text(mobileText(context, '直接执行')),
                      ),
                      ButtonSegment(
                        value: 'plugin',
                        label: Text(mobileText(context, '插件自动化')),
                      ),
                    ],
                    selected: {_plugin ? 'plugin' : 'direct'},
                    onSelectionChanged: _locked
                        ? null
                        : (value) {
                            final usePlugin = value.first == 'plugin';
                            setState(() => _pluginMode = usePlugin);
                            if (usePlugin && _plugins.isEmpty) _loadPlugins();
                          },
                  ),
                  const SizedBox(height: 12),
                ],
                if (_plugin)
                  if (_initial['personalPluginKey']?.toString().isNotEmpty ==
                          true &&
                      _pluginBinding.isEmpty)
                    Text(
                      mobileText(
                        context,
                        '执行方式：{0}\n个人插件和参数保持原配置，保存前由服务端校验。',
                        values: [_initial['personalPluginKey'].toString()],
                      ),
                    )
                  else
                    _pluginEditor()
                else ...[
                  if (_loading) const LinearProgressIndicator(),
                  MobileSelectField<String>(
                    compact: true,
                    key: ValueKey('automation-agent-$_agent-${_agents.length}'),
                    initialValue: _agent.isEmpty ? null : _agent,
                    decoration: InputDecoration(
                      labelText: mobileText(context, '执行底座'),
                    ),
                    items: [
                      if (_agent.isNotEmpty && !selectedKnown)
                        DropdownMenuItem(
                          value: _agent,
                          child: Text(
                            mobileText(
                              context,
                              '原执行底座 · {0}',
                              values: [_agent],
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      for (final agent in _agents)
                        DropdownMenuItem(
                          value: agent['key'] as String,
                          enabled: agent['available'] != false,
                          child: Text(
                            (agent['name'] ?? agent['key']).toString() +
                                ((agent['locationLabel']
                                            ?.toString()
                                            .isNotEmpty ??
                                        false)
                                    ? ' · ${agent['locationLabel']}'
                                    : '') +
                                (agent['available'] == false ? ' · 暂不可用' : ''),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: _locked || _loading
                        ? null
                        : (value) => setState(() => _agent = value ?? ''),
                  ),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    key: const Key('automation-model'),
                    onPressed: _locked
                        ? null
                        : () async {
                            final selected = await showWorkModelPicker(context);
                            if (!_current || selected == null) return;
                            setState(() => _modelName = selected.name);
                          },
                    icon: const Icon(Icons.auto_awesome_outlined),
                    label: Text(
                      _modelName.isEmpty
                          ? mobileText(context, '执行模型 · 自动选择')
                          : mobileText(
                              context,
                              '执行模型 · {0}',
                              values: [_modelName],
                            ),
                    ),
                  ),
                  if (_modelName.isNotEmpty)
                    TextButton(
                      onPressed: _locked
                          ? null
                          : () => setState(() => _modelName = ''),
                      child: Text(mobileText(context, '恢复自动选择模型')),
                    ),
                  if (_directoryError.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(mobileText(context, _directoryError)),
                    ),
                  TextButton.icon(
                    onPressed: _locked || _loading ? null : _loadAgents,
                    icon: const Icon(Icons.refresh),
                    label: Text(mobileText(context, '刷新执行底座')),
                  ),
                ],
                if (_preflightMessage.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text(_preflightMessage),
                  ),
                if (_error.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text(
                      _error,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _locked ? null : _save,
                  child: Text(
                    _busy
                        ? mobileText(context, '正在检查并保存…')
                        : widget.schedule == null
                        ? mobileText(context, '保存为暂停计划')
                        : mobileText(context, '保存更改'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

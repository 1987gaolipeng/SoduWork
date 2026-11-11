import 'mobile_select_field.dart';
import 'mobile_display_preferences.dart';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/work_capability.dart';
import '../state/mobile_scope.dart';
import 'mobile_theme.dart';

Future<Map<String, dynamic>?> showWorkflowInputs(
  BuildContext context, {
  required WorkCapability capability,
  required String instruction,
}) => showModalBottomSheet<Map<String, dynamic>>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  backgroundColor: context.soduWorkTheme.surface,
  constraints: const BoxConstraints(maxWidth: 600),
  shape: const RoundedRectangleBorder(
    borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
  ),
  builder: (_) =>
      WorkflowInputsSheet(capability: capability, instruction: instruction),
);

/// The form contract also projects away unknown values before returning them.
class WorkflowInputSchema {
  final List<WorkflowInputField> fields;
  WorkflowInputSchema._(this.fields);

  factory WorkflowInputSchema.fromCapability(WorkCapability capability) {
    if (capability.kind != WorkCapabilityKind.workflow || !capability.enabled) {
      throw FormatException(
        capability.reason.isEmpty ? '当前工作流不可执行' : capability.reason,
      );
    }
    final source = capability.metadata['inputs'] ?? const [];
    if (source is! List || source.length > 50) {
      throw const FormatException('工作流参数格式无法识别，请刷新目录');
    }
    final fields = <WorkflowInputField>[], keys = <String>{};
    for (final raw in source) {
      if (raw is! Map) throw const FormatException('工作流参数必须为字段对象');
      final key = raw['key'];
      if (key is! String ||
          !RegExp(r'^[A-Za-z][A-Za-z0-9_-]{0,63}$').hasMatch(key) ||
          !keys.add(key)) {
        throw const FormatException('工作流字段名称无效或重复，不能继续');
      }
      if (raw.containsKey('required') && raw['required'] is! bool) {
        throw FormatException('参数 $key 的必填规则无效');
      }
      final declared = raw['type'] ?? 'text';
      if (declared is! String) throw FormatException('参数 $key 的类型无法识别');
      var type =
          const {
            'bool': 'boolean',
            'string': 'text',
            'enum': 'select',
          }[declared] ??
          declared;
      if (type == 'text' && raw['multiline'] == true) type = 'textarea';
      if (!const {
        'text',
        'textarea',
        'boolean',
        'number',
        'select',
      }.contains(type)) {
        throw FormatException('参数 $key 使用了暂不支持的类型：$type，不能继续');
      }
      final options = <String, String>{};
      if (type == 'select') {
        final values = raw['options'];
        if (values is! List || values.isEmpty || values.length > 50) {
          throw FormatException('参数 $key 的选项无效');
        }
        for (final item in values) {
          final value = item is Map ? item['value'] : item;
          if (value is! String && value is! num && value is! bool) {
            throw FormatException('参数 $key 的选项无效');
          }
          final text = value.toString();
          if (text.isEmpty ||
              text.runes.length > 200 ||
              options.containsKey(text)) {
            throw FormatException('参数 $key 的选项为空或重复');
          }
          final label = item is Map ? item['label'] : null;
          options[text] = label is String && label.isNotEmpty ? label : text;
        }
      }
      final field = WorkflowInputField(
        key: key,
        label:
            raw['label'] is String && (raw['label'] as String).trim().isNotEmpty
            ? raw['label'] as String
            : key,
        type: type,
        isRequired: raw['required'] == true,
        description: raw['description'] is String
            ? raw['description'] as String
            : '',
        placeholder: raw['placeholder'] is String
            ? raw['placeholder'] as String
            : '',
        options: Map.unmodifiable(options),
        defaultValue: raw['default'],
      );
      if (raw.containsKey('default')) {
        final value = raw['default'];
        if (type == 'boolean' && value is! bool ||
            type == 'number' && value is! num ||
            (type == 'text' || type == 'textarea') && value is! String ||
            type == 'select' && !options.containsKey(value?.toString())) {
          throw FormatException('参数 $key 的默认值与字段类型不符');
        }
        field.normalize(value, checkRequired: false);
      }
      fields.add(field);
    }
    return WorkflowInputSchema._(List.unmodifiable(fields));
  }

  Map<String, dynamic> collect(Map<String, dynamic> values) {
    final result = <String, dynamic>{};
    for (final field in fields) {
      final value = field.normalize(
        values.containsKey(field.key) ? values[field.key] : field.defaultValue,
      );
      if (value != null) result[field.key] = value;
    }
    final serializedLength =
        jsonEncode(result).runes.length +
        (result.isEmpty ? 0 : result.length * 2 - 1);
    if (serializedLength > 100000) {
      throw const FormatException('参数合计超过100000字符，请缩短后重新确认');
    }
    return result;
  }
}

class WorkflowInputField {
  final String key, label, type, description, placeholder;
  final bool isRequired;
  final Map<String, String> options;
  final dynamic defaultValue;
  WorkflowInputField({
    required this.key,
    required this.label,
    required this.type,
    required this.isRequired,
    required this.description,
    required this.placeholder,
    required this.options,
    this.defaultValue,
  });

  dynamic normalize(dynamic value, {bool checkRequired = true}) {
    if (value == null || value is String && value.trim().isEmpty) {
      if (isRequired && checkRequired) throw FormatException('请填写$label');
      return null;
    }
    if (type == 'boolean') {
      if (value is! bool) throw FormatException('$label必须选择是或否');
      return value;
    }
    if (type == 'number') {
      if (value is String && value.runes.length > 8000) {
        throw FormatException('$label最多输入8000个字符');
      }
      final number = value is num
          ? value
          : value is String
          ? num.tryParse(value.trim())
          : null;
      if (number == null || !number.isFinite) {
        throw FormatException('$label必须为有效数字');
      }
      return number;
    }
    if (type == 'select') {
      final text = value is String || value is num || value is bool
          ? value.toString()
          : '';
      if (!options.containsKey(text)) throw FormatException('请为$label选择有效选项');
      return text;
    }
    if (value is! String) throw FormatException('$label必须为文本');
    if (value.runes.length > 8000) throw FormatException('$label最多输入8000个字符');
    return value;
  }

  String? error(dynamic value) {
    try {
      normalize(value);
      return null;
    } on FormatException catch (error) {
      return error.message;
    }
  }
}

class WorkflowInputsSheet extends StatefulWidget {
  final WorkCapability capability;
  final String instruction;
  const WorkflowInputsSheet({
    super.key,
    required this.capability,
    required this.instruction,
  });
  @override
  State<WorkflowInputsSheet> createState() => _WorkflowInputsSheetState();
}

class _WorkflowInputsSheetState extends State<WorkflowInputsSheet> {
  final _form = GlobalKey<FormState>();
  final _values = <String, dynamic>{};
  WorkflowInputSchema? _schema;
  String _error = '';
  int? _identity;
  Object? _identityOwner;

  @override
  void initState() {
    super.initState();
    try {
      _schema = WorkflowInputSchema.fromCapability(widget.capability);
      for (final field in _schema!.fields) {
        if (field.defaultValue != null) _values[field.key] = field.defaultValue;
      }
    } on FormatException catch (error) {
      _error = error.message;
    }
  }

  bool get _current {
    final state = MobileScope.maybeOf(context);
    return state == null
        ? _identityOwner == null
        : identical(state, _identityOwner) &&
              _identity == state.identityRevision;
  }

  void _confirm() {
    if (!_current || _schema == null || !_form.currentState!.validate()) return;
    try {
      Navigator.pop(context, _schema!.collect(_values));
    } on FormatException catch (error) {
      setState(() {
        _error = error.message;
      });
    }
  }

  Widget _field(WorkflowInputField field) {
    final label = field.label + (field.isRequired ? ' *' : '');
    if (field.type == 'boolean') {
      return FormField<bool>(
        key: ValueKey('work-input:${field.key}'),
        initialValue: field.defaultValue as bool?,
        validator: field.error,
        builder: (state) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(label),
              subtitle: field.description.isEmpty
                  ? null
                  : Text(field.description),
              tristate: true,
              value: state.value,
              onChanged: (value) {
                state.didChange(value);
                _values[field.key] = value;
              },
            ),
            if (state.hasError)
              Text(
                state.errorText!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      );
    }
    final decoration = InputDecoration(
      labelText: label,
      counterText: field.type == 'number' ? '' : null,
      hintText: field.placeholder.isEmpty ? null : field.placeholder,
      helperText: field.description.isEmpty ? null : field.description,
      helperMaxLines: 5,
      errorMaxLines: 4,
    );
    if (field.type == 'select') {
      return MobileSelectField<String>(
        key: ValueKey('work-input:${field.key}'),
        initialValue: field.defaultValue?.toString(),

        decoration: decoration,
        items: [
          for (final option in field.options.entries)
            DropdownMenuItem(
              value: option.key,
              child: Text(option.value, overflow: TextOverflow.ellipsis),
            ),
        ],
        validator: field.error,
        onChanged: (value) {
          _values[field.key] = value;
        },
      );
    }
    return TextFormField(
      key: ValueKey('work-input:${field.key}'),
      initialValue: field.defaultValue?.toString() ?? '',
      decoration: decoration,
      minLines: field.type == 'textarea' ? 3 : 1,
      maxLines: field.type == 'textarea' ? 8 : 1,
      maxLength: 8000,
      maxLengthEnforcement: MaxLengthEnforcement.none,
      keyboardType: field.type == 'number'
          ? const TextInputType.numberWithOptions(decimal: true, signed: true)
          : TextInputType.multiline,
      textInputAction: field.type == 'textarea'
          ? TextInputAction.newline
          : TextInputAction.next,
      validator: field.error,
      onChanged: (value) {
        _values[field.key] = value;
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    if (MobileScope.maybeOf(context) != null) {
      final state = MobileScope.of(context);
      _identity ??= state.identityRevision;
      _identityOwner ??= state;
    }
    final theme = context.soduWorkTheme;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * .8,
        child: Column(
          children: [
            Expanded(
              child: !_current
                  ? Center(
                      child: Padding(
                        padding: EdgeInsets.all(24),
                        child: Text(mobileText(context, '账号已切换，请关闭后重新填写。')),
                      ),
                    )
                  : Form(
                      key: _form,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                        children: [
                          Text(
                            mobileText(context, '确认工作流参数'),
                            style: TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w600,
                              color: theme.ink,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            widget.capability.label,
                            style: TextStyle(color: theme.inkSecondary),
                          ),
                          const SizedBox(height: 20),
                          Text(
                            mobileText(context, '工作说明'),
                            style: TextStyle(fontWeight: FontWeight.w600),
                          ),
                          const SizedBox(height: 8),
                          SelectableText(widget.instruction),
                          const SizedBox(height: 8),
                          Text(
                            mobileText(context, '工作说明独立提交，不会自动填入插件参数。'),
                            style: TextStyle(color: theme.inkMuted),
                          ),
                          const SizedBox(height: 20),
                          if (_schema == null)
                            Text(
                              _error,
                              style: TextStyle(
                                color: Theme.of(context).colorScheme.error,
                              ),
                            )
                          else ...[
                            if (_schema!.fields.isEmpty)
                              Text(mobileText(context, '此工作流无需额外参数。')),
                            for (final field in _schema!.fields)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 18),
                                child: _field(field),
                              ),
                            if (_error.isNotEmpty)
                              Text(
                                _error,
                                style: TextStyle(
                                  color: Theme.of(context).colorScheme.error,
                                ),
                              ),
                          ],
                        ],
                      ),
                    ),
            ),
            DecoratedBox(
              decoration: BoxDecoration(
                border: Border(top: BorderSide(color: theme.line)),
              ),
              child: SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
                  child: Row(
                    children: [
                      TextButton(
                        onPressed: () => Navigator.pop(context),
                        style: TextButton.styleFrom(
                          minimumSize: const Size(64, 48),
                        ),
                        child: Text(mobileText(context, '取消')),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: FilledButton(
                          style: FilledButton.styleFrom(
                            minimumSize: const Size(44, 48),
                            backgroundColor: theme.ink,
                            foregroundColor: SoduWorkTheme.readableOn(theme.ink),
                          ),
                          onPressed: _schema != null && _current
                              ? _confirm
                              : null,
                          child: Text(mobileText(context, '确认参数')),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

import 'dart:convert';

/// PC maker contract: public inputs and per-user installation preferences.
const pluginInputTypes = <String, String>{
  'text': '单行文本',
  'textarea': '多行文本',
  'boolean': '开关',
  'number': '数字',
  'select': '单选',
};
const pluginPreferenceTypes = <String, String>{
  ...pluginInputTypes,
  'multiselect': '多选',
  'url': '网址',
};

Map<String, dynamic> copyPluginField(Map<String, dynamic> value) =>
    Map<String, dynamic>.from(jsonDecode(jsonEncode(value)) as Map);
List<Map<String, dynamic>> pluginPreferenceFields(Map<String, dynamic> setup) =>
    (setup['preferences'] is List ? setup['preferences'] as List : [])
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
String pluginFieldType(dynamic value) {
  final raw = value?.toString().toLowerCase() ?? 'text';
  return const {'string': 'text', 'bool': 'boolean', 'enum': 'select'}[raw] ??
      raw;
}

dynamic pluginOptionValue(dynamic option) =>
    option is Map ? option['value'] : option;
String pluginOptionLabel(dynamic option) => option is Map
    ? (option['label'] ?? option['value'] ?? '').toString()
    : option?.toString() ?? '';

/// Do not coerce defaults into labels or strings: 1 and "1" are different values.
List<String> validatePluginFields(
  List<Map<String, dynamic>> inputs,
  Map<String, dynamic> setup,
) {
  final errors = <String>[];
  void validate(List<Map<String, dynamic>> fields, bool preference) {
    final keys = <String>{};
    for (final field in fields) {
      final key = field['key']?.toString() ?? '';
      final label = (field['label'] ?? key).toString();
      final type = pluginFieldType(field['type']);
      if (!RegExp(r'^[A-Za-z][A-Za-z0-9_-]{0,63}$').hasMatch(key) ||
          !keys.add(key)) {
        errors.add('参数标识不合法或重复：$key');
      }
      if (label.trim().isEmpty) errors.add('参数显示名称不能为空');
      if (!(preference ? pluginPreferenceTypes : pluginInputTypes).containsKey(
        type,
      )) {
        errors.add('「$label」不支持参数类型：$type');
      }
      final options = field['options'] is List ? field['options'] as List : [];
      final values = <dynamic>[];
      if (type == 'select' || type == 'multiselect') {
        if (options.isEmpty) errors.add('「$label」至少需要一个选项');
        for (final option in options) {
          final value = pluginOptionValue(option);
          if (value == null ||
              value is List ||
              value is Map ||
              (value is num && !value.isFinite) ||
              (value is String && value.isEmpty) ||
              values.contains(value)) {
            errors.add('「$label」选项值不能为空、重复或使用复杂对象');
          }
          values.add(value);
        }
      }
      final minimum = field['minimum'], maximum = field['maximum'];
      final minLength = field['minLength'], maxLength = field['maxLength'];
      if (preference) {
        if (minimum != null && (minimum is! num || !minimum.isFinite) ||
            maximum != null && (maximum is! num || !maximum.isFinite)) {
          errors.add('「$label」数值范围必须为有限数字');
        }
        if (minimum is num && maximum is num && minimum > maximum) {
          errors.add('「$label」最小值不能大于最大值');
        }
        if (minLength != null &&
                (minLength is! int || minLength < 0 || minLength > 8000) ||
            maxLength != null &&
                (maxLength is! int || maxLength < 1 || maxLength > 8000)) {
          errors.add('「$label」长度限制必须为有效整数，最多 8000');
        }
        if (minLength is int && maxLength is int && minLength > maxLength) {
          errors.add('「$label」最小长度不能大于最大长度');
        }
      }
      if (!field.containsKey('default')) continue;
      final value = field['default'];
      if (type == 'boolean' && value is! bool) {
        errors.add('「$label」默认值必须为开或关');
      }
      if (type == 'number' && (value is! num || !value.isFinite)) {
        errors.add('「$label」默认值必须为有限数字');
      }
      if (type == 'select' && !values.contains(value)) {
        errors.add('「$label」默认值必须匹配选项的真实值');
      }
      if (type == 'multiselect' &&
          (value is! List ||
              value.any((item) => !values.contains(item)) ||
              value.toSet().length != value.length)) {
        errors.add('「$label」默认多选值必须来自选项且不能重复');
      }
      if (const {'text', 'textarea', 'url'}.contains(type) &&
          value is! String) {
        errors.add('「$label」默认值必须为文本');
      }
      if (type == 'url' && value is String && value.isNotEmpty) {
        final url = Uri.tryParse(value);
        if (url == null ||
            !const {'http', 'https'}.contains(url.scheme) ||
            url.host.isEmpty) {
          errors.add('「$label」默认网址必须为有效 HTTP(S) 地址');
        }
      }
      if (value is num) {
        if (minimum is num && value < minimum ||
            maximum is num && value > maximum) {
          errors.add('「$label」默认值超出数值范围');
        }
      }
      if (value is String &&
          (minLength is int && value.length < minLength ||
              maxLength is int && value.length > maxLength)) {
        errors.add('「$label」默认值超出长度范围');
      }
    }
  }

  validate(inputs, false);
  validate(pluginPreferenceFields(setup), true);
  return errors.toSet().toList();
}

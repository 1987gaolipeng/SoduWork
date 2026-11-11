import 'package:flutter/material.dart';

import 'mobile_display_preferences.dart';
import 'mobile_sheet.dart';
import 'mobile_sheet_pages.dart';

String automationTemplateText(
  Map<String, dynamic> item,
  String field,
  String locale,
) {
  final translations = item['${field}Locales'];
  if (locale != 'zh-CN' && translations is Map) {
    final value = translations[locale];
    if (value is String && value.trim().isNotEmpty) return value;
  }
  return item[field]?.toString() ?? '';
}

/// Same allowlisted defaults as the desktop recipe. Identity, enabled state and
/// personal credentials can never be supplied by a template.
Map<String, dynamic> automationTemplateValues(
  Map<String, dynamic> item,
  String locale,
) => {
  'title': automationTemplateText(item, 'title', locale).isNotEmpty
      ? automationTemplateText(item, 'title', locale)
      : automationTemplateText(item, 'name', locale),
  'note': automationTemplateText(item, 'note', locale),
  for (final key in const [
    'every',
    'atHour',
    'atMinute',
    'weekday',
    'timeZone',
    'requiredCapabilities',
    'retryLimit',
    'retryDelayMinutes',
    'pluginBindingId',
    'pluginInputs',
  ])
    if (item[key] != null) key: item[key],
};

Future<Map<String, dynamic>?> showAutomationTemplates(
  BuildContext context,
  List<Map<String, dynamic>> templates,
) {
  final nested = MobileSheetPages.maybeOf(context) != null;
  final presentationNavigator = Navigator.of(context);
  final locale =
      MobileDisplayScope.maybeOf(context)?.language == MobileLanguage.english
      ? 'en-US'
      : 'zh-CN';
  return showMobileSheet<Map<String, dynamic>>(
    context,
    title: '自动化模板',
    builder: (context, scroll) => Material(
      type: MaterialType.transparency,
      child: ListView.separated(
        controller: scroll,
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
        itemCount: templates.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final item = templates[index];
          final description = automationTemplateText(
            item,
            'description',
            locale,
          );
          return ListTile(
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 4,
              vertical: 8,
            ),
            leading: const Icon(Icons.auto_awesome_motion_outlined),
            title: Text(automationTemplateText(item, 'name', locale)),
            subtitle: description.isEmpty
                ? null
                : Text(
                    description,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
            trailing: const Icon(Icons.chevron_right_rounded),
            onTap: () =>
                (nested ? Navigator.of(context) : presentationNavigator).pop(
                  automationTemplateValues(item, locale),
                ),
          );
        },
      ),
    ),
  );
}

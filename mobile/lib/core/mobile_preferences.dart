import 'package:shared_preferences/shared_preferences.dart';

/// Presentation preferences contain no account identity or conversation data.
class MobilePreferences {
  static const _appearanceKey = 'soduwork_mobile.dark_appearance';

  static Future<bool?> darkAppearance() async =>
      (await SharedPreferences.getInstance()).getBool(_appearanceKey);

  static Future<void> saveDarkAppearance(bool dark) async {
    final saved = await (await SharedPreferences.getInstance()).setBool(
      _appearanceKey,
      dark,
    );
    if (!saved) throw StateError('appearance preference was not saved');
  }

  static Future<Map<String, String>> presentation() async {
    final prefs = await SharedPreferences.getInstance();
    final legacy = prefs.getBool(_appearanceKey);
    return {
      'appearance':
          prefs.getString('soduwork_mobile.appearance') ??
          (legacy == null
              ? 'system'
              : legacy
              ? 'dark'
              : 'light'),
      'language': prefs.getString('soduwork_mobile.language') ?? 'chinese',
      'accent': prefs.getString('soduwork_mobile.accent') ?? 'brand',
    };
  }

  static Future<void> savePresentation(Map<String, String> values) async {
    final prefs = await SharedPreferences.getInstance();
    for (final key in ['appearance', 'language', 'accent']) {
      if (!await prefs.setString('soduwork_mobile.$key', values[key]!)) {
        throw StateError('presentation preference was not saved');
      }
    }
    final mode = values['appearance'];
    if (mode == 'system') {
      await prefs.remove(_appearanceKey);
    } else {
      await saveDarkAppearance(mode == 'dark');
    }
  }
}

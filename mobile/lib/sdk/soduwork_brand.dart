import 'package:flutter/material.dart';

typedef SoduWorkMarkBuilder = Widget Function(BuildContext context, double size);

@immutable
class SoduWorkBrandAssets {
  final SoduWorkMarkBuilder? markBuilder;

  const SoduWorkBrandAssets({this.markBuilder});
}

@immutable
class SoduWorkBrandTheme extends ThemeExtension<SoduWorkBrandTheme> {
  final String brandName;
  final String assistantName;
  final Brightness brightness;
  final String fontFamily;
  final List<String> fontFallbacks;
  final Color canvas;
  final Color surface;
  final Color surfaceMuted;
  final Color surfaceRaised;
  final Color ink;
  final Color inkSecondary;
  final Color inkMuted;
  final Color line;
  final Color lineStrong;
  final Color primary;
  final Color primarySoft;
  final Color secondary;
  final Color secondarySoft;
  final Color success;
  final Color successSoft;
  final Color warning;
  final Color warningSoft;
  final Color danger;
  final Color dangerSoft;
  final List<Color> markColors;
  final double radiusSmall;
  final double radiusMedium;
  final double radiusLarge;

  const SoduWorkBrandTheme({
    this.brandName = 'SoduWork',
    this.assistantName = 'SoduWork',
    this.brightness = Brightness.light,
    this.fontFamily = 'Noto Sans SC',
    this.fontFallbacks = const [
      'Noto Sans SC',
      'Alibaba PuHuiTi 3',
      'HarmonyOS Sans SC',
      'Noto Sans CJK SC',
      'PingFang SC',
      'Arial',
    ],
    this.canvas = const Color(0xFFFAF9FC),
    this.surface = const Color(0xFFFFFFFF),
    this.surfaceMuted = const Color(0xFFF2F1F5),
    this.surfaceRaised = const Color(0xFFFEFDFE),
    this.ink = const Color(0xFF24232A),
    this.inkSecondary = const Color(0xFF625E6B),
    this.inkMuted = const Color(0xFF77727F),
    this.line = const Color(0xFFEAE7EF),
    this.lineStrong = const Color(0xFFDCD7E4),
    this.primary = const Color(0xFF7153A6),
    this.primarySoft = const Color(0xFFF0EAF8),
    this.secondary = const Color(0xFF3976E8),
    this.secondarySoft = const Color(0xFFEBF2FF),
    this.success = const Color(0xFF149C73),
    this.successSoft = const Color(0xFFE8F7F2),
    this.warning = const Color(0xFFD68A16),
    this.warningSoft = const Color(0xFFFFF3DF),
    this.danger = const Color(0xFFE51C32),
    this.dangerSoft = const Color(0xFFFFECEF),
    this.markColors = const [
      Color(0xFFD68A16),
      Color(0xFF3976E8),
      Color(0xFF149C73),
      Color(0xFFE51C32),
    ],
    this.radiusSmall = 10,
    this.radiusMedium = 14,
    this.radiusLarge = 18,
  });

  factory SoduWorkBrandTheme.fromJson(
    Map<String, dynamic> json, {
    SoduWorkBrandTheme fallback = const SoduWorkBrandTheme(),
  }) {
    final schemaVersion = json['schemaVersion'];
    if (schemaVersion != null && schemaVersion.toString().trim() != '1') {
      return fallback;
    }
    final colors = _map(json['colors']);
    final shape = _map(json['shape']);
    final typography = _map(json['typography']);
    final mark = (json['markColors'] as List?)
        ?.map((value) => _color(value, null))
        .whereType<Color>()
        .take(4)
        .toList(growable: false);
    return fallback.copyWith(
      brandName: _label(json['brandName'], fallback.brandName),
      assistantName: _label(json['assistantName'], fallback.assistantName),
      brightness: json['brightness'] == 'dark'
          ? Brightness.dark
          : json['brightness'] == 'light'
          ? Brightness.light
          : fallback.brightness,
      fontFamily: _label(typography['fontFamily'], fallback.fontFamily),
      fontFallbacks:
          _stringList(typography['fallbacks']) ?? fallback.fontFallbacks,
      canvas: _color(colors['canvas'], fallback.canvas),
      surface: _color(colors['surface'], fallback.surface),
      surfaceMuted: _color(colors['surfaceMuted'], fallback.surfaceMuted),
      surfaceRaised: _color(colors['surfaceRaised'], fallback.surfaceRaised),
      ink: _color(colors['ink'], fallback.ink),
      inkSecondary: _color(colors['inkSecondary'], fallback.inkSecondary),
      inkMuted: _color(colors['inkMuted'], fallback.inkMuted),
      line: _color(colors['line'], fallback.line),
      lineStrong: _color(colors['lineStrong'], fallback.lineStrong),
      primary: _color(colors['primary'], fallback.primary),
      primarySoft: _color(colors['primarySoft'], fallback.primarySoft),
      secondary: _color(colors['secondary'], fallback.secondary),
      secondarySoft: _color(colors['secondarySoft'], fallback.secondarySoft),
      success: _color(colors['success'], fallback.success),
      successSoft: _color(colors['successSoft'], fallback.successSoft),
      warning: _color(colors['warning'], fallback.warning),
      warningSoft: _color(colors['warningSoft'], fallback.warningSoft),
      danger: _color(colors['danger'], fallback.danger),
      dangerSoft: _color(colors['dangerSoft'], fallback.dangerSoft),
      markColors: mark?.length == 4 ? mark : fallback.markColors,
      radiusSmall: _radius(shape['small'], fallback.radiusSmall),
      radiusMedium: _radius(shape['medium'], fallback.radiusMedium),
      radiusLarge: _radius(shape['large'], fallback.radiusLarge),
    );
  }

  Map<String, dynamic> toJson() => {
    'schemaVersion': 1,
    'brandName': brandName,
    'assistantName': assistantName,
    'brightness': brightness.name,
    'typography': {'fontFamily': fontFamily, 'fallbacks': fontFallbacks},
    'colors': {
      'canvas': _hex(canvas),
      'surface': _hex(surface),
      'surfaceMuted': _hex(surfaceMuted),
      'surfaceRaised': _hex(surfaceRaised),
      'ink': _hex(ink),
      'inkSecondary': _hex(inkSecondary),
      'inkMuted': _hex(inkMuted),
      'line': _hex(line),
      'lineStrong': _hex(lineStrong),
      'primary': _hex(primary),
      'primarySoft': _hex(primarySoft),
      'secondary': _hex(secondary),
      'secondarySoft': _hex(secondarySoft),
      'success': _hex(success),
      'successSoft': _hex(successSoft),
      'warning': _hex(warning),
      'warningSoft': _hex(warningSoft),
      'danger': _hex(danger),
      'dangerSoft': _hex(dangerSoft),
    },
    'markColors': effectiveMarkColors.map(_hex).toList(growable: false),
    'shape': {
      'small': radiusSmall,
      'medium': radiusMedium,
      'large': radiusLarge,
    },
  };

  @override
  SoduWorkBrandTheme copyWith({
    String? brandName,
    String? assistantName,
    Brightness? brightness,
    String? fontFamily,
    List<String>? fontFallbacks,
    Color? canvas,
    Color? surface,
    Color? surfaceMuted,
    Color? surfaceRaised,
    Color? ink,
    Color? inkSecondary,
    Color? inkMuted,
    Color? line,
    Color? lineStrong,
    Color? primary,
    Color? primarySoft,
    Color? secondary,
    Color? secondarySoft,
    Color? success,
    Color? successSoft,
    Color? warning,
    Color? warningSoft,
    Color? danger,
    Color? dangerSoft,
    List<Color>? markColors,
    double? radiusSmall,
    double? radiusMedium,
    double? radiusLarge,
  }) => SoduWorkBrandTheme(
    brandName: brandName ?? this.brandName,
    assistantName: assistantName ?? this.assistantName,
    brightness: brightness ?? this.brightness,
    fontFamily: fontFamily ?? this.fontFamily,
    fontFallbacks: fontFallbacks ?? this.fontFallbacks,
    canvas: canvas ?? this.canvas,
    surface: surface ?? this.surface,
    surfaceMuted: surfaceMuted ?? this.surfaceMuted,
    surfaceRaised: surfaceRaised ?? this.surfaceRaised,
    ink: ink ?? this.ink,
    inkSecondary: inkSecondary ?? this.inkSecondary,
    inkMuted: inkMuted ?? this.inkMuted,
    line: line ?? this.line,
    lineStrong: lineStrong ?? this.lineStrong,
    primary: primary ?? this.primary,
    primarySoft: primarySoft ?? this.primarySoft,
    secondary: secondary ?? this.secondary,
    secondarySoft: secondarySoft ?? this.secondarySoft,
    success: success ?? this.success,
    successSoft: successSoft ?? this.successSoft,
    warning: warning ?? this.warning,
    warningSoft: warningSoft ?? this.warningSoft,
    danger: danger ?? this.danger,
    dangerSoft: dangerSoft ?? this.dangerSoft,
    markColors: markColors ?? this.markColors,
    radiusSmall: radiusSmall ?? this.radiusSmall,
    radiusMedium: radiusMedium ?? this.radiusMedium,
    radiusLarge: radiusLarge ?? this.radiusLarge,
  );

  @override
  SoduWorkBrandTheme lerp(covariant SoduWorkBrandTheme? other, double t) {
    if (other == null) return this;
    final fromMarkColors = effectiveMarkColors;
    final toMarkColors = other.effectiveMarkColors;
    return copyWith(
      brandName: t < .5 ? brandName : other.brandName,
      assistantName: t < .5 ? assistantName : other.assistantName,
      brightness: t < .5 ? brightness : other.brightness,
      fontFamily: t < .5 ? fontFamily : other.fontFamily,
      fontFallbacks: t < .5 ? fontFallbacks : other.fontFallbacks,
      canvas: Color.lerp(canvas, other.canvas, t),
      surface: Color.lerp(surface, other.surface, t),
      surfaceMuted: Color.lerp(surfaceMuted, other.surfaceMuted, t),
      surfaceRaised: Color.lerp(surfaceRaised, other.surfaceRaised, t),
      ink: Color.lerp(ink, other.ink, t),
      inkSecondary: Color.lerp(inkSecondary, other.inkSecondary, t),
      inkMuted: Color.lerp(inkMuted, other.inkMuted, t),
      line: Color.lerp(line, other.line, t),
      lineStrong: Color.lerp(lineStrong, other.lineStrong, t),
      primary: Color.lerp(primary, other.primary, t),
      primarySoft: Color.lerp(primarySoft, other.primarySoft, t),
      secondary: Color.lerp(secondary, other.secondary, t),
      secondarySoft: Color.lerp(secondarySoft, other.secondarySoft, t),
      success: Color.lerp(success, other.success, t),
      successSoft: Color.lerp(successSoft, other.successSoft, t),
      warning: Color.lerp(warning, other.warning, t),
      warningSoft: Color.lerp(warningSoft, other.warningSoft, t),
      danger: Color.lerp(danger, other.danger, t),
      dangerSoft: Color.lerp(dangerSoft, other.dangerSoft, t),
      markColors: List.generate(
        4,
        (index) => Color.lerp(fromMarkColors[index], toMarkColors[index], t)!,
        growable: false,
      ),
      radiusSmall: _lerpDouble(radiusSmall, other.radiusSmall, t),
      radiusMedium: _lerpDouble(radiusMedium, other.radiusMedium, t),
      radiusLarge: _lerpDouble(radiusLarge, other.radiusLarge, t),
    );
  }

  static Map<String, dynamic> _map(dynamic value) => value is Map
      ? value.map((key, item) => MapEntry(key.toString(), item))
      : const {};

  static String _label(dynamic value, String fallback) {
    final text = value?.toString().trim() ?? '';
    return text.isEmpty
        ? fallback
        : text.substring(0, text.length.clamp(0, 40));
  }

  static List<String>? _stringList(dynamic value) {
    if (value is! List) return null;
    final rows = value
        .map((item) => item.toString().trim())
        .where((item) => item.isNotEmpty)
        .map((item) => item.substring(0, item.length.clamp(0, 80)))
        .take(8)
        .toList(growable: false);
    return rows.isEmpty ? null : rows;
  }

  List<Color> get effectiveMarkColors {
    final defaults = const SoduWorkBrandTheme().markColors;
    return List.generate(
      4,
      (index) =>
          index < markColors.length ? markColors[index] : defaults[index],
      growable: false,
    );
  }

  static double _radius(dynamic value, double fallback) {
    final number = value is num ? value.toDouble() : double.tryParse('$value');
    if (number == null || !number.isFinite) return fallback;
    return number.clamp(0, 32).toDouble();
  }

  static Color? _color(dynamic value, Color? fallback) {
    if (value is int) {
      return value >= 0 && value <= 0xFFFFFFFF ? Color(value) : fallback;
    }
    final raw = value?.toString().trim().replaceFirst('#', '') ?? '';
    final normalized = raw.length == 6 ? 'FF$raw' : raw;
    if (normalized.length != 8) return fallback;
    final parsed = int.tryParse(normalized, radix: 16);
    return parsed == null ? fallback : Color(parsed);
  }

  static String _hex(Color color) =>
      '#${color.toARGB32().toRadixString(16).padLeft(8, '0').toUpperCase()}';

  static double _lerpDouble(double a, double b, double t) => a + (b - a) * t;
}

class SoduWorkBrandController extends ValueNotifier<SoduWorkBrandTheme> {
  SoduWorkBrandAssets? _assetsOverride;

  SoduWorkBrandController([
    super.value = const SoduWorkBrandTheme(),
    SoduWorkBrandAssets? assets,
  ]) : _assetsOverride = assets;

  SoduWorkBrandTheme get theme => value;

  void updateTheme(SoduWorkBrandTheme theme) => value = theme;

  SoduWorkBrandAssets resolveAssets(SoduWorkBrandAssets fallback) =>
      _assetsOverride ?? fallback;

  void updateAssets(SoduWorkBrandAssets assets) {
    _assetsOverride = assets;
    // Re-assign the theme value as well: mark swaps must rebuild even when the
    // theme fields are unchanged, so every listening surface re-reads assets.
    value = value.copyWith();
  }

  void resetAssets() {
    if (_assetsOverride == null) return;
    _assetsOverride = null;
    notifyListeners();
  }

  void applyManifest(Map<String, dynamic> manifest) {
    value = SoduWorkBrandTheme.fromJson(manifest, fallback: value);
  }
}

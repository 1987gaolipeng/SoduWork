import 'mobile_input_border.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../sdk/soduwork_brand.dart';

/// Default SoduWork colors kept for source compatibility. New UI reads the
/// contextual [SoduWorkBrandTheme] so multiple embedded workspaces can differ.
abstract final class SoduWorkPalette {
  static const canvas = Color(0xFFFAF9FC);
  static const surface = Color(0xFFFFFFFF);
  static const surfaceMuted = Color(0xFFF2F1F5);
  static const surfaceRaised = Color(0xFFFEFDFE);
  static const ink = Color(0xFF24232A);
  static const inkSecondary = Color(0xFF625E6B);
  static const inkMuted = Color(0xFF77727F);
  static const line = Color(0xFFEAE7EF);
  static const lineStrong = Color(0xFFDCD7E4);
  static const red = Color(0xFFE51C32);
  static const redSoft = Color(0xFFFFECEF);
  static const blue = Color(0xFF3976E8);
  static const blueSoft = Color(0xFFEBF2FF);
  static const green = Color(0xFF149C73);
  static const greenSoft = Color(0xFFE8F7F2);
  static const amber = Color(0xFFD68A16);
  static const amberSoft = Color(0xFFFFF3DF);
}

abstract final class SoduWorkTheme {
  static ThemeData light([
    SoduWorkBrandTheme brand = const SoduWorkBrandTheme(),
  ]) {
    final compactRadius = (brand.radiusMedium - 2).clamp(0, 32).toDouble();
    final cardRadius = (brand.radiusLarge - 2).clamp(0, 32).toDouble();
    final scheme =
        ColorScheme.fromSeed(
          seedColor: brand.primary,
          brightness: brand.brightness,
        ).copyWith(
          primary: brand.primary,
          onPrimary: readableOn(brand.primary),
          primaryContainer: brand.primarySoft,
          onPrimaryContainer: brand.ink,
          secondary: brand.secondary,
          onSecondary: readableOn(brand.secondary),
          secondaryContainer: brand.secondarySoft,
          onSecondaryContainer: brand.ink,
          surface: brand.surface,
          surfaceContainerLowest: brand.surface,
          surfaceContainerLow: brand.surfaceRaised,
          surfaceContainer: brand.surfaceMuted,
          surfaceContainerHigh: brand.surfaceMuted,
          surfaceContainerHighest: brand.surfaceMuted,
          onSurface: brand.ink,
          error: brand.danger,
          onError: readableOn(brand.danger),
          errorContainer: brand.dangerSoft,
          onErrorContainer: brand.ink,
          outline: brand.line,
          outlineVariant: brand.lineStrong,
        );
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: brand.canvas,
      fontFamily: brand.fontFamily,
      fontFamilyFallback: brand.fontFallbacks,
      splashFactory: InkSparkle.splashFactory,
      visualDensity: VisualDensity.standard,
      extensions: [brand],
    );
    return base.copyWith(
      textTheme: base.textTheme
          .copyWith(
            headlineLarge: TextStyle(
              fontSize: 24,
              height: 1.18,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.45,
              color: brand.ink,
            ),
            headlineMedium: TextStyle(
              fontSize: 20,
              height: 1.25,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.2,
              color: brand.ink,
            ),
            titleLarge: TextStyle(
              fontSize: 17,
              height: 1.4,
              fontWeight: FontWeight.w600,
              color: brand.ink,
            ),
            titleMedium: TextStyle(
              fontSize: 15.5,
              height: 1.4,
              fontWeight: FontWeight.w600,
              color: brand.ink,
            ),
            bodyLarge: TextStyle(
              fontSize: 15.5,
              height: 1.55,
              fontWeight: FontWeight.w400,
              color: brand.ink,
            ),
            bodyMedium: TextStyle(
              fontSize: 14,
              height: 1.5,
              fontWeight: FontWeight.w400,
              color: brand.inkSecondary,
            ),
            bodySmall: TextStyle(
              fontSize: 12.5,
              height: 1.45,
              fontWeight: FontWeight.w400,
              color: brand.inkMuted,
            ),
            labelLarge: const TextStyle(
              fontSize: 14,
              height: 1.3,
              fontWeight: FontWeight.w600,
            ),
          )
          .apply(
            fontFamily: brand.fontFamily,
            fontFamilyFallback: brand.fontFallbacks,
          ),
      appBarTheme: AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        backgroundColor: brand.surface,
        foregroundColor: brand.ink,
        surfaceTintColor: Colors.transparent,
        shape: const Border(),
        systemOverlayStyle: brand.brightness == Brightness.dark
            ? SystemUiOverlayStyle.light
            : SystemUiOverlayStyle.dark,
        titleTextStyle: TextStyle(
          fontFamily: brand.fontFamily,
          fontFamilyFallback: brand.fontFallbacks,
          fontSize: 17,
          height: 1.3,
          fontWeight: FontWeight.w600,
          color: brand.ink,
        ),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: brand.surface,
        surfaceTintColor: Colors.transparent,
        elevation: 6,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        textStyle: TextStyle(color: brand.ink, fontSize: 15),
      ),
      menuTheme: MenuThemeData(
        style: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(brand.surface),
          surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        height: 64,
        elevation: 0,
        backgroundColor: brand.surface,
        indicatorColor: Colors.transparent,
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            fontFamily: brand.fontFamily,
            fontFamilyFallback: brand.fontFallbacks,
            fontSize: 11,
            fontWeight: states.contains(WidgetState.selected)
                ? FontWeight.w600
                : FontWeight.w500,
            color: states.contains(WidgetState.selected)
                ? brand.primary
                : brand.inkMuted,
          ),
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            size: 21,
            color: states.contains(WidgetState.selected)
                ? brand.primary
                : brand.inkMuted,
          ),
        ),
      ),
      cardTheme: CardThemeData(
        margin: EdgeInsets.zero,
        elevation: 0,
        color: brand.surface,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: brand.line),
          borderRadius: BorderRadius.circular(cardRadius),
        ),
      ),
      dividerTheme: DividerThemeData(color: brand.line, thickness: 1, space: 1),
      listTileTheme: ListTileThemeData(
        dense: true,
        minTileHeight: 54,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16),
        iconColor: brand.inkSecondary,
        textColor: brand.ink,
        titleTextStyle: TextStyle(
          fontFamily: brand.fontFamily,
          fontFamilyFallback: brand.fontFallbacks,
          color: brand.ink,
          fontSize: 14.5,
          fontWeight: FontWeight.w500,
        ),
        subtitleTextStyle: TextStyle(
          fontFamily: brand.fontFamily,
          fontFamilyFallback: brand.fontFallbacks,
          color: brand.inkMuted,
          fontSize: 12.5,
          height: 1.35,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        floatingLabelBehavior: FloatingLabelBehavior.always,
        floatingLabelStyle: TextStyle(
          color: brand.inkMuted,
          fontSize: 16,
          height: 1.2,
        ),
        filled: true,
        fillColor: brand.surface,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 15,
          vertical: 14,
        ),
        hintStyle: TextStyle(color: brand.inkMuted),
        border: MobileInputBorder(
          borderRadius: BorderRadius.circular(brand.radiusMedium),
          borderSide: BorderSide(color: brand.line),
        ),
        enabledBorder: MobileInputBorder(
          borderRadius: BorderRadius.circular(brand.radiusMedium),
          borderSide: BorderSide(color: brand.line),
        ),
        focusedBorder: MobileInputBorder(
          borderRadius: BorderRadius.circular(brand.radiusMedium),
          borderSide: BorderSide(color: brand.inkSecondary, width: 1.1),
        ),
        errorBorder: MobileInputBorder(
          borderRadius: BorderRadius.circular(brand.radiusMedium),
          borderSide: BorderSide(color: brand.danger),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: brand.primary,
          foregroundColor: readableOn(brand.primary),
          minimumSize: const Size(44, 44),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(brand.radiusMedium),
          ),
          textStyle: TextStyle(
            fontFamily: brand.fontFamily,
            fontFamilyFallback: brand.fontFallbacks,
            fontSize: 14,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(44, 44),
          foregroundColor: brand.ink,
          side: BorderSide(color: brand.lineStrong),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(brand.radiusMedium),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: brand.inkSecondary,
          textStyle: TextStyle(
            fontFamily: brand.fontFamily,
            fontFamilyFallback: brand.fontFallbacks,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (s) =>
              s.contains(WidgetState.selected) ? brand.surface : brand.inkMuted,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (s) =>
              s.contains(WidgetState.selected) ? brand.ink : brand.surfaceMuted,
        ),
      ),
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected) ? brand.ink : null,
        ),
        checkColor: WidgetStatePropertyAll(brand.surface),
      ),
      chipTheme: base.chipTheme.copyWith(
        selectedColor: brand.surfaceMuted,
        secondarySelectedColor: brand.surfaceMuted,
        checkmarkColor: brand.ink,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(brand.radiusSmall),
        ),
        side: BorderSide(color: brand.line),
        deleteIconColor: brand.inkMuted,
        labelStyle: TextStyle(
          fontFamily: brand.fontFamily,
          fontFamilyFallback: brand.fontFallbacks,
          fontSize: 12.5,
          color: brand.ink,
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          minimumSize: const Size(44, 44),
          foregroundColor: brand.inkSecondary,
        ),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: brand.ink,
        selectionColor: brand.secondary.withValues(alpha: .18),
        selectionHandleColor: brand.inkSecondary,
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: brand.inkSecondary,
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: brand.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        showDragHandle: true,
        dragHandleColor: brand.lineStrong,
        dragHandleSize: const Size(32, 4),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        ),
        backgroundColor: brand.surface,
        surfaceTintColor: Colors.transparent,
        modalBackgroundColor: brand.surface,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: brand.ink,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(compactRadius),
        ),
      ),
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        },
      ),
    );
  }

  static Color readableOn(Color background) {
    const dark = Color(0xFF111318);
    final luminance = background.computeLuminance();
    final lightContrast = 1.05 / (luminance + .05);
    final darkContrast = (luminance + .05) / (dark.computeLuminance() + .05);
    return darkContrast >= lightContrast ? dark : Colors.white;
  }
}

extension SoduWorkThemeContext on BuildContext {
  SoduWorkBrandTheme get soduWorkTheme =>
      Theme.of(this).extension<SoduWorkBrandTheme>() ??
      const SoduWorkBrandTheme();
}

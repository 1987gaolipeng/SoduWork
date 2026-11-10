import 'package:flutter/material.dart';

import '../sdk/soduwork_brand.dart';

/// Apply appearance without replacing the host's identity, accent or shape.
SoduWorkBrandTheme mobileAppearance(SoduWorkBrandTheme brand, Brightness? choice) {
  if (choice == null || choice == brand.brightness) return brand;
  final dark = choice == Brightness.dark;
  const light = SoduWorkBrandTheme();
  return brand.copyWith(
    brightness: choice,
    canvas: dark ? const Color(0xFF161419) : light.canvas,
    surface: dark ? const Color(0xFF211E26) : light.surface,
    surfaceMuted: dark ? const Color(0xFF2A2631) : light.surfaceMuted,
    surfaceRaised: dark ? const Color(0xFF26222D) : light.surfaceRaised,
    ink: dark ? const Color(0xFFF4F0F8) : light.ink,
    inkSecondary: dark ? const Color(0xFFD0C9D9) : light.inkSecondary,
    inkMuted: dark ? const Color(0xFFABA2B6) : light.inkMuted,
    line: dark ? const Color(0xFF37313F) : light.line,
    lineStrong: dark ? const Color(0xFF4B4355) : light.lineStrong,
    primarySoft: dark
        ? brand.primary.withValues(alpha: .18)
        : light.primarySoft,
    secondarySoft: dark
        ? brand.secondary.withValues(alpha: .18)
        : light.secondarySoft,
    successSoft: dark
        ? brand.success.withValues(alpha: .18)
        : light.successSoft,
    warningSoft: dark
        ? brand.warning.withValues(alpha: .18)
        : light.warningSoft,
    dangerSoft: dark ? brand.danger.withValues(alpha: .18) : light.dangerSoft,
  );
}

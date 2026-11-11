import 'package:flutter/material.dart';
import 'mobile_theme.dart';
import '../sdk/soduwork_brand.dart';

/// Shared visual treatment for home and conversation input areas.
class ConversationInputSurface extends StatelessWidget {
  final Widget child;
  const ConversationInputSurface({super.key, required this.child});
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.surfaceRaised,
        borderRadius: BorderRadius.circular(28),
        border: Border.all(
          color: theme.lineStrong.withValues(alpha: .65),
          width: .7,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: .035),
            blurRadius: 24,
            offset: const Offset(0, 5),
          ),
        ],
      ),
      child: child,
    );
  }
}

ButtonStyle conversationCircleStyle(
  BuildContext context, {
  SoduWorkBrandTheme? brand,
}) {
  final theme = brand ?? context.soduWorkTheme;
  return IconButton.styleFrom(
    minimumSize: const Size(44, 44),
    maximumSize: const Size(44, 44),
    backgroundColor: theme.surfaceRaised,
    foregroundColor: theme.ink,
    side: BorderSide(color: theme.lineStrong.withValues(alpha: .7), width: .6),
    shape: const CircleBorder(),
  );
}

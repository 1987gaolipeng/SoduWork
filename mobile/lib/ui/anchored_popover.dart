import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'mobile_theme.dart';

Rect? popoverAnchor(BuildContext context, GlobalKey key) {
  final box = key.currentContext?.findRenderObject();
  final overlay = Overlay.of(context).context.findRenderObject();
  if (box is! RenderBox || overlay is! RenderBox || !box.attached) return null;
  return Rect.fromPoints(
    box.localToGlobal(Offset.zero, ancestor: overlay),
    box.localToGlobal(box.size.bottomRight(Offset.zero), ancestor: overlay),
  );
}

/// A compact, dismissible menu that stays inside safe areas and the keyboard.
/// No device setup or execution is performed when the menu opens.
Future<T?> showAnchoredPopover<T>(
  BuildContext context, {
  Rect? anchor,
  bool alignRight = true,
  double width = 292,
  required WidgetBuilder builder,
}) {
  final themes = InheritedTheme.capture(
    from: context,
    to: Navigator.of(context).context,
  );
  return showGeneralDialog<T>(
    context: context,
    useRootNavigator: false,
    requestFocus: false,
    barrierDismissible: true,
    barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
    barrierColor: Colors.transparent,
    transitionDuration: MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : const Duration(milliseconds: 180),
    pageBuilder: (context, _, _) => themes.wrap(
      TextFieldTapRegion(
        child: _Popover(
          anchor: anchor,
          alignRight: alignRight,
          width: width,
          builder: builder,
        ),
      ),
    ),
    transitionBuilder: (_, animation, _, child) => FadeTransition(
      opacity: animation,
      child: ScaleTransition(
        scale: Tween<double>(begin: .97, end: 1).animate(
          CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
        ),
        alignment: alignRight ? Alignment.bottomRight : Alignment.bottomLeft,
        child: child,
      ),
    ),
  );
}

class _Popover extends StatelessWidget {
  final Rect? anchor;
  final bool alignRight;
  final double width;
  final WidgetBuilder builder;
  const _Popover({
    this.anchor,
    required this.alignRight,
    required this.width,
    required this.builder,
  });

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    final theme = context.soduWorkTheme;
    return LayoutBuilder(
      builder: (context, constraints) {
        final size = constraints.biggest;
        final safeTop = math.min(size.height, media.padding.top + 12);
        final safeBottom = math.max(
          safeTop,
          size.height -
              math.max(media.viewInsets.bottom, media.padding.bottom) -
              12,
        );
        final panelWidth = math.min(
          width,
          math.max(0.0, size.width - media.padding.horizontal - 24),
        );
        final target =
            anchor ??
            Rect.fromLTWH(
              size.width - media.padding.right - 12,
              safeBottom,
              0,
              0,
            );
        final leftLimit = media.padding.left + 12;
        final rightLimit = math.max(
          leftLimit,
          size.width - media.padding.right - panelWidth - 12,
        );
        final left = (alignRight ? target.right - panelWidth : target.left)
            .clamp(leftLimit, rightLimit)
            .toDouble();
        final aboveEnd = (target.top - 10)
            .clamp(safeTop, safeBottom)
            .toDouble();
        final belowStart = (target.bottom + 10)
            .clamp(safeTop, safeBottom)
            .toDouble();
        final above = aboveEnd - safeTop;
        final below = safeBottom - belowStart;
        final opensUp =
            above >= math.min(220.0, safeBottom - safeTop) || above >= below;
        final available = opensUp ? above : below;
        return Stack(
          children: [
            Positioned(
              left: left,
              width: panelWidth,
              top: opensUp ? null : belowStart,
              bottom: opensUp ? size.height - aboveEnd : null,
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: available),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(26),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: .10),
                        blurRadius: 32,
                        offset: const Offset(0, 10),
                      ),
                    ],
                  ),
                  child: Material(
                    key: const Key('anchored-popover-panel'),
                    color: theme.surfaceRaised,
                    surfaceTintColor: Colors.transparent,
                    clipBehavior: Clip.antiAlias,
                    shape: RoundedRectangleBorder(
                      side: BorderSide(
                        color: theme.lineStrong.withValues(alpha: .65),
                        width: .7,
                      ),
                      borderRadius: BorderRadius.circular(26),
                    ),
                    child: Builder(builder: builder),
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

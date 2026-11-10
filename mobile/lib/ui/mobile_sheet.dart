import 'package:flutter/material.dart';
import '../sdk/soduwork_brand.dart';
import '../state/mobile_scope.dart';
import 'mobile_display_preferences.dart';
import 'mobile_theme.dart';
import 'mobile_sheet_pages.dart';
import 'mobile_layer_surface.dart';

Future<T?> showMobileSheet<T>(
  BuildContext context, {
  String title = '',
  double initialSize = .92,
  required Widget Function(BuildContext, ScrollController) builder,
}) {
  final pages = MobileSheetPages.maybeOf(context);
  if (pages != null) {
    return pages.open<T>(
      title,
      (context, scroll) => MobileSheetScope(
        scrollController: scroll,
        child: Builder(builder: (context) => builder(context, scroll)),
      ),
    );
  }
  final preferences = MobileDisplayScope.maybeOf(context);
  final brand = context.soduWorkTheme;
  final state = MobileScope.read(context);
  final coordinator =
      MobileLayerScope.maybeOf(context) ??
      MobileLayerCoordinator(disposeWhenEmpty: true);
  final entry = coordinator.add();
  var attached = false;
  try {
    return showModalBottomSheet<T>(
      context: context,
      useRootNavigator: false,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: false,
      backgroundColor: Colors.transparent,
      barrierColor: Colors.black.withValues(
        alpha: brand.brightness == Brightness.dark ? .22 : .12,
      ),
      sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
          ? AnimationStyle.noAnimation
          : const AnimationStyle(
              duration: Duration(milliseconds: 320),
              reverseDuration: Duration(milliseconds: 260),
            ),
      constraints: const BoxConstraints(maxWidth: 640),
      builder: (_) {
        attached = true;
        return MobileScope(
          state: state,
          child: MobileLayerScope(
            coordinator: coordinator,
            child: MobilePresentationTheme(
              preferences: preferences,
              base: brand,
              child: _PresentedMobileSheet(
                coordinator: coordinator,
                entry: entry,
                title: title,
                initialSize: initialSize,
                builder: builder,
              ),
            ),
          ),
        );
      },
    ).whenComplete(() {
      if (!attached) coordinator.remove(entry);
    });
  } catch (_) {
    if (!attached) coordinator.remove(entry);
    rethrow;
  }
}

class _PresentedMobileSheet extends StatefulWidget {
  final MobileLayerCoordinator coordinator;
  final MobileLayerEntry entry;
  final String title;
  final double initialSize;
  final Widget Function(BuildContext, ScrollController) builder;
  const _PresentedMobileSheet({
    required this.coordinator,
    required this.entry,
    required this.title,
    required this.initialSize,
    required this.builder,
  });
  @override
  State<_PresentedMobileSheet> createState() => _PresentedMobileSheetState();
}

class _PresentedMobileSheetState extends State<_PresentedMobileSheet> {
  final _extent = DraggableScrollableController();
  Animation<double>? _route;
  bool _closing = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context)?.animation;
    if (_route != route) {
      _route?.removeListener(_progress);
      _route = route;
      _route?.addListener(_progress);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _progress();
      });
    }
  }

  void _progress() => widget.coordinator.update(
    widget.entry,
    Curves.easeOutCubic.transform((_route?.value ?? 1).clamp(0, 1)),
  );

  void _drag(DragUpdateDetails details, double height) {
    if (!_extent.isAttached || _closing || height <= 0) return;
    final size = (_extent.size - details.delta.dy / height).clamp(.35, .96);
    if (size <= .35) {
      _close();
    } else {
      _extent.jumpTo(size);
    }
  }

  void _close() {
    if (_closing || ModalRoute.of(context)?.isCurrent != true) return;
    _closing = true;
    Navigator.pop(context);
  }

  void _release(DragEndDetails details) {
    if (!_extent.isAttached || _closing) return;
    final speed = details.primaryVelocity ?? 0;
    if (speed > 1000 && _extent.size < .86 || _extent.size < .44) {
      _close();
      return;
    }
    final stops = <double>{.6, widget.initialSize.clamp(.35, .96), .96}.toList()
      ..sort(
        (a, b) => (a - _extent.size).abs().compareTo((b - _extent.size).abs()),
      );
    if (MediaQuery.disableAnimationsOf(context)) {
      _extent.jumpTo(stops.first);
    } else {
      _extent.animateTo(
        stops.first,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOutCubic,
      );
    }
  }

  @override
  void dispose() {
    _route?.removeListener(_progress);
    _extent.dispose();
    widget.coordinator.remove(widget.entry);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    const corners = BorderRadius.vertical(top: Radius.circular(32));
    return MobileLayerSurface(
      coordinator: widget.coordinator,
      entry: widget.entry,
      child: LayoutBuilder(
        builder: (context, constraints) => DraggableScrollableSheet(
          controller: _extent,
          expand: false,
          initialChildSize: widget.initialSize.clamp(.35, .96),
          minChildSize: .35,
          maxChildSize: .96,
          snap: true,
          snapSizes: const [.6, .96],
          snapAnimationDuration: const Duration(milliseconds: 220),
          builder: (context, scroll) => DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: corners,
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withValues(
                    alpha: theme.brightness == Brightness.dark ? .3 : .12,
                  ),
                  blurRadius: 30,
                  offset: const Offset(0, -4),
                  spreadRadius: -2,
                ),
              ],
            ),
            child: Material(
              color: theme.canvas,
              clipBehavior: Clip.antiAlias,
              shape: const RoundedRectangleBorder(borderRadius: corners),
              child: SafeArea(
                top: false,
                child: MobileSheetScope(
                  scrollController: scroll,
                  child: MobileSheetPages(
                    title: widget.title,
                    builder: widget.builder,
                    scroll: scroll,
                    onClose: _close,
                    onDrag: (details) => _drag(details, constraints.maxHeight),
                    onRelease: _release,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Preference changes also rebuild an already open sheet or conversation.
class MobilePresentationTheme extends StatelessWidget {
  final MobileDisplayPreferences? preferences;
  final SoduWorkBrandTheme base;
  final Widget child;
  const MobilePresentationTheme({
    super.key,
    required this.preferences,
    required this.base,
    required this.child,
  });
  @override
  Widget build(BuildContext context) {
    final prefs = preferences;
    if (prefs == null) return Theme(data: SoduWorkTheme.light(base), child: child);
    return MobileDisplayScope(
      preferences: prefs,
      child: ListenableBuilder(
        listenable: prefs,
        builder: (context, _) => Theme(
          data: SoduWorkTheme.light(
            prefs.apply(base, MediaQuery.platformBrightnessOf(context)),
          ),
          child: child,
        ),
      ),
    );
  }
}

bool popMobileSheet<T>(BuildContext context, [T? result]) {
  final pages = MobileSheetPages.maybeOf(context);
  if (pages != null && pages.pop<T>(result)) return true;
  // The sheet belongs to its workspace navigator, not the host app navigator.
  // The pages context is above the sheet's internal navigator.
  Navigator.of(pages?.context ?? context).pop<T>(result);
  return true;
}

class MobileSheetScope extends InheritedWidget {
  final ScrollController scrollController;
  const MobileSheetScope({
    super.key,
    required this.scrollController,
    required super.child,
  });
  static MobileSheetScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<MobileSheetScope>();
  @override
  bool updateShouldNotify(MobileSheetScope oldWidget) =>
      scrollController != oldWidget.scrollController;
}

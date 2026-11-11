import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

/// Mobile navigation reveals the sidebar beneath a rounded, moving main card.
class MobileSidebarSurface extends StatefulWidget {
  final Widget sidebar, child;
  final Color surface;
  const MobileSidebarSurface({
    super.key,
    required this.sidebar,
    required this.child,
    required this.surface,
  });
  @override
  State<MobileSidebarSurface> createState() => MobileSidebarSurfaceState();
}

class MobileSidebarSurfaceState extends State<MobileSidebarSurface>
    with SingleTickerProviderStateMixin {
  late final _position = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 280),
  )..addListener(_changed);
  bool _dragging = false;
  void _changed() {
    if (mounted) setState(() {});
  }

  void open() {
    FocusManager.instance.primaryFocus?.unfocus();
    _go(1);
  }

  void close() => _go(0);
  void _go(double value) {
    if (MediaQuery.disableAnimationsOf(context)) {
      _position.value = value;
    } else {
      _position.animateTo(value, curve: Curves.easeOutCubic);
    }
  }

  void _move(DragUpdateDetails details, double width) {
    _dragging = true;
    _position.value = (_position.value + details.delta.dx / width).clamp(0, 1);
  }

  void _end(DragEndDetails details) {
    _dragging = false;
    final speed = details.primaryVelocity ?? 0;
    _go(
      speed.abs() > 400 ? (speed > 0 ? 1 : 0) : (_position.value > .5 ? 1 : 0),
    );
  }

  @override
  void dispose() {
    _position.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final width = (constraints.maxWidth * .79).clamp(0.0, 320.0),
          value = _position.value;
      return PopScope(
        canPop: value == 0,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop && value > 0) close();
        },
        child: ColoredBox(
          color: widget.surface,
          child: Stack(
            children: [
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                width: width,
                child: Offstage(
                  offstage: value == 0,
                  child: ExcludeSemantics(
                    excluding: value == 0,
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onHorizontalDragUpdate: (d) => _move(d, width),
                      onHorizontalDragEnd: _end,
                      child: widget.sidebar,
                    ),
                  ),
                ),
              ),
              Transform.translate(
                offset: Offset(width * value, 12 * value),
                child: Transform.scale(
                  scale: 1 - .025 * value,
                  alignment: Alignment.topLeft,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(32 * value),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withValues(alpha: .12 * value),
                          blurRadius: 24,
                          offset: const Offset(-6, 0),
                        ),
                      ],
                    ),
                    child: ClipRRect(
                      key: const Key('sidebar-main-card'),
                      borderRadius: BorderRadius.circular(32 * value),
                      child: Stack(
                        children: [
                          AbsorbPointer(
                            absorbing: value > 0,
                            child: ExcludeSemantics(
                              excluding: value > 0,
                              child: MobileSidebarInteraction(
                                blocked: value > 0,
                                child: widget.child,
                              ),
                            ),
                          ),
                          if (value > 0)
                            Positioned.fill(
                              child: Semantics(
                                button: true,
                                label: '关闭侧栏',
                                child: GestureDetector(
                                  behavior: HitTestBehavior.opaque,
                                  onTap: close,
                                  onHorizontalDragUpdate: (d) =>
                                      _move(d, width),
                                  onHorizontalDragEnd: _end,
                                  child: ColoredBox(
                                    color: Colors.black.withValues(
                                      alpha: .045 * value,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                width: 20,
                child: IgnorePointer(
                  ignoring: value > 0 && !_dragging,
                  child: GestureDetector(
                    behavior: HitTestBehavior.translucent,
                    onHorizontalDragUpdate: (d) => _move(d, width),
                    onHorizontalDragEnd: _end,
                    supportedDevices: const {
                      PointerDeviceKind.touch,
                      PointerDeviceKind.stylus,
                      PointerDeviceKind.mouse,
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class MobileSidebarInteraction extends InheritedWidget {
  final bool blocked;
  const MobileSidebarInteraction({
    super.key,
    required this.blocked,
    required super.child,
  });
  static bool blockedOf(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<MobileSidebarInteraction>()
          ?.blocked ??
      false;
  @override
  bool updateShouldNotify(MobileSidebarInteraction oldWidget) =>
      blocked != oldWidget.blocked;
}

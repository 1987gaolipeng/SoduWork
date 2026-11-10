import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

/// Visual state belongs to one workspace. It never contains account or task data.
class MobileLayerCoordinator extends ChangeNotifier {
  final bool disposeWhenEmpty;
  final _entries = <MobileLayerEntry>[];
  bool _disposed = false, _notificationPending = false;
  MobileLayerCoordinator({this.disposeWhenEmpty = false});

  MobileLayerEntry add() {
    final entry = MobileLayerEntry();
    _entries.add(entry);
    return entry;
  }

  void update(MobileLayerEntry entry, double value) {
    if (_disposed || !_entries.contains(entry) || entry.progress == value) {
      return;
    }
    entry.progress = value.clamp(0, 1);
    _notify();
  }

  void remove(MobileLayerEntry entry) {
    if (_disposed || !_entries.remove(entry)) return;
    if (disposeWhenEmpty && _entries.isEmpty) {
      dispose();
    } else {
      _notify();
    }
  }

  double depthAbove(MobileLayerEntry? entry) {
    final start = entry == null ? 0 : _entries.indexOf(entry) + 1;
    return _entries.skip(start).fold<double>(0, (sum, e) => sum + e.progress);
  }

  void _notify() {
    if (SchedulerBinding.instance.schedulerPhase ==
        SchedulerPhase.persistentCallbacks) {
      if (_notificationPending) return;
      _notificationPending = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _notificationPending = false;
        if (!_disposed) notifyListeners();
      });
    } else {
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

class MobileLayerEntry {
  double progress = 0;
}

class MobileLayerScope extends InheritedWidget {
  final MobileLayerCoordinator coordinator;
  const MobileLayerScope({
    super.key,
    required this.coordinator,
    required super.child,
  });
  static MobileLayerCoordinator? maybeOf(BuildContext context) => context
      .dependOnInheritedWidgetOfExactType<MobileLayerScope>()
      ?.coordinator;
  @override
  bool updateShouldNotify(MobileLayerScope oldWidget) =>
      coordinator != oldWidget.coordinator;
}

class MobileLayerHost extends StatefulWidget {
  final Widget child;
  final Color background;
  const MobileLayerHost({
    super.key,
    required this.child,
    required this.background,
  });
  @override
  State<MobileLayerHost> createState() => _MobileLayerHostState();
}

class _MobileLayerHostState extends State<MobileLayerHost> {
  final _coordinator = MobileLayerCoordinator();
  @override
  void dispose() {
    _coordinator.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MobileLayerScope(
    coordinator: _coordinator,
    child: ColoredBox(
      color: widget.background,
      child: MobileLayerSurface(coordinator: _coordinator, child: widget.child),
    ),
  );
}

/// The active sheet drives this transform through its route animation. Keeping
/// entries until route disposal also makes interactive dismissal restore the
/// underlying surface continuously instead of popping it back early.
class MobileLayerSurface extends StatelessWidget {
  final MobileLayerCoordinator coordinator;
  final MobileLayerEntry? entry;
  final Widget child;
  const MobileLayerSurface({
    super.key,
    required this.coordinator,
    this.entry,
    required this.child,
  });
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: coordinator,
    child: RepaintBoundary(child: child),
    builder: (context, child) {
      final depth = coordinator.depthAbove(entry).clamp(0.0, 2.0);
      final first = depth.clamp(0.0, 1.0);
      final extra = (depth - 1).clamp(0.0, 1.0);
      final isRoot = entry == null;
      return Transform.translate(
        offset: Offset(0, isRoot ? first * 10 : -first * 16 - extra * 8),
        child: Transform.scale(
          scale: 1 - first * .035 - extra * .015,
          alignment: Alignment.topCenter,
          child: isRoot
              ? ClipRRect(
                  key: const Key('mobile-main-layer'),
                  borderRadius: BorderRadius.circular(first * 30),
                  child: child,
                )
              : child,
        ),
      );
    },
  );
}

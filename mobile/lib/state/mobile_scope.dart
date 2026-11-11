import 'package:flutter/widgets.dart';

import 'mobile_state.dart';

class MobileScope extends InheritedNotifier<MobileState> {
  const MobileScope({
    super.key,
    required MobileState state,
    required super.child,
  }) : super(notifier: state);

  static MobileState of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<MobileScope>();
    assert(scope != null, 'MobileScope is missing above this context');
    return scope!.notifier!;
  }

  static MobileState read(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<MobileScope>();
    assert(scope != null, 'MobileScope is missing above this context');
    return scope!.notifier!;
  }

  /// Null-safe lookup for widgets that can appear outside a scope (tests).
  static MobileState? maybeOf(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<MobileScope>();
    return scope?.notifier;
  }
}

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'conversation_chrome.dart';
import 'mobile_display_preferences.dart';
import 'mobile_theme.dart';

/// One modal surface, with ordinary navigation inside it. Child pages do not
/// create another barrier or transform the workspace a second time.
class MobileSheetPages extends StatefulWidget {
  final String title;
  final Widget Function(BuildContext, ScrollController) builder;
  final ScrollController scroll;
  final VoidCallback onClose;
  final GestureDragUpdateCallback onDrag;
  final GestureDragEndCallback onRelease;
  const MobileSheetPages({
    super.key,
    required this.title,
    required this.builder,
    required this.scroll,
    required this.onClose,
    required this.onDrag,
    required this.onRelease,
  });

  static MobileSheetPagesState? maybeOf(BuildContext context) =>
      context.findAncestorStateOfType<MobileSheetPagesState>();

  @override
  State<MobileSheetPages> createState() => MobileSheetPagesState();
}

class MobileSheetPagesState extends State<MobileSheetPages> {
  final _navigator = GlobalKey<NavigatorState>();

  Future<T?> open<T>(
    String title,
    Widget Function(BuildContext, ScrollController) builder,
  ) => _navigator.currentState!.push<T>(
    CupertinoPageRoute<T>(
      builder: (_) =>
          _SheetChildPage(title: title, builder: builder, owner: this),
    ),
  );

  bool pop<T>([T? result]) {
    final navigator = _navigator.currentState;
    if (navigator == null || !navigator.canPop()) return false;
    navigator.pop<T>(result);
    return true;
  }

  Widget header(BuildContext context, String title, {bool back = false}) =>
      Semantics(
        label: mobileText(context, '拖动调整高度，下拉关闭'),
        onDismiss: widget.onClose,
        child: GestureDetector(
          key: const Key('mobile-sheet-drag-region'),
          behavior: HitTestBehavior.opaque,
          onVerticalDragUpdate: widget.onDrag,
          onVerticalDragEnd: widget.onRelease,
          child: Column(
            children: [
              SizedBox(
                height: 24,
                child: Center(
                  child: Container(
                    width: 32,
                    height: 4,
                    decoration: BoxDecoration(
                      color: context.soduWorkTheme.lineStrong,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 6),
                child: Row(
                  children: [
                    if (back)
                      IconButton(
                        tooltip: mobileText(context, '返回'),
                        icon: const Icon(CupertinoIcons.chevron_left, size: 22),
                        onPressed: () => _navigator.currentState!.maybePop(),
                      )
                    else
                      const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        mobileText(context, title),
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                          color: context.soduWorkTheme.ink,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: mobileText(context, '关闭'),
                      style: conversationCircleStyle(context),
                      icon: const Icon(CupertinoIcons.xmark, size: 22),
                      onPressed: widget.onClose,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      );

  @override
  Widget build(BuildContext context) => NavigatorPopHandler<Object?>(
    onPopWithResult: (result) => _navigator.currentState!.pop(result),
    child: Navigator(
      key: _navigator,
      onGenerateRoute: (_) => CupertinoPageRoute<void>(
        builder: (context) => ColoredBox(
          color: context.soduWorkTheme.canvas,
          child: Column(
            children: [
              header(context, widget.title),
              Expanded(
                child: Builder(
                  builder: (context) => widget.builder(context, widget.scroll),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _SheetChildPage extends StatefulWidget {
  final String title;
  final Widget Function(BuildContext, ScrollController) builder;
  final MobileSheetPagesState owner;
  const _SheetChildPage({
    required this.title,
    required this.builder,
    required this.owner,
  });
  @override
  State<_SheetChildPage> createState() => _SheetChildPageState();
}

class _SheetChildPageState extends State<_SheetChildPage> {
  final _scroll = ScrollController();
  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ColoredBox(
    color: context.soduWorkTheme.canvas,
    child: Column(
      children: [
        widget.owner.header(context, widget.title, back: true),
        Expanded(child: widget.builder(context, _scroll)),
      ],
    ),
  );
}

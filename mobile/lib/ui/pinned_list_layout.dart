import 'package:flutter/material.dart';

class PinnedListLayout extends StatelessWidget {
  const PinnedListLayout({
    super.key,
    required this.header,
    required this.children,
    this.padding = const EdgeInsets.all(16),
    this.onRefresh,
    this.controller,
  });
  final List<Widget> header;
  final List<Widget> children;
  final EdgeInsets padding;
  final RefreshCallback? onRefresh;
  final ScrollController? controller;

  @override
  Widget build(BuildContext context) {
    final results = ListView(
      controller: controller,
      primary: false,
      physics: onRefresh == null ? null : const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.fromLTRB(
        padding.left,
        0,
        padding.right,
        padding.bottom,
      ),
      children: children,
    );
    return LayoutBuilder(
      builder: (context, bounds) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Keep results reachable even with the keyboard open or large text.
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: bounds.maxHeight * .78),
            child: SingleChildScrollView(
              primary: false,
              physics: const ClampingScrollPhysics(),
              padding: EdgeInsets.fromLTRB(
                padding.left,
                padding.top,
                padding.right,
                0,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: header,
              ),
            ),
          ),
          const SizedBox(height: 16),
          Expanded(
            child: onRefresh == null
                ? results
                : RefreshIndicator(onRefresh: onRefresh!, child: results),
          ),
        ],
      ),
    );
  }
}

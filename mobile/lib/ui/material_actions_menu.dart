import 'dart:math' as math;
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'mobile_theme.dart';

Future<String?> showMaterialActions(
  BuildContext context, {
  required Rect anchor,
}) {
  final theme = context.soduWorkTheme;
  final overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
  final media = MediaQuery.of(context);
  const width = 252.0;
  const height = 260.0;
  final left = anchor.left
      .clamp(12.0, math.max(12.0, overlay.size.width - width - 12))
      .toDouble();
  final top = math.max(media.padding.top + 12, anchor.top - height - 10);
  return showMenu<String>(
    context: context,
    position: RelativeRect.fromLTRB(
      left,
      top,
      math.max(0.0, overlay.size.width - left - width),
      math.max(0.0, overlay.size.height - top),
    ),
    constraints: const BoxConstraints.tightFor(width: width),
    color: theme.surfaceRaised,
    surfaceTintColor: Colors.transparent,
    elevation: 8,
    shadowColor: Colors.black.withValues(alpha: .10),
    shape: RoundedRectangleBorder(
      side: BorderSide(color: theme.line.withValues(alpha: .7)),
      borderRadius: BorderRadius.circular(26),
    ),
    menuPadding: const EdgeInsets.all(8),
    items: [
      for (final action in const [
        (CupertinoIcons.camera, '相机', 'camera'),
        (CupertinoIcons.photo, '照片', 'photos'),
        (CupertinoIcons.paperclip, '文件', 'files'),
        (CupertinoIcons.square_grid_2x2, '插件与工具', 'plugins'),
      ])
        PopupMenuItem<String>(
          value: action.$3,
          height: 60,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              Container(
                width: 38,
                height: 38,
                decoration: BoxDecoration(
                  color: theme.surfaceMuted,
                  shape: BoxShape.circle,
                ),
                child: Icon(action.$1, size: 21, color: theme.ink),
              ),
              const SizedBox(width: 14),
              Text(
                action.$2,
                style: TextStyle(
                  color: theme.ink,
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
    ],
  );
}

import 'package:flutter/material.dart';

/// Rounded field with the filled-input label layout: the label stays inside
/// the container rather than cutting into its top edge or preceding content.
class MobileInputBorder extends UnderlineInputBorder {
  const MobileInputBorder({
    super.borderSide,
    super.borderRadius = const BorderRadius.all(Radius.circular(12)),
  });

  @override
  MobileInputBorder copyWith({
    BorderSide? borderSide,
    BorderRadius? borderRadius,
  }) => MobileInputBorder(
    borderSide: borderSide ?? this.borderSide,
    borderRadius: borderRadius ?? this.borderRadius,
  );

  @override
  MobileInputBorder scale(double t) => MobileInputBorder(
    borderSide: borderSide.scale(t),
    borderRadius: borderRadius * t,
  );

  @override
  ShapeBorder? lerpFrom(ShapeBorder? a, double t) => a is MobileInputBorder
      ? MobileInputBorder(
          borderSide: BorderSide.lerp(a.borderSide, borderSide, t),
          borderRadius: BorderRadius.lerp(a.borderRadius, borderRadius, t)!,
        )
      : super.lerpFrom(a, t);

  @override
  ShapeBorder? lerpTo(ShapeBorder? b, double t) => b is MobileInputBorder
      ? MobileInputBorder(
          borderSide: BorderSide.lerp(borderSide, b.borderSide, t),
          borderRadius: BorderRadius.lerp(borderRadius, b.borderRadius, t)!,
        )
      : super.lerpTo(b, t);

  @override
  void paint(
    Canvas canvas,
    Rect rect, {
    double? gapStart,
    double gapExtent = 0,
    double gapPercentage = 0,
    TextDirection? textDirection,
  }) {
    if (borderSide.style == BorderStyle.none) {
      return;
    }
    canvas.drawRRect(
      borderRadius.toRRect(rect).deflate(borderSide.width / 2),
      borderSide.toPaint(),
    );
  }
}

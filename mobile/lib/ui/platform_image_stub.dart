import 'package:flutter/widgets.dart';

/// Web implementation: image_picker hands out blob URLs on the web, which
/// `Image.network` renders fine.
Widget imageFromFile(
  String path, {
  double? width,
  double? height,
  BoxFit? fit,
  ImageErrorWidgetBuilder? errorBuilder,
}) {
  return Image.network(
    path,
    width: width,
    height: height,
    fit: fit,
    errorBuilder: errorBuilder,
  );
}

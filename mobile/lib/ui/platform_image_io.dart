import 'dart:io';

import 'package:flutter/widgets.dart';

/// Native implementation backed by `dart:io` file rendering.
Widget imageFromFile(
  String path, {
  double? width,
  double? height,
  BoxFit? fit,
  ImageErrorWidgetBuilder? errorBuilder,
}) {
  return Image.file(
    File(path),
    width: width,
    height: height,
    fit: fit,
    errorBuilder: errorBuilder,
  );
}

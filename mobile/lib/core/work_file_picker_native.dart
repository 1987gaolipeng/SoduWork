import 'package:flutter/foundation.dart';
import 'package:flutter_file_dialog/flutter_file_dialog.dart';
import 'package:file_selector/file_selector.dart';

import 'soduwork_api.dart';

Future<List<XFile>> pickWorkFiles({bool multiple = true}) async {
  final files = multiple ? await openFiles() : [?await openFile()];
  if (files.length > 20) throw const ApiFailure('最多添加20个文件。');
  var total = 0;
  for (final file in files) {
    final size = await file.length();
    total += size;
    if (size <= 0 || total > 90 * 1024 * 1024) {
      throw const ApiFailure('文件不能为空，合计不能超过90MB。');
    }
  }
  return files;
}

Future<void> saveWorkFile(XFile file, String filename) async {
  final leaf = filename
      .replaceAll('\\', '/')
      .split('/')
      .last
      .replaceAll(RegExp(r'[\x00-\x1f<>:"|?*]'), '_')
      .trim();
  final name = leaf.isEmpty || leaf == '.' || leaf == '..' ? '文件' : leaf;
  if (defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS) {
    await FlutterFileDialog.saveFile(
      params: SaveFileDialogParams(
        data: await file.readAsBytes(),
        fileName: name,
      ),
    );
    return;
  }
  final location = await getSaveLocation(suggestedName: name);
  if (location != null) await file.saveTo(location.path);
}

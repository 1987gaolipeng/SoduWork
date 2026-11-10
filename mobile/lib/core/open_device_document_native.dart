import 'dart:io';
import 'package:open_file/open_file.dart';
import 'package:path_provider/path_provider.dart';
import 'artifact_download.dart';

/// Present only a copy of the authorized file, within the app's private cache.
Future<bool> openDeviceDocument(
  DownloadedArtifact artifact,
  bool Function() current,
) async {
  if (!Platform.isAndroid && !Platform.isIOS) return false;
  final name = artifact.filename
      .split(RegExp(r'[/\\]'))
      .last
      .replaceAll(RegExp(r'[\x00-\x1f<>:"|?*]'), '_')
      .trim();
  if (!RegExp(
    r'\.(docx?|xlsx?|pptx?|od[tps]|rtf|pdf|txt|md|csv|json|zip|html?|png|jpe?g|webp|gif|mp[34]|mov|wav)$',
    caseSensitive: false,
  ).hasMatch(name)) {
    return false;
  }
  final root = await getTemporaryDirectory();
  final cache = Directory('${root.path}/soduwork-file-view');
  await cache.create(recursive: true);
  final cutoff = DateTime.now().subtract(const Duration(days: 1));
  await for (final item in cache.list(followLinks: false)) {
    if (item is Directory &&
        item.path.split(Platform.pathSeparator).last.startsWith('view-')) {
      try {
        if ((await item.stat()).modified.isBefore(cutoff)) {
          await item.delete(recursive: true);
        }
      } on FileSystemException {
        /* A viewer may still hold the file. */
      }
    }
  }
  if (!current()) return true;
  final dir = await cache.createTemp('view-');
  final copy = File('${dir.path}/$name');
  var opened = false;
  try {
    await copy.writeAsBytes(artifact.bytes, flush: true);
    if (!current()) return true;
    final result = await OpenFile.open(copy.path, isIOSAppOpen: true);
    opened = result.type == ResultType.done;
    return opened;
  } finally {
    if (!opened && await dir.exists()) await dir.delete(recursive: true);
  }
}

import 'file_preview.dart';
import '../core/open_device_document_stub.dart'
    if (dart.library.io) '../core/open_device_document_native.dart';
import 'mobile_display_preferences.dart';
import '../state/mobile_scope.dart';
import '../core/work_file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/artifact_download.dart';
import '../core/soduwork_api.dart';

Future<void> openMobileArtifact(
  BuildContext context,
  SoduWorkApi api, {
  String id = '',
  required String url,
  String filename = '成果',
  String contentType = 'application/octet-stream',
  bool rethrowErrors = false,
  bool previewDelivery = false,
  String? entry,
}) async {
  try {
    final downloader = ArtifactDownloader(api);
    if (downloader.isPrivateDeliveryUrl(url)) {
      final artifact = await downloader.download(
        url,
        filename: filename,
        contentType: contentType,
      );
      if (!context.mounted) return;
      await exportMobileFile(
        context,
        artifact,
        openOnDevice: previewDelivery,
        entry: entry,
      );
      return;
    }
    final raw = Uri.tryParse(url.trim());
    if (raw != null &&
        raw.hasScheme &&
        !{'http', 'https'}.contains(raw.scheme)) {
      throw const ApiFailure('这份成果没有可打开的网页地址。');
    }
    final initial = Uri.tryParse(api.absoluteUrl(url));
    final segments = initial?.pathSegments ?? const <String>[];
    final attachmentId = id.isNotEmpty
        ? id
        : segments.length == 4 &&
              segments[0] == 'api' &&
              segments[1] == 'v1' &&
              segments[2] == 'attachments'
        ? segments[3]
        : '';
    if (attachmentId.isNotEmpty) {
      try {
        final file = await downloader.downloadAttachment(
          attachmentId,
          filename: filename,
          contentType: contentType,
        );
        if (context.mounted) {
          await exportMobileFile(context, file, openOnDevice: true);
        }
      } on ArtifactSizeLimit {
        final revision = api.authRevision;
        final link = await downloader.attachmentAccess(attachmentId);
        if (!context.mounted) return;
        await showDialog<void>(
          context: context,
          builder: (dialog) => AlertDialog(
            title: const Text('文件较大'),
            content: const Text('可以用浏览器下载原文件。'),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialog),
                child: const Text('取消'),
              ),
              TextButton(
                onPressed: () async {
                  if (api.authRevision != revision || !context.mounted) {
                    Navigator.pop(dialog);
                    return;
                  }
                  var launched = false;
                  try {
                    launched = await launchUrl(
                      link,
                      mode: LaunchMode.externalApplication,
                    );
                  } catch (_) {
                    launched = false;
                  } finally {
                    if (dialog.mounted) Navigator.pop(dialog);
                    if (!launched && context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('无法打开下载地址，请重试。')),
                      );
                    }
                  }
                },
                child: const Text('用浏览器下载'),
              ),
            ],
          ),
        );
      }
      return;
    }
    final uri = initial;
    if (uri == null ||
        !{'http', 'https'}.contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      throw const ApiFailure('这份成果没有可打开的网页地址。');
    }
    if (!context.mounted) return;
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      throw const ApiFailure('手机上没有能打开这份成果的应用。');
    }
  } catch (error) {
    if (rethrowErrors) rethrow;
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(mobileText(context, "暂时无法打开成果：{0}", values: [error])),
      ),
    );
  }
}

/// Export only bytes already fetched through the authenticated download guard.
Future<void> exportMobileFile(
  BuildContext context,
  DownloadedArtifact artifact, {
  bool openOnDevice = false,
  String? entry,
  List<Map<String, String>>? resources,
}) async {
  if (!context.mounted) return;
  if (openOnDevice) {
    final owner = MobileScope.read(context);
    final revision = owner.identityRevision;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (sheet) => ListenableBuilder(
        listenable: owner,
        builder: (_, _) => owner.identityRevision == revision
            ? _DeviceFileView(
                artifact: artifact,
                entry: entry,
                resources: resources,
              )
            : const ListTile(title: Text('账号已切换，请关闭后重新打开。')),
      ),
    );
    return;
  }
  await saveWorkFile(_deviceFile(artifact), artifact.filename);
}

XFile _deviceFile(DownloadedArtifact artifact) => XFile.fromData(
  artifact.bytes,
  mimeType: artifact.contentType,
  name: artifact.filename,
);

Future<void> shareDeviceFile(
  BuildContext context,
  DownloadedArtifact artifact,
) async {
  final owner = MobileScope.read(context);
  final revision = owner.identityRevision;
  bool current() => context.mounted && owner.identityRevision == revision;
  if (!kIsWeb && await openDeviceDocument(artifact, current)) return;
  if (!context.mounted || !current()) return;
  final box = context.findRenderObject();
  final origin = box is RenderBox && box.hasSize
      ? box.localToGlobal(Offset.zero) & box.size
      : null;
  await SharePlus.instance.share(
    ShareParams(
      files: [_deviceFile(artifact)],
      fileNameOverrides: [artifact.filename],
      sharePositionOrigin: origin,
      downloadFallbackEnabled: false,
    ),
  );
}

class _DeviceFileView extends StatefulWidget {
  const _DeviceFileView({required this.artifact, this.entry, this.resources});
  final String? entry;
  final List<Map<String, String>>? resources;
  final DownloadedArtifact artifact;
  @override
  State<_DeviceFileView> createState() => _DeviceFileViewState();
}

class _DeviceFileViewState extends State<_DeviceFileView> {
  bool busy = false;
  String error = '';
  DownloadedArtifact get file => widget.artifact;

  Future<void> _export({required bool download}) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = '';
    });
    try {
      if (download) {
        await saveWorkFile(_deviceFile(file), file.filename);
      } else {
        await shareDeviceFile(context, file);
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => error = download
              ? '文件未能保存，请重试。'
              : kIsWeb
              ? '当前浏览器无法分享这个文件。可以选择下方的「下载文件」。'
              : '未能打开系统分享菜单，请重试。',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    file.filename,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.pop(context),
                  tooltip: '关闭',
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Expanded(
              child: FilePreview(
                file: file,
                entry: widget.entry,
                resources: widget.resources,
                openMember: (member, {entry, resources}) => exportMobileFile(
                  context,
                  member,
                  openOnDevice: true,
                  entry: entry,
                  resources: resources,
                ),
              ),
            ),
            if (error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(error),
              ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: [
                FilledButton.icon(
                  onPressed: busy ? null : () => _export(download: false),
                  icon: const Icon(Icons.ios_share),
                  label: const Text('系统分享或打开'),
                ),
                OutlinedButton.icon(
                  onPressed: busy ? null : () => _export(download: true),
                  icon: const Icon(Icons.download_outlined),
                  label: Text(kIsWeb ? '下载文件' : '保存到设备'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

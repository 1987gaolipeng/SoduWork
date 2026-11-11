import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:pdfrx/pdfrx.dart';
import '../core/artifact_download.dart';
import '../core/file_preview_content.dart';
import 'conversation_markdown.dart';
import 'isolated_document.dart';

typedef OpenFilePreview =
    Future<void> Function(
      DownloadedArtifact file, {
      String? entry,
      List<Map<String, String>>? resources,
    });

class FilePreview extends StatefulWidget {
  final DownloadedArtifact file;
  final OpenFilePreview openMember;
  final String? entry;
  final List<Map<String, String>>? resources;
  const FilePreview({
    super.key,
    required this.file,
    required this.openMember,
    this.entry,
    this.resources,
  });
  @override
  State<FilePreview> createState() => _FilePreviewState();
}

class _FilePreviewState extends State<FilePreview> {
  late final Widget content = _content();
  Widget _scroll(Widget body) => SingleChildScrollView(
    padding: const EdgeInsets.all(12),
    child: Align(alignment: Alignment.topLeft, child: body),
  );
  Widget _content() {
    final file = widget.file;
    try {
      switch (filePreviewKind(file.filename, file.contentType)) {
        case PreviewKind.text:
          final text = previewText(file);
          return _scroll(SelectableText(text.isEmpty ? '空文件' : text));
        case PreviewKind.markdown:
          return _scroll(ConversationMarkdown(data: previewText(file)));
        case PreviewKind.image:
          return InteractiveViewer(
            child: Center(
              child: Image.memory(
                file.bytes,
                fit: BoxFit.contain,
                errorBuilder: (_, _, _) => const Text('图片无法预览，可用其他应用打开。'),
              ),
            ),
          );
        case PreviewKind.pdf:
          if (kIsWeb) {
            Pdfrx.pdfiumWasmModulesUrl ??= Uri.base
                .resolve('assets/packages/pdfrx/assets/')
                .toString();
          }
          return PdfViewer.data(
            file.bytes,
            sourceName: '${file.filename}-${identityHashCode(file)}',
            params: PdfViewerParams(
              errorBannerBuilder: (_, _, _, _) =>
                  const Center(child: Text('PDF 无法预览，可保存原件或用其他应用打开。')),
            ),
          );
        case PreviewKind.word:
          final body = PreviewArchive(file.bytes).wordText();
          return _scroll(
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Word 正文'),
                const Divider(),
                SelectableText(body.isEmpty ? '此文档没有可显示的正文。' : body),
              ],
            ),
          );
        case PreviewKind.html:
          if (file.bytes.length > 8 * 1024 * 1024) {
            throw const FormatException('网页文件较大');
          }
          return IsolatedDocument(
            entry: widget.entry ?? 'index.html',
            files:
                widget.resources ??
                [
                  {'path': 'index.html', 'data': base64Encode(file.bytes)},
                ],
          );
        case PreviewKind.zip:
          final archive = PreviewArchive(file.bytes);
          final paths = archive.entries.keys.toList();
          final primary =
              widget.entry ?? (paths.length == 1 ? paths.single : null);
          if (primary != null && archive.entries.containsKey(primary)) {
            final kind = filePreviewKind(primary, '');
            if (kind != PreviewKind.zip && kind != PreviewKind.other) {
              return FilePreview(
                file: DownloadedArtifact(
                  bytes: archive.read(primary),
                  filename: primary.split('/').last,
                  contentType: 'application/octet-stream',
                ),
                entry: kind == PreviewKind.html ? primary : null,
                resources: kind == PreviewKind.html ? archive.webFiles() : null,
                openMember: widget.openMember,
              );
            }
          }
          if (paths.isEmpty) return const Center(child: Text('压缩包为空'));
          return ListView.builder(
            itemCount: paths.length,
            itemBuilder: (context, i) {
              final path = paths[i];
              return ListTile(
                title: Text(path),
                leading: const Icon(Icons.insert_drive_file_outlined),
                onTap: () async {
                  try {
                    final html = filePreviewKind(path, '') == PreviewKind.html;
                    await widget.openMember(
                      DownloadedArtifact(
                        bytes: archive.read(path),
                        filename: path.split('/').last,
                        contentType: 'application/octet-stream',
                      ),
                      entry: html ? path : null,
                      resources: html ? archive.webFiles() : null,
                    );
                  } catch (_) {
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('此文件无法预览，请下载完整压缩包。')),
                      );
                    }
                  }
                },
              );
            },
          );
        case PreviewKind.other:
          return const Center(child: Text('此格式可保存到设备，或选择其他应用打开。'));
      }
    } catch (_) {
      return const Center(child: Text('无法预览此文件，可保存原件或用其他应用打开。'));
    }
  }

  @override
  Widget build(BuildContext context) => content;
}

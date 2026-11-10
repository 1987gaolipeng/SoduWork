import 'dart:convert';
import 'dart:typed_data';
import 'package:archive/archive.dart';
import 'package:xml/xml_events.dart';
import 'artifact_download.dart';

enum PreviewKind { text, markdown, image, pdf, word, html, zip, other }

PreviewKind filePreviewKind(String name, String contentType) {
  final ext = name.toLowerCase().split('.').last;
  final mime = contentType.toLowerCase().split(';').first.trim();
  if (['html', 'htm', 'xhtml'].contains(ext) || mime == 'text/html') {
    return PreviewKind.html;
  }
  if (ext == 'pdf' || mime == 'application/pdf') return PreviewKind.pdf;
  if (ext == 'docx' ||
      mime ==
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return PreviewKind.word;
  }
  if (['md', 'markdown', 'mdown'].contains(ext) || mime == 'text/markdown') {
    return PreviewKind.markdown;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'avif'].contains(ext) ||
      mime.startsWith('image/') && !mime.contains('svg')) {
    return PreviewKind.image;
  }
  if (ext == 'zip' || mime == 'application/zip') return PreviewKind.zip;
  if (mime.startsWith('text/') ||
      [
        'txt',
        'log',
        'csv',
        'tsv',
        'json',
        'xml',
        'yml',
        'yaml',
        'css',
        'js',
        'py',
        'dart',
        'ini',
        'sql',
        'svg',
      ].contains(ext)) {
    return PreviewKind.text;
  }
  return PreviewKind.other;
}

class PreviewArchive {
  final entries = <String, ZipFileHeader>{};
  PreviewArchive(Uint8List bytes) {
    final directory = ZipDirectory();
    var count = 0;
    for (final row in directory.headers(
      InputMemoryStream(bytes),
      verify: true,
    )) {
      if (++count > 1500) throw const FormatException('压缩包文件过多');
      if (row.filename.endsWith('/')) continue;
      if (row.filename.contains(r'\') ||
          row.filename
              .split('/')
              .any((p) => p.isEmpty || p == '.' || p == '..') ||
          entries.containsKey(row.filename)) {
        throw const FormatException('压缩包包含无效路径');
      }
      entries[row.filename] = row;
    }
    if (directory.filePosition < 0) throw const FormatException('无法读取压缩包目录');
  }

  Uint8List read(String path, {int limit = 16 * 1024 * 1024}) {
    final header = entries[path];
    if (header == null ||
        header.uncompressedSize < 0 ||
        header.uncompressedSize > limit) {
      throw const FormatException('文件缺失或超过预览大小限制');
    }
    final entry = header.file;
    if (entry == null ||
        entry.uncompressedSize != header.uncompressedSize ||
        entry.filename != path) {
      throw const FormatException('压缩包文件信息不一致');
    }
    entry.verify = true;
    entry.throwOnError = true;
    final output = OutputMemoryStream();
    entry.decompress(output);
    if (output.length != header.uncompressedSize) {
      throw const FormatException('文件内容不完整');
    }
    return output.getBytes();
  }

  String wordText() {
    final source = utf8.decode(
      read('word/document.xml', limit: 4 * 1024 * 1024),
    );
    if (source.contains('<!DOCTYPE')) {
      throw const FormatException('无法读取此 Word 文档');
    }
    final out = StringBuffer();
    bool text = false;
    for (final event in parseEvents(source)) {
      if (event is XmlStartElementEvent) {
        final tag = event.name.split(':').last;
        if (tag == 't') text = !event.isSelfClosing;
        if (tag == 'br') out.writeln();
        if (tag == 'tab') out.write('\t');
      } else if (event is XmlEndElementEvent) {
        final tag = event.name.split(':').last;
        if (tag == 't') text = false;
        if (tag == 'p') out.writeln();
      } else if (text && event is XmlTextEvent) {
        out.write(event.value);
      }
      if (out.length > 256 * 1024) {
        out.write('\n（正文较长，完整内容请查看原文件）');
        break;
      }
    }
    return out.toString().trim();
  }

  List<Map<String, String>> webFiles() {
    final files = <Map<String, String>>[];
    var remaining = 16 * 1024 * 1024;
    for (final path in entries.keys.where(
      (p) => RegExp(
        r'\.(html?|css|js|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp[34])$',
        caseSensitive: false,
      ).hasMatch(p),
    )) {
      if (files.length >= 200) throw const FormatException('网页资源过多');
      final data = read(path, limit: remaining);
      remaining -= data.length;
      files.add({'path': path, 'data': base64Encode(data)});
    }
    return files;
  }
}

String previewText(DownloadedArtifact file) {
  const limit = 512 * 1024;
  final length = file.bytes.length;
  var end = length > limit ? limit : length;
  if (end < length) {
    while (end > 0 && file.bytes[end] & 0xc0 == 0x80) {
      end--;
    }
  }
  final text = utf8.decode(Uint8List.sublistView(file.bytes, 0, end));
  if (text.contains('\u0000')) throw const FormatException('无法识别文本编码');
  return end < length ? '$text\n（仅显示部分内容）' : text;
}

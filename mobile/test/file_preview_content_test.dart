import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:archive/archive.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:pdfrx/pdfrx.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/file_preview_content.dart';

Uint8List zip(Map<String, String> files) {
  final archive = Archive();
  for (final e in files.entries) {
    archive.addFile(ArchiveFile.string(e.key, e.value));
  }
  return ZipEncoder().encodeBytes(archive);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('renders an actual PDF page from authenticated file bytes', () async {
    // Flutter's Linux test runner bundles hook outputs here, whereas PDFium's
    // default loader looks beside flutter_tester or in the old Dart asset map.
    // Load the real generated library; keep the rendering assertions below.
    if (!kIsWeb && Platform.isLinux) {
      Pdfrx.pdfiumModulePath = File(
        'build/native_assets/linux/libpdfium.so',
      ).absolute.path;
    }
    Pdfrx.cacheDirectoryPath ??= '.';
    await pdfrxFlutterInitialize();
    final doc = await PdfDocument.openData(
      base64Decode(
        'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzNiA0OF0gL0NvbnRlbnRzIDQgMCBSID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggMCA+PgpzdHJlYW0KCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjAwIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1Jvb3QgMSAwIFIgL1NpemUgNSA+PgpzdGFydHhyZWYKMjQ5CiUlRU9G',
      ),
    );
    try {
      expect(doc.pages.length, 1);
      final image = await doc.pages.first.render();
      expect(image, isNotNull);
      expect(image!.width, 36);
      expect(image.height, 48);
      image.dispose();
    } finally {
      await doc.dispose();
    }
  });
  test(
    'DOCX exposes readable paragraph text without opening embedded objects',
    () {
      final archive = PreviewArchive(
        zip({
          'word/document.xml':
              '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>甲 &amp; 乙</w:t></w:r></w:p><w:p><w:r><w:t>下一段</w:t></w:r></w:p></w:body></w:document>',
          'word/media/x.png': 'unrelated',
        }),
      );
      expect(archive.wordText(), '甲 & 乙\n下一段');
    },
  );
  test(
    'archive preview bounds reads and supplies matching webpage resources',
    () {
      final archive = PreviewArchive(
        zip({
          'site/index.html': '<script src="game.js"></script>',
          'site/game.js': 'run()',
          'file.doc': 'opaque',
        }),
      );
      expect(archive.webFiles().map((f) => f['path']), [
        'site/index.html',
        'site/game.js',
      ]);
      expect(utf8.decode(archive.read('site/game.js')), 'run()');
      expect(() => archive.read('file.doc', limit: 2), throwsFormatException);
      expect(
        () => PreviewArchive(zip({'../escape.js': 'x'})),
        throwsFormatException,
      );
    },
  );
  test(
    'common attachment types use the same preview regardless of entry point',
    () {
      expect(
        filePreviewKind('文稿.MD', 'application/octet-stream'),
        PreviewKind.markdown,
      );
      expect(filePreviewKind('附件', 'application/pdf'), PreviewKind.pdf);
      expect(filePreviewKind('演示.docx', ''), PreviewKind.word);
      expect(filePreviewKind('游戏.HTML', ''), PreviewKind.html);
      expect(
        filePreviewKind('旧文件.doc', 'application/msword'),
        PreviewKind.other,
      );
    },
  );
}

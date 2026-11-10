import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'document_frame_stub.dart'
    if (dart.library.js_interop) 'document_frame_web.dart'
    if (dart.library.io) 'document_frame_native.dart';

/// Only the nested, opaque-origin frame runs delivered scripts.
class IsolatedDocument extends StatefulWidget {
  final String entry;
  final List<Map<String, String>> files;
  const IsolatedDocument({super.key, required this.entry, required this.files});
  @override
  State<IsolatedDocument> createState() => _IsolatedDocumentState();
}

class _IsolatedDocumentState extends State<IsolatedDocument> {
  late final Future<String> document = _buildDocument();
  Future<String> _buildDocument() async {
    final script = await rootBundle.loadString(
      'assets/shared-conversation/delivery-preview.js',
    );
    final payload =
        jsonEncode({'entryPath': widget.entry, 'files': widget.files})
            .replaceAll('<', r'\u003c')
            .replaceAll('\u2028', r'\u2028')
            .replaceAll('\u2029', r'\u2029');
    final template = await rootBundle.loadString('assets/document-frame.html');
    return template
        .replaceFirst('/* FILE */', payload)
        .replaceFirst(
          '/* RENDERER */',
          script.replaceAll('</script', r'<\/script'),
        );
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<String>(
    future: document,
    builder: (_, s) {
      if (s.hasError) return const Center(child: Text('网页预览未能加载，可下载原件。'));
      return s.hasData
          ? DocumentFrame(html: s.requireData)
          : const Center(child: CircularProgressIndicator());
    },
  );
}

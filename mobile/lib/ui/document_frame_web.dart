import 'dart:js_interop';
import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

class DocumentFrame extends StatelessWidget {
  final String html;
  const DocumentFrame({super.key, required this.html});
  @override
  Widget build(BuildContext context) => HtmlElementView.fromTagName(
    tagName: 'iframe',
    onElementCreated: (element) {
      final frame = element as web.HTMLIFrameElement;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = '文件预览';
      frame.style.cssText = 'border:0;width:100%;height:100%';
      frame.srcdoc = html.toJS;
    },
  );
}

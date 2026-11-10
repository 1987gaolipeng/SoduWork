import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

class DocumentFrame extends StatefulWidget {
  final String html;
  const DocumentFrame({super.key, required this.html});
  @override
  State<DocumentFrame> createState() => _DocumentFrameState();
}

class _DocumentFrameState extends State<DocumentFrame> {
  late final controller = WebViewController()
    ..setJavaScriptMode(JavaScriptMode.unrestricted)
    ..setNavigationDelegate(
      NavigationDelegate(
        onNavigationRequest: (request) =>
            request.url == 'about:blank' ||
                request.url == 'about:srcdoc' ||
                request.url.startsWith('data:text/html') && request.isMainFrame
            ? NavigationDecision.navigate
            : NavigationDecision.prevent,
      ),
    )
    ..loadHtmlString(widget.html);
  @override
  Widget build(BuildContext context) {
    if (defaultTargetPlatform != TargetPlatform.android &&
        defaultTargetPlatform != TargetPlatform.iOS) {
      return const Center(child: Text('请在浏览器或手机上预览此网页。'));
    }
    return WebViewWidget(controller: controller);
  }
}

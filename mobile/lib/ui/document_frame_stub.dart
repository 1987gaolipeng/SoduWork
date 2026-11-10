import 'package:flutter/widgets.dart';

class DocumentFrame extends StatelessWidget {
  final String html;
  const DocumentFrame({super.key, required this.html});
  @override
  Widget build(BuildContext context) => const Text('请保存后打开网页。');
}

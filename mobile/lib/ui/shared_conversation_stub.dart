import 'package:flutter/widgets.dart';

const sharedConversationAvailable = false;

class SharedConversationView extends StatelessWidget {
  final Future<Object?> Function(String, Map<String, dynamic>) onRequest;
  final bool dark;
  final String accent;
  final String locale;
  const SharedConversationView({
    super.key,
    required this.onRequest,
    this.dark = false,
    this.accent = 'neutral',
    this.locale = 'zh-CN',
  });

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

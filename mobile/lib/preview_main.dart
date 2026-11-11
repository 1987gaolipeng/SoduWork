import 'package:flutter/material.dart';

import 'models/work_models.dart';
import 'screens/app_shell.dart';
import 'state/mobile_scope.dart';
import 'state/mobile_state.dart';
import 'ui/mobile_theme.dart';

/// Dedicated build target. It never initializes auth, storage or an API client.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MobilePreview());
}

class MobilePreview extends StatefulWidget {
  const MobilePreview({super.key});
  @override
  State<MobilePreview> createState() => _MobilePreviewState();
}

class _MobilePreviewState extends State<MobilePreview> {
  final _state = MobileState()..phase = MobilePhase.ready;

  @override
  void initState() {
    super.initState();
    _state.tasks = [
      WorkTask.fromJson({
        'id': 'preview-delivery',
        'title': '整理项目交付材料',
        'note': '帮我整理项目交付材料，列出成果和验收标准。',
        'status': 'done',
        'origin': 'cloud-conversation',
      }),
      WorkTask.fromJson({
        'id': 'preview-weekly',
        'title': '梳理本周团队工作',
        'note': '梳理本周团队的工作重点和需要确认的事项。',
        'status': 'done',
        'origin': 'cloud-conversation',
      }),
    ];
  }

  @override
  void dispose() {
    _state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    title: 'SoduWork · 界面预览',
    theme: SoduWorkTheme.light(),
    home: MobileScope(state: _state, child: const AppShell(preview: true)),
  );
}

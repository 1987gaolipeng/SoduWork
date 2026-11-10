import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_sheet.dart';
import '../ui/mobile_theme.dart';

class WorkBriefSheet extends StatefulWidget {
  const WorkBriefSheet({super.key});
  @override
  State<WorkBriefSheet> createState() => _WorkBriefSheetState();
}

class _WorkBriefSheetState extends State<WorkBriefSheet> {
  bool _busy = false;
  String _error = '';
  Future<void> _generate() async {
    final state = MobileScope.read(context),
        identity = MobileScope.read(context).identityRevision;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await state.generateBrief();
    } on ApiFailure catch (e) {
      if (mounted && state.identityRevision == identity) {
        setState(() => _error = e.message);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context), theme = context.soduWorkTheme;
    final english =
        MobileDisplayScope.maybeOf(context)?.language == MobileLanguage.english;
    return ListView(
      controller: MobileSheetScope.maybeOf(context)?.scrollController,
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
      children: [
        if (_error.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Text(mobileText(context, _error), style: TextStyle(color: theme.inkMuted)),
          ),
        Material(
          color: theme.surface,
          borderRadius: BorderRadius.circular(22),
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: SelectableText(
              state.brief?.content.isNotEmpty == true
                  ? state.brief!.content
                  : english
                  ? 'Your work brief will appear here after you have more work activity.'
                  : mobileText(context, '工作简报会根据你的实际工作记录整理。当前还没有可显示的内容。'),
              style: TextStyle(color: theme.ink, fontSize: 15, height: 1.7),
            ),
          ),
        ),
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _busy ? null : _generate,
          child: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 1.5),
                )
              : Text(
                  english ? 'Generate brief' : mobileText(context, '生成工作简报'),
                ),
        ),
      ],
    );
  }
}

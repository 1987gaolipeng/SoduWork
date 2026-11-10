import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../state/mobile_scope.dart';
import 'mobile_theme.dart';

class CloudConversationAcceptanceCard extends StatefulWidget {
  final dynamic approval;
  final String taskId;

  const CloudConversationAcceptanceCard({
    super.key,
    required this.approval,
    required this.taskId,
  });

  @override
  State<CloudConversationAcceptanceCard> createState() =>
      _AcceptanceCardState();
}

class _AcceptanceCardState extends State<CloudConversationAcceptanceCard> {
  bool _busy = false;
  String _error = '';

  Future<void> _decide(String decision, {String note = ''}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final state = MobileScope.read(context);
      await state.decideApproval(
        widget.approval,
        decision: decision,
        note: note,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            decision == 'approve'
                ? mobileText(context, '已通过验收')
                : mobileText(context, '已打回，附上了你的意见'),
          ),
        ),
      );
    } catch (error) {
      if (mounted) setState(() => _error = '操作没有完成：$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _rejectFlow() async {
    final controller = TextEditingController();
    final theme = context.soduWorkTheme;
    final note = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(mobileText(context, '打回这次交付？')),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 2,
          maxLines: 4,
          decoration: InputDecoration(
            hintText: mobileText(context, '说明哪里不符合预期，云端会接着修改…'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(mobileText(context, '取消')),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: theme.ink,
              foregroundColor: theme.surface,
            ),
            onPressed: () => Navigator.of(context).pop(controller.text.trim()),
            child: Text(mobileText(context, '打回')),
          ),
        ],
      ),
    );
    if (!mounted || note == null) return;
    await _decide('reject', note: note);
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 6, 16, 4),
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
      decoration: BoxDecoration(
        color: theme.surface,
        border: Border.all(color: theme.lineStrong),
        borderRadius: BorderRadius.circular(theme.radiusMedium),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.verified_outlined,
                size: 17,
                color: theme.inkSecondary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  mobileText(context, '成果已交付，等你验收'),
                  style: TextStyle(
                    color: theme.ink,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          Text(
            mobileText(context, '核对上面的交付成果，通过后这项工作就完成了。'),
            style: TextStyle(
              color: theme.inkMuted,
              fontSize: 11.5,
              height: 1.4,
            ),
          ),
          if (_error.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(mobileText(context, _error), style: TextStyle(color: theme.danger, fontSize: 12)),
          ],
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : _rejectFlow,
                  child: Text(mobileText(context, '打回')),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton.icon(
                  onPressed: _busy ? null : () => _decide('approve'),
                  icon: _busy
                      ? SizedBox(
                          width: 15,
                          height: 15,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.check_rounded, size: 16),
                  label: Text(mobileText(context, '通过验收')),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

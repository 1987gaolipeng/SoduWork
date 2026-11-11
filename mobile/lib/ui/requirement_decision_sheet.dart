import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

/// Owns its controller until the sheet's closing transition has completed.
class RequirementDecisionSheet extends StatefulWidget {
  final String decision;
  const RequirementDecisionSheet({super.key, required this.decision});
  @override
  State<RequirementDecisionSheet> createState() =>
      _RequirementDecisionSheetState();
}

class _RequirementDecisionSheetState extends State<RequirementDecisionSheet> {
  final _controller = TextEditingController();
  String _error = '';
  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reject = widget.decision == 'reject';
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        4,
        20,
        20 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              reject
                  ? mobileText(context, '驳回并说明原因')
                  : mobileText(context, '确认通过'),
              style: Theme.of(context).textTheme.headlineMedium,
            ),
            const SizedBox(height: 7),
            Text(
              reject
                  ? mobileText(context, '原因会作为下一轮修正的依据，所选返修资料会一并提供。')
                  : mobileText(context, '意见提交后由服务端继续推进当前流程。'),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _controller,
              autofocus: reject,
              minLines: 3,
              maxLines: 6,
              maxLength: 1000,
              decoration: InputDecoration(
                labelText: reject
                    ? mobileText(context, '驳回原因')
                    : mobileText(context, '审批意见（可选）'),
                alignLabelWithHint: true,
              ),
            ),
            if (_error.isNotEmpty) Text(mobileText(context, _error)),
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () {
                  final value = _controller.text.trim();
                  if (reject && value.isEmpty) {
                    setState(() => _error = '请写清需要修正的问题。');
                    return;
                  }
                  Navigator.of(context).pop(value);
                },
                child: Text(
                  reject
                      ? mobileText(context, '确认驳回')
                      : mobileText(context, '确认通过'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

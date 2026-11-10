import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import 'mobile_display_preferences.dart';

/// A lost response must be reconciled with its original server receipt.
class PendingCloudRequestBanner extends StatefulWidget {
  final ValueChanged<Map<String, dynamic>> onResolved;
  const PendingCloudRequestBanner({super.key, required this.onResolved});
  @override
  State<PendingCloudRequestBanner> createState() =>
      _PendingCloudRequestBannerState();
}

class _PendingCloudRequestBannerState extends State<PendingCloudRequestBanner> {
  bool _busy = false;
  String _error = '';
  Future<void> _reconcile() async {
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final receipt = await state.reconcilePendingCloudRequest();
      if (mounted && state.identityRevision == identity) {
        widget.onResolved(receipt);
      }
    } on ApiFailure catch (error) {
      if (mounted && state.identityRevision == identity) {
        setState(
          () => _error = error.status == 404
              ? '云端暂未找到原请求回执，请稍后再次核对或联系管理员。为避免重复执行，暂不重新派发。'
              : error.message,
        );
      }
    } catch (_) {
      if (mounted && state.identityRevision == identity) {
        setState(() => _error = '暂时无法核对发送结果，请稍后重试。');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    final request = state.pendingCloudRequest;
    if (request == null || request.isAccountBranch || !request.receiptOnly) {
      return const SizedBox.shrink();
    }
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            mobileText(context, '上一笔发送结果待核对'),
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(mobileText(context, '先确认云端是否接单，再继续新对话。核对不会重新发送内容。')),
          if (_error.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              mobileText(context, _error),
              style: TextStyle(color: scheme.error),
            ),
          ],
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: _busy ? null : _reconcile,
              icon: _busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.sync_rounded, size: 18),
              label: Text(mobileText(context, _busy ? '正在核对' : '核对发送结果')),
            ),
          ),
        ],
      ),
    );
  }
}

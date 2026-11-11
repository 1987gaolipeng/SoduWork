import 'package:flutter/material.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import 'mobile_display_preferences.dart';

List<Map<String, dynamic>> capabilityRows(dynamic value) => value is List
    ? value
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList()
    : [];

/// Freeze the owner for an open editor. A changed identity must reopen the page;
/// it must never inherit the previous account's form or pending response.
abstract class CapabilityState<T extends StatefulWidget> extends State<T> {
  MobileState? owner;
  int? identity;
  bool busy = false;
  bool invalidated = false;
  String error = '';
  String receipt = '';
  bool get current =>
      mounted &&
      !invalidated &&
      identical(owner, MobileScope.read(context)) &&
      owner!.identityRevision == identity;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (owner == null) {
      owner = state;
      identity = state.identityRevision;
      owner!.addListener(_identityChanged);
      initialize();
    } else if (!identical(owner, state) || identity != state.identityRevision) {
      invalidated = true;
    }
  }

  void _identityChanged() {
    if (mounted && identity != owner!.identityRevision) {
      setState(() => invalidated = true);
    }
  }

  void initialize() {}

  Future<void> perform(Future<void> Function(SoduWorkApi api) action) async {
    if (!current || busy) return;
    setState(() {
      busy = true;
      error = '';
      receipt = '';
    });
    try {
      await action(owner!.api);
    } catch (e) {
      if (current) {
        setState(
          () =>
              error = e is ApiFailure ? e.message : '操作未能确认，请刷新后核对；已填写的内容会保留。',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget text(String label) => Text(mobileText(context, label));
  Widget get identityNotice => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: text('账号或服务已切换，请关闭后重新打开。'),
    ),
  );
  List<Widget> get feedback => [
    if (busy) const LinearProgressIndicator(),
    if (error.isNotEmpty)
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Text(
          mobileText(context, error),
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      ),
    if (receipt.isNotEmpty)
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Text(mobileText(context, receipt)),
      ),
  ];

  Future<bool> confirm(String title, String detail) async =>
      await showDialog<bool>(
            context: context,
            builder: (context) => AlertDialog(
              title: text(title),
              content: text(detail),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: text('取消'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: text('确认'),
                ),
              ],
            ),
          ) ==
          true &&
      current;

  @override
  void dispose() {
    owner?.removeListener(_identityChanged);
    super.dispose();
  }
}

class CapabilityScopeNote extends StatelessWidget {
  const CapabilityScopeNote({super.key});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Text(
      mobileText(context, '此处管理当前手机连接身份的能力。远程电脑的安装与配置仍由对应设备管理；启用不代表目标执行机已就绪。'),
      style: Theme.of(context).textTheme.bodySmall,
    ),
  );
}

class CapabilityDraftGuard extends StatefulWidget {
  final bool dirty;
  final bool busy;
  final Widget child;
  const CapabilityDraftGuard({
    super.key,
    required this.dirty,
    required this.busy,
    required this.child,
  });
  @override
  State<CapabilityDraftGuard> createState() => _CapabilityDraftGuardState();
}

class _CapabilityDraftGuardState extends State<CapabilityDraftGuard> {
  bool _allow = false;
  bool _asking = false;
  @override
  Widget build(BuildContext context) => PopScope(
    canPop: _allow || (!widget.dirty && !widget.busy),
    onPopInvokedWithResult: (didPop, result) async {
      if (didPop || widget.busy || _asking) return;
      _asking = true;
      final leave = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(mobileText(context, '保留正在编辑的内容？')),
          content: Text(mobileText(context, '继续编辑可保留输入；放弃后将关闭此页。')),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(mobileText(context, '继续编辑')),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(mobileText(context, '放弃编辑')),
            ),
          ],
        ),
      );
      _asking = false;
      if (!mounted || leave != true) return;
      setState(() => _allow = true);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).pop();
      });
    },
    child: widget.child,
  );
}

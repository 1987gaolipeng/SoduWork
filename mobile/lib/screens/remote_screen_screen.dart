import '../ui/mobile_display_preferences.dart';
import 'dart:async';

import 'package:flutter/material.dart';

import '../state/remote_screen_controller.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_theme.dart';

/// This route owns the supplied controller and ends consent when it leaves.
class RemoteScreenScreen extends StatefulWidget {
  final String sourceClientId;
  final String sourceName;
  final RemoteScreenController controller;
  const RemoteScreenScreen({
    super.key,
    required this.sourceClientId,
    required this.sourceName,
    required this.controller,
  });

  @override
  State<RemoteScreenScreen> createState() => _RemoteScreenScreenState();
}

class _RemoteScreenScreenState extends State<RemoteScreenScreen>
    with WidgetsBindingObserver {
  MobileState? _identityState;
  int? _identityRevision;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.maybeOf(context);
    if (identical(state, _identityState)) return;
    _identityState?.removeListener(_checkIdentity);
    if (_identityState != null) {
      unawaited(widget.controller.stop(message: '登录环境已变化，看屏已停止'));
    }
    _identityState = state;
    _identityRevision = state?.identityRevision;
    state?.addListener(_checkIdentity);
  }

  void _checkIdentity() {
    if (_identityState?.identityRevision != _identityRevision ||
        _identityState?.phase != MobilePhase.ready) {
      unawaited(widget.controller.stop(message: '登录身份已变化，画面已清除'));
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      unawaited(widget.controller.stop(message: '页面已离开前台，看屏已停止'));
    }
  }

  @override
  void dispose() {
    _identityState?.removeListener(_checkIdentity);
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.sourceName.isEmpty
              ? mobileText(context, '远程看屏')
              : widget.sourceName,
        ),
      ),
      body: SafeArea(
        child: ListenableBuilder(
          listenable: widget.controller,
          builder: (context, _) {
            final controller = widget.controller;
            return Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    controller.status,
                    style: TextStyle(color: theme.inkSecondary),
                  ),
                ),
                Expanded(
                  child: controller.frame == null
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(
                              mobileText(
                                context,
                                '只查看电脑明确同意共享的屏幕。\n不允许鼠标、键盘、声音或文件操作。',
                              ),
                              textAlign: TextAlign.center,
                              style: TextStyle(color: theme.inkMuted),
                            ),
                          ),
                        )
                      : InteractiveViewer(
                          minScale: 1,
                          maxScale: 5,
                          child: Image.memory(
                            controller.frame!,
                            cacheWidth: 1280,
                            fit: BoxFit.contain,
                            semanticLabel: mobileText(context, '来源电脑的只读屏幕画面'),
                            errorBuilder: (context, error, stack) {
                              WidgetsBinding.instance.addPostFrameCallback((_) {
                                unawaited(
                                  controller.stop(message: '来源画面无法解码，看屏已停止'),
                                );
                              });
                              return Text(mobileText(context, '无法显示画面'));
                            },
                          ),
                        ),
                ),
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: controller.grant == null && !controller.ended
                      ? FilledButton.icon(
                          onPressed: controller.busy
                              ? null
                              : () => controller.start(widget.sourceClientId),
                          icon: const Icon(Icons.desktop_windows_outlined),
                          label: Text(
                            controller.busy
                                ? mobileText(context, '正在申请…')
                                : mobileText(context, '向电脑申请只读看屏'),
                          ),
                        )
                      : OutlinedButton.icon(
                          onPressed: controller.ended
                              ? null
                              : () => controller.stop(),
                          icon: const Icon(Icons.stop_circle_outlined),
                          label: Text(
                            controller.ended
                                ? mobileText(context, '已结束')
                                : mobileText(context, '停止查看'),
                          ),
                        ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

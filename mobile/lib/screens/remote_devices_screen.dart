import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_sheet.dart';
import 'package:flutter/material.dart';

import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../state/remote_screen_controller.dart';
import '../ui/work_widgets.dart';
import 'remote_screen_screen.dart';

class RemoteDevicesScreen extends StatefulWidget {
  const RemoteDevicesScreen({super.key});
  @override
  State<RemoteDevicesScreen> createState() => _RemoteDevicesScreenState();
}

class _RemoteDevicesScreenState extends State<RemoteDevicesScreen> {
  MobileState? _state;
  int _identity = -1;
  int _request = 0;
  bool _loading = true;
  String _error = '';
  List<Map<String, dynamic>> _devices = const [];

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state != state || _identity != state.identityRevision) {
      _state = state;
      _identity = state.identityRevision;
      _devices = const [];
      _loading = true;
      _error = '';
      _load();
    }
  }

  bool _current(MobileState state, int identity) =>
      mounted &&
      state == _state &&
      state.identityRevision == identity &&
      state.phase == MobilePhase.ready;

  Future<void> _load() async {
    final state = _state!;
    final identity = _identity;
    final request = ++_request;
    try {
      final value = await state.api.remoteScreenRequest(
        'GET',
        '/api/v1/remote-screen/sources',
      );
      if (!_current(state, identity) || request != _request) return;
      final rows = value['items'];
      if (rows is! List) throw const ApiFailure('设备目录响应不完整，请重试。');
      setState(() {
        _devices = rows
            .whereType<Map<String, dynamic>>()
            .where(
              (row) =>
                  row['id'] is String &&
                  (row['id'] as String).isNotEmpty &&
                  row['capability'] == 'read-only-screen-v1',
            )
            .toList(growable: false);
        _error = '';
      });
    } on ApiFailure catch (failure) {
      if (_current(state, identity) && request == _request) {
        setState(
          () => _error = failure.status == 404
              ? '当前 Hub 尚未开放远程看屏，请等待服务升级。'
              : failure.message,
        );
      }
    } catch (_) {
      if (_current(state, identity) && request == _request) {
        setState(() => _error = '暂时无法读取你的电脑，请重试。');
      }
    } finally {
      if (_current(state, identity) && request == _request) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    await _load();
  }

  void _open(Map<String, dynamic> device) {
    final state = _state!;
    final identity = _identity;
    if (!_current(state, identity) || device['online'] != true) return;
    final controller = RemoteScreenController(
      baseUrl: Uri.parse(state.api.baseUrl),
      isCurrent: () =>
          state.identityRevision == identity &&
          state.phase == MobilePhase.ready,
      request: (method, path, {body}) async {
        if (!_current(state, identity)) {
          throw const ApiFailure('账号已切换，请重新选择电脑。');
        }
        final value = await state.api.remoteScreenRequest(
          method,
          path,
          body: body,
        );
        if (!_current(state, identity)) {
          throw const ApiFailure('账号已切换，请重新选择电脑。');
        }
        return value;
      },
    );
    final theme = Theme.of(context);
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => Theme(
          data: theme,
          child: RemoteScreenScreen(
            sourceClientId: device['id'] as String,
            sourceName: (device['name'] ?? '我的电脑').toString(),
            controller: controller,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    final current = _current(state, _identity);
    return Scaffold(
      appBar: MobileSheetScope.maybeOf(context) != null
          ? null
          : AppBar(
              title: Text(mobileText(context, '远程看屏')),
              actions: [
                IconButton(
                  tooltip: mobileText(context, '刷新电脑'),
                  onPressed: _loading || !current ? null : _refresh,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          controller: MobileSheetScope.maybeOf(context)?.scrollController,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              mobileText(context, '查看自己电脑上的工作'),
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 10),
            Text(mobileText(context, '在电脑端同意并选定屏幕后，手机才能看到画面。你可以随时停止共享。')),
            const SizedBox(height: 8),
            Text(mobileText(context, '当前支持只读画面，可放大查看；鼠标、键盘、声音和文件操作暂未开放。')),
            const SizedBox(height: 24),
            if (_loading) const LinearProgressIndicator(),
            if (_error.isNotEmpty)
              InlineError(message: mobileText(context, _error), onRetry: _refresh),
            if (!_loading && _error.isEmpty && _devices.isEmpty)
              Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Column(
                  children: [
                    Icon(Icons.desktop_windows_outlined, size: 42),
                    SizedBox(height: 14),
                    Text(mobileText(context, '还没有可查看的电脑')),
                    SizedBox(height: 8),
                    Text(
                      mobileText(
                        context,
                        '请在电脑安装支持看屏的 SoduWork 客户端，登录同一个账号并保持在线。',
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ),
              ),
            if (current)
              for (final device in _devices)
                Card(
                  elevation: 0,
                  child: ListTile(
                    leading: const Icon(Icons.desktop_windows_outlined),
                    title: Text((device['name'] ?? '我的电脑').toString()),
                    subtitle: Text(
                      device['online'] == true
                          ? mobileText(context, '在线 · 需要电脑端同意')
                          : mobileText(context, '离线 · 请先打开电脑客户端'),
                    ),
                    trailing: const Icon(Icons.chevron_right_rounded),
                    enabled: device['online'] == true,
                    onTap: () => _open(device),
                  ),
                ),
          ],
        ),
      ),
    );
  }
}

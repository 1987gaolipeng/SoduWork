import '../sdk/soduwork_sdk_config.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_theme.dart';

class SettingsSheet extends StatefulWidget {
  final ScrollController scrollController;
  final MobileDisplayPreferences preferences;
  final bool preview;
  final ValueChanged<String> onResource;
  const SettingsSheet({
    super.key,
    required this.scrollController,
    required this.preferences,
    this.preview = false,
    required this.onResource,
  });
  @override
  State<SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends State<SettingsSheet> {
  Map<String, dynamic>? _profile;
  String _error = '';
  bool _loading = false;
  int? _identity;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_identity == null) {
      _identity = state.identityRevision;
      if (!widget.preview) _load();
    } else if (_identity != state.identityRevision) {
      _profile = null;
      _error = '账号已变化，请关闭后重新打开。';
      _loading = false;
    }
  }

  Future<void> _load() async {
    final state = MobileScope.read(context);
    if (_identity != state.identityRevision) return;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final data = await state.api.currentAccount();
      if (!mounted || _identity != state.identityRevision) return;
      final user = data['user'];
      if (user is! Map ||
          user['id']?.toString() != state.enrollment?.ownerUserId) {
        throw StateError('account mismatch');
      }
      setState(() => _profile = data);
    } catch (_) {
      if (mounted && _identity == state.identityRevision) {
        setState(() => _error = '账号资料暂时无法读取');
      }
    } finally {
      if (mounted && _identity == state.identityRevision) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _choice<T>(
    BuildContext rowContext,
    List<(T, String)> choices,
    T value,
    ValueChanged<T> selected,
  ) async {
    final box = rowContext.findRenderObject() as RenderBox;
    final overlay =
        Overlay.of(rowContext).context.findRenderObject() as RenderBox;
    final point = box.localToGlobal(Offset.zero, ancestor: overlay);
    final picked = await showMenu<T>(
      context: rowContext,
      position: RelativeRect.fromRect(
        Rect.fromLTWH(
          point.dx + box.size.width - 44,
          point.dy,
          44,
          box.size.height,
        ),
        Offset.zero & overlay.size,
      ),
      constraints: const BoxConstraints(minWidth: 200, maxWidth: 240),
      color: context.soduWorkTheme.surfaceRaised,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      items: [
        for (final item in choices)
          PopupMenuItem<T>(
            value: item.$1,
            child: Row(
              children: [
                SizedBox(
                  width: 24,
                  child: item.$1 == value
                      ? const Icon(CupertinoIcons.check_mark, size: 17)
                      : null,
                ),
                Text(mobileText(context, item.$2)),
              ],
            ),
          ),
      ],
    );
    if (mounted && picked != null) selected(picked);
  }

  Future<void> _signOut() async {
    final state = MobileScope.read(context);
    if (_identity != state.identityRevision) return;
    final identity = state.identityRevision;
    final confirmed = await showDialog<bool>(
      context: context,
      useRootNavigator: false,
      builder: (context) => AlertDialog(
        title: Text(mobileText(context, '退出当前账号？')),
        content: Text(mobileText(context, '此设备将退出登录。已同步的会话仍保留在企业工作空间中。')),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(mobileText(context, '取消')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(mobileText(context, '退出账号')),
          ),
        ],
      ),
    );
    if (!mounted || confirmed != true || identity != state.identityRevision) {
      return;
    }
    await state.signOut();
    if (mounted && state.phase != MobilePhase.ready) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    if (_identity != state.identityRevision ||
        (!widget.preview && state.phase != MobilePhase.ready)) {
      return Center(child: Text(mobileText(context, '账号已变化，请关闭后重新打开。')));
    }
    final prefs = widget.preferences;
    final theme = context.soduWorkTheme;
    final user = _profile?['user'] is Map ? _profile!['user'] as Map : const {};
    final quota = _profile?['quota'] is Map
        ? _profile!['quota'] as Map
        : const {};
    final display = user['displayName']?.toString().trim() ?? '';
    final account = user['username']?.toString() ?? '';
    final title = widget.preview
        ? mobileText(context, '界面预览')
        : display.isNotEmpty
        ? display
        : account.isNotEmpty
        ? account
        : mobileText(context, '账号');
    String value(Object? raw) => raw == null || raw.toString().isEmpty
        ? mobileText(context, '未提供')
        : raw.toString();
    return ListenableBuilder(
      listenable: prefs,
      builder: (context, _) => ListView(
        controller: widget.scrollController,
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 32),
        children: [
          Center(
            child: Column(
              children: [
                CircleAvatar(
                  radius: 32,
                  backgroundColor: theme.ink.withValues(alpha: .09),
                  foregroundColor: theme.ink,
                  child: _loading
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 1.5),
                        )
                      : Text(
                          title.characters.take(2).toString(),
                          style: const TextStyle(
                            fontSize: 23,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                ),
                const SizedBox(height: 10),
                Text(
                  title,
                  style: TextStyle(
                    color: theme.ink,
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (display.isNotEmpty && account.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      account,
                      style: TextStyle(color: theme.inkMuted, fontSize: 13),
                    ),
                  ),
              ],
            ),
          ),
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      mobileText(context, _error),
                      style: TextStyle(color: theme.inkMuted, fontSize: 12),
                    ),
                  ),
                  if (_identity == state.identityRevision)
                    TextButton(
                      onPressed: _loading ? null : _load,
                      child: Text(mobileText(context, '重试')),
                    ),
                ],
              ),
            ),
          _label('账户信息'),
          _group([
            _row(
              CupertinoIcons.person,
              '账号',
              value: widget.preview
                  ? mobileText(context, '界面预览')
                  : account.isNotEmpty
                  ? account
                  : '—',
            ),
            if (!widget.preview)
              _row(
                CupertinoIcons.arrow_2_circlepath,
                '切换账号',
                onTap: state.signingOut ? null : _signOut,
              ),
            _row(
              CupertinoIcons.building_2_fill,
              '企业服务',
              value: widget.preview
                  ? 'SoduWork'
                  : (SoduWorkSdkScope.maybeOf(
                          context,
                        )?.serviceDisplayName.isNotEmpty ??
                        false)
                  ? SoduWorkSdkScope.of(context).serviceDisplayName
                  : Uri.tryParse(state.endpoint.baseUrl)?.host ?? '—',
            ),
            if (!widget.preview)
              _row(
                CupertinoIcons.device_phone_portrait,
                '当前设备',
                value: value(state.enrollment?.deviceName),
              ),
            if (!widget.preview)
              ExpansionTile(
                tilePadding: const EdgeInsets.symmetric(horizontal: 16),
                leading: Icon(
                  CupertinoIcons.person_crop_circle,
                  size: 22,
                  color: theme.ink,
                ),
                title: Text(
                  mobileText(context, '账号详情'),
                  style: TextStyle(color: theme.ink, fontSize: 14.5),
                ),
                shape: const Border(),
                collapsedShape: const Border(),
                childrenPadding: const EdgeInsets.fromLTRB(48, 0, 16, 14),
                children: [
                  for (final detail in [
                    ('用户标识', state.enrollment?.ownerUserId),
                    ('设备标识', state.enrollment?.deviceId),
                    ('团队标识', user['orgId']),
                    ('角色标识', user['roleId']),
                  ])
                    if (detail.$2 != null && detail.$2.toString().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 8),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: SelectableText(
                            '${mobileText(context, detail.$1)}: ${detail.$2}',
                            style: TextStyle(
                              color: theme.inkMuted,
                              fontSize: 12,
                              height: 1.5,
                            ),
                          ),
                        ),
                      ),
                ],
              ),
          ]),
          _label('偏好设置'),
          _group([
            Builder(
              builder: (rowContext) => _row(
                CupertinoIcons.sun_max,
                '外观',
                value: mobileText(context, switch (prefs.appearance) {
                  MobileAppearanceMode.system => '跟随系统',
                  MobileAppearanceMode.light => '浅色',
                  MobileAppearanceMode.dark => '深色',
                }),
                onTap: () => _choice(
                  rowContext,
                  const [
                    (MobileAppearanceMode.system, '跟随系统'),
                    (MobileAppearanceMode.light, '浅色'),
                    (MobileAppearanceMode.dark, '深色'),
                  ],
                  prefs.appearance,
                  (value) => prefs.update(appearance: value),
                ),
              ),
            ),
            Builder(
              builder: (rowContext) => _row(
                CupertinoIcons.globe,
                '语言',
                value: prefs.language == MobileLanguage.chinese
                    ? '简体中文'
                    : 'English',
                onTap: () => _choice(
                  rowContext,
                  const [
                    (MobileLanguage.chinese, '简体中文'),
                    (MobileLanguage.english, 'English'),
                  ],
                  prefs.language,
                  (value) => prefs.update(language: value),
                ),
              ),
            ),
            Builder(
              builder: (rowContext) => _row(
                CupertinoIcons.paintbrush,
                '强调色',
                value: mobileText(context, switch (prefs.accent) {
                  'brand' => '品牌紫',
                  'blue' => '蓝色',
                  'green' => '绿色',
                  _ => '黑白',
                }),
                onTap: () => _choice(
                  rowContext,
                  const [
                    ('brand', '品牌紫'),
                    ('neutral', '黑白'),
                    ('blue', '蓝色'),
                    ('green', '绿色'),
                  ],
                  prefs.accent,
                  (value) => prefs.update(accent: value),
                ),
              ),
            ),
          ]),
          if (prefs.language == MobileLanguage.english)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                mobileText(context, '界面语言用于导航、设置与工作操作。你的内容、插件说明及服务端返回的信息保留原文。'),
                style: TextStyle(
                  color: theme.inkMuted,
                  fontSize: 12,
                  height: 1.5,
                ),
              ),
            ),
          if (prefs.saveError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                mobileText(context, prefs.saveError),
                style: TextStyle(color: theme.inkMuted, fontSize: 12),
              ),
            ),
          if (quota['enabled'] == true) ...[
            _label('使用情况'),
            _group([
              _row(
                CupertinoIcons.chart_bar,
                '本月已用',
                value: value(quota['used']),
              ),
              _row(CupertinoIcons.gauge, '本月额度', value: value(quota['limit'])),
            ]),
          ],
          _label('个性化'),
          _group([
            _row(
              CupertinoIcons.folder,
              '项目',
              onTap: () => widget.onResource('projects'),
            ),
            _row(
              CupertinoIcons.square_grid_2x2,
              '插件',
              onTap: () => widget.onResource('tools'),
            ),
          ]),
          _label('工作空间'),
          _group([
            _row(
              CupertinoIcons.bell,
              '通知',
              onTap: () => widget.onResource('notifications'),
            ),
            _row(
              CupertinoIcons.slider_horizontal_3,
              '我的模型',
              onTap: () => widget.onResource('models'),
            ),
            _row(
              CupertinoIcons.cloud,
              '云端环境',
              onTap: () => widget.onResource('cloud'),
            ),
            _row(
              CupertinoIcons.clock,
              '自动化',
              onTap: () => widget.onResource('automations'),
            ),
          ]),
          const SizedBox(height: 24),
          if (!widget.preview)
            _group([
              ListTile(
                title: Text(
                  mobileText(context, state.signingOut ? '正在退出…' : '退出当前账号'),
                  textAlign: TextAlign.center,
                  style: TextStyle(color: theme.danger, fontSize: 15),
                ),
                onTap: state.signingOut ? null : _signOut,
              ),
            ]),
          const SizedBox(height: 22),
          Center(
            child: Text(
              widget.preview
                  ? 'SoduWork · ${mobileText(context, '界面预览')}'
                  : 'SoduWork',
              style: TextStyle(color: theme.inkMuted, fontSize: 11),
            ),
          ),
        ],
      ),
    );
  }

  Widget _label(String label) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 26, 16, 9),
    child: Text(
      mobileText(context, label),
      style: TextStyle(
        color: context.soduWorkTheme.inkMuted,
        fontSize: 13,
        fontWeight: FontWeight.w500,
      ),
    ),
  );
  Widget _group(List<Widget> rows) => Material(
    color: context.soduWorkTheme.surface,
    borderRadius: BorderRadius.circular(22),
    clipBehavior: Clip.antiAlias,
    child: Column(
      children: [
        for (var i = 0; i < rows.length; i++) ...[
          if (i > 0)
            Divider(
              height: 1,
              indent: 48,
              endIndent: 16,
              color: context.soduWorkTheme.line,
            ),
          rows[i],
        ],
      ],
    ),
  );
  Widget _row(
    IconData icon,
    String label, {
    String? value,
    VoidCallback? onTap,
  }) => ListTile(
    minTileHeight: 52,
    horizontalTitleGap: 12,
    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
    leading: Icon(icon, size: 22, color: context.soduWorkTheme.ink),
    title: Row(
      children: [
        Expanded(
          child: Text(
            mobileText(context, label),
            style: TextStyle(
              color: context.soduWorkTheme.ink,
              fontSize: 14.5,
              fontWeight: FontWeight.w400,
            ),
          ),
        ),
        if (value != null && onTap != null)
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.right,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: context.soduWorkTheme.inkMuted, fontSize: 13),
            ),
          ),
      ],
    ),
    subtitle: value == null || onTap != null
        ? null
        : Text(
            value,
            style: TextStyle(color: context.soduWorkTheme.inkMuted, fontSize: 12.5),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
    trailing: onTap == null
        ? null
        : Icon(
            value == null
                ? CupertinoIcons.chevron_right
                : CupertinoIcons.chevron_up_chevron_down,
            size: 14,
            color: context.soduWorkTheme.inkMuted,
          ),
    onTap: onTap,
  );
}

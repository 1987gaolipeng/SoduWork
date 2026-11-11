import 'package:flutter/services.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_state.dart';
import 'package:flutter/material.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';

String authText(BuildContext context, String zh, String en) =>
    MobileDisplayScope.maybeOf(context)?.language == MobileLanguage.english
    ? en
    : zh;

class AccountAuthHeader extends StatelessWidget {
  final String title;
  final String subtitle;
  const AccountAuthHeader({
    super.key,
    required this.title,
    required this.subtitle,
  });
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final prefs = MobileDisplayScope.maybeOf(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const SoduWorkMark(size: 34),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                theme.brandName,
                style: TextStyle(
                  fontSize: 20,
                  color: theme.ink,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -.5,
                ),
              ),
            ),
            if (prefs != null)
              TextButton.icon(
                icon: const Icon(Icons.language_rounded, size: 18),
                label: Text(
                  prefs.language == MobileLanguage.english ? '中文' : 'EN',
                ),
                onPressed: () => prefs.update(
                  language: prefs.language == MobileLanguage.english
                      ? MobileLanguage.chinese
                      : MobileLanguage.english,
                ),
              ),
          ],
        ),
        const SizedBox(height: 38),
        Text(
          title,
          style: TextStyle(
            color: theme.ink,
            fontSize: 30,
            fontWeight: FontWeight.w700,
            height: 1.2,
            letterSpacing: -.8,
          ),
        ),
        const SizedBox(height: 10),
        Text(
          subtitle,
          style: TextStyle(
            color: theme.inkSecondary,
            fontSize: 15,
            height: 1.55,
          ),
        ),
      ],
    );
  }
}

class AccountAuthNotice extends StatelessWidget {
  final String message;
  final bool error;
  final VoidCallback? onRetry;
  const AccountAuthNotice({
    super.key,
    required this.message,
    this.error = false,
    this.onRetry,
  });
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: error ? theme.dangerSoft : theme.surfaceMuted,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              error ? Icons.error_outline_rounded : Icons.info_outline_rounded,
              size: 18,
              color: error ? theme.danger : theme.inkSecondary,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    message,
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.5,
                      color: theme.inkSecondary,
                    ),
                  ),
                  if (onRetry != null)
                    TextButton(
                      onPressed: onRetry,
                      style: TextButton.styleFrom(
                        padding: EdgeInsets.zero,
                        minimumSize: const Size(44, 40),
                        alignment: Alignment.centerLeft,
                      ),
                      child: Text(authText(context, '重新检查', 'Check again')),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Low-frequency legal, service and administrator details stay out of the form flow.
class AccountAuthFooter extends StatelessWidget {
  final MobileState state;
  final ClientAuthPolicy? policy;
  final bool busy, local;
  final Future<void> Function(Map<String, dynamic>) onLegal;
  const AccountAuthFooter({
    super.key,
    required this.state,
    required this.policy,
    required this.busy,
    required this.local,
    required this.onLegal,
  });
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    String t(String zh, String en) => authText(context, zh, en);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (policy?.legalDocuments.isNotEmpty == true)
          Wrap(
            alignment: WrapAlignment.center,
            children: [
              for (final document in policy!.legalDocuments)
                TextButton(
                  onPressed: () => onLegal(document),
                  child: Text(
                    document['key'] == 'terms'
                        ? t('用户协议', 'Terms of Use')
                        : t('隐私政策', 'Privacy Policy'),
                    style: TextStyle(color: theme.inkSecondary, fontSize: 12),
                  ),
                ),
            ],
          ),
        const SizedBox(height: 16),
        const Divider(),
        const SizedBox(height: 18),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.lock_outline_rounded, size: 13, color: theme.inkMuted),
            const SizedBox(width: 5),
            Flexible(
              child: Text(
                t(
                  '密码与验证码不会保存在应用中',
                  'Passwords and codes are not saved in the app',
                ),
                textAlign: TextAlign.center,
                style: TextStyle(color: theme.inkMuted, fontSize: 11.5),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Text(
          local
              ? t(
                  '本机测试 · 与线上账号和数据隔离',
                  'Local test · Separate accounts and data',
                )
              : '${t('连接', 'Connected to')} ${Uri.tryParse(state.endpoint.baseUrl)?.host ?? ''}',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12, color: theme.inkMuted),
        ),
        if (!state.signingOut && (state.enrollment?.deviceId ?? '').isNotEmpty)
          ExpansionTile(
            key: const Key('administrator-activation'),
            tilePadding: EdgeInsets.zero,
            title: Text(
              t('通过管理员激活', 'Administrator activation'),
              style: TextStyle(color: theme.inkSecondary, fontSize: 13),
            ),
            children: [_activation(context)],
          ),
        if (Navigator.of(context).canPop())
          TextButton(
            onPressed: busy ? null : () => Navigator.of(context).maybePop(),
            child: Text(t('返回连接选项', 'Connection options')),
          ),
      ],
    );
  }

  Widget _activation(BuildContext context) {
    final deviceId = state.enrollment?.deviceId ?? '';
    return WorkSurface(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(authText(context, '设备激活码', 'Device activation code')),
          Row(
            children: [
              Expanded(child: SelectableText(deviceId)),
              IconButton(
                tooltip: authText(context, '复制激活码', 'Copy code'),
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: deviceId));
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(
                          authText(context, '激活码已复制', 'Activation code copied'),
                        ),
                      ),
                    );
                  }
                },
                icon: const Icon(Icons.copy_rounded, size: 18),
              ),
            ],
          ),
          Text(
            authText(
              context,
              '将激活码交给管理员绑定账号，完成后重新检查。',
              'Ask your administrator to link this device to your account, then check again.',
            ),
            style: const TextStyle(fontSize: 13, height: 1.5),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: busy ? null : state.connect,
            child: Text(authText(context, '重新检查激活状态', 'Check activation')),
          ),
        ],
      ),
    );
  }
}

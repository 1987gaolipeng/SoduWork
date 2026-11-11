import '../ui/mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../state/mobile_scope.dart';
import '../state/session_feed.dart';
import '../ui/conversation_landing.dart';
import '../ui/mobile_theme.dart';

class PreviewWorkPane extends StatelessWidget {
  final ValueChanged<SessionFeedEntry> onEntry;
  const PreviewWorkPane({super.key, required this.onEntry});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final entries = buildSessionFeed(MobileScope.of(context).tasks);
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const PreviewNotice(),
        Text(
          mobileText(context, '工作空间'),
          style: Theme.of(context).textTheme.headlineLarge,
        ),
        const SizedBox(height: 8),
        Text(
          mobileText(context, '从交办到交付，让每一项工作都有下文。'),
          style: TextStyle(color: theme.inkMuted),
        ),
        const SizedBox(height: 24),
        for (final entry in entries)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Card(
              child: ListTile(
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 18,
                  vertical: 12,
                ),
                leading: Icon(Icons.article_outlined, color: theme.secondary),
                title: Text(entry.task.title),
                subtitle: Text(mobileText(context, '演示工作 · 点击查看会话与成果样式')),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => onEntry(entry),
              ),
            ),
          ),
        const SizedBox(height: 16),
        Text(
          mobileText(context, '审批、任务状态和执行进度将在接入真实服务后展示。这里没有执行中的真实工作。'),
          style: TextStyle(color: theme.inkMuted, fontSize: 12, height: 1.7),
        ),
      ],
    );
  }
}

class PreviewProfilePane extends StatelessWidget {
  final VoidCallback onTheme;
  final bool dark;
  const PreviewProfilePane({
    super.key,
    required this.onTheme,
    required this.dark,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const PreviewNotice(),
        const SizedBox(height: 24),
        CircleAvatar(
          radius: 34,
          backgroundColor: theme.surfaceMuted,
          child: Icon(Icons.people_outline_rounded, size: 30, color: theme.ink),
        ),
        const SizedBox(height: 14),
        Text(
          mobileText(context, '团队工作空间'),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(
          mobileText(context, '离线界面预览'),
          textAlign: TextAlign.center,
          style: TextStyle(color: theme.inkMuted),
        ),
        const SizedBox(height: 32),
        Text(
          mobileText(context, '外观'),
          style: TextStyle(color: theme.inkMuted, fontSize: 12),
        ),
        const SizedBox(height: 10),
        Card(
          child: ListTile(
            leading: Icon(
              dark ? Icons.dark_mode_outlined : Icons.light_mode_outlined,
            ),
            title: Text(mobileText(context, '主题')),
            subtitle: Text(mobileText(context, '本次打开期间生效')),
            trailing: Text(
              dark ? mobileText(context, '深色') : mobileText(context, '浅色'),
            ),
            onTap: onTheme,
          ),
        ),
        const SizedBox(height: 24),
        Text(
          mobileText(context, '账号与设备'),
          style: TextStyle(color: theme.inkMuted, fontSize: 12),
        ),
        const SizedBox(height: 10),
        Card(
          child: Column(
            children: [
              ListTile(
                leading: Icon(Icons.business_outlined),
                title: Text(mobileText(context, '企业服务')),
                trailing: Text(mobileText(context, '未连接')),
              ),
              Divider(),
              ListTile(
                leading: Icon(Icons.devices_outlined),
                title: Text(mobileText(context, '远程设备')),
                trailing: Text(mobileText(context, '未连接')),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        Text(
          mobileText(
            context,
            '本预览不读取登录信息，不连接设备，也不展示虚构的用量、订阅或在线状态。正式登录入口仍保持独立。',
          ),
          style: TextStyle(color: theme.inkMuted, height: 1.7, fontSize: 12),
        ),
      ],
    );
  }
}

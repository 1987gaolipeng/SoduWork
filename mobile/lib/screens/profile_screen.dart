import 'package:flutter/material.dart';

import '../core/device_store.dart';
import '../state/mobile_scope.dart';
import '../ui/mobile_chrome.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';
import 'ai_resources_screen.dart';
import 'automations_screen.dart';
import 'connect_screen.dart';
import 'notifications_screen.dart';

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  Future<void> _signOut() async {
    final state = MobileScope.read(context);
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
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(mobileText(context, '退出账号')),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted || identity != state.identityRevision) {
      return;
    }
    await state.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    final resourceTheme = Theme.of(context);
    final deviceName =
        state.enrollment?.deviceName ?? '${context.soduWorkTheme.brandName} Mobile';
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: state.refreshAll,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 28),
          children: [
            CommercialHeader(
              title: mobileText(context, '我的'),
              subtitle: mobileText(context, '账号、设备与个人设置'),
              notificationCount: state.unreadMessageCount,
              onNotifications: () => NotificationsScreen.show(context),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  WorkSurface(
                    padding: const EdgeInsets.fromLTRB(15, 14, 13, 14),
                    child: Row(
                      children: [
                        const SoduWorkMark(size: 42),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${context.soduWorkTheme.brandName} ${mobileText(context, '工作空间')}',
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              const SizedBox(height: 3),
                              Text(
                                deviceName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                            ],
                          ),
                        ),
                        StatePill(
                          label: mobileText(
                            context,
                            state.syncing
                                ? '同步中'
                                : state.refreshError.isNotEmpty
                                ? '更新失败'
                                : '已登录',
                          ),
                          color: state.refreshError.isNotEmpty
                              ? context.soduWorkTheme.warning
                              : context.soduWorkTheme.inkSecondary,
                          background: context.soduWorkTheme.surfaceMuted,
                          icon: state.refreshError.isNotEmpty
                              ? Icons.sync_problem_rounded
                              : Icons.check_rounded,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                  Text(
                    mobileText(context, '设置'),
                    style: TextStyle(
                      color: context.soduWorkTheme.inkMuted,
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 8),
                  WorkSurface(
                    padding: EdgeInsets.zero,
                    child: Column(
                      children: [
                        ListTile(
                          leading: const Icon(Icons.hub_outlined),
                          title: Text(mobileText(context, '我的模型')),
                          subtitle: Text(mobileText(context, '查看当前账号授权的模型')),
                          trailing: const Icon(Icons.chevron_right_rounded),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => Theme(
                                data: resourceTheme,
                                child: const AiResourcesScreen(
                                  section: AiResourceSection.models,
                                ),
                              ),
                            ),
                          ),
                        ),
                        const Divider(indent: 52),
                        ListTile(
                          leading: const Icon(Icons.cloud_outlined),
                          title: Text(mobileText(context, '云端环境')),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => Theme(
                                data: resourceTheme,
                                child: const AiResourcesScreen(
                                  section: AiResourceSection.cloud,
                                ),
                              ),
                            ),
                          ),
                        ),
                        const Divider(indent: 52),
                        ListTile(
                          leading: const Icon(Icons.auto_mode_outlined),
                          title: Text(mobileText(context, '我的自动化')),
                          subtitle: Text(mobileText(context, '查看计划、运行记录和失败恢复')),
                          trailing: const Icon(Icons.chevron_right_rounded),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => Theme(
                                data: resourceTheme,
                                child: const AutomationsScreen(),
                              ),
                            ),
                          ),
                        ),
                        const Divider(indent: 52),
                        ListTile(
                          leading: const Icon(Icons.notifications_none_rounded),
                          title: Text(mobileText(context, '通知')),
                          subtitle: Text(mobileText(context, '同事留言、工作交办与已读回执')),
                          trailing: const Icon(Icons.chevron_right_rounded),
                          onTap: () => NotificationsScreen.show(context),
                        ),
                        const Divider(indent: 52),
                        ListTile(
                          leading: const Icon(Icons.devices_outlined),
                          title: Text(mobileText(context, '连接与设备')),
                          subtitle: Text(
                            state.endpoint.environment.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          trailing: const Icon(Icons.chevron_right_rounded),
                          onTap: () => Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => Theme(
                                data: resourceTheme,
                                child: const ConnectScreen(),
                              ),
                            ),
                          ),
                        ),
                        const Divider(indent: 52),
                        ListTile(
                          leading: const Icon(Icons.info_outline_rounded),
                          onTap: () => showAboutDialog(
                            context: context,
                            applicationName:
                                '${context.soduWorkTheme.brandName} Mobile',
                            applicationVersion: mobileText(context, '开发预览'),
                            applicationIcon: const SoduWorkMark(size: 42),
                            children: [
                              Text(
                                mobileText(
                                  context,
                                  '企业团队的移动 AI 工作空间。正式发行版本与隐私说明将在发布前提供。',
                                ),
                              ),
                            ],
                          ),
                          title: Text(mobileText(context, '关于')),
                          subtitle: Text(
                            '${context.soduWorkTheme.brandName} Mobile · ${mobileText(context, '开发预览')}',
                          ),
                          trailing: const Icon(Icons.chevron_right_rounded),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    child: OutlinedButton.icon(
                      onPressed: state.signingOut ? null : _signOut,
                      icon: const Icon(Icons.logout_rounded),
                      label: Text(
                        mobileText(
                          context,
                          state.signingOut ? '正在退出…' : '退出当前账号',
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Center(
                    child: Text(
                      '${mobileText(context, '团队试用版')} · ${state.endpoint.baseUrl}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
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

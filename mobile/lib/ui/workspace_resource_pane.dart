import '../core/artifact_download.dart';
import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import '../models/account_conversation.dart';
import '../models/work_capability.dart';
import '../state/session_feed.dart';
import '../screens/ai_resources_screen.dart';
import '../screens/automations_screen.dart';
import '../screens/notifications_screen.dart';
import '../screens/projects_screen.dart';
import 'mobile_sheet.dart';
import 'mobile_theme.dart';
import '../screens/capability_center_screen.dart';
import '../screens/library_screen.dart';

const supportedWorkspaceResources = {
  'projects',
  'tools',
  'models',
  'cloud',
  'automations',
  'notifications',
  'library',
};

String workspaceResourceTitle(String resource) => switch (resource) {
  'projects' => '项目',
  'tools' => '插件',
  'models' => '我的模型',
  'cloud' => '云端环境',
  'automations' => '自动化',
  'notifications' => '通知',
  'library' => '资料库',
  _ => '暂不支持',
};

/// Same resource body for main navigation and settings sheets. Data ownership,
/// permissions and mutations are shared; only the surrounding surface changes.
class WorkspaceResourcePane extends StatefulWidget {
  final Future<void> Function(List<DownloadedArtifact>, String)? onDiscuss;
  final Future<void> Function(String, String)? onLibrarySource;
  final String resource;
  final bool preview;
  final ValueChanged<AccountConversation> onAccount;
  final ValueChanged<SessionFeedEntry> onEntry;
  final ValueChanged<WorkCapability>? onCapability;
  final VoidCallback? onCreatePlugin;
  final VoidCallback? onCreateAutomation;
  const WorkspaceResourcePane({
    super.key,
    required this.resource,
    this.onDiscuss,
    this.onLibrarySource,
    required this.preview,
    required this.onAccount,
    required this.onEntry,
    this.onCapability,
    this.onCreatePlugin,
    this.onCreateAutomation,
  });
  @override
  State<WorkspaceResourcePane> createState() => _WorkspaceResourcePaneState();
}

class _WorkspaceResourcePaneState extends State<WorkspaceResourcePane> {
  final _scroll = ScrollController();
  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final inherited = MobileSheetScope.maybeOf(context);
    Widget body;
    if (!supportedWorkspaceResources.contains(widget.resource)) {
      return Center(child: Text(mobileText(context, '此功能尚未接入手机，请在电脑端使用。')));
    }
    if (widget.resource == 'projects') {
      body = ProjectsScreen(
        preview: widget.preview,
        onAccount: widget.onAccount,
        onEntry: widget.onEntry,
      );
    } else if (widget.preview) {
      body = Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                workspaceResourceTitle(widget.resource),
                style: TextStyle(
                  color: context.soduWorkTheme.ink,
                  fontSize: 22,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 14),
              Text(
                mobileText(context, '连接企业账号后，查看实际数据并管理。此处为界面预览。'),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      );
    } else {
      body = switch (widget.resource) {
        'tools' => CapabilityCenterScreen(
          onConversationCreate: widget.onCreatePlugin == null
              ? null
              : () {
                  if (inherited != null) Navigator.of(context).pop();
                  widget.onCreatePlugin!();
                },
        ),
        'models' => const AiResourcesScreen(section: AiResourceSection.models),
        'cloud' => const AiResourcesScreen(section: AiResourceSection.cloud),
        'automations' => AutomationsScreen(
          onCreate: widget.onCreateAutomation == null
              ? null
              : () {
                  if (inherited != null) Navigator.of(context).pop();
                  widget.onCreateAutomation!();
                },
        ),
        'notifications' => const NotificationsScreen(),
        'library' => LibraryScreen(
          onDiscuss: widget.onDiscuss,
          onSource: widget.onLibrarySource,
        ),
        _ => Center(child: Text(mobileText(context, '此功能尚未接入手机，请在电脑端使用。'))),
      };
    }
    return MobileSheetScope(
      scrollController: inherited?.scrollController ?? _scroll,
      child: ColoredBox(color: context.soduWorkTheme.surface, child: body),
    );
  }
}

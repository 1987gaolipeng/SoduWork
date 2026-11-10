import '../core/artifact_download.dart';
import 'package:flutter/material.dart';
import '../models/account_conversation.dart';
import '../models/work_capability.dart';
import '../state/session_feed.dart';
import '../screens/settings_sheet.dart';
import 'mobile_display_preferences.dart';
import 'mobile_sheet.dart';
import 'workspace_resource_pane.dart';

Future<void> showWorkspaceSettings(
  BuildContext context, {
  required MobileDisplayPreferences preferences,
  required bool preview,
  required ValueChanged<AccountConversation> onAccount,
  required ValueChanged<SessionFeedEntry> onEntry,
  ValueChanged<WorkCapability>? onCapability,
  Future<void> Function(List<DownloadedArtifact>, String)? onDiscuss,
  Future<void> Function(String, String)? onLibrarySource,
}) => showMobileSheet<void>(
  context,
  builder: (sheetContext, scroll) => SettingsSheet(
    scrollController: scroll,
    preferences: preferences,
    preview: preview,
    onResource: (resource) => showWorkspaceResource(
      sheetContext,
      resource,
      preview: preview,
      onResource: (_) {},
      onAccount: onAccount,
      onEntry: onEntry,
      onCapability: onCapability,
      onDiscuss: onDiscuss,
      onLibrarySource: onLibrarySource,
    ),
  ),
);

Future<void> showWorkspaceResource(
  BuildContext context,
  String resource, {
  required bool preview,
  required ValueChanged<String> onResource,
  required ValueChanged<AccountConversation> onAccount,
  required ValueChanged<SessionFeedEntry> onEntry,
  ValueChanged<WorkCapability>? onCapability,
  Future<void> Function(List<DownloadedArtifact>, String)? onDiscuss,
  Future<void> Function(String, String)? onLibrarySource,
}) async {
  await showMobileSheet<void>(
    context,
    title: mobileText(context, workspaceResourceTitle(resource)),
    builder: (_, _) => WorkspaceResourcePane(
      resource: resource,
      preview: preview,
      onAccount: onAccount,
      onEntry: onEntry,
      onCapability: onCapability,
      onDiscuss: onDiscuss,
      onLibrarySource: onLibrarySource,
    ),
  );
}

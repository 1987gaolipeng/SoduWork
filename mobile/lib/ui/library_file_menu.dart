import 'package:flutter/material.dart';

import '../core/mobile_library.dart';
import '../core/artifact_download.dart';
import 'library_location_picker.dart';
import '../core/soduwork_api.dart';
import 'artifact_actions.dart';
import 'capability_widgets.dart';
import 'library_actions.dart';
import 'mobile_display_preferences.dart';

Future<String?> libraryTextDialog(
  BuildContext context, {
  required String title,
  required String initial,
  int maxLength = 240,
}) => showDialog<String>(
  context: context,
  builder: (_) =>
      _LibraryNameDialog(title: title, initial: initial, maxLength: maxLength),
);

class _LibraryNameDialog extends StatefulWidget {
  final String title, initial;
  final int maxLength;
  const _LibraryNameDialog({
    required this.title,
    required this.initial,
    required this.maxLength,
  });
  @override
  State<_LibraryNameDialog> createState() => _LibraryNameDialogState();
}

class _LibraryNameDialogState extends State<_LibraryNameDialog> {
  late final TextEditingController _text = TextEditingController(
    text: widget.initial,
  );
  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(mobileText(context, widget.title)),
    content: TextField(
      controller: _text,
      autofocus: true,
      maxLength: widget.maxLength,
      onChanged: (_) => setState(() {}),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: Text(mobileText(context, '取消')),
      ),
      FilledButton(
        onPressed: _text.text.trim().isEmpty
            ? null
            : () => Navigator.pop(context, _text.text.trim()),
        child: Text(mobileText(context, '确认')),
      ),
    ],
  );
}

enum FileCommand {
  discuss('围绕此内容展开对话', Icons.chat_bubble_outline),
  source('打开原会话', Icons.forum_outlined),
  system('在手机打开或保存', Icons.open_in_new),

  download('下载文件', Icons.download_outlined),
  favorite('收藏', Icons.star_border),
  edit('编辑内容', Icons.edit_outlined),
  rename('重命名', Icons.drive_file_rename_outline),
  move('移动到文件夹', Icons.drive_file_move_outline),
  copy('存储到远程', Icons.copy_outlined),
  share('分享给同事', Icons.share_outlined),
  trash('移入回收站', Icons.delete_outline),
  restore('恢复资料', Icons.restore),
  purge('永久删除', Icons.delete_forever_outlined);

  const FileCommand(this.label, this.icon);
  final String label;
  final IconData icon;
}

class LibraryFileMenu extends StatelessWidget {
  final Map<String, dynamic> item;
  final bool enabled, detail, desktop, history, canDiscuss, canSource, canCopy;
  final ValueChanged<FileCommand> onSelected;
  const LibraryFileMenu({
    super.key,
    required this.item,
    required this.enabled,
    required this.onSelected,
    this.detail = false,
    this.desktop = false,
    this.history = false,
    this.canDiscuss = false,
    this.canSource = false,
    this.canCopy = false,
  });

  @override
  Widget build(BuildContext context) {
    final editable = RegExp(
      r'\.(txt|md|markdown)$',
      caseSensitive: false,
    ).hasMatch(item['filename']?.toString() ?? '');
    final deleted = item['isDeleted'] == true;
    final favorite = item['favorite'] == true;
    final actions = deleted
        ? [if (!detail) FileCommand.restore, FileCommand.purge]
        : [
            if (canDiscuss) FileCommand.discuss,
            if (canSource && (item['sessionId'] ?? '').toString().isNotEmpty)
              FileCommand.source,
            if (!detail) FileCommand.download,
            FileCommand.system,
            FileCommand.favorite,
            if (editable) FileCommand.edit,
            FileCommand.rename,
            if (!history) FileCommand.move,
            if (desktop && canCopy && item['deliverySnapshot'] != true)
              FileCommand.copy,
            FileCommand.share,
            FileCommand.trash,
          ];
    return PopupMenuButton<FileCommand>(
      icon: const Icon(Icons.more_horiz),
      tooltip: mobileText(context, '更多操作'),
      enabled: enabled,
      onSelected: onSelected,
      itemBuilder: (context) => [
        for (final action in actions) ...[
          if (action == FileCommand.trash ||
              (action == FileCommand.purge && !detail))
            const PopupMenuDivider(),
          PopupMenuItem(
            value: action,
            child: Row(
              children: [
                Icon(
                  action == FileCommand.favorite && favorite
                      ? Icons.star
                      : action.icon,
                  size: 20,
                  color:
                      action == FileCommand.trash || action == FileCommand.purge
                      ? Theme.of(context).colorScheme.error
                      : null,
                ),
                const SizedBox(width: 12),
                Flexible(
                  child: Text(
                    mobileText(
                      context,
                      action == FileCommand.favorite && favorite
                          ? '取消收藏'
                          : action.label,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

mixin LibraryFileCommands<T extends StatefulWidget> on CapabilityState<T> {
  MobileLibrary get library;

  Future<void> runFileCommand(
    FileCommand command,
    Map<String, dynamic> item, {
    Future<void> Function(List<DownloadedArtifact>, String)? onDiscuss,
    Future<void> Function(String)? onSource,
    required VoidCallback onPurged,
    required ValueChanged<Map<String, dynamic>> onUpdated,
  }) async {
    if (!current || busy) return;
    if (command == FileCommand.trash &&
        !await confirm('移入回收站？', '原文件会保留，可在回收站恢复。')) {
      return;
    }
    if (command == FileCommand.purge &&
        !await confirm('永久删除这份资料？', '此操作不可恢复。')) {
      return;
    }
    await perform((_) async {
      final id = item['id'].toString();
      final target = library;
      void accept(Map<String, dynamic> response) {
        target.check();
        final next = response['item'];
        if (response['ok'] != true || next is! Map || next['id'] != id) {
          throw const ApiFailure('未收到保存回执，请刷新核对。');
        }
        onUpdated(Map<String, dynamic>.from(next));
      }

      Future<void> change(Map<String, dynamic> body) async =>
          accept(await target.call('updateItem', id: id, body: body));
      switch (command) {
        case FileCommand.discuss:
          if (onDiscuss == null) throw const ApiFailure('当前入口无法打开会话');
          final file = await target.read(item, limit: 16 * 1024 * 1024);
          if (current) await onDiscuss([file], '请围绕资料《${file.filename}》展开对话。');
        case FileCommand.source:
          if (onSource == null) throw const ApiFailure('来源会话不可用');
          await onSource(item['sessionId'].toString());
        case FileCommand.system:
          final file = await target.read(item);
          if (mounted && current) {
            await exportMobileFile(context, file, openOnDevice: true);
          }
        case FileCommand.download:
          final file = await target.read(item);
          if (mounted && current) await exportMobileFile(context, file);
        case FileCommand.favorite:
          await change({'favorite': item['favorite'] != true});
        case FileCommand.rename:
          final title = await libraryTextDialog(
            context,
            title: '重命名',
            initial: item['title']?.toString() ?? '',
          );
          if (current && title != null) await change({'title': title});
        case FileCommand.edit:
          final value = await target.call('readContent', id: id);
          if (!mounted || !current) return;
          if ((value['preview'] as Map?)?['truncated'] == true) {
            throw const ApiFailure('内容过长，请下载后编辑');
          }
          await editLibraryText(
            context,
            value['content']?.toString() ?? '',
            save: (content) => change({
              'content': content,
              'expectedUpdatedAt': (value['item'] as Map)['updatedAt'],
              if (target.location.desktop)
                'expectedContentRevision': value['contentRevision'],
            }),
          );
        case FileCommand.move:
          final folder = await chooseLibraryFolder(context, target);
          if (current && folder != null) await change({'folderId': folder});
        case FileCommand.copy:
          final targets = await LibraryTargets.load(target.api);
          target.check();
          if (!targets.remoteReady) throw const ApiFailure('远程存储未连接');
          if (!await confirm('存储到远程？', '将在已连接的远程存储中保存副本，保留电脑上的原件。')) return;
          final recorded = await target.copyToRemote(
            item,
            targets.remoteLocation,
          );
          if (current) {
            setState(
              () => receipt = recorded ? '远程副本已保存' : '远程副本已保存，电脑上的复制记录未确认。',
            );
          }
        case FileCommand.share:
          await shareLibraryItem(context, target, item);
        case FileCommand.trash:
          accept(await target.call('deleteItem', id: id));
        case FileCommand.restore:
          accept(await target.call('restoreItem', id: id));
        case FileCommand.purge:
          final result = await target.call('purgeItem', id: id);
          if (result['ok'] != true) throw const ApiFailure('未收到保存回执，请刷新核对。');
          if (current) onPurged();
      }
    });
  }
}

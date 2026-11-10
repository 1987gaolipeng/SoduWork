import 'package:flutter/material.dart';
import '../core/cloud_conversation_request.dart';
import '../core/artifact_download.dart';
import '../core/mobile_library.dart';
import '../core/soduwork_api.dart';
import '../screens/library_screen.dart';
import '../state/mobile_scope.dart';

Future<bool> saveArtifactToLibrary(
  BuildContext context,
  SoduWorkApi api,
  Map<String, dynamic> item, {
  Map<String, dynamic> source = const {},
}) async {
  final state = MobileScope.read(context),
      revision = MobileScope.read(context).identityRevision;
  final id = (item['attachmentId'] ?? item['id'] ?? '').toString();
  final url = (item['url'] ?? item['downloadUrl'] ?? item['href'] ?? '')
      .toString();
  final downloader = ArtifactDownloader(api);
  final name = (item['filename'] ?? item['name'] ?? '成果').toString();
  final type = item['contentType']?.toString() ?? 'application/octet-stream';
  final DownloadedArtifact file;
  if (downloader.isPrivateDeliveryUrl(url)) {
    file = await downloader.download(
      url,
      filename: name,
      contentType: type,
      byteLimit: 32 * 1024 * 1024,
    );
  } else {
    final uri = Uri.tryParse(url), parts = uri?.pathSegments ?? [];
    final attachment = id.isNotEmpty && id != 'artifact-url'
        ? id
        : parts.length == 4 && parts.take(3).join('/') == 'api/v1/attachments'
        ? parts[3]
        : '';
    if (attachment.isEmpty) throw const ApiFailure('这项成果只有网页链接，请打开后下载文件再保存');
    file = await downloader.downloadAttachment(
      attachment,
      filename: name,
      contentType: type,
      byteLimit: 32 * 1024 * 1024,
    );
  }
  if (revision != state.identityRevision) {
    throw const ApiFailure('账号已切换，请重新打开成果');
  }
  if (!context.mounted) return false;
  return saveToLibrary(context, file, source: source);
}

Future<bool> saveToLibrary(
  BuildContext context,
  DownloadedArtifact file, {
  Map<String, dynamic> source = const {},
}) async =>
    await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => Scaffold(
          appBar: AppBar(title: const Text('保存到资料库')),
          body: LibraryScreen(saveFile: file, source: source),
        ),
      ),
    ) ==
    true;

Future<DownloadedArtifact?> pickLibraryFile(BuildContext context) =>
    Navigator.of(context).push<DownloadedArtifact>(
      MaterialPageRoute(
        builder: (_) => Scaffold(
          appBar: AppBar(title: const Text('选择资料')),
          body: const LibraryScreen(pick: true),
        ),
      ),
    );

Future<String?> chooseLibraryFolder(
  BuildContext context,
  MobileLibrary library,
) => showModalBottomSheet<String>(
  context: context,
  isScrollControlled: true,
  builder: (_) => _Folders(library: library),
);

class _Folders extends StatefulWidget {
  final MobileLibrary library;
  const _Folders({required this.library});
  @override
  State<_Folders> createState() => _FoldersState();
}

class _FoldersState extends State<_Folders> {
  final trail = <Map<String, dynamic>>[];
  late Future<Map<String, dynamic>> data = load();
  String get folder => trail.lastOrNull?['id']?.toString() ?? '';
  Future<Map<String, dynamic>> load() =>
      widget.library.list(scope: 'all', folderId: folder);
  @override
  Widget build(BuildContext context) => SafeArea(
    child: SizedBox(
      height: 460,
      child: Column(
        children: [
          ListTile(
            title: Text(trail.lastOrNull?['name']?.toString() ?? '根目录'),
            leading: trail.isEmpty
                ? const Icon(Icons.folder_outlined)
                : IconButton(
                    icon: const Icon(Icons.arrow_back),
                    onPressed: () => setState(() {
                      trail.removeLast();
                      data = load();
                    }),
                  ),
          ),
          Expanded(
            child: FutureBuilder<Map<String, dynamic>>(
              future: data,
              builder: (context, snapshot) {
                if (snapshot.hasError) {
                  return Center(child: Text('${snapshot.error}'));
                }
                if (!snapshot.hasData) {
                  return const Center(child: CircularProgressIndicator());
                }
                return ListView(
                  children: [
                    for (final raw in snapshot.data!['folders'] as List? ?? [])
                      ListTile(
                        leading: const Icon(Icons.folder_outlined),
                        title: Text(raw['name'].toString()),
                        onTap: () => setState(() {
                          trail.add(Map<String, dynamic>.from(raw));
                          data = load();
                        }),
                      ),
                  ],
                );
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: FilledButton(
              onPressed: () {
                widget.library.check();
                Navigator.pop(context, folder);
              },
              child: const Text('选择此文件夹'),
            ),
          ),
        ],
      ),
    ),
  );
}

Future<String?> editLibraryText(
  BuildContext context,
  String content, {
  required Future<void> Function(String) save,
}) => Navigator.of(context).push<String>(
  MaterialPageRoute(
    builder: (_) => _TextEditor(content: content, save: save),
  ),
);

class _TextEditor extends StatefulWidget {
  final String content;
  final Future<void> Function(String) save;
  const _TextEditor({required this.content, required this.save});
  @override
  State<_TextEditor> createState() => _TextEditorState();
}

class _TextEditorState extends State<_TextEditor> {
  late final text = TextEditingController(text: widget.content);
  bool leaving = false;
  bool busy = false;
  String error = '';
  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !busy && (leaving || text.text == widget.content),
    onPopInvokedWithResult: (didPop, _) async {
      if (didPop || busy) return;
      final discard = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('放弃未保存的内容？'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('继续编辑'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('放弃'),
            ),
          ],
        ),
      );
      if (discard == true && mounted) {
        setState(() => leaving = true);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) Navigator.pop(context);
        });
      }
    },
    child: Scaffold(
      appBar: AppBar(
        title: const Text('编辑文本'),
        actions: [
          TextButton(
            onPressed: busy
                ? null
                : () async {
                    setState(() {
                      busy = true;
                      error = '';
                    });
                    try {
                      await widget.save(text.text);
                      if (!mounted) return;
                      setState(() {
                        leaving = true;
                        busy = false;
                      });
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        if (mounted) Navigator.pop(context, text.text);
                      });
                    } catch (e) {
                      if (mounted) {
                        setState(() {
                          busy = false;
                          error = e.toString();
                        });
                      }
                    }
                  },
            child: const Text('保存'),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            if (busy) const LinearProgressIndicator(),
            if (error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(error),
              ),
            Expanded(
              child: TextField(
                enabled: !busy,
                controller: text,
                expands: true,
                maxLines: null,
                minLines: null,
                onChanged: (_) => setState(() {}),
                textAlignVertical: TextAlignVertical.top,
                decoration: const InputDecoration(hintText: '输入内容'),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

Future<void> shareLibraryItem(
  BuildContext context,
  MobileLibrary library,
  Map<String, dynamic> item,
) async {
  await shareLibrarySelection(context, library, [item], []);
}

Future<bool> shareLibrarySelection(
  BuildContext context,
  MobileLibrary library,
  List<Map<String, dynamic>> items,
  List<Map<String, dynamic>> folders,
) async {
  final result = await library.api.libraryMembers();
  library.check();
  if (!context.mounted) return false;
  return await showDialog<bool>(
        context: context,
        builder: (_) => _Share(
          library: library,
          items: items,
          folders: folders,
          members: (result['members'] as List? ?? [])
              .map((e) => Map<String, dynamic>.from(e))
              .toList(),
        ),
      ) ??
      false;
}

class _Share extends StatefulWidget {
  final MobileLibrary library;
  final List<Map<String, dynamic>> items, folders;
  final List<Map<String, dynamic>> members;
  const _Share({
    required this.library,
    required this.items,
    required this.folders,
    required this.members,
  });
  @override
  State<_Share> createState() => _ShareState();
}

class _ShareState extends State<_Share> {
  final selected = <String>{}, note = TextEditingController();
  final request = mobileRequestId().substring(
    1,
  ); // UUID accepts the 32-digit hex form.
  bool busy = false;
  String error = '';
  @override
  void dispose() {
    note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !busy,
    child: AlertDialog(
      title: const Text('分享给同事'),
      content: SizedBox(
        width: double.maxFinite,
        height: 360,
        child: Column(
          children: [
            const Text('发送当前文件的副本；原文件保持不变。'),
            Expanded(
              child: ListView(
                children: [
                  if (widget.members.isEmpty) const Text('当前账号没有可分享的同事'),
                  for (final member in widget.members)
                    CheckboxListTile(
                      title: Text(member['name'].toString()),
                      value: selected.contains(member['id']),
                      onChanged: busy
                          ? null
                          : (value) => setState(() {
                              value == true
                                  ? selected.add(member['id'].toString())
                                  : selected.remove(member['id']);
                            }),
                    ),
                ],
              ),
            ),
            TextField(
              controller: note,
              enabled: !busy,
              maxLength: 500,
              decoration: const InputDecoration(hintText: '附言（可选）'),
            ),
            if (error.isNotEmpty) Text(error),
            if (busy) const LinearProgressIndicator(),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: busy ? null : () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: busy || selected.isEmpty
              ? null
              : () async {
                  setState(() {
                    busy = true;
                    error = '';
                  });
                  try {
                    final result = await widget.library.shareSelection(
                      widget.items,
                      widget.folders,
                      selected.toList(),
                      note.text,
                      request,
                    );
                    if (result['ok'] != true) {
                      throw const ApiFailure('分享结果未确认，请核对通知记录');
                    }
                    if (context.mounted) Navigator.pop(context, true);
                  } catch (e) {
                    if (mounted) setState(() => error = e.toString());
                  } finally {
                    if (mounted) setState(() => busy = false);
                  }
                },
          child: const Text('确认发送'),
        ),
      ],
    ),
  );
}

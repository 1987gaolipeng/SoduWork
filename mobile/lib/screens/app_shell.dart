import '../core/workspace_location_store.dart';
import '../ui/pending_cloud_request_banner.dart';
import '../ui/open_work_conversation.dart';
import '../ui/conversation_handoff_sheet.dart';
import '../sdk/soduwork_sdk_config.dart';
import '../ui/artifact_actions.dart';
import 'plugin_builder_screen.dart';
import '../state/work_conversation_navigation.dart';
import '../state/mobile_state.dart';
import '../core/shared_conversation_host.dart';
import '../core/requirement_review_conversation.dart';
import '../ui/shared_conversation.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:flutter/cupertino.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import '../ui/library_actions.dart';
import '../core/artifact_download.dart';
import 'package:image_picker/image_picker.dart';
import '../core/cloud_conversation_request.dart';
import '../core/work_file_picker.dart';
import '../core/work_submission_store.dart';
import '../models/work_capability.dart';
import '../models/work_models.dart';
import '../core/soduwork_api.dart';
import '../ui/work_model_picker.dart';
import '../ui/work_execution_picker.dart';
import '../ui/anchored_popover.dart';
import '../ui/conversation_chrome.dart';
import 'conversation_search.dart';
import '../models/account_conversation.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_sheet.dart';
import '../ui/mobile_layer_surface.dart';
import '../ui/mobile_sidebar_surface.dart';
import '../models/general_chat.dart';
import '../core/direct_work_sender.dart';
import '../ui/workspace_sheets.dart';
import '../ui/workspace_resource_pane.dart';
import '../ui/material_actions_menu.dart';
import '../ui/work_capability_picker.dart';
import '../ui/work_request_sheet.dart';
import '../ui/task_forms.dart';
import '../ui/automation_editor.dart';
import 'work_submission_screen.dart';

import '../sdk/soduwork_brand.dart';
import '../state/mobile_scope.dart';
import '../state/session_feed.dart';
import '../ui/conversation_drawer.dart';
import '../ui/conversation_landing.dart';
import '../ui/mobile_theme.dart';
import 'cloud_conversation_screen.dart';
import 'account_conversation_screen.dart';
import 'conversation_preview_screen.dart';
import 'preview_workspace.dart';
import 'profile_screen.dart';
import 'task_detail_screen.dart';
import 'work_screen.dart';

String _workActionTitle(String value) {
  final compact = value.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (compact.isEmpty) return '新建工作';
  final instructionBoundary = RegExp(
    r'\s+(?=(?:创建|搭建|每(?:天|周|月)|请|要求|自动|定期|抓取|汇总|整理|生成|执行|检查))',
  ).firstMatch(compact);
  if (instructionBoundary != null && instructionBoundary.start > 0) {
    return compact.substring(0, instructionBoundary.start).trim();
  }
  if (compact.length <= 200) return compact;
  final candidate = RegExp(
    r'^(.{1,200}?)(?:[。！？.!?]|$)',
  ).firstMatch(compact)?.group(1)?.trim();
  if (candidate != null && candidate.isNotEmpty) {
    return candidate.length > 200
        ? candidate.substring(0, 200).trim()
        : candidate;
  }
  return compact.substring(0, 200).trim();
}

String _workActionMaterial(String text, String contextText, String title) {
  final values = <String>[];
  final context = contextText.trim();
  final source = text.trim();
  if (context.isNotEmpty) values.add(context);
  if (source.isNotEmpty && source != title && source != context) {
    values.add(source);
  }
  return values.join('\n\n');
}

class AppShell extends StatefulWidget {
  final bool preview;
  const AppShell({super.key, this.preview = false});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> with WidgetsBindingObserver {
  final _scaffold = GlobalKey<ScaffoldState>();
  final _sidebar = GlobalKey<MobileSidebarSurfaceState>();
  final _workAddAnchor = GlobalKey();
  final _workModelAnchor = GlobalKey();
  GeneralChatModel? _workModel;
  String _workAgent = '',
      _workAgentLabel = '',
      _workRunnerId = '',
      _workRunnerKind = 'cloud';
  bool _workAgentModelPick = true;
  String? _activeTask;
  AccountConversation? _activeAccount;
  RequirementReviewConversation? _reviewDraft;
  String _activeTitle = '';
  String _activeAgentLabel = '', _activeRef = '';
  WorkConversationNavigation? _conversationNavigation;
  String? _previewText;
  late MobileDisplayPreferences _display;
  bool _ownsDisplay = true;
  String _loadError = '';
  String? _resource;
  String _locationScope = '';
  int _locationRevision = 0;

  WorkspaceLocationStore _locationStore(MobileState state) =>
      WorkspaceLocationStore(
        state.endpoint.baseUrl,
        widget.preview ? '' : state.enrollment?.ownerUserId ?? '',
      );

  void _rememberLocation(String location) {
    _locationRevision++;
    unawaited(
      _locationStore(
        MobileScope.read(context),
      ).save(location).catchError((Object _) {}),
    );
  }

  Future<void> _restoreLocation(MobileState state) async {
    final store = _locationStore(state), revision = ++_locationRevision;
    final identity = state.identityRevision;
    try {
      final location = await store.read();
      if (!mounted ||
          revision != _locationRevision ||
          identity != state.identityRevision ||
          store.key != _locationStore(state).key) {
        return;
      }
      if (location != null && location.startsWith('resource:')) {
        final resource = location.substring(9);
        if (supportedWorkspaceResources.contains(resource)) {
          setState(() => _resource = resource);
        }
      } else if (location == 'tab:3') {
        setState(() => _resource = null);
        state.selectTab(3);
      }
    } catch (_) {
      // A storage failure must not prevent opening the workspace.
    }
  }

  String _workDraft = '';
  String _workActionId = '';
  String _workError = '';
  int _workVersion = 0;
  final List<XFile> _workFiles = [];
  bool _workCardDirty = false;
  bool _workCardBusy = false;
  final List<WorkCapability> _capabilities = [];
  final _workStore = WorkSubmissionStore();
  int? _scope;
  SharedConversationHost? _sharedHost;
  String _sharedRoute = '';
  String _workCardHistoryId = '';
  List<Map<String, dynamic>> _workCardHistory = [];
  int _sharedEpoch = 0;
  bool _sharedDiscardDraft = false;

  Timer? _syncTimer;
  bool _foreground = true;

  Future<void> _executionOptions() async {
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    if (widget.preview) {
      await showMobileSheet<void>(
        context,
        title: _display.text('执行设置'),
        initialSize: .5,
        builder: (_, scroll) => ListView(
          controller: scroll,
          padding: const EdgeInsets.all(24),
          children: [
            Text(_display.text('连接企业服务后，可选择你的真实执行底座。')),
            SizedBox(height: 20),
            Text(_display.text('工程与 Loop 目前需从电脑端发起。')),
          ],
        ),
      );
      return;
    }
    final selected = await showWorkExecutionPicker(
      context,
      selectedAgent: _workAgent,
      selectedRunnerId: _workRunnerId,
      locked: _activeTask != null,
    );
    if (!mounted ||
        state.identityRevision != identity ||
        selected == null ||
        _activeTask != null) {
      return;
    }
    setState(() {
      _workAgent = selected.id;
      _workAgentLabel = selected.label;
      _workRunnerId = selected.runnerId;
      _workRunnerKind = selected.runnerKind;
      _workAgentModelPick = selected.modelPick;
      if (!selected.modelPick) {
        _workModel = null;
      }
    });
  }

  bool _pluginAuthoring = false;

  Future<bool> _openWorkConversation(
    String prompt, {
    bool pluginAuthoring = false,
    String actionId = '',
  }) async {
    final previous = _workVersion;
    await _newConversation();
    if (!mounted || previous == _workVersion) return false;
    setState(() {
      _workDraft = prompt;
      _workActionId = actionId;
      _pluginAuthoring = pluginAuthoring;
      _workVersion++;
    });
    return true;
  }

  Future<bool> _openPluginConversation({
    String seed = '',
    String contextText = '',
  }) async {
    final source = seed.trim().isNotEmpty
        ? seed.trim()
        : '请先询问我制作一个可复用插件所需的最少信息。';
    final material = contextText.trim();
    final excerpt = material.substring(
      0,
      material.length > 12000 ? 12000 : material.length,
    );
    final prompt = material.isEmpty
        ? '制作插件：\n$source'
        : '制作插件：\n$source\n\n请结合以下当前对话上下文理解目标，先给出插件草稿，再等待我确认：\n$excerpt';
    return _openWorkConversation(prompt, pluginAuthoring: true);
  }

  bool _creatingConversation = false;

  Future<void> _newConversation({
    List<DownloadedArtifact> materials = const [],
    String prefill = '',
    bool fromLibrary = false,
  }) async {
    if (_creatingConversation) return;
    _creatingConversation = true;
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    try {
      _sidebar.currentState?.close();
      if (_workCardBusy) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('工作表单正在保存，请等待回执后再新建对话。')));
        return;
      }
      if (_workDraft.trim().isNotEmpty ||
          _workActionId.isNotEmpty ||
          _workCardDirty ||
          _workFiles.isNotEmpty ||
          _capabilities.isNotEmpty) {
        final discard = await showDialog<bool>(
          context: _scaffold.currentContext ?? context,
          // Keep the dialog on the conversation's navigator. Its ModalRoute
          // then becomes inactive and the HTML frame stops receiving clicks.
          useRootNavigator: false,
          builder: (dialogContext) => AlertDialog(
            title: Text(_display.text('开始新对话？')),
            content: Text(_display.text('当前还有未发送的内容。新建对话将清空这份草稿。')),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: Text(_display.text('保留草稿')),
              ),
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, true),
                child: Text(_display.text('新建对话')),
              ),
            ],
          ),
        );
        if (!mounted || state.identityRevision != identity || discard != true) {
          return;
        }
        if (_workCardBusy) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text('工作表单正在保存，请等待回执后再新建对话。')),
          );
          return;
        }
      }
      setState(() {
        _pluginAuthoring = false;
        _workCardDirty = false;
        _workCardBusy = false;
        _sharedDiscardDraft = true;
        _workCardHistoryId = '';
        _activeAccount = null;
        _activeTask = null;
        _reviewDraft = null;
        _activeAgentLabel = '';
        _activeRef = '';
        _previewText = null;
        _workDraft = prefill;
        _workActionId = '';
        _workError = '';
        _workFiles
          ..clear()
          ..addAll(materials.map((f) => LibraryMaterialFile(f)));
        _capabilities.clear();
        _workVersion++;
      });
      if (fromLibrary) Navigator.of(context).popUntil((r) => r.isFirst);
      _select(0);
    } finally {
      _creatingConversation = false;
    }
  }

  Future<void> _refresh() async {
    final state = MobileScope.read(context);
    if (widget.preview || state.enrollment == null) return;
    try {
      await Future.wait([
        state.refreshAll(),
        state.loadTeamMessages(),
        state.loadConversations(),
        state.loadAccountConversations(),
      ]);
      if (mounted) setState(() => _loadError = '');
    } catch (_) {
      if (mounted) setState(() => _loadError = '暂时无法更新会话，请重试。');
    } finally {
      _scheduleSync();
    }
  }

  void _scheduleSync() {
    _syncTimer?.cancel();
    if (mounted && !widget.preview && _foreground) {
      _syncTimer = Timer(const Duration(seconds: 10), () {
        if (!mounted) return;
        if (ModalRoute.of(context)?.isCurrent == false) {
          _scheduleSync();
          return;
        }
        final state = MobileScope.read(context);
        final future = Future.wait([
          if (!state.teamMessages.received.loading) state.loadTeamMessages(),
          if (state.accountConversations.supported != false)
            state.loadAccountConversations(),
        ]);
        unawaited(future.whenComplete(_scheduleSync));
      });
    }
  }

  late SoduWorkBrandTheme _brand;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final existingDisplay = context
        .getInheritedWidgetOfExactType<MobileDisplayScope>()
        ?.notifier;
    _ownsDisplay = existingDisplay == null;
    _display =
        existingDisplay ?? MobileDisplayPreferences(persist: !widget.preview);
    _display.addListener(_displayChanged);
    if (_ownsDisplay) unawaited(_display.restore());
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_refresh());
    });
  }

  @override
  void dispose() {
    _syncTimer?.cancel();
    _conversationNavigation?.removeListener(_openRequestedConversation);
    if (_conversationNavigation?.beforeOpen == _checkRequestedConversation) {
      _conversationNavigation?.beforeOpen = null;
    }
    _display.removeListener(_displayChanged);
    if (_ownsDisplay) _display.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground && !widget.preview) {
      unawaited(_refresh());
    } else {
      _syncTimer?.cancel();
    }
  }

  void _select(int index) {
    _rememberLocation('tab:$index');
    _sidebar.currentState?.close();
    setState(() => _resource = null);
    MobileScope.read(context).selectTab(index);
  }

  void _displayChanged() {
    if (mounted) setState(() {});
  }

  void _toggleTheme() {
    _display.update(
      appearance: _brand.brightness == Brightness.dark
          ? MobileAppearanceMode.light
          : MobileAppearanceMode.dark,
    );
  }

  Future<void> _push(Widget page) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => MobilePresentationTheme(
          preferences: _display,
          base: context.soduWorkTheme,
          child: page,
        ),
      ),
    );
  }

  Future<void> _settings() async {
    _sidebar.currentState?.close();
    await showWorkspaceSettings(
      _scaffold.currentContext ?? context,
      onDiscuss: (files, prompt) => _newConversation(
        materials: files,
        prefill: prompt,
        fromLibrary: true,
      ),
      onLibrarySource: _librarySource,
      preferences: _display,
      preview: widget.preview,
      onAccount: (entry) {
        Navigator.of(_scaffold.currentContext ?? context).pop();
        _openAccount(entry);
      },
      onEntry: (entry) {
        Navigator.of(_scaffold.currentContext ?? context).pop();
        _openEntry(entry);
      },
      onCapability: (picked) {
        if (_acceptCapability(picked)) {
          Navigator.of(_scaffold.currentContext ?? context).pop();
          _select(0);
        }
      },
    );
  }

  Future<void> _openAccount(AccountConversation entry) async {
    _sidebar.currentState?.close();
    if (entry.taskProjectionId.isNotEmpty) {
      final state = MobileScope.read(context),
          identity = MobileScope.read(context).identityRevision;
      try {
        final task = await state.loadTask(entry.taskProjectionId);
        if (!mounted || identity != state.identityRevision) return;
        await openWorkConversation(context, taskId: task.id, title: task.title);
      } catch (error) {
        if (mounted && identity == state.identityRevision) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(SnackBar(content: Text('$error')));
        }
      }
      return;
    }
    if (!sharedConversationAvailable) {
      unawaited(_push(AccountConversationScreen(conversation: entry)));
      return;
    }
    setState(() {
      _activeTask = null;
      _activeAccount = entry;
      _activeTitle = entry.displayTitle;
      _reviewDraft = null;
      _workCardHistoryId = '';
    });
    _select(0);
  }

  Future<void> _searchHistory() async {
    _sidebar.currentState?.close();
    final state = MobileScope.read(context),
        identity = MobileScope.read(context).identityRevision;
    final picked = await showConversationSearch(
      _scaffold.currentContext ?? context,
      preview: widget.preview,
    );
    if (!mounted || state.identityRevision != identity || picked == null) {
      return;
    }
    if (picked.newChat) {
      await _newConversation();
    } else if (picked.account != null) {
      _openAccount(picked.account!);
    } else if (picked.task != null) {
      _openEntry(picked.task!);
    }
  }

  Future<bool> _pickCapability(String prefix) async {
    if (widget.preview) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_display.text('连接企业服务后，可读取你的插件、技能与同事目录。'))),
      );
      return false;
    }
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    final picked = await showWorkCapabilityPicker(
      _scaffold.currentContext ?? context,
      prefix: prefix,
      onCreatePlugin: () => _openPluginConversation(),
    );
    if (!mounted || state.identityRevision != identity || picked == null) {
      return false;
    }
    return _acceptCapability(picked);
  }

  bool _acceptCapability(WorkCapability picked) {
    if (_capabilities.any(
      (item) => item.kind == picked.kind && item.id == picked.id,
    )) {
      return true;
    }
    if (_capabilities.isNotEmpty &&
        (picked.kind != WorkCapabilityKind.skill ||
            _capabilities.any((row) => row.kind != WorkCapabilityKind.skill))) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_display.text('本次选择一个插件、一位同事或一组技能，请先移除当前选择。'))),
      );
      return false;
    }
    setState(() => _capabilities.add(picked));
    return true;
  }

  Future<void> _librarySource(String id, String clientId) async {
    final state = MobileScope.read(context);
    final revision = state.identityRevision;
    await state.loadAccountConversations();
    if (!mounted || state.identityRevision != revision) return;
    final rows = state.accountConversations.conversations
        .where(
          (r) =>
              (r.id == id || r.sourceSessionId == id) &&
              (clientId.isEmpty || r.sourceClientId == clientId),
        )
        .toList();
    final task = state.tasks
        .where((t) => t.id == id || t.cloudSessionId == id)
        .firstOrNull;
    if (rows.length != 1 && task == null) {
      throw const ApiFailure('来源会话不可用，原会话可能已被删除。');
    }
    Navigator.of(context).popUntil((r) => r.isFirst);
    if (rows.length == 1) {
      await _openAccount(rows.single);
    } else {
      _openEntry(SessionFeedEntry(task!));
    }
  }

  void _openResource(String resource) {
    if (!supportedWorkspaceResources.contains(resource)) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_display.text('此功能尚未接入手机，请在电脑端使用。'))),
      );
      return;
    }
    FocusManager.instance.primaryFocus?.unfocus();
    _sidebar.currentState?.close();
    _rememberLocation('resource:$resource');
    setState(() => _resource = resource);
  }

  Future<void> _chooseWorkModel() async {
    if (widget.preview) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_display.text('连接企业服务后，可选择账号获准使用的工作模型。'))),
      );
      return;
    }
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    final chosen = await showWorkModelPicker(
      _scaffold.currentContext ?? context,
      selected: _workModel,
      anchor: popoverAnchor(
        _scaffold.currentContext ?? context,
        _workModelAnchor,
      ),
    );
    if (mounted && state.identityRevision == identity && chosen != null) {
      setState(() => _workModel = chosen);
    }
  }

  Future<void> _materials() async {
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    final anchorKey = _workAddAnchor;
    final box = anchorKey.currentContext?.findRenderObject();
    if (box is! RenderBox) return;
    final overlay =
        Overlay.of(
              _scaffold.currentContext ?? context,
            ).context.findRenderObject()
            as RenderBox;
    final anchor = Rect.fromPoints(
      box.localToGlobal(Offset.zero, ancestor: overlay),
      box.localToGlobal(box.size.bottomRight(Offset.zero), ancestor: overlay),
    );
    final action = await showMaterialActions(
      _scaffold.currentContext ?? context,
      anchor: anchor,
    );
    if (!mounted || state.identityRevision != identity || action == null) {
      return;
    }
    if (action == 'plugins') {
      await _pickCapability('/');
    } else {
      await _pickMaterials(action);
    }
  }

  Future<void> _pickMaterials(String source) async {
    if (widget.preview) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_display.text('当前为离线预览，连接后可选择材料。'))),
      );
      return;
    }
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    try {
      final List<XFile> files;
      if (source == 'files') {
        files = await pickWorkFiles();
      } else if (source == 'camera') {
        final file = await ImagePicker().pickImage(
          source: ImageSource.camera,
          imageQuality: 85,
        );
        files = file == null ? [] : [file];
      } else {
        files = await ImagePicker().pickMultiImage(imageQuality: 85);
      }
      if (!mounted || state.identityRevision != identity || files.isEmpty) {
        return;
      }
      final all = [..._workFiles, ...files];
      var total = 0;
      for (final file in all) {
        total += await file.length();
      }
      if (!mounted || state.identityRevision != identity) return;
      if (all.length > 20 || total > 90 * 1024 * 1024) {
        throw const FormatException('最多20个文件，合计不超过90MB。');
      }
      setState(() {
        _workFiles.addAll(files);
        _workError = '';
      });
    } catch (_) {
      if (mounted && state.identityRevision == identity) {
        setState(() => _workError = '未能添加材料，请检查权限与文件大小后重试。');
      }
    }
  }

  String _workScopeKey() =>
      '${MobileScope.read(context).endpoint.baseUrl}:${MobileScope.read(context).enrollment?.ownerUserId}:${MobileScope.read(context).enrollment?.deviceId}';

  Future<bool> _sendWork(String text) async {
    if (widget.preview) {
      setState(() {
        _previewText = text;
        _workDraft = '';
        _workActionId = '';
      });
      return true;
    }
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    final scope = _workScopeKey();
    try {
      final pending = await _workStore.load(scope);
      if (!mounted || state.identityRevision != identity) return false;
      if (pending != null) {
        await _push(
          WorkSubmissionScreen(
            submission: pending,
            scope: scope,
            identity: identity,
          ),
        );
        return false;
      }
      final capability = _capabilities
          .where((row) => row.kind != WorkCapabilityKind.skill)
          .firstOrNull;
      if (capability != null) {
        if (_workFiles.isNotEmpty) {
          throw const FormatException('此插件或同事留言请先使用文字参数，移除材料后再发送。');
        }
        if (text.trim().isEmpty) throw const FormatException('请先填写要完成的工作。');
        final id = mobileRequestId();
        final Map<String, dynamic> payload;
        if (capability.kind == WorkCapabilityKind.teammate) {
          if (text.trim().length > 500) {
            throw const FormatException('同事留言最多500字，请缩短后发送。');
          }
          payload = {'recipientId': capability.id, 'text': text.trim()};
        } else {
          final inputs = await showWorkflowInputs(
            _scaffold.currentContext ?? context,
            capability: capability,
            instruction: text,
          );
          if (!mounted ||
              state.identityRevision != identity ||
              inputs == null) {
            return false;
          }
          payload = {
            'bindingId': capability.id,
            'inputs': inputs,
            'instruction': text.trim(),
          };
        }
        final submission = WorkSubmission(
          id: id,
          kind: capability.kind == WorkCapabilityKind.teammate
              ? 'teammate'
              : 'workflow',
          label: capability.label,
          payload: payload,
        );
        await _workStore.save(scope, submission);
        if (!mounted || state.identityRevision != identity) return false;
        unawaited(
          _push(
            WorkSubmissionScreen(
              submission: submission,
              scope: scope,
              identity: identity,
              autoSubmit: true,
            ),
          ),
        );
        setState(() {
          _workFiles.clear();
          _capabilities.clear();
          _workDraft = '';
          _workActionId = '';
        });
        return true;
      }
      final receipt = await sendWorkDirectly(
        state,
        text: text,
        files: List.of(_workFiles),
        skills: _capabilities.map((row) => row.id).toList(),
        model: _workModel?.name ?? '',
        agentId: _workAgent,
        targetRunnerId: _workRunnerId,
        targetRunnerKind: _workRunnerKind,
      );
      if (!mounted || state.identityRevision != identity) return false;
      final taskId = (receipt['taskId'] ?? '').toString();
      if (taskId.isEmpty) return false;
      final task = state.findTask(taskId);
      setState(() {
        _workFiles.clear();
        _capabilities.clear();
        _workDraft = '';
        _workActionId = '';
      });
      setState(() {
        _activeAccount = null;
        _activeTask = taskId;
        _activeTitle = task?.title ?? text;
        _activeAgentLabel = _workAgentLabel;
        _activeRef = '';
      });
      return true;
    } on ApiFailure catch (failure) {
      if (mounted && state.identityRevision == identity) {
        setState(() => _workError = failure.message);
      }
    } on FormatException catch (failure) {
      if (mounted && state.identityRevision == identity) {
        setState(() => _workError = failure.message);
      }
    } catch (_) {
      if (mounted && state.identityRevision == identity) {
        setState(() => _workError = '本次工作尚未发送，请保留草稿并重试。');
      }
    }
    return false;
  }

  void _restoreCloudReceipt(Map<String, dynamic> receipt) {
    if (!mounted) return;
    final state = MobileScope.read(context);
    setState(() {
      _activeAccount = null;
      _activeTask = receipt['taskId'] as String;
      _activeTitle = state.findTask(_activeTask!)?.title ?? '云端对话';
      _activeRef = receipt['ref'] as String? ?? '';
      _workError = '';
    });
  }

  void _openEntry(SessionFeedEntry entry) {
    _sidebar.currentState?.close();
    if (widget.preview) {
      setState(() {
        _previewText = entry.task.note.isEmpty
            ? entry.task.title
            : entry.task.note;
        _workCardHistoryId = '';
        _activeAccount = null;
        _activeTask = null;
        _reviewDraft = null;
      });
      _select(0);
    } else if (entry.isCloudConversation || entry.task.hasExecutionHistory) {
      setState(() {
        _workCardHistoryId = '';
        _activeAccount = null;
        _reviewDraft = null;
        _activeTask = entry.task.id;
        _activeTitle = entry.task.title;
        _activeAgentLabel = entry.agentLabel;
        _activeRef = '';
      });
      _select(0);
    } else {
      unawaited(_push(TaskDetailScreen(taskId: entry.task.id)));
    }
  }

  void _checkRequestedConversation(WorkConversationDestination destination) {
    final state = MobileScope.read(context);
    if (!mounted || destination.identity != state.identityRevision) {
      throw const ApiFailure('账号已变化，请重新打开需求。');
    }
    final newReview = destination.review != null && destination.taskId.isEmpty;
    if (destination.review != null && !sharedConversationAvailable) {
      throw const ApiFailure('当前版本未启用完整会话，请在新版移动端打开验收分析。');
    }
    if (newReview &&
        !destination.resumesReviewDraft(
          activeTaskId: _activeTask,
          draft: _reviewDraft,
        ) &&
        (_workDraft.trim().isNotEmpty ||
            _workFiles.isNotEmpty ||
            _workCardDirty ||
            _workCardBusy ||
            state.pendingCloudRequest != null)) {
      throw const ApiFailure('主会话有未发送或待确认的内容，请先处理后再打开验收分析。');
    }
  }

  void _openRequestedConversation() {
    final destination = _conversationNavigation?.destination;
    final state = MobileScope.read(context);
    if (!mounted ||
        destination == null ||
        destination.identity != state.identityRevision) {
      return;
    }
    final newReview = destination.review != null && destination.taskId.isEmpty;
    final resumeDraft = destination.resumesReviewDraft(
      activeTaskId: _activeTask,
      draft: _reviewDraft,
    );
    Navigator.of(context).popUntil((route) => route.isFirst);
    _sidebar.currentState?.close();
    if (resumeDraft) {
      // Keep the live composer, attachments and any pending send intact.
      setState(() => _resource = null);
      _rememberLocation('tab:0');
      state.selectTab(0);
      return;
    }
    setState(() {
      _workCardHistoryId = '';
      _activeAccount = null;
      _activeTask = destination.taskId.isEmpty ? null : destination.taskId;
      _reviewDraft = newReview ? destination.review : null;
      if (newReview) {
        _workDraft = destination.review!.automatic
            ? '请逐项核验这次交付，按实际证据提交验收结论；无法证实的标准请说明原因并退回修改。'
            : '请逐项核对这次交付，说明满足与不满足的标准及依据，暂不提交验收决定。';
        _workActionId = '';
        _sharedDiscardDraft = true;
        _pluginAuthoring = false;
        _workVersion++;
      }
      _activeTitle = destination.title;
      _activeAgentLabel = destination.agentLabel;
      _activeRef = destination.ref;
      _resource = null;
    });
    _rememberLocation('tab:0');
    state.selectTab(0);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final navigation = MobileScope.read(context).workConversationNavigation;
    if (_conversationNavigation != navigation) {
      _conversationNavigation?.removeListener(_openRequestedConversation);
      if (_conversationNavigation?.beforeOpen == _checkRequestedConversation) {
        _conversationNavigation?.beforeOpen = null;
      }
      _conversationNavigation = navigation;
      navigation.beforeOpen = _checkRequestedConversation;
      navigation.addListener(_openRequestedConversation);
    }
    final identity = MobileScope.of(context).identityRevision;
    if (_scope != null && _scope != identity) {
      _workFiles.clear();
      _capabilities.clear();
      _workDraft = '';
      _workActionId = '';
      _workError = '';
      _workModel = null;
      _previewText = null;
      _workCardHistoryId = '';
      _activeAccount = null;
      _activeTask = null;
      _reviewDraft = null;
      _workAgent = '';
      _workAgentLabel = '';
      _workRunnerId = '';
      _workRunnerKind = 'cloud';
      _workAgentModelPick = true;
      _resource = null;
      _workVersion++;
    }
    if (_scope != identity) {
      _workCardHistory = [];
      _workCardHistoryId = '';
    }
    _scope = identity;
    final state = MobileScope.read(context);
    final locationKey = _locationStore(state).key;
    if (_locationScope != locationKey) {
      _locationScope = locationKey;
      unawaited(_restoreLocation(state));
    }
  }

  String _sharedRouteKey(MobileState state) =>
      '${state.identityRevision}:$_workVersion:${_activeAccount?.id ?? _activeTask ?? "new"}:$_workCardHistoryId';

  Widget _sharedConversation(MobileState state, bool dark) {
    final route = _sharedRouteKey(state);
    if (_sharedHost == null || _sharedRoute != route) {
      _sharedRoute = route;
      _sharedEpoch++;
      final epoch = _sharedEpoch;
      _sharedHost = SharedConversationHost(
        state: state,
        taskId: _activeTask,
        accountConversation: _activeAccount,
        review: _activeTask == null && _activeAccount == null
            ? _reviewDraft
            : state.workConversationNavigation.reviewForTask(_activeTask),
        title: _activeTitle,
        dark: dark,
        clearNewDraft: _sharedDiscardDraft,
        initialDraft: _workDraft,
        initialFiles: _activeTask == null && _activeAccount == null
            ? List.of(_workFiles)
            : const [],
        initialAction: _workActionId,
        pluginAuthoring: _pluginAuthoring && _activeTask == null,
        onWorkFormOpen: (kind, id) async {
          if (!mounted || epoch != _sharedEpoch) {
            throw const ApiFailure('会话已切换，请重新打开。');
          }
          if (kind == 'requirement') {
            _select(3);
            await _push(TaskDetailScreen(taskId: id));
          } else {
            _openResource('automations');
          }
        },
        onPluginDraft: (draft) async {
          if (!mounted || epoch != _sharedEpoch) {
            throw const ApiFailure('会话已切换。');
          }
          return Navigator.of(context).push<Map<String, dynamic>>(
            MaterialPageRoute(
              builder: (_) => PluginBuilderScreen(initialValues: draft),
            ),
          );
        },
        workCardHistoryId: _workCardHistoryId,
        onWorkCardHistory: (rows) {
          if (!mounted || epoch != _sharedEpoch) return;
          setState(() => _workCardHistory = rows);
        },
        onWorkCardDraft: (dirty, busy) {
          if (!mounted || epoch != _sharedEpoch) return;
          _workCardDirty = dirty;
          _workCardBusy = busy;
        },
        onDraftAction: (actionId) {
          if (mounted && epoch == _sharedEpoch && _activeAccount == null) {
            _workActionId = actionId;
          }
        },
        onDraft: (text) {
          if (mounted && epoch == _sharedEpoch && _activeAccount == null) {
            _workDraft = text;
          }
        },
        onCreated: (taskId) {
          if (!mounted || epoch != _sharedEpoch) return;
          setState(() {
            _activeAccount = null;
            _activeTask = taskId;
            _workDraft = '';
            _workActionId = '';
            _sharedRoute = _sharedRouteKey(state);
          });
        },
        onAccountCreated: (conversation) {
          if (!mounted || epoch != _sharedEpoch) return;
          setState(() {
            _workDraft = '';
            _workActionId = '';
            _activeTask = null;
            _activeAccount = conversation;
            _activeTitle = conversation.displayTitle;
            _reviewDraft = null;
            _workCardHistoryId = '';
          });
        },
        onResource: (key) async {
          if (mounted && epoch == _sharedEpoch) _openResource(key);
        },
        onWorkAction: (actionId, args) async {
          void check() {
            if (!mounted || epoch != _sharedEpoch) {
              throw const ApiFailure('会话已切换，请重新打开。');
            }
          }

          check();
          final text = (args['text'] as String? ?? '').trim();
          final contextText = args['contextText'] as String? ?? '';
          final title = _workActionTitle(text);
          final material = _workActionMaterial(text, contextText, title);
          if (actionId == 'work.requirement.create') {
            final saved = await showMobileSheet<WorkTask>(
              context,
              title: '新建需求',
              builder: (_, scroll) =>
                  CreateTaskSheet(initialTitle: title, initialNote: material),
            );
            check();
            if (saved == null) return {'cancelled': true};
            unawaited(state.refreshAll());
            return {'ok': true, 'id': saved.id};
          }
          if (actionId == 'work.automation.create') {
            final saved = await showAutomationEditor(
              context,
              initialValues: {
                'title': title,
                'note': material,
                'enabled': false,
              },
            );
            check();
            if (saved == null) return {'cancelled': true};
            unawaited(state.refreshAll());
            return {'ok': true, 'id': saved.id};
          }
          if (actionId == 'work.plugin.create') {
            final opened = await _openPluginConversation(
              seed: text,
              contextText: contextText,
            );
            return opened
                ? {'ok': true, 'newSession': true}
                : {'cancelled': true};
          }
          await showDialog<void>(
            context: context,
            useRootNavigator: false,
            builder: (dialogContext) => AlertDialog(
              title: const Text('调试插件'),
              content: const Text(
                '移动端已接入插件工作流入口。逐节点调试需要在当前任务中选择个人工作流后运行；你可以先用“制作插件”创建并预检插件。',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(dialogContext).pop(),
                  child: const Text('知道了'),
                ),
              ],
            ),
          );
          return {'ok': true};
        },
        onHandoff: (kind, seed) async {
          void check() {
            if (!mounted || epoch != _sharedEpoch) {
              throw const ApiFailure('会话已切换，请重新打开。');
            }
          }

          check();
          return showConversationHandoff(
            context,
            kind: kind,
            seed: seed,
            check: check,
          );
        },
        onArtifact: (row) async {
          if (!mounted || epoch != _sharedEpoch) {
            throw const ApiFailure('会话已切换。');
          }
          if (row['action'] == 'saveLibrary') {
            await saveArtifactToLibrary(
              context,
              state.api,
              row,
              source: {
                'type': 'conversation',
                'sessionId': row['taskId'] ?? _activeTask ?? '',
                'conversationTitle': _activeTitle,
              },
            );
            return;
          }
          await openMobileArtifact(
            context,
            state.api,
            id: row['id'] as String? ?? '',
            url: row['url'] as String,
            filename: row['filename'] as String? ?? '成果',
            contentType:
                row['contentType'] as String? ?? 'application/octet-stream',
            previewDelivery: row['action'] == 'preview',
            entry: row['entryPath'] as String?,
            rethrowErrors: true,
          );
        },
        onLibraryPick: () async {
          if (!mounted || epoch != _sharedEpoch) {
            throw const ApiFailure('会话已切换');
          }
          return pickLibraryFile(context);
        },
        onLibrarySave: (file, source) async {
          if (!mounted || epoch != _sharedEpoch) {
            throw const ApiFailure('会话已切换');
          }
          return saveToLibrary(context, file, source: source);
        },
        onExternal: (url) async {
          await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
        },
      );
    }
    _sharedDiscardDraft = false;
    return Column(
      children: [
        if (_sharedHost?.review case final review?)
          ListTile(
            dense: true,
            title: Text(
              '${review.label} · ${review.title}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: TextButton(
              onPressed: () {
                // Back from the detail returns to the pool, not the analysis.
                _select(3);
                unawaited(_push(TaskDetailScreen(taskId: review.taskId)));
              },
              child: Text(mobileText(context, '返回需求验收')),
            ),
          ),
        if (_activeTask == null && _activeAccount == null)
          PendingCloudRequestBanner(onResolved: _restoreCloudReceipt),
        Expanded(
          child: SharedConversationView(
            key: ValueKey('shared-${state.identityRevision}-$_sharedEpoch'),
            onRequest: _sharedHost!.call,
            dark: dark,
            accent: _display.accent,
            locale: _display.language == MobileLanguage.english
                ? 'en-US'
                : 'zh-CN',
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    _brand = _display.apply(
      context.soduWorkTheme,
      MediaQuery.platformBrightnessOf(context),
    );
    final dark = _brand.brightness == Brightness.dark;
    return MobileLayerHost(
      background: _brand.canvas,
      child: MobileDisplayScope(
        preferences: _display,
        child: Theme(
          data: SoduWorkTheme.light(_brand),
          child: MobileSidebarSurface(
            key: _sidebar,
            surface: _brand.surface,
            sidebar: ConversationDrawer(
              state: state,
              preview: widget.preview,
              dark: dark,
              onNew: _newConversation,
              onDestination: _select,
              onEntry: _openEntry,
              workCards: _workCardHistory,
              onWorkCard: (row) async {
                final state = MobileScope.read(context);
                final identity = state.identityRevision;
                final version = _workVersion;
                await _newConversation();
                if (!mounted ||
                    state.identityRevision != identity ||
                    version == _workVersion) {
                  return;
                }
                setState(() {
                  _workCardHistoryId = row['id'] as String;
                  final taskId = row['taskId'] as String? ?? '';
                  _activeAccount = null;
                  _activeTask = taskId.isEmpty ? null : taskId;
                  _activeTitle = row['title'] as String;
                  _sharedDiscardDraft = false;
                });
              },
              onAccountEntry: _openAccount,
              onSearch: _searchHistory,
              onSettings: _settings,
              onTheme: _toggleTheme,
              onResource: _openResource,
            ),
            child: Scaffold(
              key: _scaffold,
              drawerScrimColor: _brand.ink.withValues(alpha: .12),
              backgroundColor: state.tabIndex < 2
                  ? _brand.surface
                  : _brand.canvas,
              body: SafeArea(
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
                      child: Row(
                        children: [
                          IconButton(
                            key: const Key('open-sidebar'),
                            tooltip: _display.text('打开侧栏'),
                            style: conversationCircleStyle(
                              context,
                              brand: _brand,
                            ),
                            onPressed: () => _sidebar.currentState?.open(),
                            icon: const Icon(CupertinoIcons.equal, size: 24),
                          ),
                          Expanded(
                            child: _resource == null && state.tabIndex < 2
                                ? Text(
                                    SoduWorkSdkScope.maybeOf(
                                              context,
                                            )?.serviceDisplayName ==
                                            '本机独立测试'
                                        ? _display.text('本机测试')
                                        : _activeTask == null &&
                                              _activeAccount == null
                                        ? ''
                                        : 'SoduWork',
                                    textAlign: TextAlign.center,
                                    style: TextStyle(
                                      color: _brand.ink,
                                      fontSize: 17,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  )
                                : Center(
                                    child: Text(
                                      _display.text(
                                        _resource != null
                                            ? workspaceResourceTitle(_resource!)
                                            : state.tabIndex == 2
                                            ? '工作空间'
                                            : state.tabIndex >= 3
                                            ? '需求池'
                                            : '工作',
                                      ),
                                      style: TextStyle(
                                        color: _brand.ink,
                                        fontSize: 17,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ),
                          ),
                          if (_resource == null && state.tabIndex < 2)
                            IconButton(
                              tooltip: _display.text('新对话'),
                              style: conversationCircleStyle(
                                context,
                                brand: _brand,
                              ),
                              onPressed: _newConversation,
                              icon: const Icon(
                                CupertinoIcons.square_pencil,
                                size: 23,
                              ),
                            )
                          else
                            const SizedBox(width: 44),
                        ],
                      ),
                    ),
                    Expanded(
                      child: IndexedStack(
                        index: _resource == null ? 0 : 1,
                        children: [
                          IndexedStack(
                            index: state.tabIndex < 2 ? 0 : state.tabIndex - 1,
                            children: [
                              if (sharedConversationAvailable &&
                                  !widget.preview)
                                _sharedConversation(state, dark)
                              else if (_previewText != null)
                                ConversationPreviewScreen(
                                  key: ValueKey(_previewText),
                                  title: 'SoduWork',
                                  message: _previewText!,
                                  embedded: true,
                                )
                              else if (_activeTask != null)
                                CloudConversationScreen(
                                  key: ValueKey(_activeTask),
                                  taskId: _activeTask!,
                                  title: _activeTitle,
                                  agentLabel: _activeAgentLabel.isEmpty
                                      ? _workAgentLabel
                                      : _activeAgentLabel,
                                  ref: _activeRef,
                                  modelLabel: _workModel?.label ?? '',
                                  embedded: true,
                                  onExecutionOptions: _executionOptions,
                                )
                              else
                                Column(
                                  children: [
                                    if (!widget.preview)
                                      PendingCloudRequestBanner(
                                        onResolved: _restoreCloudReceipt,
                                      ),
                                    Expanded(
                                      child: ConversationLanding(
                                        key: ValueKey(
                                          'work-draft-$_workVersion',
                                        ),
                                        workMode: true,
                                        addButtonKey: _workAddAnchor,
                                        modelAnchorKey: _workModelAnchor,
                                        modelLabel:
                                            _capabilities.any(
                                              (row) =>
                                                  row.kind ==
                                                  WorkCapabilityKind.workflow,
                                            )
                                            ? '插件预设'
                                            : _capabilities.any(
                                                (row) =>
                                                    row.kind ==
                                                    WorkCapabilityKind.teammate,
                                              )
                                            ? '同事留言'
                                            : !_workAgentModelPick
                                            ? '底座自带模型'
                                            : _workModel == null
                                            ? '选择模型'
                                            : _workModel!.label,
                                        executionLabel: _workAgentLabel,
                                        onExecutionOptions: _executionOptions,
                                        onPickModel:
                                            !_workAgentModelPick ||
                                                _capabilities.any(
                                                  (row) =>
                                                      row.kind !=
                                                      WorkCapabilityKind.skill,
                                                )
                                            ? null
                                            : _chooseWorkModel,
                                        preview: widget.preview,
                                        initialText: _workDraft,
                                        onDraftChanged: (text) =>
                                            _workDraft = text,
                                        voiceScopeKey:
                                            '${state.endpoint.baseUrl}:${state.identityRevision}:work',
                                        onSend: _sendWork,
                                        onWork: () => _select(3),
                                        onAdd: _materials,
                                        onPickCapability: _pickCapability,
                                        capabilities: List.of(_capabilities),
                                        attachmentNames: _workFiles
                                            .map((file) => file.name)
                                            .toList(),
                                        onRemoveCapability: (index) => setState(
                                          () => _capabilities.removeAt(index),
                                        ),
                                        onRemoveAttachment: (index) => setState(
                                          () => _workFiles.removeAt(index),
                                        ),
                                        errorText: _workError.isNotEmpty
                                            ? _workError
                                            : _loadError,
                                        onRetry: _refresh,
                                      ),
                                    ),
                                  ],
                                ),
                              widget.preview
                                  ? PreviewProfilePane(
                                      onTheme: _toggleTheme,
                                      dark: dark,
                                    )
                                  : const ProfileScreen(),
                              widget.preview
                                  ? PreviewWorkPane(onEntry: _openEntry)
                                  : WorkScreen(
                                      onCreate: () => _openWorkConversation(
                                        sharedConversationAvailable
                                            ? ''
                                            : '/需求 ',
                                        actionId: 'work.requirement.create',
                                      ),
                                    ),
                            ],
                          ),
                          if (_resource != null)
                            WorkspaceResourcePane(
                              key: ValueKey(_resource),
                              resource: _resource!,
                              onDiscuss: (files, prompt) => _newConversation(
                                materials: files,
                                prefill: prompt,
                                fromLibrary: true,
                              ),
                              onLibrarySource: _librarySource,
                              preview: widget.preview,
                              onAccount: _openAccount,
                              onEntry: _openEntry,
                              onCreatePlugin: () => _openPluginConversation(),
                              onCreateAutomation: () => _openWorkConversation(
                                sharedConversationAvailable ? '' : '/自动化 ',
                                actionId: 'work.automation.create',
                              ),
                              onCapability: (picked) {
                                if (_acceptCapability(picked)) {
                                  _select(0);
                                }
                              },
                            )
                          else
                            const SizedBox.shrink(),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

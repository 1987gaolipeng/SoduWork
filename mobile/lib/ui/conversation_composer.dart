import 'pending_cloud_request_banner.dart';
import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../core/soduwork_api.dart';
import '../core/cloud_conversation_request.dart';
import '../core/work_file_picker.dart';
import '../core/conversation_target_roster.dart';
import '../models/work_models.dart';
import '../models/account_conversation.dart';
import '../state/mobile_scope.dart';
import '../ui/mobile_theme.dart';
import 'platform_image.dart';
import 'voice_input_control.dart';
import '../ui/work_widgets.dart';

/// Modal sheet that starts a remote conversation: pick an executor, describe
/// the request, optionally attach reference images. Pops the backend receipt.
Future<Map<String, dynamic>?> showConversationComposer(
  BuildContext context, {
  String initialText = '',
  List<XFile> initialFiles = const [],
  List<String> requiredSkills = const [],
  AiAssignee? initialAssignee,
  AccountConversation? branch,
}) async {
  final pending = MobileScope.read(context).pendingCloudRequest;
  if (branch != null &&
      pending != null &&
      pending.options['accountConversationId'] != branch.id) {
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(mobileText(context, '先核对上一笔派发')),
        content: Text(
          mobileText(context, '还有一笔派发结果尚未确认。请回到首页发送面板核对，避免重复执行。当前聊天没有变化。'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(mobileText(context, '知道了')),
          ),
        ],
      ),
    );
    return null;
  }
  if (!context.mounted) return null;
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    constraints: const BoxConstraints(maxWidth: 600),
    builder: (_) => ConversationComposer(
      initialText: initialText,
      branch: branch,
      initialFiles: initialFiles,
      requiredSkills: requiredSkills,
      initialAssignee: initialAssignee,
    ),
  );
}

const int _maxFiles = 20;
const int _maxTotalBytes = 90 * 1024 * 1024;

class ConversationComposer extends StatefulWidget {
  final String initialText;
  final AiAssignee? initialAssignee;
  final AccountConversation? branch;
  final List<XFile> initialFiles;
  final List<String> requiredSkills;

  const ConversationComposer({
    super.key,
    this.initialText = '',
    this.initialAssignee,
    this.branch,
    this.initialFiles = const [],
    this.requiredSkills = const [],
  });

  @override
  State<ConversationComposer> createState() => _ConversationComposerState();
}

class _ConversationComposerState extends State<ConversationComposer> {
  final _message = TextEditingController();
  final _focus = FocusNode();
  AiAssignee? _agent;
  AiRoster? _roster;
  bool _loadingAgents = true;
  String _agentError = '';
  final List<XFile> _files = [];
  CloudConversationRequest? _request;
  bool _submitting = false;
  String _error = '';
  int? _identity;

  String? _branchId;
  int? _branchRevision;
  bool get _branch => _branchId != null;

  @override
  void initState() {
    super.initState();
    _message.text = widget.initialText;
    _files.addAll(widget.initialFiles);
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final state = MobileScope.read(context);
      _identity = state.identityRevision;
      await state.restorePendingBranch();
      if (!mounted || _identity != state.identityRevision) return;
      if (state.pendingRequestError.isNotEmpty) {
        setState(() => _error = state.pendingRequestError);
        return;
      }
      _request = state.pendingCloudRequest;
      _branchId =
          _request?.options['accountConversationId'] as String? ??
          widget.branch?.id;
      _branchRevision =
          _request?.options['expectedRevision'] as int? ??
          widget.branch?.revision;
      if (_request != null) {
        _message.text = _request!.options['text'] as String? ?? '';
        setState(() {});
      }
      // Receipt recovery must not depend on executor discovery or create a new
      // submission. The original request remains the only source of truth.
      if (_request?.receiptOnly == true) return;
      await _loadAgents();
    });
  }

  Future<void> _loadAgents() async {
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    setState(() {
      _loadingAgents = true;
      _agentError = '';
    });
    try {
      final catalogs = await Future.wait<Object>([
        Future<Object>.sync(() => state.aiAgents(force: true)),
        Future<Object>.sync(state.cloudConversationTargets),
      ]);
      final roster = conversationTargetRoster(
        catalogs[0] as AiRoster,
        catalogs[1] as Map<String, dynamic>,
      );
      if (!mounted || identity != state.identityRevision) return;
      final previous = _agent ?? widget.initialAssignee;
      final rows = roster.cloudAgents;
      setState(() {
        _roster = roster;
        _agent = _request != null
            ? rows
                  .where(
                    (item) =>
                        item.cli == _request!.options['agentId'] &&
                        (_request!.options['targetRunnerId'] == null ||
                            item.runnerId ==
                                _request!.options['targetRunnerId']) &&
                        (_request!.options['targetRunnerKind'] == null ||
                            item.runnerKind ==
                                _request!.options['targetRunnerKind']) &&
                        item.model == (_request!.options['model'] ?? ''),
                  )
                  .firstOrNull
            : previous == null
            ? rows
                  .where((item) => item.runnerKind == 'work-computer')
                  .firstOrNull
            : rows
                  .where(
                    (item) =>
                        item.cli == previous.cli &&
                        (previous.runnerId.isEmpty ||
                            item.runnerId == previous.runnerId) &&
                        item.model == previous.model,
                  )
                  .firstOrNull;
      });
    } on ApiFailure catch (failure) {
      if (mounted && identity == state.identityRevision) {
        setState(() => _agentError = failure.message);
      }
    } catch (_) {
      if (mounted && identity == state.identityRevision) {
        setState(() => _agentError = '暂时无法读取执行环境，请重试。');
      }
    } finally {
      if (mounted && identity == state.identityRevision) {
        setState(() => _loadingAgents = false);
      }
    }
  }

  @override
  void dispose() {
    _message.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _insertTranscript(String text) {
    final selection = _message.selection;
    final start = selection.isValid ? selection.start : _message.text.length;
    final end = selection.isValid ? selection.end : start;
    final next = _message.text.replaceRange(start, end, text);
    _message.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: start + text.length),
    );
    setState(() {});
  }

  Future<int> _sumBytes(List<XFile> files) async {
    var total = 0;
    for (final file in files) {
      total += await file.length();
    }
    return total;
  }

  bool get _canSubmit =>
      !_submitting &&
      (_request != null ||
          (!_loadingAgents &&
              _agentError.isEmpty &&
              _message.text.trim().isNotEmpty &&
              _agent?.cli.isNotEmpty == true));

  Future<void> _pickAttachments() async {
    final room = _maxFiles - _files.length;
    if (room <= 0) {
      _flash('最多附加 $_maxFiles 份文件');
      return;
    }
    final state = MobileScope.read(context);
    final revision = state.identityRevision;
    final source = await showModalBottomSheet<String>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.attach_file),
              title: const Text('选择文件'),
              onTap: () => Navigator.pop(sheet, 'files'),
            ),
            ListTile(
              leading: const Icon(Icons.photo_outlined),
              title: const Text('选择照片'),
              onTap: () => Navigator.pop(sheet, 'photos'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || state.identityRevision != revision || source == null) {
      return;
    }
    try {
      final picker = ImagePicker();
      final picked = source == 'files'
          ? await pickWorkFiles()
          : room == 1
          ? [
              ?await picker.pickImage(
                source: ImageSource.gallery,
                imageQuality: 82,
              ),
            ]
          : await picker.pickMultiImage(imageQuality: 82, limit: room);
      if (picked.isEmpty || !mounted || state.identityRevision != revision) {
        return;
      }
      final next = [..._files];
      var total = await _sumBytes(_files);
      var overflowed = false;
      for (final file in picked) {
        final size = await file.length();
        if (next.length >= _maxFiles || total + size > _maxTotalBytes) {
          overflowed = true;
          break;
        }
        total += size;
        next.add(file);
      }
      if (!mounted || state.identityRevision != revision) return;
      setState(() {
        _files
          ..clear()
          ..addAll(next);
      });
      if (overflowed) _flash('已附加到当前上限（20 份 / 90MB）');
    } catch (_) {
      _flash('没能读取所选文件，请重试');
    }
  }

  void _flash(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final state = MobileScope.read(context);
    final endpoint = state.endpoint.baseUrl;
    setState(() {
      _submitting = true;
      _error = '';
    });
    try {
      final text = _message.text.trim();
      final identity = state.identityRevision;
      _request ??= _branch
          ? CloudConversationRequest.accountBranch(
              conversationId: _branchId!,
              revision: _branchRevision!,
              text: text,
              agentId: _agent!.cli,
              model: _agent!.model,
              targetRunnerId: _agent!.runnerId,
              targetRunnerKind: _agent!.runnerKind,
            )
          : await CloudConversationRequest.prepare(
              text: text,
              agentId: _agent!.cli,
              model: _agent!.model,
              targetRunnerId: _agent!.runnerId,
              targetRunnerKind: _agent!.runnerKind,
              title: text.length > 24 ? '${text.substring(0, 24)}…' : text,
              files: List.of(_files),
              requiredSkills: widget.requiredSkills,
            );
      if (!mounted ||
          endpoint != state.endpoint.baseUrl ||
          identity != state.identityRevision) {
        return;
      }
      await state.rememberCloudRequest(_request!);
      if (!mounted || identity != state.identityRevision) return;
      final receipt = await state.startCloudConversation(
        text: _request!.options['text'] as String,
        request: _request,
      );
      if (mounted) Navigator.of(context).pop(receipt);
    } on ApiFailure catch (failure) {
      if (!mounted || _identity != state.identityRevision) return;
      final uncertain =
          failure.isNetwork || failure.status >= 500 || failure.status == 408;
      var canClear = !uncertain;
      if (canClear) {
        try {
          if (_request != null) await state.forgetCloudRequest(_request!.id);
        } catch (_) {
          canClear = false;
        }
      }
      if (!mounted || _identity != state.identityRevision) return;
      setState(() {
        _error =
            (failure.message ==
                    'conversation changed; refresh before continuing'
                ? '来源聊天已有更新。'
                : failure.message) +
            (_branch && failure.status == 409 ? ' 请关闭此面板，更新来源聊天记录后重新确认。' : '');
        if (canClear) _request = null;
      });
    } on FormatException catch (failure) {
      if (mounted) setState(() => _error = failure.message);
    } catch (_) {
      if (mounted) setState(() => _error = '发送结果尚未确认，请重试核对。');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = MobileScope.of(context);
    if (_identity != null && _identity != state.identityRevision) {
      return SafeArea(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(mobileText(context, '账号已切换，请关闭后重新打开。')),
        ),
      );
    }
    if (state.pendingCloudRequest?.receiptOnly == true) {
      return SafeArea(
        child: PendingCloudRequestBanner(
          onResolved: (receipt) => Navigator.of(context).pop(receipt),
        ),
      );
    }
    final theme = context.soduWorkTheme;
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    final availableHeight =
        (MediaQuery.sizeOf(context).height * .9 - bottom - 36).clamp(
          180.0,
          900.0,
        );
    final locked = _submitting || _request != null;
    final attachments = _branch
        ? null
        : IconButton(
            tooltip: _files.isEmpty
                ? mobileText(context, '添加附件')
                : mobileText(context, '继续添加附件'),
            onPressed: locked ? null : _pickAttachments,
            icon: const Icon(Icons.add_photo_alternate_outlined, size: 22),
          );
    return Padding(
      padding: EdgeInsets.only(bottom: bottom),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: availableHeight),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _SheetHeader(
              branch: _branch,
              onClose: () => Navigator.of(context).pop(),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (_branch) ...[
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: theme.surfaceMuted,
                          borderRadius: BorderRadius.circular(14),
                        ),
                        child: Text(
                          mobileText(
                            context,
                            '引用此聊天的完整已同步正文，创建独立会话。原电脑的文件、工具状态和操作权限不会迁移。',
                          ),
                          style: TextStyle(
                            fontSize: 12.5,
                            height: 1.6,
                            color: theme.inkSecondary,
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                    ],
                    if (widget.requiredSkills.isNotEmpty) ...[
                      Text(
                        mobileText(
                          context,
                          "本次技能：{0}",
                          values: [widget.requiredSkills.join('、')],
                        ),
                        style: TextStyle(
                          color: theme.inkSecondary,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 14),
                    ],
                    _Eyebrow('执行环境', trailing: '选择本次执行位置'),
                    const SizedBox(height: 10),
                    AbsorbPointer(
                      absorbing: locked,
                      child: _AgentPicker(
                        agents: _roster?.cloudAgents ?? const [],
                        loading: _loadingAgents,
                        error: _agentError,
                        onRetry: _loadAgents,
                        selected: _agent,
                        onSelect: (agent) => setState(() {
                          _agent = agent;
                          _error = '';
                        }),
                      ),
                    ),
                    const SizedBox(height: 22),
                    _Eyebrow(_branch ? '接下来做什么' : '需求内容'),
                    const SizedBox(height: 10),
                    Container(
                      decoration: BoxDecoration(
                        color: theme.surfaceMuted,
                        borderRadius: BorderRadius.circular(18),
                        border: Border.all(color: theme.line),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(6, 4, 6, 6),
                        child: Column(
                          children: [
                            TextField(
                              controller: _message,
                              readOnly: locked,
                              focusNode: _focus,
                              minLines: 3,
                              maxLines: 6,
                              autofocus: false,
                              textInputAction: TextInputAction.newline,
                              cursorColor: theme.ink,
                              style: TextStyle(
                                fontSize: 15,
                                height: 1.6,
                                color: theme.ink,
                              ),
                              onChanged: (_) => setState(() {}),
                              decoration: InputDecoration(
                                hintText: mobileText(
                                  context,
                                  '描述要完成的事、标准和截止时间…',
                                ),
                                hintStyle: TextStyle(
                                  color: theme.inkMuted,
                                  fontSize: 14.5,
                                  height: 1.6,
                                ),
                                filled: false,
                                border: InputBorder.none,
                                enabledBorder: InputBorder.none,
                                focusedBorder: InputBorder.none,
                                contentPadding: const EdgeInsets.fromLTRB(
                                  12,
                                  12,
                                  12,
                                  8,
                                ),
                              ),
                            ),
                            VoiceInputControl(
                              compact: true,
                              scopeKey:
                                  '${state.endpoint.baseUrl}:${state.identityRevision}:composer',
                              inputFocus: _focus,
                              enabled: !locked,
                              onTranscript: _insertTranscript,
                              leading: attachments,
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (!_branch && _files.isNotEmpty) ...[
                      const SizedBox(height: 14),
                      AbsorbPointer(
                        absorbing: locked,
                        child: _AttachmentGrid(
                          files: _files,
                          onAdd: _pickAttachments,
                          onRemove: (index) =>
                              setState(() => _files.removeAt(index)),
                        ),
                      ),
                    ],
                    if (_request != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        mobileText(context, '本次内容已保留，重试会核对同一次派发。'),
                        style: TextStyle(
                          fontSize: 12.5,
                          color: theme.inkMuted,
                          height: 1.5,
                        ),
                      ),
                    ],
                    if (_error.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      InlineError(message: mobileText(context, _error)),
                    ],
                  ],
                ),
              ),
            ),
            Container(
              padding: EdgeInsets.fromLTRB(
                20,
                14,
                20,
                14 + MediaQuery.paddingOf(context).bottom,
              ),
              decoration: BoxDecoration(
                color: theme.surface,
                border: Border(top: BorderSide(color: theme.line)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  FilledButton.icon(
                    style: FilledButton.styleFrom(
                      backgroundColor: theme.ink,
                      foregroundColor: theme.surface,
                      disabledBackgroundColor: theme.surfaceMuted,
                      disabledForegroundColor: theme.inkMuted,
                      minimumSize: const Size(double.infinity, 48),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                      ),
                    ),
                    onPressed: _canSubmit ? _submit : null,
                    icon: _submitting
                        ? SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: theme.surface,
                            ),
                          )
                        : const Icon(Icons.arrow_upward_rounded, size: 19),
                    label: Text(
                      _submitting
                          ? mobileText(context, '派发中')
                          : _request != null
                          ? mobileText(context, '重试确认')
                          : mobileText(
                              context,
                              _agent?.runnerKind == 'work-computer'
                                  ? '派到本人电脑执行'
                                  : '派到云端执行',
                            ),
                    ),
                  ),
                  const SizedBox(height: 9),
                  Text(
                    mobileText(
                      context,
                      _agent?.runnerKind == 'work-computer'
                          ? '所选电脑和执行服务需保持在线，结果会保存在新会话中'
                          : '在云端环境执行，结果会保存在会话中',
                    ),
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 11.5,
                      color: theme.inkMuted,
                      height: 1.4,
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

class _SheetHeader extends StatelessWidget {
  final VoidCallback onClose;
  final bool branch;
  const _SheetHeader({required this.onClose, required this.branch});
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 10, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    branch
                        ? mobileText(context, '用这段聊天继续')
                        : mobileText(context, '确认发送'),
                    style: TextStyle(
                      color: theme.ink,
                      fontSize: 20,
                      height: 1.4,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    mobileText(context, '选择执行环境，确认后开始处理'),
                    style: TextStyle(
                      color: theme.inkMuted,
                      fontSize: 12.5,
                      height: 1.5,
                    ),
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            tooltip: mobileText(context, '关闭'),
            onPressed: onClose,
            icon: const Icon(Icons.close_rounded, size: 22),
          ),
        ],
      ),
    );
  }
}

class _Eyebrow extends StatelessWidget {
  final String title;
  final String? trailing;

  const _Eyebrow(this.title, {this.trailing});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Row(
      children: [
        Text(
          title,
          style: TextStyle(
            color: theme.ink,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
        const Spacer(),
        if (trailing != null)
          Text(
            trailing!,
            style: TextStyle(color: theme.inkMuted, fontSize: 12),
          ),
      ],
    );
  }
}

class _AgentPicker extends StatelessWidget {
  final List<AiAssignee> agents;
  final bool loading;
  final String error;
  final VoidCallback onRetry;
  final AiAssignee? selected;
  final ValueChanged<AiAssignee> onSelect;
  const _AgentPicker({
    required this.agents,
    required this.loading,
    required this.error,
    required this.onRetry,
    required this.selected,
    required this.onSelect,
  });
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    if (loading || error.isNotEmpty || agents.isEmpty) {
      return Container(
        padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
        decoration: BoxDecoration(
          color: theme.surfaceMuted,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(
          children: [
            if (loading)
              SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 1.7,
                  color: theme.inkSecondary,
                ),
              )
            else
              Icon(
                error.isNotEmpty
                    ? Icons.wifi_off_rounded
                    : Icons.cloud_off_outlined,
                size: 20,
                color: theme.inkMuted,
              ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                loading
                    ? mobileText(context, '正在读取执行环境…')
                    : error.isNotEmpty
                    ? error
                    : mobileText(context, '暂时没有可接收本次会话的执行环境'),
                style: TextStyle(
                  color: theme.inkSecondary,
                  fontSize: 13,
                  height: 1.5,
                ),
              ),
            ),
            if (!loading)
              IconButton(
                tooltip: mobileText(context, '刷新执行环境'),
                onPressed: onRetry,
                icon: const Icon(Icons.refresh_rounded, size: 20),
              ),
          ],
        ),
      );
    }
    return Column(
      children: [
        for (var i = 0; i < agents.length; i++) ...[
          _AgentCard(
            agent: agents[i],
            selected:
                selected?.cli == agents[i].cli &&
                selected?.runnerId == agents[i].runnerId &&
                selected?.runnerKind == agents[i].runnerKind &&
                selected?.model == agents[i].model,
            onTap: () => onSelect(agents[i]),
          ),
          if (i < agents.length - 1) const SizedBox(height: 8),
        ],
      ],
    );
  }
}

class _AgentCard extends StatelessWidget {
  final AiAssignee agent;
  final bool selected;
  final VoidCallback onTap;

  const _AgentCard({
    required this.agent,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Semantics(
      button: true,
      selected: selected,
      label: '选择执行环境 ${agent.name}',
      child: Material(
        color: selected
            ? theme.secondarySoft.withValues(alpha: .55)
            : theme.surface,
        shape: RoundedRectangleBorder(
          side: BorderSide(
            color: selected ? theme.secondary : theme.line,
            width: selected ? 1.2 : 1,
          ),
          borderRadius: BorderRadius.circular(theme.radiusMedium),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
            child: Row(
              children: [
                Container(
                  width: 34,
                  height: 34,
                  decoration: BoxDecoration(
                    color: theme.secondary.withValues(
                      alpha: selected ? .16 : .08,
                    ),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    Icons.smart_toy_outlined,
                    size: 17,
                    color: theme.secondary,
                  ),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        agent.foundationLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: theme.ink,
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        [
                          '${agent.runnerKind == 'work-computer' ? '本人电脑' : '云端执行机'} · ${agent.machineLabel}',
                          if (agent.model.isNotEmpty) agent.model,
                        ].join(' · '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: theme.inkMuted, fontSize: 11.5),
                      ),
                    ],
                  ),
                ),
                if (agent.busy)
                  StatePill(
                    label: mobileText(context, '忙碌'),
                    color: theme.warning,
                    background: theme.warningSoft,
                  )
                else ...[
                  StatusBeacon(size: 7, color: theme.success),
                  const SizedBox(width: 6),
                  Text(
                    mobileText(context, '可接单'),
                    style: TextStyle(color: theme.success, fontSize: 11.5),
                  ),
                ],
                const SizedBox(width: 8),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 180),
                  child: selected
                      ? Icon(
                          Icons.check_circle_rounded,
                          key: const ValueKey('on'),
                          size: 20,
                          color: theme.secondary,
                        )
                      : Icon(
                          Icons.radio_button_unchecked_rounded,
                          key: const ValueKey('off'),
                          size: 20,
                          color: theme.lineStrong,
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _AttachmentGrid extends StatelessWidget {
  final List<XFile> files;
  final VoidCallback onAdd;
  final ValueChanged<int> onRemove;

  const _AttachmentGrid({
    required this.files,
    required this.onAdd,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final canAdd = files.length < _maxFiles;
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (var index = 0; index < files.length; index++)
          _Thumb(file: files[index], onRemove: () => onRemove(index)),
        if (canAdd)
          InkWell(
            onTap: onAdd,
            borderRadius: BorderRadius.circular(theme.radiusSmall),
            child: Container(
              width: 74,
              height: 74,
              decoration: BoxDecoration(
                color: theme.surfaceMuted,
                borderRadius: BorderRadius.circular(theme.radiusSmall),
                border: Border.all(color: theme.lineStrong),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.add_photo_alternate_outlined,
                    size: 20,
                    color: theme.inkSecondary,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    mobileText(context, '添加'),
                    style: TextStyle(color: theme.inkMuted, fontSize: 11),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _Thumb extends StatelessWidget {
  final XFile file;
  final VoidCallback onRemove;

  const _Thumb({required this.file, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Stack(
      clipBehavior: Clip.none,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(theme.radiusSmall),
          child:
              !RegExp(
                    r'\.(png|jpe?g|gif|bmp|webp|heic|avif)$',
                    caseSensitive: false,
                  ).hasMatch(file.name) &&
                  !(file.mimeType ?? '').startsWith('image/')
              ? SizedBox(
                  width: 74,
                  height: 74,
                  child: Center(
                    child: Text(
                      file.name,
                      textAlign: TextAlign.center,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                )
              : imageFromFile(
                  file.path,
                  width: 74,
                  height: 74,
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => Container(
                    width: 74,
                    height: 74,
                    color: theme.surfaceMuted,
                    child: Icon(
                      Icons.image_not_supported_outlined,
                      size: 20,
                      color: theme.inkMuted,
                    ),
                  ),
                ),
        ),
        Positioned(
          top: -6,
          right: -6,
          child: GestureDetector(
            onTap: onRemove,
            child: Container(
              width: 20,
              height: 20,
              decoration: BoxDecoration(
                color: theme.ink,
                shape: BoxShape.circle,
                border: Border.all(color: theme.surface, width: 1.5),
              ),
              child: Icon(Icons.close_rounded, size: 12, color: theme.surface),
            ),
          ),
        ),
      ],
    );
  }
}

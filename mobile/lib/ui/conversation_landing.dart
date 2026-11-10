import 'dart:async';
import 'package:flutter/cupertino.dart';
import '../models/work_capability.dart';
import 'package:flutter/material.dart';

import 'mobile_theme.dart';
import 'work_widgets.dart';
import 'adaptive_conversation_input.dart';
import 'mobile_display_preferences.dart';

/// Shared by the connected application and the explicitly offline preview.
class ConversationLanding extends StatefulWidget {
  final bool workMode;
  final Key? addButtonKey;
  final Key? modelAnchorKey;
  final String modelLabel;
  final String executionLabel;
  final VoidCallback? onExecutionOptions;
  final FutureOr<void> Function()? onPickModel;
  final String initialText;
  final VoidCallback? onAdd;
  final Future<bool> Function(String prefix)? onPickCapability;
  final List<WorkCapability> capabilities;
  final List<String> attachmentNames;
  final ValueChanged<int>? onRemoveCapability;
  final ValueChanged<int>? onRemoveAttachment;
  final bool preview;
  final Object? voiceScopeKey;
  final bool busy;
  final Future<bool> Function(String) onSend;
  final int pendingCount;
  final String errorText;
  final VoidCallback? onRetry;
  final VoidCallback onWork;
  final ValueChanged<String>? onDraftChanged;

  const ConversationLanding({
    super.key,
    this.workMode = false,
    this.addButtonKey,
    this.modelAnchorKey,
    this.modelLabel = '选择模型',
    this.executionLabel = '',
    this.onExecutionOptions,
    this.onPickModel,
    this.initialText = '',
    this.onAdd,
    this.onPickCapability,
    this.capabilities = const [],
    this.attachmentNames = const [],
    this.onRemoveCapability,
    this.onRemoveAttachment,
    this.preview = false,
    this.voiceScopeKey,
    this.busy = false,
    required this.onSend,
    this.pendingCount = 0,
    this.errorText = '',
    this.onRetry,
    required this.onWork,
    this.onDraftChanged,
  });

  @override
  State<ConversationLanding> createState() => _ConversationLandingState();
}

class _ConversationLandingState extends State<ConversationLanding> {
  final _text = TextEditingController();
  final _focus = FocusNode();
  bool _sending = false;
  bool _pickingCapability = false;

  @override
  void initState() {
    super.initState();
    _text.text = widget.initialText;
  }

  void _draftChanged(String text) {
    widget.onDraftChanged?.call(text);
    setState(() {});
    if (!widget.workMode ||
        _pickingCapability ||
        widget.onPickCapability == null) {
      return;
    }
    final caret = _text.selection.isValid
        ? _text.selection.extentOffset
        : text.length;
    if (caret < 0 || caret > text.length) return;
    final match = RegExp(
      r'(?:^|\s)([/@#])$',
    ).firstMatch(text.substring(0, caret));
    if (match == null) return;
    _pickingCapability = true;
    widget.onPickCapability!(match.group(1)!).then(
      (selected) {
        if (!mounted) return;
        if (selected && _text.text == text) {
          final start = caret - 1;
          final next = text.replaceRange(start, caret, '');
          _text.value = TextEditingValue(
            text: next,
            selection: TextSelection.collapsed(offset: start),
          );
          widget.onDraftChanged?.call(next);
        }
        _pickingCapability = false;
        _focus.requestFocus();
        setState(() {});
      },
      onError: (Object error) {
        if (mounted) {
          _pickingCapability = false;
          setState(() {});
        }
      },
    );
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  Future<void> _send({bool allowEmpty = false}) async {
    final text = _text.text.trim();
    if ((!allowEmpty && text.isEmpty) || _sending || widget.busy) return;
    setState(() => _sending = true);
    try {
      final accepted = await widget.onSend(text);
      if (mounted && accepted && _text.text.trim() == text) {
        _text.clear();
        widget.onDraftChanged?.call('');
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  void _suggest(String text) {
    _text.text = text;
    widget.onDraftChanged?.call(text);
    _text.selection = TextSelection.collapsed(offset: text.length);
    _focus.requestFocus();
    setState(() {});
  }

  void _insertVoice(String text) {
    final selection = _text.selection;
    final start = selection.isValid ? selection.start : _text.text.length;
    final end = selection.isValid ? selection.end : start;
    final next = _text.text.replaceRange(start, end, text);
    _text.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: start + text.length),
    );
    widget.onDraftChanged?.call(next);
    setState(() {});
  }

  void _addMaterials() {
    if (_sending || widget.busy) return;
    if (widget.onAdd != null) {
      widget.onAdd!();
      return;
    }
    if (!widget.preview) {
      _send(allowEmpty: true);
      return;
    }
    showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      builder: (context) => Padding(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.attach_file_rounded, size: 28),
            const SizedBox(height: 16),
            Text(
              mobileText(context, '添加参考材料'),
              style: TextStyle(fontSize: 19, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 10),
            Text(
              mobileText(context, '当前为离线界面预览。连接企业服务后，可以选择执行环境并添加图片。'),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(mobileText(context, '知道了')),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final brand = context.soduWorkTheme;
    final busy = _sending || widget.busy;
    final add = IconButton(
      key: widget.addButtonKey,
      tooltip: mobileText(context, '添加材料与执行方式'),
      onPressed: busy ? null : _addMaterials,
      icon: const Icon(CupertinoIcons.plus, size: 23),
    );
    final send = IconButton.filled(
      key: const Key('home-send'),
      tooltip: mobileText(context, '发送'),
      onPressed: _text.text.trim().isEmpty || busy ? null : _send,
      style: IconButton.styleFrom(
        minimumSize: const Size(44, 44),
        maximumSize: const Size(44, 44),
        backgroundColor: mobileActionColor(context),
        foregroundColor: brand.surface,
        disabledBackgroundColor: brand.surfaceMuted,
        disabledForegroundColor: brand.inkMuted,
      ),
      icon: _sending
          ? SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: brand.surface,
              ),
            )
          : const Icon(CupertinoIcons.arrow_up, size: 22),
    );
    final model = widget.workMode
        ? ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 150),
            child: TextButton(
              onPressed: busy || widget.onPickModel == null
                  ? null
                  : () async {
                      final scope = widget.voiceScopeKey;
                      await widget.onPickModel!();
                      if (mounted && widget.voiceScopeKey == scope) {
                        _focus.requestFocus();
                      }
                    },
              style: TextButton.styleFrom(
                minimumSize: const Size(0, 44),
                padding: const EdgeInsets.symmetric(horizontal: 6),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(
                      mobileText(context, widget.modelLabel),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w500,
                        color: brand.inkSecondary,
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Icon(CupertinoIcons.chevron_down, size: 12),
                ],
              ),
            ),
          )
        : null;
    final shortcuts = widget.workMode
        ? const [
            (CupertinoIcons.doc_text, '整理一份工作简报', '帮我整理本周工作简报，先列出需要的材料。'),
            (CupertinoIcons.doc_text_search, '分析文档与资料', '帮我分析资料，提炼关键结论和下一步行动。'),
            (CupertinoIcons.wand_stars, '开始一项工作', '我想开始一项新工作，请先帮我梳理目标和验收标准。'),
          ]
        : const [
            (CupertinoIcons.lightbulb, '解释一个概念', '请用通俗的语言解释一个我想了解的概念，并举例说明。'),
            (CupertinoIcons.pencil, '帮我润色文字', '我想润色一段文字，请先问我内容和期望的风格。'),
            (CupertinoIcons.chat_bubble, '一起理清思路', '帮我梳理一个问题，先从需要了解的信息开始。'),
          ];
    final selected =
        widget.capabilities.isEmpty && widget.attachmentNames.isEmpty
        ? null
        : Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 2),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (var i = 0; i < widget.capabilities.length; i++)
                    InputChip(
                      label: Text(widget.capabilities[i].label),
                      onDeleted: widget.onRemoveCapability == null
                          ? null
                          : () => widget.onRemoveCapability!(i),
                      backgroundColor: brand.surface,
                      side: BorderSide(color: brand.line),
                    ),
                  for (var i = 0; i < widget.attachmentNames.length; i++)
                    InputChip(
                      avatar: const Icon(CupertinoIcons.paperclip, size: 16),
                      label: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 180),
                        child: Text(
                          widget.attachmentNames[i],
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      onDeleted: widget.onRemoveAttachment == null
                          ? null
                          : () => widget.onRemoveAttachment!(i),
                      backgroundColor: brand.surface,
                      side: BorderSide(color: brand.line),
                    ),
                ],
              ),
            ),
          );
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 720),
        child: Column(
          children: [
            if (widget.preview) const PreviewNotice(),
            if (widget.errorText.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: InlineError(
                  message: widget.errorText,
                  onRetry: widget.onRetry,
                ),
              ),
            Expanded(
              child: Align(
                alignment: Alignment.bottomLeft,
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 18),
                  child: Semantics(
                    label: mobileText(
                      context,
                      widget.workMode ? '想把什么交给我？' : '今天，想聊些什么？',
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (final item in shortcuts)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: TextButton.icon(
                              onPressed: busy ? null : () => _suggest(item.$3),
                              icon: Icon(item.$1, size: 22),
                              label: Text(mobileText(context, item.$2)),
                              style: TextButton.styleFrom(
                                foregroundColor: brand.inkSecondary,
                                alignment: Alignment.centerLeft,
                                minimumSize: const Size(0, 44),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 10,
                                ),
                                textStyle: const TextStyle(
                                  fontSize: 15.5,
                                  fontWeight: FontWeight.w400,
                                ),
                              ),
                            ),
                          ),
                        if (widget.pendingCount > 0)
                          TextButton.icon(
                            onPressed: widget.onWork,
                            icon: const Icon(
                              CupertinoIcons.checkmark_seal,
                              size: 20,
                            ),
                            label: Text(
                              mobileText(
                                context,
                                "{0} 项工作等待你确认",
                                values: [widget.pendingCount],
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            if (widget.onExecutionOptions != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: busy ? null : widget.onExecutionOptions,
                    icon: const Icon(CupertinoIcons.command, size: 15),
                    label: Text(
                      widget.executionLabel.isEmpty
                          ? mobileText(context, '执行设置')
                          : widget.executionLabel,
                    ),
                    style: TextButton.styleFrom(
                      foregroundColor: brand.inkSecondary,
                      textStyle: const TextStyle(fontSize: 12.5),
                      padding: const EdgeInsets.symmetric(horizontal: 6),
                    ),
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              child: AdaptiveConversationInput(
                controller: _text,
                focusNode: _focus,
                workMode: widget.workMode,
                preview: widget.preview,
                enabled: !busy,
                inputKey: const Key('home-composer'),
                menuAnchorKey: widget.modelAnchorKey,
                voiceScopeKey: widget.voiceScopeKey,
                add: add,
                model: model,
                send: send,
                selections: selected,
                onChanged: _draftChanged,
                onTranscript: _insertVoice,
                hint: widget.workMode ? '与 SoduWork 协作' : '有问题，尽管问',
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 6),
              child: Text(
                mobileText(
                  context,
                  widget.preview ? '仅供界面体验，不会调用模型或连接企业服务' : '重要的决定，请核对依据与结果。',
                ),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 10.5, color: brand.inkMuted),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class PreviewNotice extends StatelessWidget {
  const PreviewNotice({super.key});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 16),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(
          Icons.science_outlined,
          size: 14,
          color: context.soduWorkTheme.inkMuted,
        ),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            mobileText(context, '界面预览 · 未连接企业服务'),
            style: TextStyle(fontSize: 11, color: context.soduWorkTheme.inkMuted),
          ),
        ),
      ],
    ),
  );
}

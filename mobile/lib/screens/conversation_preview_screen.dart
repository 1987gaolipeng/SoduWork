import '../ui/mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../ui/conversation_landing.dart';
import '../ui/cloud_conversation_controls.dart';
import '../ui/mobile_theme.dart';
import '../ui/conversation_markdown.dart';

/// Static interaction sample. No API, timer, generated progress or model call.
class ConversationPreviewScreen extends StatefulWidget {
  final String title;
  final String message;
  final bool embedded;

  const ConversationPreviewScreen({
    super.key,
    required this.title,
    required this.message,
    this.embedded = false,
  });

  @override
  State<ConversationPreviewScreen> createState() =>
      _ConversationPreviewScreenState();
}

class _ConversationPreviewScreenState extends State<ConversationPreviewScreen> {
  final _text = TextEditingController();
  final _scroll = ScrollController();
  final _focus = FocusNode();
  final List<String> _followups = [];

  @override
  void dispose() {
    _focus.dispose();
    _text.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send() {
    final text = _text.text.trim();
    if (text.isEmpty) return;
    setState(() {
      _followups.add(text);
      _text.clear();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Widget _bubble(String text) => Align(
    alignment: Alignment.centerRight,
    child: Container(
      margin: const EdgeInsets.only(top: 18, bottom: 24),
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
      constraints: const BoxConstraints(maxWidth: 580),
      decoration: BoxDecoration(
        color: context.soduWorkTheme.surfaceMuted,
        borderRadius: BorderRadius.circular(24),
      ),
      child: Text(
        text,
        style: TextStyle(color: context.soduWorkTheme.ink, height: 1.6),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final brand = context.soduWorkTheme;
    return Scaffold(
      backgroundColor: brand.surface,
      appBar: widget.embedded
          ? null
          : AppBar(
              title: Text(widget.title),
              centerTitle: true,
              actions: [
                IconButton(
                  tooltip: mobileText(context, '返回新会话'),
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.edit_square),
                ),
              ],
            ),
      body: SafeArea(
        top: false,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: Column(
              children: [
                const PreviewNotice(),
                Expanded(
                  child: ListView(
                    key: const Key('preview-transcript'),
                    controller: _scroll,
                    padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
                    children: [
                      _bubble(widget.message),
                      Text(
                        mobileText(context, '下面是一份成果展示示例。'),
                        style: TextStyle(
                          color: brand.ink,
                          fontSize: 16,
                          height: 1.7,
                        ),
                      ),
                      const SizedBox(height: 14),
                      const ConversationMarkdown(
                        data:
                            '工作可以从这里开始：\n\n1. 明确目标和完成标准。\n2. 补充参考资料与约束。\n3. 在同一会话跟进过程、确认结果。',
                      ),
                      const SizedBox(height: 24),
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(18),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Icon(
                                    Icons.description_outlined,
                                    color: brand.secondary,
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Text(
                                      mobileText(context, '项目交付清单'),
                                      style: TextStyle(
                                        fontWeight: FontWeight.w600,
                                        color: brand.ink,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              Text(
                                mobileText(context, '成果卡片 · 演示内容'),
                                style: TextStyle(
                                  fontSize: 12,
                                  color: brand.inkMuted,
                                ),
                              ),
                              const SizedBox(height: 16),
                              OutlinedButton.icon(
                                onPressed: () => showModalBottomSheet<void>(
                                  context: context,
                                  useSafeArea: true,
                                  isScrollControlled: true,
                                  builder: (context) => SafeArea(
                                    child: SingleChildScrollView(
                                      padding: const EdgeInsets.all(24),
                                      child: Column(
                                        mainAxisSize: MainAxisSize.min,
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            mobileText(context, '项目交付清单'),
                                            style: Theme.of(
                                              context,
                                            ).textTheme.titleLarge,
                                          ),
                                          const SizedBox(height: 16),
                                          SelectableText(
                                            mobileText(
                                              context,
                                              '示例文档\n\n目标：明确预期成果与责任人。\n材料：相关文档、参考图片、业务约束。\n验收：检查结果与依据，确认后完成交付。\n\n这是本地静态示例，没有生成或下载真实文件。',
                                            ),
                                          ),
                                          const SizedBox(height: 18),
                                          TextButton(
                                            onPressed: () =>
                                                Navigator.pop(context),
                                            child: Text(
                                              mobileText(context, '关闭预览'),
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                ),
                                icon: const Icon(
                                  Icons.open_in_new_rounded,
                                  size: 17,
                                ),
                                label: Text(mobileText(context, '预览示例文档')),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                      Text(
                        mobileText(
                          context,
                          '当前是离线交互预览。发送的内容仅在本页内存中展示，不会发给 AI；返回后不保存。',
                        ),
                        style: TextStyle(
                          color: brand.inkMuted,
                          fontSize: 12,
                          height: 1.6,
                        ),
                      ),
                      for (final text in _followups) ...[
                        _bubble(text),
                        Text(
                          mobileText(context, '已在本页展示这条输入。真实回答将在连接企业服务后提供。'),
                          style: TextStyle(
                            color: brand.inkSecondary,
                            height: 1.6,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                CloudConversationComposer(
                  controller: _text,
                  focusNode: _focus,
                  enabled: true,
                  busy: false,
                  hint: '与 SoduWork 协作',
                  onSend: _send,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import 'mobile_theme.dart';

/// GFM rendering uses flutter_markdown_plus 1.0.12 and markdown 7.3.1,
/// both BSD-3-Clause. Images never resolve a URI or perform network/file IO.
/// https://github.com/foresightmobile/flutter_markdown_plus
class ConversationMarkdown extends StatelessWidget {
  final String data;
  final Future<bool> Function(Uri uri)? openLink;

  const ConversationMarkdown({super.key, required this.data, this.openLink});

  static Uri? safeLink(String? href) {
    if (href == null || href.length > 8192) return null;
    final value = href.trim();
    if (RegExp(r'[\x00-\x20\x7f]').hasMatch(value)) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        !['https', 'http'].contains(uri.scheme.toLowerCase()) ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      return null;
    }
    return uri;
  }

  Future<void> _open(BuildContext context, String? href) async {
    final uri = safeLink(href);
    if (uri == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(mobileText(context, '此链接不支持安全打开'))),
      );
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(mobileText(context, '打开外部链接')),
        content: SingleChildScrollView(child: SelectableText(uri.toString())),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(mobileText(context, '取消')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(mobileText(context, '打开链接')),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    try {
      final opened =
          await (openLink?.call(uri) ??
              launchUrl(uri, mode: LaunchMode.externalApplication));
      if (!opened && context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(mobileText(context, '无法打开链接，请复制地址后重试'))),
        );
      }
    } on Exception {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(mobileText(context, '无法打开链接，请复制地址后重试'))),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final text = Theme.of(context).textTheme.bodyMedium!.copyWith(
      color: theme.ink,
      fontSize: 14.5,
      height: 1.58,
    );
    return SelectionArea(
      child: MarkdownBody(
        data: data,
        selectable: false,
        extensionSet: md.ExtensionSet.gitHubFlavored,
        onTapLink: (_, href, _) => _open(context, href),
        imageBuilder: (_, _, alt) => _ImagePlaceholder(alt: alt),
        builders: {'pre': _CodeBuilder()},
        styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
          p: text,
          a: text.copyWith(
            color: theme.secondary,
            decoration: TextDecoration.underline,
          ),
          listBullet: text,
          code: text.copyWith(fontFamily: 'monospace', fontSize: 13),
          blockSpacing: 12,
          blockquotePadding: const EdgeInsets.all(12),
          blockquoteDecoration: BoxDecoration(
            color: theme.surfaceMuted,
            border: Border(left: BorderSide(color: theme.secondary, width: 3)),
          ),
          tableColumnWidth: const IntrinsicColumnWidth(),
          tableScrollbarThumbVisibility: true,
          tableHead: text.copyWith(fontWeight: FontWeight.w600),
          tableBody: text,
          tableBorder: TableBorder.all(color: theme.line),
          tableCellsPadding: const EdgeInsets.symmetric(
            horizontal: 12,
            vertical: 9,
          ),
          codeblockPadding: EdgeInsets.zero,
          codeblockDecoration: const BoxDecoration(),
        ),
      ),
    );
  }
}

class _ImagePlaceholder extends StatelessWidget {
  final String? alt;
  const _ImagePlaceholder({this.alt});

  @override
  Widget build(BuildContext context) {
    final description = alt?.trim();
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: context.soduWorkTheme.surfaceMuted,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        description == null || description.isEmpty
            ? mobileText(context, '图片未自动加载')
            : mobileText(context, "图片未自动加载：{0}", values: [description]),
        style: TextStyle(color: context.soduWorkTheme.inkSecondary, fontSize: 12),
      ),
    );
  }
}

class _CodeBuilder extends MarkdownElementBuilder {
  @override
  bool isBlockElement() => true;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final children = element.children;
    final code = children != null && children.isNotEmpty
        ? children.first
        : null;
    final language = code is md.Element
        ? code.attributes['class']?.replaceFirst('language-', '') ?? ''
        : '';
    return _CodeBlock(code: element.textContent, language: language);
  }
}

class _CodeBlock extends StatefulWidget {
  final String code;
  final String language;
  const _CodeBlock({required this.code, required this.language});

  @override
  State<_CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends State<_CodeBlock> {
  bool _copying = false;

  Future<void> _copy() async {
    setState(() => _copying = true);
    try {
      await Clipboard.setData(ClipboardData(text: widget.code));
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(mobileText(context, '已复制代码'))));
      }
    } on Exception {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(mobileText(context, '复制失败，请选中代码重试'))),
        );
      }
    } finally {
      if (mounted) setState(() => _copying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return Container(
      clipBehavior: Clip.hardEdge,
      decoration: BoxDecoration(
        color: theme.surfaceMuted,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: theme.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(left: 12, right: 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    widget.language.isEmpty
                        ? mobileText(context, '代码')
                        : widget.language,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: theme.inkMuted, fontSize: 12),
                  ),
                ),
                IconButton(
                  tooltip: mobileText(context, '复制代码'),
                  onPressed: _copying ? null : _copy,
                  icon: const Icon(Icons.copy_rounded, size: 17),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: Text(
              widget.code,
              softWrap: false,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 13,
                height: 1.6,
                color: theme.ink,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

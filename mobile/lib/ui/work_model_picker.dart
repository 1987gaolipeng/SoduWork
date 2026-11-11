import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../models/general_chat.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import 'mobile_theme.dart';
import 'anchored_popover.dart';

Future<GeneralChatModel?> showWorkModelPicker(
  BuildContext context, {
  GeneralChatModel? selected,
  Rect? anchor,
}) => showAnchoredPopover<GeneralChatModel>(
  context,
  anchor: anchor,
  builder: (_) => _WorkModels(selected: selected),
);

class _WorkModels extends StatefulWidget {
  final GeneralChatModel? selected;
  const _WorkModels({this.selected});
  @override
  State<_WorkModels> createState() => _WorkModelsState();
}

class _WorkModelsState extends State<_WorkModels> {
  List<GeneralChatModel> _models = const [];
  String _error = '';
  bool _loading = true;
  int? _identity;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_identity == null) {
      _identity = state.identityRevision;
      _load();
    } else if (_identity != state.identityRevision) {
      _models = const [];
      _error = '账号已切换，请关闭后重新选择。';
      _loading = false;
    }
  }

  Future<void> _load() async {
    final state = MobileScope.read(context);
    if (_identity != state.identityRevision) return;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final catalog = await state.api.chatModelCatalog();
      if (!mounted || _identity != state.identityRevision) return;
      setState(() {
        _models = GeneralChatModel.fromCatalog(catalog);
        _error = _models.isEmpty ? '当前账号没有获准使用的模型，请检查企业模型授权。' : '';
      });
    } on ApiFailure catch (e) {
      if (mounted && _identity == state.identityRevision) {
        setState(() => _error = e.message);
      }
    } catch (_) {
      if (mounted && _identity == state.identityRevision) {
        setState(() => _error = '模型目录暂时不可用，请重试。');
      }
    } finally {
      if (mounted && _identity == state.identityRevision) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final current = _identity == MobileScope.of(context).identityRevision;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Flexible(
          fit: FlexFit.loose,
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 10),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        mobileText(context, '工作模型'),
                        style: TextStyle(
                          color: theme.ink,
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: mobileText(context, '关闭'),
                      onPressed: () => Navigator.pop(context),
                      icon: const Icon(CupertinoIcons.xmark, size: 17),
                    ),
                  ],
                ),
              ),
              if (_loading)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 26),
                  child: Center(
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 1.7,
                        color: theme.inkSecondary,
                      ),
                    ),
                  ),
                )
              else if (_error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _error,
                        style: TextStyle(
                          color: theme.inkSecondary,
                          fontSize: 13,
                          height: 1.6,
                        ),
                      ),
                      if (current)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: TextButton.icon(
                            onPressed: _load,
                            icon: const Icon(
                              CupertinoIcons.arrow_clockwise,
                              size: 16,
                            ),
                            label: Text(mobileText(context, '重新读取')),
                          ),
                        ),
                    ],
                  ),
                )
              else ...[
                Divider(
                  height: 1,
                  indent: 16,
                  endIndent: 16,
                  color: theme.line,
                ),
                const SizedBox(height: 6),
                for (final row in _models)
                  ListTile(
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 3,
                    ),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                    title: Text(
                      row.label,
                      style: TextStyle(
                        color: theme.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    subtitle: Text(
                      row.providerName,
                      style: TextStyle(color: theme.inkMuted, fontSize: 12),
                    ),
                    trailing: widget.selected?.name == row.name
                        ? Icon(
                            CupertinoIcons.check_mark,
                            size: 18,
                            color: theme.ink,
                          )
                        : null,
                    onTap: !current ? null : () => Navigator.pop(context, row),
                  ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

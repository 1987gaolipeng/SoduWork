import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'conversation_chrome.dart';
import 'mobile_display_preferences.dart';
import 'mobile_theme.dart';
import 'voice_input_control.dart';

class AdaptiveConversationInput extends StatefulWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool workMode, preview, enabled;
  final Object? voiceScopeKey;
  final Widget? add, model, selections;
  final Widget send;
  final Key? menuAnchorKey, inputKey;
  final ValueChanged<String> onChanged, onTranscript;
  final String hint;
  const AdaptiveConversationInput({
    super.key,
    required this.controller,
    required this.focusNode,
    this.workMode = false,
    this.preview = false,
    this.enabled = true,
    this.voiceScopeKey,
    this.add,
    this.model,
    this.selections,
    required this.send,
    this.menuAnchorKey,
    this.inputKey,
    required this.onChanged,
    required this.onTranscript,
    required this.hint,
  });
  @override
  State<AdaptiveConversationInput> createState() =>
      _AdaptiveConversationInputState();
}

class _AdaptiveConversationInputState extends State<AdaptiveConversationInput> {
  bool _editing = false;

  @override
  void initState() {
    super.initState();
    widget.focusNode.addListener(_changed);
    widget.controller.addListener(_changed);
  }

  void _changed() {
    if (mounted) {
      setState(() {
        if (widget.focusNode.hasFocus) _editing = true;
      });
    }
  }

  @override
  void didUpdateWidget(AdaptiveConversationInput old) {
    super.didUpdateWidget(old);
    if (old.focusNode != widget.focusNode) {
      old.focusNode.removeListener(_changed);
      widget.focusNode.addListener(_changed);
    }
    if (old.controller != widget.controller) {
      old.controller.removeListener(_changed);
      widget.controller.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.focusNode.removeListener(_changed);
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final brand = context.soduWorkTheme;
    final expanded =
        widget.workMode &&
        (_editing ||
            widget.focusNode.hasFocus ||
            widget.controller.text.isNotEmpty ||
            widget.selections != null);
    final field = TextField(
      key: widget.inputKey,
      controller: widget.controller,
      enabled: widget.enabled,
      focusNode: widget.focusNode,
      onTapOutside: (_) {
        widget.focusNode.unfocus();
        if (mounted) setState(() => _editing = false);
      },
      minLines: 1,
      // Keep the Web editing connection multiline before and after focus.
      // Changing maxLines from one to many replaces its semantic input node.
      maxLines: widget.workMode ? 6 : 4,
      keyboardType: TextInputType.multiline,
      textInputAction: TextInputAction.newline,
      onChanged: widget.onChanged,
      cursorColor: brand.ink,
      style: TextStyle(color: brand.ink, fontSize: 16, height: 1.4),
      decoration: InputDecoration(
        hintText: mobileText(context, widget.hint),
        hintMaxLines: 1,
        filled: false,
        isDense: true,
        border: InputBorder.none,
        enabledBorder: InputBorder.none,
        focusedBorder: InputBorder.none,
        contentPadding: const EdgeInsets.symmetric(horizontal: 6, vertical: 11),
      ),
    );
    final controls = !widget.preview && widget.voiceScopeKey != null
        ? VoiceInputControl(
            compact: true,
            scopeKey: widget.voiceScopeKey!,
            inputFocus: widget.focusNode,
            enabled: widget.enabled,
            onTranscript: widget.onTranscript,
            leading: widget.add,

            accessory: expanded ? widget.model : null,
            trailing: widget.send,
          )
        : Row(
            children: [
              if (widget.add != null) widget.add!,
              const Spacer(),
              if (expanded && widget.model != null)
                Flexible(child: widget.model!),
              widget.send,
            ],
          );
    // Keep EditableText at one stable location in the element tree. Moving it
    // between a Row and Column reconnects the Web text input on every focus
    // change and can cause a focus/resize/blur loop.
    return TextFieldTapRegion(
      child: ConversationInputSurface(
        child: Padding(
          padding: const EdgeInsets.all(4),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (widget.selections != null) widget.selections!,
              _ComposerLayout(
                key: const ValueKey('composer-stable-layout'),
                expanded: expanded,
                // Keep accessibility groups in the same DOM order when the
                // field moves above the toolbar. Reordering the focused Web
                // textarea detaches its browser editing connection.
                field: Semantics(
                  container: true,
                  sortKey: const OrdinalSortKey(0),
                  child: field,
                ),
                controls: Semantics(
                  container: true,
                  sortKey: const OrdinalSortKey(1),
                  child: KeyedSubtree(
                    key: widget.menuAnchorKey,
                    child: controls,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ComposerLayout extends MultiChildRenderObjectWidget {
  final bool expanded;
  _ComposerLayout({
    super.key,
    required this.expanded,
    required Widget field,
    required Widget controls,
  }) : super(children: [field, controls]);
  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderComposer(expanded);
  @override
  void updateRenderObject(
    BuildContext context,
    covariant _RenderComposer renderObject,
  ) {
    renderObject.expanded = expanded;
  }
}

class _ComposerParentData extends ContainerBoxParentData<RenderBox> {}

class _RenderComposer extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _ComposerParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _ComposerParentData> {
  bool _expanded;
  _RenderComposer(this._expanded);
  set expanded(bool value) {
    if (_expanded != value) {
      _expanded = value;
      markNeedsLayout();
    }
  }

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _ComposerParentData) {
      child.parentData = _ComposerParentData();
    }
  }

  @override
  void performLayout() {
    final width = constraints.maxWidth;
    final field = firstChild!, controls = lastChild!;
    controls.layout(
      BoxConstraints.tightFor(width: width),
      parentUsesSize: true,
    );
    final left = _expanded ? 12.0 : 48.0, right = _expanded ? 12.0 : 102.0;
    field.layout(
      BoxConstraints.tightFor(width: (width - left - right).clamp(0, width)),
      parentUsesSize: true,
    );
    final height = _expanded
        ? field.size.height + controls.size.height
        : field.size.height > controls.size.height
        ? field.size.height
        : controls.size.height;
    size = constraints.constrain(Size(width, height));
    (field.parentData as _ComposerParentData).offset = Offset(
      left,
      _expanded ? 0 : (size.height - field.size.height) / 2,
    );
    (controls.parentData as _ComposerParentData).offset = Offset(
      0,
      _expanded
          ? size.height - controls.size.height
          : (size.height - controls.size.height) / 2,
    );
  }

  @override
  void paint(PaintingContext context, Offset offset) =>
      defaultPaint(context, offset);
  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);
}

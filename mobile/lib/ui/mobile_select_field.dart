import 'mobile_input_border.dart';
import 'package:flutter/material.dart';

import 'anchored_popover.dart';
import 'mobile_theme.dart';

/// A settings-style form row with an anchored, scrollable single-choice menu.
class MobileSelectField<T> extends FormField<T> {
  final List<DropdownMenuItem<T>> items;
  final ValueChanged<T?>? onChanged;
  final InputDecoration decoration;
  final Widget? hint;
  final bool compact;

  MobileSelectField({
    super.key,
    super.initialValue,
    required this.items,
    required this.onChanged,
    this.decoration = const InputDecoration(),
    this.hint,
    this.compact = false,
    super.validator,
  }) : super(
         enabled: onChanged != null,
         builder: (field) => (field as _MobileSelectFieldState<T>).buildRow(),
       );

  @override
  FormFieldState<T> createState() => _MobileSelectFieldState<T>();
}

class _MobileSelectFieldState<T> extends FormFieldState<T> {
  final _anchor = GlobalKey();
  bool _open = false;
  MobileSelectField<T> get select => widget as MobileSelectField<T>;

  @override
  void didUpdateWidget(covariant MobileSelectField<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.initialValue != widget.initialValue) {
      setValue(widget.initialValue);
    }
  }

  Future<void> _showOptions() async {
    if (_open || !widget.enabled || select.items.isEmpty) return;
    _open = true;
    try {
      // Return the item rather than its nullable value to distinguish dismissal.
      final item = await showAnchoredPopover<DropdownMenuItem<T>>(
        context,
        anchor: popoverAnchor(context, _anchor),
        width: select.compact ? 260 : 360,
        builder: (menuContext) => ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.symmetric(vertical: 8),
          children: [
            for (final option in select.items)
              Semantics(
                selected: option.value == value,
                child: ListTile(
                  dense: select.compact,
                  visualDensity: select.compact ? VisualDensity.compact : null,
                  enabled: option.enabled,
                  minLeadingWidth: 22,
                  leading: option.value == value
                      ? const Icon(Icons.check_rounded, size: 21)
                      : const SizedBox(width: 21),
                  title: DefaultTextStyle.merge(
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                    ),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    child: option.child,
                  ),
                  onTap: option.enabled
                      ? () => Navigator.pop(menuContext, option)
                      : null,
                ),
              ),
          ],
        ),
      );
      if (!mounted || item == null || !widget.enabled) return;
      // A refreshed directory may have removed a choice while the menu was open.
      if (!select.items.any(
        (entry) => entry.value == item.value && entry.enabled,
      )) {
        return;
      }
      didChange(item.value);
      select.onChanged?.call(item.value);
    } finally {
      _open = false;
    }
  }

  Widget buildRow() {
    final theme = context.soduWorkTheme;
    final selected = select.items
        .where((item) => item.value == value)
        .firstOrNull;
    final label = select.decoration.labelText;
    final error = errorText ?? select.decoration.errorText;
    final helper = select.decoration.helperText;
    if (select.compact) {
      return InkWell(
        key: _anchor,
        onTap: widget.enabled && select.items.isNotEmpty ? _showOptions : null,
        borderRadius: BorderRadius.circular(10),
        child: InputDecorator(
          isEmpty: false,
          decoration: select.decoration.copyWith(
            enabled: widget.enabled,
            errorText: error,
            isDense: true,
            filled: true,
            fillColor: theme.surfaceRaised,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 12,
              vertical: 12,
            ),
            border: MobileInputBorder(borderRadius: BorderRadius.circular(10)),
            enabledBorder: MobileInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: theme.line),
            ),
          ),
          child: Row(
            children: [
              Expanded(
                child: DefaultTextStyle.merge(
                  style: TextStyle(
                    fontSize: 14,
                    color: widget.enabled ? theme.ink : theme.inkMuted,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  child:
                      selected?.child ??
                      select.hint ??
                      Text(select.decoration.hintText ?? '—'),
                ),
              ),
              Icon(
                Icons.keyboard_arrow_down_rounded,
                size: 18,
                color: theme.inkMuted,
              ),
            ],
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Material(
          color: theme.surfaceMuted.withValues(alpha: .55),
          borderRadius: BorderRadius.circular(18),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            key: _anchor,
            onTap: widget.enabled && select.items.isNotEmpty
                ? _showOptions
                : null,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
              child: Row(
                children: [
                  if (select.decoration.prefixIcon != null) ...[
                    IconTheme(
                      data: IconThemeData(size: 21, color: theme.inkSecondary),
                      child: select.decoration.prefixIcon!,
                    ),
                    const SizedBox(width: 12),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (label != null) ...[
                          Text(
                            label,
                            style: TextStyle(
                              fontSize: 12,
                              color: theme.inkMuted,
                            ),
                          ),
                          const SizedBox(height: 4),
                        ],
                        DefaultTextStyle.merge(
                          style: TextStyle(
                            fontSize: 15,
                            height: 1.35,
                            fontWeight: FontWeight.w500,
                            color: widget.enabled ? theme.ink : theme.inkMuted,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          child:
                              selected?.child ??
                              select.hint ??
                              Text(select.decoration.hintText ?? '—'),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  Icon(
                    Icons.unfold_more_rounded,
                    size: 20,
                    color: theme.inkMuted,
                  ),
                ],
              ),
            ),
          ),
        ),
        if (error != null || helper != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 12, 0),
            child: Text(
              error ?? helper!,
              style: TextStyle(
                fontSize: 12,
                color: error != null ? theme.danger : theme.inkMuted,
              ),
            ),
          ),
      ],
    );
  }
}

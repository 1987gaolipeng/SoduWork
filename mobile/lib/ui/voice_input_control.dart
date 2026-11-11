import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../core/voice_input.dart';
import '../core/voice_input_controller.dart';
import 'mobile_theme.dart';
import 'mobile_display_preferences.dart';

/// Optional draft input. The host owns insertion into its current draft and
/// sending; this widget never submits a conversation or accesses a Hub.
class VoiceInputControl extends StatefulWidget {
  final ValueChanged<String> onTranscript;
  final Object scopeKey;
  final FocusNode? inputFocus;
  final bool enabled;
  final VoiceInputEngine? engine;
  final bool compact;
  final Widget? leading;
  final double? leadingWidth;
  final Widget? trailing;
  final Widget? accessory;
  final Widget? input;

  const VoiceInputControl({
    super.key,
    required this.onTranscript,
    required this.scopeKey,
    this.inputFocus,
    this.enabled = true,
    this.engine,
    this.compact = false,
    this.leading,
    this.leadingWidth = 44,
    this.trailing,
    this.accessory,
    this.input,
  });

  @override
  State<VoiceInputControl> createState() => _VoiceInputControlState();
}

class _VoiceInputControlState extends State<VoiceInputControl>
    with WidgetsBindingObserver {
  late VoiceInputController _controller;
  final _controlFocus = FocusNode(debugLabel: 'Voice input controls');
  bool _focusCheckScheduled = false;

  @override
  void initState() {
    super.initState();
    _attachController();
    widget.inputFocus?.addListener(_focusChanged);
    WidgetsBinding.instance.addObserver(this);
  }

  void _attachController() {
    _controller = VoiceInputController(
      engine: widget.engine,
      onTranscript: (text) {
        if (mounted && widget.enabled) widget.onTranscript(text);
      },
    )..addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(VoiceInputControl oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.inputFocus != widget.inputFocus) {
      oldWidget.inputFocus?.removeListener(_focusChanged);
      widget.inputFocus?.addListener(_focusChanged);
    }
    if (oldWidget.engine != widget.engine) {
      _controller.removeListener(_changed);
      _controller.dispose();
      _attachController();
    }
    if (oldWidget.scopeKey != widget.scopeKey) {
      _controller.cancel(message: '会话或账号已切换，本次语音输入已取消。');
    } else if (!widget.enabled && _controller.isActive) {
      _controller.cancel();
    }
  }

  void _focusChanged() {
    if (widget.inputFocus?.hasFocus == false) _scheduleFocusCheck();
  }

  void _scheduleFocusCheck() {
    if (!_controller.isActive || _focusCheckScheduled) {
      return;
    }
    _focusCheckScheduled = true;
    // Moving from the draft to its own Stop/Cancel button is an internal focus
    // transition, not leaving the input. Wait until the new primary focus has
    // settled before deciding whether the microphone must be released.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _focusCheckScheduled = false;
      if (!mounted ||
          !_controller.isActive ||
          widget.inputFocus?.hasFocus == true ||
          _controlFocus.hasFocus) {
        return;
      }
      _controller.cancel(message: '输入框已离开，已取消本次语音输入。');
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed && _controller.isActive) {
      _controller.cancel(message: '页面已离开，已取消本次语音输入。');
    }
  }

  void _toggle() {
    if (!widget.enabled) return;
    if (_controller.isActive) {
      _controller.stop();
    } else {
      _controller.start();
    }
  }

  Widget _target(Widget child, {Key? key}) => SizedBox.square(
    key: key,
    dimension: 44,
    child: Center(child: child),
  );

  Widget _microphone(BuildContext context) {
    final brand = context.soduWorkTheme;
    final active = _controller.isActive;
    final stopping = _controller.status == VoiceInputStatus.stopping;
    return _target(
      IconButton(
        key: const Key('voice-input-toggle'),
        tooltip: active
            ? mobileText(context, '停止语音并转为文字')
            : mobileText(context, '语音输入'),
        onPressed: widget.enabled && !stopping ? _toggle : null,
        style: IconButton.styleFrom(
          foregroundColor: brand.inkSecondary,
          disabledForegroundColor: brand.inkMuted,
          backgroundColor: active ? brand.surfaceMuted : Colors.transparent,
          overlayColor: brand.ink.withValues(alpha: .08),
          minimumSize: const Size.square(44),
          maximumSize: const Size.square(44),
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
        icon: Icon(
          active ? CupertinoIcons.stop_circle : CupertinoIcons.mic,
          size: 22,
        ),
      ),
    );
  }

  Widget _cancel(BuildContext context) => TextButton(
    key: const Key('voice-input-cancel'),
    onPressed: () => _controller.cancel(),
    style: TextButton.styleFrom(
      foregroundColor: context.soduWorkTheme.inkSecondary,
      overlayColor: context.soduWorkTheme.ink.withValues(alpha: .08),
      minimumSize: const Size(44, 44),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      padding: const EdgeInsets.symmetric(horizontal: 10),
    ),
    child: Text(mobileText(context, '取消')),
  );

  Widget _feedback(BuildContext context) {
    final brand = context.soduWorkTheme;
    final active = _controller.isActive;
    final failed = _controller.status == VoiceInputStatus.failed;
    final waiting =
        _controller.status == VoiceInputStatus.starting ||
        _controller.status == VoiceInputStatus.stopping;
    return Container(
      key: const Key('voice-input-feedback'),
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(12, 4, 4, 8),
      decoration: BoxDecoration(
        color: brand.surfaceMuted,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (waiting)
                SizedBox.square(
                  dimension: 15,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.7,
                    color: brand.inkSecondary,
                  ),
                )
              else
                Icon(
                  failed ? CupertinoIcons.info_circle : CupertinoIcons.mic,
                  size: 17,
                  color: brand.inkSecondary,
                ),
              const SizedBox(width: 8),
              Expanded(
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    _controller.message,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: brand.inkSecondary,
                      height: 1.5,
                    ),
                  ),
                ),
              ),
              if (active)
                _cancel(context)
              else
                _target(
                  IconButton(
                    tooltip: mobileText(context, '收起语音提示'),
                    onPressed: () => _controller.cancel(message: ''),
                    style: IconButton.styleFrom(
                      foregroundColor: brand.inkMuted,
                      overlayColor: brand.ink.withValues(alpha: .08),
                      minimumSize: const Size.square(44),
                      maximumSize: const Size.square(44),
                      padding: EdgeInsets.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    icon: const Icon(CupertinoIcons.xmark, size: 18),
                  ),
                ),
            ],
          ),
          if (active && _controller.transcript.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 25, right: 8, bottom: 4),
              child: Text(
                _controller.transcript,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: brand.ink,
                  height: 1.55,
                ),
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Focus(
    focusNode: _controlFocus,
    canRequestFocus: false,
    includeSemantics: false,
    onFocusChange: (hasFocus) {
      if (!hasFocus) _scheduleFocusCheck();
    },
    child: _buildControl(context),
  );

  Widget _buildControl(BuildContext context) {
    final active = _controller.isActive;
    final failed = _controller.status == VoiceInputStatus.failed;
    if (widget.compact) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (active || failed) _feedback(context),
          Row(
            key: const Key('voice-input-toolbar'),
            children: [
              if (widget.leading != null)
                SizedBox(
                  key: const Key('voice-input-leading-target'),
                  width: widget.leadingWidth,
                  height: 44,
                  child: widget.leading!,
                ),
              if (widget.input != null)
                Expanded(child: widget.input!)
              else
                const Spacer(),
              if (widget.accessory != null) Flexible(child: widget.accessory!),
              _microphone(context),
              if (widget.trailing != null) ...[
                const SizedBox(width: 4),
                _target(
                  widget.trailing!,
                  key: const Key('voice-input-trailing-target'),
                ),
              ],
            ],
          ),
        ],
      );
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            if (widget.leading != null)
              SizedBox(
                width: widget.leadingWidth,
                height: 44,
                child: widget.leading!,
              ),
            _microphone(context),
            Expanded(
              child: Semantics(
                liveRegion: true,
                child: Text(
                  _controller.message.isEmpty
                      ? mobileText(context, '说话转文字')
                      : _controller.message,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: failed ? Theme.of(context).colorScheme.error : null,
                  ),
                ),
              ),
            ),
            if (active) _cancel(context),
            if (widget.trailing != null) _target(widget.trailing!),
          ],
        ),
        if (active && _controller.transcript.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Text(
              _controller.transcript,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
            ),
          ),
      ],
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.inputFocus?.removeListener(_focusChanged);
    _controller.removeListener(_changed);
    _controller.dispose();
    _controlFocus.dispose();
    super.dispose();
  }
}

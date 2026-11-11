import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';
import 'account_auth_widgets.dart';
import 'account_sign_in_form.dart';

/// Authentication stays on the same surface; a successful login disposes this
/// gateway with ConnectScreen, without leaving a modal above the workspace.
class AccountWelcome extends StatefulWidget {
  final MobileState state;
  const AccountWelcome({super.key, required this.state});
  @override
  State<AccountWelcome> createState() => _AccountWelcomeState();
}

class _AccountWelcomeState extends State<AccountWelcome>
    with SingleTickerProviderStateMixin {
  late final AnimationController _sheet = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 340),
    reverseDuration: const Duration(milliseconds: 260),
  );
  AccountAuthMode _mode = AccountAuthMode.password;
  bool _open = false;
  bool _present = false;
  double _drag = 0;

  void _show(AccountAuthMode mode) {
    if (_open) return;
    setState(() {
      _mode = mode;
      _open = true;
      _present = true;
    });
    if (MediaQuery.disableAnimationsOf(context)) {
      _sheet.value = 1;
    } else {
      _sheet.forward();
    }
  }

  Future<void> _close() async {
    if (!_open) return;
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() => _open = false);
    if (MediaQuery.disableAnimationsOf(context)) {
      _sheet.value = 0;
    } else {
      await _sheet.reverse();
    }
    if (mounted && !_open) setState(() => _present = false);
  }

  @override
  void dispose() {
    _sheet.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final reduced = MediaQuery.disableAnimationsOf(context);
    return PopScope(
      canPop: !_open,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _close();
      },
      child: AnimatedBuilder(
        animation: _sheet,
        builder: (context, _) {
          final progress = Curves.easeOutCubic.transform(_sheet.value);
          return Stack(
            children: [
              Positioned.fill(
                child: ExcludeSemantics(
                  excluding: _present,
                  child: IgnorePointer(
                    ignoring: _present,
                    child: Transform.scale(
                      scale: reduced ? 1 : 1 - .035 * progress,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(28 * progress),
                        child: _WelcomeScene(
                          active: !_present,
                          onSignIn: () => _show(AccountAuthMode.password),
                          onRegister: () => _show(AccountAuthMode.register),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (_present) ...[
                Positioned.fill(
                  child: GestureDetector(
                    excludeFromSemantics: true,
                    onTap: _close,
                    child: ColoredBox(
                      color: Colors.black.withValues(alpha: .12 * progress),
                    ),
                  ),
                ),
                Positioned.fill(
                  top: 12,
                  child: FractionalTranslation(
                    translation: Offset(0, 1 - progress),
                    child: IgnorePointer(
                      ignoring: !_open,
                      child: ClipRRect(
                        borderRadius: const BorderRadius.vertical(
                          top: Radius.circular(30),
                        ),
                        child: Material(
                          color: theme.surface,
                          child: Column(
                            children: [
                              GestureDetector(
                                behavior: HitTestBehavior.opaque,
                                onVerticalDragStart: (_) => _drag = 0,
                                onVerticalDragUpdate: (event) =>
                                    _drag += event.delta.dy,
                                onVerticalDragEnd: (event) {
                                  if (_drag > 42 ||
                                      (event.primaryVelocity ?? 0) > 750) {
                                    _close();
                                  }
                                },
                                child: SizedBox(
                                  height: 48,
                                  width: double.infinity,
                                  child: Stack(
                                    alignment: Alignment.center,
                                    children: [
                                      Container(
                                        width: 34,
                                        height: 4,
                                        decoration: BoxDecoration(
                                          color: theme.lineStrong,
                                          borderRadius: BorderRadius.circular(
                                            3,
                                          ),
                                        ),
                                      ),
                                      Positioned(
                                        right: 8,
                                        child: IconButton(
                                          key: const Key('close-account-form'),
                                          tooltip: authText(
                                            context,
                                            '关闭',
                                            'Close',
                                          ),
                                          onPressed: _close,
                                          icon: const Icon(
                                            Icons.close_rounded,
                                            size: 21,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                              Expanded(
                                child: AccountSignInForm(
                                  key: ValueKey(_mode),
                                  state: widget.state,
                                  initialMode: _mode,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _WelcomeScene extends StatelessWidget {
  final bool active;
  final VoidCallback onSignIn, onRegister;
  const _WelcomeScene({
    required this.active,
    required this.onSignIn,
    required this.onRegister,
  });
  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final preferences = MobileDisplayScope.maybeOf(context);
    final dark = theme.brightness == Brightness.dark;
    final panel = dark ? theme.surfaceRaised : theme.ink;
    final onPanel = SoduWorkTheme.readableOn(panel);
    return ColoredBox(
      color: theme.canvas,
      child: LayoutBuilder(
        builder: (context, constraints) => SingleChildScrollView(
          child: SizedBox(
            height: math.max(500, constraints.maxHeight),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 16, 16, 0),
                  child: Row(
                    children: [
                      const SoduWorkMark(size: 30),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          theme.brandName,
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w700,
                            color: theme.ink,
                          ),
                        ),
                      ),
                      if (preferences != null)
                        TextButton.icon(
                          onPressed: () => preferences.update(
                            language:
                                preferences.language == MobileLanguage.english
                                ? MobileLanguage.chinese
                                : MobileLanguage.english,
                          ),
                          icon: const Icon(Icons.language_rounded, size: 18),
                          label: Text(
                            preferences.language == MobileLanguage.english
                                ? '中文'
                                : 'EN',
                          ),
                        ),
                    ],
                  ),
                ),
                Expanded(
                  child: Center(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 28),
                      child: AccountWelcomeStory(active: active),
                    ),
                  ),
                ),
                Container(
                  key: const Key('welcome-actions'),
                  width: double.infinity,
                  padding: const EdgeInsets.fromLTRB(20, 26, 20, 22),
                  decoration: BoxDecoration(
                    color: panel,
                    borderRadius: const BorderRadius.vertical(
                      top: Radius.circular(32),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        authText(
                          context,
                          '让工作，更从容。',
                          'Make room for better work.',
                        ),
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: onPanel.withValues(alpha: .78),
                          fontSize: 14,
                          height: 1.5,
                        ),
                      ),
                      const SizedBox(height: 22),
                      FilledButton(
                        key: const Key('welcome-sign-in'),
                        onPressed: onSignIn,
                        style: FilledButton.styleFrom(
                          backgroundColor: dark ? theme.primary : theme.surface,
                          foregroundColor: SoduWorkTheme.readableOn(
                            dark ? theme.primary : theme.surface,
                          ),
                          minimumSize: const Size.fromHeight(52),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(17),
                          ),
                        ),
                        child: Text(authText(context, '登录', 'Sign in')),
                      ),
                      const SizedBox(height: 10),
                      OutlinedButton(
                        key: const Key('welcome-register'),
                        onPressed: onRegister,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: onPanel,
                          side: BorderSide(
                            color: onPanel.withValues(alpha: .22),
                          ),
                          minimumSize: const Size.fromHeight(52),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(17),
                          ),
                        ),
                        child: Text(
                          authText(context, '创建账号', 'Create account'),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        authText(
                          context,
                          '同一个账号，随时接续工作。',
                          'One account. Pick up where you left off.',
                        ),
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.5,
                          color: onPanel.withValues(alpha: .65),
                        ),
                      ),
                    ],
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

/// Loop the type/hold/erase sequence only while the welcome page is visible.
/// Pause behind the form or in the background; reduced motion is static.
class AccountWelcomeStory extends StatefulWidget {
  final bool active;
  const AccountWelcomeStory({super.key, this.active = true});
  @override
  State<AccountWelcomeStory> createState() => _AccountWelcomeStoryState();
}

class _AccountWelcomeStoryState extends State<AccountWelcomeStory>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final AnimationController _story = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 12000),
  );
  bool _foreground = true, _reduced = false, _ticker = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // TickerMode may be finalized after the first dependency pass in web builds.
    // Re-sync once the welcome page has entered the active frame so the loop
    // cannot remain stopped after its initial cycle.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _sync();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = MediaQuery.disableAnimationsOf(context);
    _ticker = TickerMode.valuesOf(context).enabled;
    _sync();
  }

  @override
  void didUpdateWidget(AccountWelcomeStory oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _sync();
  }

  void _sync() {
    if (_reduced || !widget.active || !_foreground || !_ticker) {
      _story.stop();
    } else if (!_story.isAnimating) {
      _story.repeat(
        min: 0,
        max: 1,
        period: const Duration(milliseconds: 12000),
      );
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _story.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final phrases = [
      authText(context, '整理想法', 'Shape your ideas'),
      authText(context, '推进工作', 'Move work forward'),
      authText(context, '交付成果', 'Deliver results'),
      authText(context, '开始吧', 'Let’s get to work'),
    ];
    return Semantics(
      label: authText(
        context,
        '整理想法，推进工作，交付成果。',
        'Shape ideas. Move work forward. Deliver results.',
      ),
      child: ExcludeSemantics(
        child: AnimatedBuilder(
          animation: _story,
          builder: (context, _) {
            final time = _reduced ? 12.0 : _story.value * 12;
            final index = math.min(3, (time / 3).floor());
            final local = time - index * 3;
            final reveal = (local / .7).clamp(0.0, 1.0);
            final visible = _reduced
                ? 1.0
                : local > 2.25
                ? ((2.85 - local) / .6).clamp(0.0, 1.0)
                : reveal;
            final characters = phrases[index].characters;
            final text = characters
                .take((characters.length * visible).round())
                .toString();
            return FittedBox(
              fit: BoxFit.scaleDown,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    text,
                    key: const Key('welcome-story-text'),
                    style: TextStyle(
                      fontSize: 31,
                      height: 1.3,
                      letterSpacing: -.8,
                      color: theme.ink,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  SizedBox(width: text.isEmpty ? 0 : 7),
                  Container(
                    key: const Key('welcome-story-dot'),
                    width: 16,
                    height: 16,
                    decoration: BoxDecoration(
                      color: theme.ink,
                      shape: BoxShape.circle,
                    ),
                  ),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

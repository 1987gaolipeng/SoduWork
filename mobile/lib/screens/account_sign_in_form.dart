import '../ui/conversation_markdown.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../core/soduwork_api.dart';
import '../sdk/soduwork_sdk_config.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_theme.dart';
import '../ui/mobile_sheet.dart';
import 'account_auth_widgets.dart';

enum AccountAuthMode { password, email, register, reset }

class AccountSignInForm extends StatefulWidget {
  final MobileState state;
  final AccountAuthMode initialMode;
  const AccountSignInForm({
    super.key,
    required this.state,
    this.initialMode = AccountAuthMode.password,
  });
  @override
  State<AccountSignInForm> createState() => _AccountSignInFormState();
}

class _AccountSignInFormState extends State<AccountSignInForm> {
  final _account = TextEditingController(), _password = TextEditingController();
  final _code = TextEditingController(),
      _confirmation = TextEditingController();
  final _passwordFocus = FocusNode();
  AccountAuthMode _mode = AccountAuthMode.password;
  ClientAuthPolicy? _policy;
  EmailAuthChallenge? _challenge;
  Timer? _clock, _deliveryTimer;
  DateTime? _retryAt;
  bool _obscure = true, _submitting = false, _sending = false;
  bool _policyLoading = true, _agreed = false;
  int _operation = 0, _policyOperation = 0;
  String _error = '', _notice = '', _delivery = '', _policyError = '';
  String? _endpointSnapshot;
  bool get _busy =>
      _submitting ||
      _sending ||
      widget.state.signingOut ||
      widget.state.phase == MobilePhase.connecting;
  bool get _emailMode => _mode != AccountAuthMode.password;
  bool get _newPassword =>
      _mode == AccountAuthMode.register || _mode == AccountAuthMode.reset;
  String get _purpose => switch (_mode) {
    AccountAuthMode.register => 'register',
    AccountAuthMode.reset => 'reset_password',
    _ => 'login',
  };
  int get _retry =>
      (_retryAt?.difference(DateTime.now()).inSeconds ?? 0).clamp(0, 86400);
  String t(String zh, String en) => authText(context, zh, en);

  @override
  void initState() {
    super.initState();
    _mode = widget.initialMode;
    unawaited(_loadPolicy());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final endpoint = widget.state.endpoint.baseUrl;
    if (_endpointSnapshot != null && _endpointSnapshot != endpoint) {
      _invalidateChallenge();
      _policyOperation++;
      _policy = null;
      _retryAt = null;
      _clock?.cancel();
      _password.clear();
      _confirmation.clear();
      _error = '';
      _notice = '';
      _policyLoading = true;
      unawaited(_loadPolicy());
    }
    _endpointSnapshot = endpoint;
  }

  void _startClock() {
    _clock?.cancel();
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (_retry == 0 && (_challenge == null || _challenge!.expired)) {
        _clock?.cancel();
      }
      setState(() {});
    });
  }

  @override
  void didUpdateWidget(AccountSignInForm oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state != widget.state) {
      _invalidateChallenge();
      _password.clear();
      _confirmation.clear();
      _account.clear();
      unawaited(_loadPolicy());
    }
  }

  @override
  void dispose() {
    _operation++;
    _policyOperation++;
    _clock?.cancel();
    _deliveryTimer?.cancel();
    _account.dispose();
    _password.dispose();
    _code.dispose();
    _confirmation.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  void _invalidateChallenge() {
    _operation++;
    _challenge = null;
    _code.clear();
    _delivery = '';
    _deliveryTimer?.cancel();
  }

  void _changeMode(AccountAuthMode mode) {
    if (_busy) return;
    setState(() {
      _invalidateChallenge();
      _mode = mode;
      _error = '';
      _notice = '';
      _password.clear();
      _confirmation.clear();
      _agreed = false;
    });
  }

  Future<void> _loadPolicy() async {
    final op = ++_policyOperation, endpoint = widget.state.endpoint.baseUrl;
    if (mounted) {
      setState(() {
        _policyLoading = true;
        _policyError = '';
      });
    }
    try {
      final value = await widget.state.authenticationPolicy();
      if (!mounted ||
          op != _policyOperation ||
          endpoint != widget.state.endpoint.baseUrl) {
        return;
      }
      setState(() => _policy = value);
    } catch (_) {
      if (!mounted ||
          op != _policyOperation ||
          endpoint != widget.state.endpoint.baseUrl) {
        return;
      }
      setState(() {
        _policy = null;
        _policyError = 'unavailable';
      });
    } finally {
      if (mounted && op == _policyOperation) {
        setState(() => _policyLoading = false);
      }
    }
  }

  String _emailAvailability() {
    if (_policyLoading) return t('正在检查邮箱登录…', 'Checking email sign-in…');
    if (_policyError.isNotEmpty) {
      return t(
        '暂时无法读取登录选项，你仍可使用账号密码。',
        'Sign-in options are unavailable. You can still use your password.',
      );
    }
    if (_policy?.supportsEmail != true) {
      return t(
        '当前服务尚未支持邮箱验证，请使用账号密码登录。',
        'This service does not support email verification yet. Use your password to sign in.',
      );
    }
    if (_policy?.mailReady != true) {
      return t(
        '邮件服务尚未启用，请联系管理员；已有账号可以使用密码登录。',
        'Email delivery is not enabled. Contact your administrator, or sign in with your password.',
      );
    }
    if (_mode == AccountAuthMode.register &&
        _policy?.allowSelfRegistration != true) {
      return t(
        '当前工作空间未开放自助注册，请联系管理员创建账号。',
        'Self-registration is closed. Ask your administrator to create an account.',
      );
    }
    if (_mode == AccountAuthMode.register && _policy?.canRegister != true) {
      return t(
        '注册协议尚未就绪，请联系管理员。',
        'Registration agreements are not available. Contact your administrator.',
      );
    }
    return '';
  }

  bool _valid(int op, String endpoint) =>
      mounted &&
      op == _operation &&
      endpoint == widget.state.endpoint.baseUrl &&
      !widget.state.signingOut;
  Future<void> _sendCode() async {
    if (_busy || _retry > 0 || _emailAvailability().isNotEmpty) return;
    if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(_account.text.trim())) {
      setState(() => _error = t('请输入有效邮箱。', 'Enter a valid email address.'));
      return;
    }
    _invalidateChallenge();
    final op = _operation, endpoint = widget.state.endpoint.baseUrl;
    setState(() {
      _sending = true;
      _error = '';
      _notice = '';
    });
    try {
      final challenge = await widget.state.requestEmailCode(
        email: _account.text.trim(),
        purpose: _purpose,
      );
      if (!_valid(op, endpoint)) return;
      setState(() {
        _challenge = challenge;
        _retryAt = challenge.retryAt;
        _delivery = challenge.deliveryState;
      });
      _startClock();
      unawaited(_pollDelivery(challenge, op, endpoint));
    } on ApiFailure catch (error) {
      if (_valid(op, endpoint)) {
        setState(() {
          _error = error.message;
          if (error.retryAfter > 0) {
            _retryAt = DateTime.now().add(Duration(seconds: error.retryAfter));
            _startClock();
          }
        });
      }
    } catch (_) {
      if (_valid(op, endpoint)) {
        setState(
          () => _error = t(
            '验证码发送未完成，请稍后重试。',
            'The code could not be sent. Try again shortly.',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _pollDelivery(
    EmailAuthChallenge challenge,
    int op,
    String endpoint,
  ) async {
    try {
      final result = await widget.state.emailCodeDelivery(challenge);
      if (!_valid(op, endpoint) || _challenge != challenge) return;
      setState(() => _delivery = result.state);
      if (result.pending && !challenge.expired) {
        _deliveryTimer = Timer(
          const Duration(seconds: 2),
          () => unawaited(_pollDelivery(challenge, op, endpoint)),
        );
      }
    } catch (_) {
      if (_valid(op, endpoint)) setState(() => _delivery = 'unknown');
    }
  }

  Future<void> _submit() async {
    if (_busy) return;
    if (_account.text.trim().isEmpty ||
        (!_emailMode && _password.text.isEmpty)) {
      setState(
        () => _error = t('请输入账号和密码。', 'Enter your account and password.'),
      );
      return;
    }
    if (_emailMode &&
        (_emailAvailability().isNotEmpty ||
            _challenge == null ||
            _challenge!.expired ||
            _challenge!.email.toLowerCase() !=
                _account.text.trim().toLowerCase() ||
            _challenge!.purpose != _purpose ||
            _code.text.trim().length != 6)) {
      setState(
        () => _error = t(
          '请获取并输入有效的 6 位验证码。',
          'Request and enter a valid 6-digit code.',
        ),
      );
      return;
    }
    if (_newPassword &&
        (_password.text.length < (_policy?.passwordMinLength ?? 8) ||
            _password.text != _confirmation.text)) {
      setState(
        () => _error = t(
          '密码长度不符合要求，或两次密码不一致。',
          'The password is too short, or the two passwords do not match.',
        ),
      );
      return;
    }
    if (_mode == AccountAuthMode.register &&
        (!_agreed || _policy?.canRegister != true)) {
      setState(
        () => _error = t(
          '请阅读并同意用户协议与隐私政策。',
          'Read and accept the Terms and Privacy Policy.',
        ),
      );
      return;
    }
    final op = _operation, endpoint = widget.state.endpoint.baseUrl;
    setState(() {
      _submitting = true;
      _error = '';
      _notice = '';
    });
    try {
      switch (_mode) {
        case AccountAuthMode.password:
          if (_account.text.contains('@') && _policy?.supportsEmail == true) {
            await widget.state.loginWithEmailPassword(
              email: _account.text.trim(),
              password: _password.text,
            );
          } else {
            await widget.state.loginWithAccount(
              account: _account.text.trim(),
              password: _password.text,
            );
          }
        case AccountAuthMode.email:
          await widget.state.loginWithEmailCode(
            challenge: _challenge!,
            code: _code.text.trim(),
          );
        case AccountAuthMode.register:
          await widget.state.registerWithEmail(
            challenge: _challenge!,
            code: _code.text.trim(),
            password: _password.text,
            consents: Map<String, String>.from(
              _policy!.requiredConsentVersions,
            ),
          );
        case AccountAuthMode.reset:
          await widget.state.resetPasswordWithEmail(
            challenge: _challenge!,
            code: _code.text.trim(),
            newPassword: _password.text,
          );
          if (_valid(op, endpoint)) {
            setState(() {
              _invalidateChallenge();
              _mode = AccountAuthMode.password;
              _notice = t(
                '密码已更新，请使用新密码登录。',
                'Password updated. Sign in with your new password.',
              );
            });
          }
      }
      if (!mounted || endpoint != widget.state.endpoint.baseUrl) return;
      _password.clear();
      _confirmation.clear();
      _code.clear();
      TextInput.finishAutofillContext(shouldSave: false);
    } on ApiFailure catch (failure) {
      if (_valid(op, endpoint)) setState(() => _error = failure.message);
    } catch (_) {
      if (_valid(op, endpoint)) {
        setState(
          () => _error = t(
            '登录暂时没有完成，请检查网络后重试。',
            'Sign-in did not complete. Check your connection and try again.',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _legal(Map<String, dynamic> document) => showMobileSheet<void>(
    context,
    title: document['key'] == 'terms'
        ? t('用户协议', 'Terms of Use')
        : t('隐私政策', 'Privacy Policy'),
    builder: (_, scroll) => ListView(
      controller: scroll,
      padding: const EdgeInsets.all(24),
      children: [
        Text(
          document['title'] as String? ?? '',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 8),
        Text(document['version'] as String? ?? ''),
        const SizedBox(height: 20),
        ConversationMarkdown(data: document['content'] as String? ?? ''),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme, state = widget.state;
    final error = _error.isNotEmpty ? _error : state.blockingError;
    final local =
        state.api.isLocalDevelopment ||
        SoduWorkSdkScope.maybeOf(context)?.serviceDisplayName == '本机独立测试';
    final unavailable = _emailAvailability();
    final title = switch (_mode) {
      AccountAuthMode.register => t('创建你的账号', 'Create your account'),
      AccountAuthMode.reset => t('找回密码', 'Reset your password'),
      _ => t('登录 ${theme.brandName}', 'Sign in to ${theme.brandName}'),
    };
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          24,
          20,
          24,
          24 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: AutofillGroup(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AccountAuthHeader(
                    title: title,
                    subtitle: _newPassword
                        ? (_mode == AccountAuthMode.register
                              ? t(
                                  '从这里开始，让想法成为成果。',
                                  'A place to turn your ideas into results.',
                                )
                              : t(
                                  '验证邮箱后，为账号设置新密码。',
                                  'Verify your email to set a new password.',
                                ))
                        : t('让工作，更从容。', 'Make room for better work.'),
                  ),
                  if (local) ...[
                    const SizedBox(height: 20),
                    Container(
                      key: const Key('auth-local-environment'),
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: theme.surfaceMuted,
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            t('本机测试账号', 'Local test account'),
                            style: TextStyle(
                              color: theme.ink,
                              fontWeight: FontWeight.w600,
                              fontSize: 13,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            t(
                              '业务数据保存在提供此页面的电脑，不与线上账号数据同步。模型请求按所选服务处理。',
                              'Business data stays on the computer serving this page and does not sync with your online account. Model requests use the selected service.',
                            ),
                            style: TextStyle(
                              color: theme.inkSecondary,
                              fontSize: 12,
                              height: 1.5,
                            ),
                          ),
                          if (_policy?.supportsEmail == false &&
                              _policy?.allowSelfRegistration == true) ...[
                            const SizedBox(height: 6),
                            Text(
                              t(
                                '此测试服务首次登录时可能创建同名本机账号，不代表已验证线上身份。',
                                'The first sign-in may create a local account with that name; it does not verify your online identity.',
                              ),
                              style: TextStyle(
                                color: theme.inkSecondary,
                                fontSize: 12,
                                height: 1.5,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 28),
                  if (!_newPassword)
                    Container(
                      padding: const EdgeInsets.all(4),
                      decoration: BoxDecoration(
                        color: theme.surfaceMuted,
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: Row(
                        children: [
                          for (final mode in [
                            AccountAuthMode.password,
                            AccountAuthMode.email,
                          ])
                            Expanded(
                              child: TextButton(
                                onPressed: _busy
                                    ? null
                                    : () => _changeMode(mode),
                                style: TextButton.styleFrom(
                                  minimumSize: const Size(0, 44),
                                  backgroundColor: _mode == mode
                                      ? theme.surface
                                      : Colors.transparent,
                                  foregroundColor: _mode == mode
                                      ? theme.primary
                                      : theme.inkSecondary,
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(12),
                                  ),
                                ),
                                child: Text(
                                  mode == AccountAuthMode.password
                                      ? t('密码登录', 'Password')
                                      : t('验证码登录', 'Email code'),
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  const SizedBox(height: 22),
                  TextField(
                    key: const Key('auth-account'),
                    controller: _account,
                    enabled: !_busy,
                    keyboardType: _emailMode
                        ? TextInputType.emailAddress
                        : TextInputType.text,
                    autofillHints: [
                      _emailMode ? AutofillHints.email : AutofillHints.username,
                    ],
                    autocorrect: false,
                    enableSuggestions: false,
                    textInputAction: TextInputAction.next,
                    onChanged: (_) {
                      if (_challenge != null) setState(_invalidateChallenge);
                    },
                    onSubmitted: (_) {
                      if (!_emailMode || _newPassword) {
                        _passwordFocus.requestFocus();
                      }
                    },
                    decoration: InputDecoration(
                      labelText: _emailMode
                          ? t('邮箱', 'Email')
                          : t('账号', 'Account'),
                      hintText: _emailMode
                          ? 'name@example.com'
                          : t('账号或邮箱', 'Account or email'),
                    ),
                  ),
                  if (_emailMode) ...[
                    const SizedBox(height: 16),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: TextField(
                            key: const Key('auth-code'),
                            controller: _code,
                            enabled: !_busy,
                            keyboardType: TextInputType.number,
                            autofillHints: const [AutofillHints.oneTimeCode],
                            inputFormatters: [
                              FilteringTextInputFormatter.digitsOnly,
                              LengthLimitingTextInputFormatter(6),
                            ],
                            onSubmitted: (_) {
                              if (!_newPassword) _submit();
                            },
                            decoration: InputDecoration(
                              labelText: t('验证码', 'Code'),
                              hintText: t('6 位验证码', '6-digit code'),
                            ),
                          ),
                        ),
                        const SizedBox(width: 10),
                        SizedBox(
                          height: 54,
                          child: OutlinedButton(
                            onPressed:
                                _busy || _retry > 0 || unavailable.isNotEmpty
                                ? null
                                : _sendCode,
                            child: Text(
                              _sending
                                  ? t('发送中…', 'Sending…')
                                  : _retry > 0
                                  ? '${_retry}s'
                                  : t('获取验证码', 'Send code'),
                            ),
                          ),
                        ),
                      ],
                    ),
                    if (_challenge != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: Text(
                          _challenge!.expired
                              ? t(
                                  '验证码已过期，请重新获取。',
                                  'Code expired. Request a new one.',
                                )
                              : _delivery == 'sent'
                              ? t(
                                  '验证码已发送，请检查邮箱。',
                                  'Code sent. Check your inbox.',
                                )
                              : const {'failed', 'expired'}.contains(_delivery)
                              ? t(
                                  '邮件未能送达，请稍后重试或联系管理员。',
                                  'Email delivery failed. Try again or contact your administrator.',
                                )
                              : _delivery == 'unknown'
                              ? t(
                                  '邮件状态暂未确认，请检查邮箱或稍后重试。',
                                  'Delivery is unconfirmed. Check your inbox or try again.',
                                )
                              : t('邮件正在发送，请稍候…', 'Your code is on its way…'),
                          style: TextStyle(
                            fontSize: 13,
                            color: theme.inkSecondary,
                          ),
                        ),
                      ),
                  ],
                  if (!_emailMode || _newPassword) ...[
                    const SizedBox(height: 16),
                    TextField(
                      key: const Key('auth-password'),
                      controller: _password,
                      focusNode: _passwordFocus,
                      enabled: !_busy,
                      obscureText: _obscure,
                      autocorrect: false,
                      enableSuggestions: false,
                      autofillHints: [
                        _newPassword
                            ? AutofillHints.newPassword
                            : AutofillHints.password,
                      ],
                      textInputAction: _newPassword
                          ? TextInputAction.next
                          : TextInputAction.done,
                      onSubmitted: (_) {
                        if (!_newPassword) _submit();
                      },
                      decoration: InputDecoration(
                        labelText: _newPassword
                            ? t('新密码', 'New password')
                            : t('密码', 'Password'),
                        helperText: _newPassword
                            ? t(
                                '至少 ${_policy?.passwordMinLength ?? 8} 位',
                                'At least ${_policy?.passwordMinLength ?? 8} characters',
                              )
                            : null,
                        suffixIcon: IconButton(
                          tooltip: _obscure
                              ? t('显示密码', 'Show password')
                              : t('隐藏密码', 'Hide password'),
                          onPressed: _busy
                              ? null
                              : () => setState(() => _obscure = !_obscure),
                          icon: Icon(
                            _obscure
                                ? Icons.visibility_off_outlined
                                : Icons.visibility_outlined,
                            size: 20,
                          ),
                        ),
                      ),
                    ),
                    if (_newPassword) ...[
                      const SizedBox(height: 16),
                      TextField(
                        key: const Key('auth-confirm-password'),
                        controller: _confirmation,
                        enabled: !_busy,
                        obscureText: _obscure,
                        autocorrect: false,
                        enableSuggestions: false,
                        onSubmitted: (_) => _submit(),
                        decoration: InputDecoration(
                          labelText: t('确认密码', 'Confirm password'),
                        ),
                      ),
                    ],
                  ],
                  if (_mode == AccountAuthMode.register)
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      controlAffinity: ListTileControlAffinity.leading,
                      value: _agreed,
                      onChanged: _busy
                          ? null
                          : (value) => setState(() => _agreed = value ?? false),
                      title: Text(
                        t(
                          '我已阅读并同意用户协议与隐私政策',
                          'I accept the Terms of Use and Privacy Policy',
                        ),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  if (_emailMode && unavailable.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    AccountAuthNotice(
                      message: unavailable,
                      onRetry: _policyLoading || _busy ? null : _loadPolicy,
                    ),
                  ],
                  if (error.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    AccountAuthNotice(message: error, error: true),
                  ],
                  if (_notice.isNotEmpty || state.signOutNotice.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    AccountAuthNotice(
                      message: _notice.isNotEmpty
                          ? _notice
                          : state.signOutNotice,
                    ),
                  ],
                  const SizedBox(height: 22),
                  FilledButton(
                    key: const Key('auth-submit'),
                    onPressed: _busy || _emailMode && unavailable.isNotEmpty
                        ? null
                        : _submit,
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(54),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(18),
                      ),
                    ),
                    child: _busy
                        ? Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              ),
                              const SizedBox(width: 10),
                              Text(
                                state.signingOut
                                    ? t('正在安全退出…', 'Signing out…')
                                    : _sending
                                    ? t('正在发送…', 'Sending…')
                                    : _mode == AccountAuthMode.register
                                    ? t('正在创建…', 'Creating…')
                                    : _mode == AccountAuthMode.reset
                                    ? t('正在更新…', 'Updating…')
                                    : t('正在登录…', 'Signing in…'),
                              ),
                            ],
                          )
                        : Text(switch (_mode) {
                            AccountAuthMode.register => t(
                              '创建账号',
                              'Create account',
                            ),
                            AccountAuthMode.reset => t(
                              '更新密码',
                              'Update password',
                            ),
                            _ => t('登录并继续', 'Sign in'),
                          }),
                  ),
                  const SizedBox(height: 10),
                  if (_newPassword)
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => _changeMode(AccountAuthMode.password),
                      child: Text(t('返回登录', 'Back to sign in')),
                    )
                  else
                    Wrap(
                      alignment: WrapAlignment.spaceBetween,
                      children: [
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => _changeMode(AccountAuthMode.register),
                          child: Text(t('创建账号', 'Create account')),
                        ),
                        TextButton(
                          onPressed: _busy
                              ? null
                              : () => _changeMode(AccountAuthMode.reset),
                          child: Text(t('忘记密码', 'Forgot password?')),
                        ),
                      ],
                    ),
                  AccountAuthFooter(
                    state: state,
                    policy: _policy,
                    busy: _busy,
                    local: local,
                    onLegal: _legal,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

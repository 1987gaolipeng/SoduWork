import '../ui/mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../core/device_store.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_theme.dart';
import '../ui/work_widgets.dart';
import 'account_welcome.dart';

class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key});

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  SoduWorkEnvironment _environment = SoduWorkEnvironment.production;
  late final TextEditingController _developmentUrl;
  bool _initialized = false;
  bool _submitting = false;
  String _formError = '';

  @override
  void initState() {
    super.initState();
    _developmentUrl = TextEditingController();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_initialized) return;
    final state = MobileScope.of(context);
    _environment = EndpointSettings.productionUrl.trim().isEmpty
        ? SoduWorkEnvironment.development
        : state.endpoint.environment;
    if (_environment == SoduWorkEnvironment.development) {
      _developmentUrl.text = state.endpoint.baseUrl;
    }
    _initialized = true;
  }

  @override
  void dispose() {
    _developmentUrl.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() {
      _submitting = true;
      _formError = '';
    });
    final state = MobileScope.read(context);
    final navigator = Navigator.of(context);
    try {
      if (state.endpointLocked) {
        await state.connect();
      } else {
        await state.setEndpoint(
          environment: _environment,
          developmentUrl: _developmentUrl.text,
        );
      }
      if (mounted && state.phase == MobilePhase.ready && navigator.canPop()) {
        navigator.pop();
      }
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _formError = error.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final explicitState = MobileScope.of(context);
    if (explicitState.endpointLocked &&
        explicitState.phase != MobilePhase.ready) {
      return Scaffold(
        body: SafeArea(child: AccountWelcome(state: explicitState)),
      );
    }
    final state = MobileScope.of(context);
    final pending =
        state.phase == MobilePhase.pendingActivation ||
        (state.phase == MobilePhase.connecting &&
            (state.enrollment != null || state.authenticatingAccount));
    final connecting = state.phase == MobilePhase.connecting;
    return Scaffold(
      body: SafeArea(
        child: pending
            ? AccountWelcome(state: state)
            : ListView(
                padding: const EdgeInsets.fromLTRB(24, 28, 24, 32),
                children: [
                  Row(
                    children: [
                      SoduWorkMark(size: 44),
                      SizedBox(width: 12),
                      Text(
                        context.soduWorkTheme.brandName,
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.2,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 46),
                  Text(
                    mobileText(context, '连接到你的企业'),
                    style: Theme.of(context).textTheme.headlineLarge,
                  ),
                  const SizedBox(height: 10),
                  Text(
                    mobileText(context, '在手机上处理任务、查看 AI 进度，并随时掌握团队工作。'),
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                  const SizedBox(height: 28),
                  const _Benefit(
                    icon: Icons.checklist_rounded,
                    title: '工作随身可见',
                    message: '任务状态、执行进度和交付结果保持一致。',
                  ),
                  const _Benefit(
                    icon: Icons.verified_user_outlined,
                    title: '关键决定不遗漏',
                    message: '集中查看待确认事项，在手机上完成审批。',
                  ),
                  const _Benefit(
                    icon: Icons.security_outlined,
                    title: '企业级安全连接',
                    message: '通过企业账号或管理员激活连接，数据来自当前环境。',
                  ),
                  const SizedBox(height: 24),
                  if ((_formError.isNotEmpty ||
                      state.blockingError.isNotEmpty)) ...[
                    Container(
                      padding: const EdgeInsets.all(13),
                      decoration: BoxDecoration(
                        color: context.soduWorkTheme.primarySoft,
                        borderRadius: BorderRadius.circular(
                          (context.soduWorkTheme.radiusMedium - 2)
                              .clamp(0, 32)
                              .toDouble(),
                        ),
                      ),
                      child: Text(
                        _formError.isNotEmpty
                            ? _formError
                            : state.blockingError,
                        style: TextStyle(
                          color: context.soduWorkTheme.primary,
                          fontSize: 13,
                          height: 1.45,
                        ),
                      ),
                    ),
                    const SizedBox(height: 14),
                  ],
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: connecting || _submitting ? null : _connect,
                      child: Text(
                        connecting || _submitting
                            ? mobileText(context, '正在安全连接…')
                            : mobileText(
                                context,
                                '连接企业 {0}',
                                values: [context.soduWorkTheme.brandName],
                              ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (!state.endpointLocked)
                    ExpansionTile(
                      initiallyExpanded: state.endpoint.baseUrl.isEmpty,
                      tilePadding: EdgeInsets.zero,
                      childrenPadding: const EdgeInsets.only(bottom: 12),
                      title: Text(
                        mobileText(context, '连接选项'),
                        style: TextStyle(
                          color: context.soduWorkTheme.inkSecondary,
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      children: [
                        if (EndpointSettings.productionUrl.trim().isNotEmpty)
                          SizedBox(
                            width: double.infinity,
                            child: SegmentedButton<SoduWorkEnvironment>(
                              showSelectedIcon: true,
                              segments: [
                                ButtonSegment(
                                  value: SoduWorkEnvironment.production,
                                  label: Text(mobileText(context, '生产')),
                                ),
                                ButtonSegment(
                                  value: SoduWorkEnvironment.development,
                                  label: Text(mobileText(context, '开发')),
                                ),
                              ],
                              selected: {_environment},
                              onSelectionChanged: (value) {
                                setState(() => _environment = value.first);
                              },
                            ),
                          ),
                        const SizedBox(height: 12),
                        if (_environment == SoduWorkEnvironment.production)
                          Row(
                            children: [
                              Icon(
                                Icons.lock_outline_rounded,
                                size: 17,
                                color: context.soduWorkTheme.inkMuted,
                              ),
                              SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  mobileText(context, '生产服务地址由企业统一配置，员工无需填写。'),
                                  style: TextStyle(
                                    color: context.soduWorkTheme.inkMuted,
                                    fontSize: 12.5,
                                  ),
                                ),
                              ),
                            ],
                          )
                        else
                          TextField(
                            controller: _developmentUrl,
                            keyboardType: TextInputType.url,
                            autocorrect: false,
                            decoration: InputDecoration(
                              labelText: mobileText(context, '服务地址'),
                              hintText: 'https://work.example.com',
                              prefixIcon: Icon(Icons.link_rounded),
                            ),
                          ),
                      ],
                    ),
                  const SizedBox(height: 18),
                  Text(
                    mobileText(
                      context,
                      '继续即表示该设备将向企业 {0} 发起安全登记。',
                      values: [context.soduWorkTheme.brandName],
                    ),
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: context.soduWorkTheme.inkMuted,
                      fontSize: 11.5,
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

class _Benefit extends StatelessWidget {
  final IconData icon;
  final String title;
  final String message;

  const _Benefit({
    required this.icon,
    required this.title,
    required this.message,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 15),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: context.soduWorkTheme.surfaceMuted,
              borderRadius: BorderRadius.circular(
                (context.soduWorkTheme.radiusMedium - 2)
                    .clamp(0, 32)
                    .toDouble(),
              ),
            ),
            child: Icon(
              icon,
              size: 19,
              color: context.soduWorkTheme.inkSecondary,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  mobileText(context, title),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 2),
                Text(
                  mobileText(context, message),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

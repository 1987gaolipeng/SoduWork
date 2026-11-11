import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_sheet.dart';
import 'package:flutter/material.dart';

import '../core/model_probe.dart';
import '../sdk/soduwork_sdk_config.dart';
import '../ui/cloud_environment_card.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/work_widgets.dart';

enum AiResourceSection { all, models, cloud }

class AiResourcesScreen extends StatefulWidget {
  final AiResourceSection section;
  const AiResourcesScreen({super.key, this.section = AiResourceSection.all});

  @override
  State<AiResourcesScreen> createState() => _AiResourcesScreenState();
}

class _AiResourcesScreenState extends State<AiResourcesScreen> {
  MobileState? _state;
  int _identity = -1;
  int _request = 0;
  bool _loading = true;
  bool _testing = false;
  List<Map<String, dynamic>> _models = const [];
  List<Map<String, dynamic>> _environments = const [];
  String _selected = '';
  String _modelError = '';
  String _environmentError = '';
  String _probeError = '';
  ModelProbeResult? _result;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_state != state || _identity != state.identityRevision) {
      _state = state;
      _identity = state.identityRevision;
      _request++;
      _models = const [];
      _environments = const [];
      _selected = '';
      _modelError = _environmentError = _probeError = '';
      _result = null;
      _loading = true;
      _testing = false;
      _load();
    }
  }

  bool _current(MobileState state, int identity) =>
      mounted && _state == state && state.identityRevision == identity;

  Future<void> _load() async {
    final state = _state!;
    final identity = _identity;
    final request = ++_request;
    // Catalog and environment failures are independent, preserving the useful
    // half of the page during partial outages.
    Future<void> models() async {
      try {
        final data = await state.api.modelResourceCatalog();
        if (!_current(state, identity) || request != _request) return;
        final rows = _rows(data['modelOptions']);
        final seen = <String>{};
        final options = rows
            .where(
              (row) =>
                  _text(row['name']).isNotEmpty && seen.add(_text(row['name'])),
            )
            .toList();
        for (final name in [data['defaultModel'], ..._list(data['models'])]) {
          if (_text(name).isNotEmpty && seen.add(_text(name))) {
            options.add({'name': _text(name), 'label': _text(name)});
          }
        }
        setState(() {
          _models = options;
          _modelError = '';
          if (_selected.isEmpty && options.isNotEmpty) {
            final preferred = _text(data['defaultModel']);
            _selected = seen.contains(preferred)
                ? preferred
                : _text(options.first['name']);
          }
        });
      } on ApiFailure catch (error) {
        if (_current(state, identity) && request == _request) {
          setState(() => _modelError = error.message);
        }
      }
    }

    Future<void> environments() async {
      try {
        final data = await state.api.cloudEnvironments();
        if (!_current(state, identity) || request != _request) return;
        setState(() {
          _environments = _rows(data['environments']);
          _environmentError = '';
        });
      } on ApiFailure catch (error) {
        if (_current(state, identity) && request == _request) {
          setState(
            () =>
                _environmentError = const [404, 405, 501].contains(error.status)
                ? '当前服务尚未提供云环境目录，请联系管理员核对服务版本。模型列表可正常读取不代表云执行已就绪。'
                : error.message,
          );
        }
      }
    }

    await Future.wait([
      if (widget.section != AiResourceSection.cloud) models(),
      if (widget.section != AiResourceSection.models) environments(),
    ]);
    if (_current(state, identity) && request == _request) {
      setState(() => _loading = false);
    }
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    await _load();
  }

  Future<void> _testModel() async {
    if (_testing || _loading) return;
    final state = _state!;
    final identity = _identity;
    setState(() {
      _testing = true;
      _probeError = '';
      _result = null;
    });
    try {
      final result = await ModelProbe(
        state.api,
      ).run(_selected, isCurrent: () => _current(state, identity));
      if (_current(state, identity)) setState(() => _result = result);
    } on ApiFailure catch (error) {
      if (_current(state, identity)) {
        setState(() => _probeError = error.message);
      }
    } finally {
      if (_current(state, identity)) setState(() => _testing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final valid = _models.any((row) => _text(row['name']) == _selected);
    return Scaffold(
      appBar: MobileSheetScope.maybeOf(context) != null
          ? null
          : AppBar(
              title: Text(switch (widget.section) {
                AiResourceSection.models => '我的模型',
                AiResourceSection.cloud => '云端环境',
                AiResourceSection.all => '模型与执行环境',
              }),
              actions: [
                IconButton(
                  tooltip: mobileText(context, '刷新资源'),
                  onPressed: _loading || _testing ? null : _refresh,
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
      body: RefreshIndicator(
        onRefresh: _testing ? () async {} : _refresh,
        child: ListView(
          controller: MobileSheetScope.maybeOf(context)?.scrollController,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
          children: [
            if (widget.section != AiResourceSection.cloud) ...[
              Text(
                mobileText(context, '我的模型'),
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 6),
              Text(
                mobileText(
                  context,
                  '使用当前账号已授权的模型。手机任务由云端环境执行，模型与底座以该环境的实际能力为准。',
                ),
              ),
              if (_loading) ...[
                const SizedBox(height: 16),
                const LinearProgressIndicator(),
              ],
              const SizedBox(height: 16),
              if (_modelError.isNotEmpty) _message(_modelError, error: true),
              if (!_loading && _models.isEmpty && _modelError.isEmpty)
                _message('当前账号还没有可用模型。请联系团队管理员分配企业模型，或在电脑端配置个人模型。'),
              if (_selected.isNotEmpty && !valid && !_loading)
                _message('之前选择的模型已不可用，请重新选择。', error: true),
              for (final model in _models)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: WorkSurface(
                    padding: EdgeInsets.zero,
                    child: ListTile(
                      leading: Icon(
                        _selected == _text(model['name'])
                            ? Icons.radio_button_checked
                            : Icons.radio_button_off,
                      ),
                      title: Text(
                        _text(model['label']).isEmpty
                            ? _text(model['name'])
                            : _text(model['label']),
                      ),
                      subtitle: Text(
                        [_text(model['name']), _text(model['providerName'])]
                            .where((value) => value.isNotEmpty)
                            .toSet()
                            .join(' · '),
                      ),
                      selected: _selected == _text(model['name']),
                      enabled: !_testing && !_loading,
                      onTap: () => setState(() {
                        _selected = _text(model['name']);
                        _probeError = '';
                        _result = null;
                      }),
                    ),
                  ),
                ),
              if (_models.isNotEmpty) ...[
                const SizedBox(height: 4),
                FilledButton.icon(
                  onPressed: valid && !_loading && !_testing
                      ? _testModel
                      : null,
                  icon: _testing
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.network_check_rounded),
                  label: Text(
                    _testing
                        ? mobileText(context, '正在检查…')
                        : mobileText(context, '测试所选模型连接'),
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  mobileText(context, '点击后发送一条简短测试消息，可能产生少量模型用量。不会执行电脑操作。'),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              if (_probeError.isNotEmpty) _message(_probeError, error: true),
              if (_result != null)
                _message(
                  '连接正常 · ${(_result!.elapsed.inMilliseconds / 1000).toStringAsFixed(1)} 秒\n已收到模型回复。完整工作执行还需可用执行环境。',
                ),
            ],
            if (widget.section != AiResourceSection.models) ...[
              if (_loading && widget.section == AiResourceSection.cloud)
                const LinearProgressIndicator(),
              const SizedBox(height: 16),
              Text(
                mobileText(context, '云端环境'),
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 6),
              Text(mobileText(context, '这里显示归属于当前账号的云端电脑。用于运行工具、处理工程和持续完成工作。')),
              const SizedBox(height: 12),
              WorkSurface(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _connectionLabel(context),
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      mobileText(
                        context,
                        _state!.api.isLocalDevelopment
                            ? '当前使用本机独立测试服务，账号和工作记录不与正式环境同步。'
                            : '使用与 PC 相同服务、相同账号下的专属云环境。工作在该环境执行，不会自动使用 PC 本机项目和软件。',
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 14),
              if (_environmentError.isNotEmpty)
                _message(_environmentError, error: true),
              if (!_loading &&
                  _environments.isEmpty &&
                  _environmentError.isEmpty)
                _message('尚无可用云端环境。请在 PC「云端环境」接入独立运行的服务器并检查底座就绪状态；可联系管理员提供环境。'),
              for (final environment in _environments)
                CloudEnvironmentCard(environment: environment),
            ],
            if (_modelError.isNotEmpty || _environmentError.isNotEmpty)
              TextButton.icon(
                onPressed: _loading || _testing ? null : _refresh,
                icon: const Icon(Icons.refresh),
                label: Text(mobileText(context, '重新加载')),
              ),
          ],
        ),
      ),
    );
  }

  String _connectionLabel(BuildContext context) {
    final display =
        SoduWorkSdkScope.maybeOf(context)?.serviceDisplayName.trim() ?? '';
    final uri = Uri.tryParse(_state!.api.baseUrl);
    final host = uri?.host ?? '';
    return mobileText(
      context,
      '连接服务：{0}',
      values: [
        display.isNotEmpty
            ? display
            : host.isEmpty
            ? '未配置'
            : host,
      ],
    );
  }

  Widget _message(String text, {bool error = false}) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Text(
      text,
      style: TextStyle(
        color: error ? Theme.of(context).colorScheme.error : null,
      ),
    ),
  );
}

String _text(dynamic value) => value is String ? value.trim() : '';
List<dynamic> _list(dynamic value) => value is List ? value : const [];
List<Map<String, dynamic>> _rows(dynamic value) => _list(value)
    .whereType<Map>()
    .map((row) => row.map((key, value) => MapEntry(key.toString(), value)))
    .toList();

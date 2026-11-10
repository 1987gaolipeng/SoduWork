import 'package:flutter/material.dart';

import '../core/plugin_publication.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_theme.dart';

/// Refreshes the exact submitted version without installing or publishing it.
class PluginSubmissionScreen extends StatefulWidget {
  final Map<String, dynamic> item;
  const PluginSubmissionScreen({super.key, required this.item});
  @override
  State<PluginSubmissionScreen> createState() => _PluginSubmissionScreenState();
}

class _PluginSubmissionScreenState extends State<PluginSubmissionScreen> {
  MobileState? _owner;
  int? _identity;
  int _generation = 0;
  Map<String, dynamic>? _row;
  bool _loading = false;
  String _error = '';

  bool get _current =>
      mounted &&
      identical(_owner, MobileScope.read(context)) &&
      _identity == _owner!.identityRevision;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    if (_owner == null) {
      _owner = state;
      _identity = state.identityRevision;
      _row = Map<String, dynamic>.from(widget.item);
      _refresh();
    }
  }

  Future<void> _refresh() async {
    if (!_current) return;
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final result = await _owner!.api.pluginCatalog();
      if (!_current || generation != _generation) return;
      final id = widget.item['pluginId']?.toString() ?? '';
      final version = widget.item['versionId']?.toString() ?? '';
      final rows = result['submissions'];
      Map<String, dynamic>? match;
      if (id.isNotEmpty && rows is List) {
        for (final candidate in rows.whereType<Map>()) {
          if (candidate['pluginId']?.toString() == id &&
              (version.isNotEmpty
                  ? candidate['versionId']?.toString() == version
                  : candidate['version'] == widget.item['version'])) {
            match = Map<String, dynamic>.from(candidate);
            break;
          }
        }
      }
      setState(() {
        _row = match;
        if (match == null) _error = '当前提交版本已不在可见目录中，请返回“我的提交”查看最新记录。';
      });
    } catch (error) {
      if (!_current || generation != _generation) return;
      setState(() {
        _error = error is ApiFailure ? error.message : '审核状态未能刷新，请重试。';
        if (error is ApiFailure && {401, 403, 404}.contains(error.status)) {
          _row = null;
        }
      });
    } finally {
      if (_current && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  Widget _section(String title, Widget child) => Card(
    elevation: 0,
    color: context.soduWorkTheme.surface,
    margin: const EdgeInsets.only(bottom: 12),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(18),
      side: BorderSide(color: context.soduWorkTheme.line),
    ),
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 10),
          child,
        ],
      ),
    ),
  );

  String _reviewTime(dynamic value) {
    final milliseconds = num.tryParse('$value');
    final date =
        milliseconds != null &&
            milliseconds > 0 &&
            milliseconds < 8640000000000000
        ? DateTime.fromMillisecondsSinceEpoch(milliseconds.toInt()).toLocal()
        : value is String
        ? DateTime.tryParse(value)?.toLocal()
        : null;
    if (date == null) return '等待管理员处理';
    String two(int n) => n.toString().padLeft(2, '0');
    return '${date.year}-${two(date.month)}-${two(date.day)} ${two(date.hour)}:${two(date.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    final valid = _current;
    final publication = valid && _row != null ? PluginPublication(_row!) : null;
    return Scaffold(
      appBar: AppBar(
        title: const Text('企业发布进度'),
        actions: [
          IconButton(
            tooltip: '刷新审核状态',
            onPressed: valid && !_loading ? _refresh : null,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: !valid
          ? const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text('账号或连接已变更，请返回列表重新打开提交记录。'),
              ),
            )
          : RefreshIndicator(
              onRefresh: _refresh,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16),
                children: [
                  if (_loading) const LinearProgressIndicator(),
                  if (_error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(_error),
                          if (_row != null) const Text('以下为上次读取的状态。'),
                          TextButton(
                            onPressed: _loading ? null : _refresh,
                            child: const Text('重新加载'),
                          ),
                        ],
                      ),
                    ),
                  if (publication != null) ...[
                    Text(
                      publication.text('name'),
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'v${publication.text('version')} · ${publication.status}',
                    ),
                    const SizedBox(height: 8),
                    Text(
                      '申请使用范围：${publication.audience}',
                      style: TextStyle(color: context.soduWorkTheme.inkSecondary),
                    ),
                    const SizedBox(height: 16),
                    _section(
                      '当前节点',
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            publication.current.label,
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                          const SizedBox(height: 6),
                          Text(publication.current.detail),
                        ],
                      ),
                    ),
                    _section(
                      '发布阶段',
                      Column(
                        children: [
                          for (final step in publication.steps)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 8),
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Icon(
                                    step.state == 'done'
                                        ? Icons.check_circle_outline
                                        : step.state == 'bad' ||
                                              step.state == 'warn'
                                        ? Icons.info_outline
                                        : Icons.schedule,
                                    color: step.state == 'bad'
                                        ? Theme.of(context).colorScheme.error
                                        : context.soduWorkTheme.inkSecondary,
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          step.label,
                                          style: Theme.of(
                                            context,
                                          ).textTheme.titleSmall,
                                        ),
                                        const SizedBox(height: 4),
                                        Text(step.detail),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                    _section(
                      publication.signature.$1,
                      Text(publication.signature.$2),
                    ),
                    _section(
                      publication.rejected ? '管理员修改要求' : '最近审查结论',
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(publication.feedback),
                          const SizedBox(height: 12),
                          Text(
                            '${publication.text('reviewedBy').isEmpty ? '企业插件管理员' : publication.text('reviewedBy')} · ${_reviewTime(_row!['reviewedAt'])}',
                            style: TextStyle(color: context.soduWorkTheme.inkMuted),
                          ),
                        ],
                      ),
                    ),
                    if (publication.rejected)
                      _section(
                        '下一步',
                        const Text(
                          '按审核反馈修改原始草稿后重新检查并提交；新提交会生成新的版本，原审查记录保留。已提交的版本不能直接覆盖。',
                        ),
                      ),
                  ],
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('返回我的提交'),
                  ),
                ],
              ),
            ),
    );
  }
}

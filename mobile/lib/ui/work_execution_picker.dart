import 'mobile_display_preferences.dart';
import '../core/execution_target.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../state/mobile_scope.dart';
import 'mobile_sheet.dart';
import 'mobile_theme.dart';

class WorkExecutionChoice {
  final String id, label, runnerId, runnerKind;
  final bool modelPick;
  const WorkExecutionChoice(
    this.id,
    this.label, {
    this.runnerId = '',
    this.runnerKind = 'cloud',
    this.modelPick = true,
  });
}

Future<WorkExecutionChoice?> showWorkExecutionPicker(
  BuildContext context, {
  String selectedAgent = '',
  String selectedRunnerId = '',
  bool locked = false,
}) => showMobileSheet<WorkExecutionChoice>(
  context,
  title: '执行设置',
  initialSize: .76,
  builder: (_, scroll) => _ExecutionOptions(
    scroll: scroll,
    selected: selectedAgent,
    selectedRunnerId: selectedRunnerId,
    locked: locked,
  ),
);

class _ExecutionOptions extends StatefulWidget {
  final ScrollController scroll;
  final String selected, selectedRunnerId;
  final bool locked;
  const _ExecutionOptions({
    required this.scroll,
    required this.selected,
    required this.selectedRunnerId,
    required this.locked,
  });
  @override
  State<_ExecutionOptions> createState() => _ExecutionOptionsState();
}

class _ExecutionOptionsState extends State<_ExecutionOptions> {
  List<Map<String, dynamic>> _targets = [], _repos = [];
  String _error = '', _repoError = '';
  bool _loading = true;
  int? _identity;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final identity = MobileScope.of(context).identityRevision;
    if (_identity == null) {
      _identity = identity;
      _load();
    } else if (_identity != identity) {
      _targets = [];
      _repos = [];
      _loading = false;
      _error = '账号已切换，请关闭后重新打开。';
    }
  }

  Future<void> _load() async {
    final state = MobileScope.read(context), identity = _identity;
    if (state.identityRevision != identity) return;
    setState(() {
      _loading = true;
      _error = '';
      _repoError = '';
    });
    final result = await Future.wait([
      state.cloudConversationTargets().then<Object>(
        (value) => value,
        onError: (Object e) => e,
      ),
      state.api.executionRepositories().then<Object>(
        (value) => value,
        onError: (Object e) => e,
      ),
    ]);
    if (!mounted || state.identityRevision != identity) return;
    setState(() {
      _loading = false;
      if (result[0] is Map<String, dynamic>) {
        final seen = <String>{};
        _targets = ((result[0] as Map)['targets'] as List? ?? const [])
            .whereType<Map>()
            .map(normalizeExecutionTarget)
            .where((row) => isUsableExecutionTarget(row))
            .where(
              (row) => seen.add('${row['runnerId'] ?? ''}:${row['agentId']}'),
            )
            .toList();
      } else {
        _error = '暂时无法读取执行底座，请重试。';
      }
      if (result[1] is Map<String, dynamic>) {
        _repos = ((result[1] as Map)['repos'] as List? ?? const [])
            .whereType<Map<String, dynamic>>()
            .toList();
      } else {
        _repoError = '工程目录暂时无法读取。';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return ListView(
      controller: widget.scroll,
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
      children: [
        Text(
          mobileText(context, '执行底座'),
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: theme.ink,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          widget.locked
              ? mobileText(context, '当前会话沿用开始时的底座，切换请新建对话。')
              : mobileText(context, '选择实际执行工作的 Agent，模型与底座分别设置。'),
          style: TextStyle(fontSize: 13, height: 1.5, color: theme.inkMuted),
        ),
        if (_loading)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator()),
          ),
        if (_error.isNotEmpty) ...[
          Text(
            mobileText(context, _error),
            style: TextStyle(color: theme.inkSecondary),
          ),
          TextButton(onPressed: _load, child: Text(mobileText(context, '重试'))),
        ],
        if (!_loading && _error.isEmpty && _targets.isEmpty)
          Padding(
            padding: EdgeInsets.symmetric(vertical: 18),
            child: Text(
              mobileText(context, '还没有可用的个人云执行环境。请在 PC「云端环境」配置并检查连接，完成后在手机刷新。'),
            ),
          ),
        for (final target in _targets)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(CupertinoIcons.command, color: theme.ink, size: 23),
            title: Text(
              '${isWorkComputerExecutionTarget(target) ? '本人在线 PC' : '云端执行机'} · ${(target['cliName'] ?? target['agentId']).toString()}',
            ),
            subtitle: Text(
              (target['runnerName'] ?? target['machineLabel'] ?? '').toString(),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            trailing:
                widget.selected == target['agentId'] &&
                    (widget.selectedRunnerId.isEmpty ||
                        widget.selectedRunnerId == target['runnerId'])
                ? Icon(CupertinoIcons.check_mark, color: theme.ink, size: 20)
                : null,
            enabled: !widget.locked,
            onTap: widget.locked
                ? null
                : () => Navigator.pop(
                    context,
                    WorkExecutionChoice(
                      target['agentId'] as String,
                      (target['cliName'] ?? target['agentId']).toString(),
                      runnerId: (target['runnerId'] ?? '').toString(),
                      runnerKind: executionTargetKind(target),
                      modelPick: target['modelPick'] == true,
                    ),
                  ),
          ),
        const SizedBox(height: 20),
        Divider(color: theme.line),
        const SizedBox(height: 16),
        Text(
          mobileText(context, '工程'),
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: theme.ink,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          mobileText(context, '工程工作目录目前需从电脑端发起。侧栏的项目用于整理对话，不会改变执行目录。'),
          style: TextStyle(color: theme.inkSecondary, height: 1.6),
        ),
        if (_repoError.isNotEmpty)
          Text(
            mobileText(context, _repoError),
            style: TextStyle(color: theme.inkMuted),
          ),
        for (final repo in _repos)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(CupertinoIcons.folder, color: theme.inkSecondary),
            title: Text((repo['name'] ?? '').toString()),
            subtitle: Text((repo['projectName'] ?? '').toString()),
            trailing: Text(
              mobileText(context, '电脑端发起'),
              style: TextStyle(fontSize: 12, color: theme.inkMuted),
            ),
          ),
        const SizedBox(height: 24),
        Text(
          mobileText(context, 'Loop · 持续执行'),
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: theme.ink,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          mobileText(
            context,
            '围绕目标反复执行、验证，直到满足验收标准。目前需从电脑端发起，手机端暂不能启动或控制 Loop。',
          ),
          style: TextStyle(color: theme.inkSecondary, height: 1.6),
        ),
      ],
    );
  }
}

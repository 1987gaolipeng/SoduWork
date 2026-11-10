import 'mobile_select_field.dart';
import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';

import '../core/soduwork_api.dart';
import '../models/work_models.dart';
import '../state/mobile_scope.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';

/// Uses the same execution-options and dispatch contracts as PC requirements.
class RequirementAssignmentSheet extends StatefulWidget {
  final WorkTask task;
  final bool teammateFirst;
  const RequirementAssignmentSheet({
    super.key,
    required this.task,
    this.teammateFirst = false,
  });

  @override
  State<RequirementAssignmentSheet> createState() =>
      _RequirementAssignmentSheetState();
}

class _RequirementAssignmentSheetState
    extends State<RequirementAssignmentSheet> {
  late WorkTask _task;
  final _note = TextEditingController();
  final _search = TextEditingController();
  Map<String, dynamic> _options = const {};
  List<Map<String, dynamic>> _mates = const [];
  String _tab = 'ai', _agent = '', _model = '', _repo = '', _person = '';
  String _submission = '', _error = '';
  String _targetKey = '';
  bool _targetExplicit = false;
  bool _loading = true, _busy = false, _uncertain = false;
  int? _identity;
  int _revision = 0;

  List<Map<String, dynamic>> get _agents => jsonList(_options['substrates'])
      .map(jsonMap)
      .where((row) => row['available'] == true && _locations(row).isNotEmpty)
      .toList();
  List<Map<String, dynamic>> get _models =>
      jsonList(_options['modelOptions']).map(jsonMap).toList();
  List<Map<String, dynamic>> get _repos =>
      jsonList(_options['repos']).map(jsonMap).toList();
  Map<String, dynamic> get _selectedAgent =>
      _agents.where((row) => row['key'] == _agent).firstOrNull ?? const {};

  String _locationKey(Map<String, dynamic> row) =>
      '${row['mode']}:${row['runnerId'] ?? row['clientId'] ?? ''}';

  String _locationType(Map<String, dynamic> row) {
    if (row['mode'] == 'local') return '开发电脑';
    // Only structured routing metadata identifies a cloud or device executor.
    // A host name containing "cloud" is still just a user-visible name.
    if (row['runnerKind'] == 'cloud') return '云端执行机';
    if (row['runnerKind'] == 'work-computer' ||
        (row['runnerKind'] == null &&
            (row['clientId']?.toString().isNotEmpty ?? false))) {
      return '我的电脑';
    }
    return '远程执行机';
  }

  String _locationLabel(Map<String, dynamic> row) {
    final type = _locationType(row);
    if (row['mode'] == 'local') return mobileText(context, type);
    var name =
        [row['runnerName'], row['machineLabel'], row['label'], row['host']]
            .map((value) => value?.toString().trim() ?? '')
            .where((value) => value.isNotEmpty)
            .firstOrNull ??
        '';
    // Strip the old transport prefix, preserving the configured machine name.
    name = name.replaceFirst(RegExp(r'^远程 Runner\s*·\s*'), '');
    if (name == '远程 Runner' || name == '远程执行机' || name == type) name = '';
    final label = mobileText(context, type);
    return name.isEmpty ? label : '$label · $name';
  }

  String _locationHint(Map<String, dynamic> agent) {
    final selected = _executionLocation(agent);
    if (selected == null) {
      return mobileText(context, '本人电脑暂不可用，请上线电脑或选择其他执行位置。');
    }
    if (selected['mode'] != 'remote') return agent['note']?.toString() ?? '';
    return mobileText(context, switch (_locationType(selected)) {
      '云端执行机' => '在所选云端执行机运行。',
      '我的电脑' => '在所选工作电脑运行，请保持该电脑在线。',
      _ => '在所选远程执行机运行。',
    });
  }

  List<Map<String, dynamic>> _locations(Map<String, dynamic> agent) {
    final locations = jsonList(agent['locations']).map(jsonMap).toList();
    final registered = MobileScope.read(context).api.localExecutionRunnerId;
    final seen = <String>{};
    final result = locations
        .where(
          (row) =>
              (row['mode'] == 'remote' ||
                  (row['mode'] == 'local' &&
                      registered != null &&
                      registered.isNotEmpty &&
                      row['runnerId'] == registered)) &&
              row['available'] != false &&
              row['online'] != false &&
              seen.add(_locationKey(row)),
        )
        .map((row) => {...row, 'label': _locationLabel(row)})
        .toList();
    if (locations.isEmpty && agent['locationMode'] == 'remote') {
      return [
        {
          'mode': 'remote',
          'label': _locationLabel({
            'mode': 'remote',
            'label': agent['locationLabel'],
          }),
        },
      ];
    }
    return result;
  }

  Map<String, dynamic>? _executionLocation(Map<String, dynamic> agent) {
    final rows = _locations(agent);
    // Do not silently move an explicitly selected job to a different machine.
    return _targetExplicit
        ? rows.where((row) => _locationKey(row) == _targetKey).firstOrNull
        : rows
              .where(
                (row) =>
                    row['runnerKind'] == 'work-computer' &&
                    row['online'] != false,
              )
              .firstOrNull;
  }

  @override
  void initState() {
    super.initState();
    _task = widget.task;
    _tab = widget.teammateFirst ? 'mate' : 'ai';
    _repo = _task.repoId;
    Future.microtask(_load);
  }

  @override
  void dispose() {
    _revision++;
    _note.dispose();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final revision = ++_revision;
    setState(() {
      _loading = true;
      _error = '';
    });
    final state = MobileScope.read(context);
    final identity = _identity ??= state.identityRevision;
    if (identity != state.identityRevision) {
      setState(() {
        _loading = false;
        _error = '账号已切换，请关闭后重新打开需求。';
      });
      return;
    }
    try {
      if (_task.readOnly) {
        if (!_task.canClaimExecution || !_task.canArrange) {
          throw const ApiFailure('当前无权接手此需求，请刷新后确认。');
        }
        final claimed = await state.api.prepareRequirementExecution(_task.id);
        if (!mounted ||
            revision != _revision ||
            identity != state.identityRevision) {
          return;
        }
        if (claimed.id != _task.id || claimed.readOnly || !claimed.canArrange) {
          throw const ApiFailure('接手未完成，请刷新需求后重试。');
        }
        _task = claimed;
      }
      if (_tab == 'mate') {
        final rows = await state.teammates();
        if (!mounted ||
            revision != _revision ||
            identity != state.identityRevision) {
          return;
        }
        setState(() {
          _mates = rows
              .where(
                (row) =>
                    (row['id'] ?? row['userId'] ?? '').toString().isNotEmpty,
              )
              .toList();
        });
      } else {
        final options = await state.api.taskExecutionOptions({
          'taskId': _task.id,
          if (_repo.isNotEmpty) 'repoId': _repo,
        });
        if (!mounted ||
            revision != _revision ||
            identity != state.identityRevision) {
          return;
        }
        setState(() {
          _options = options;
          if (_agent.isEmpty) {
            _agent =
                (_agents
                            .where((row) => _executionLocation(row) != null)
                            .firstOrNull ??
                        _agents.firstOrNull)?['key']
                    ?.toString() ??
                '';
          }
          if (!_targetExplicit) {
            final preferred = _executionLocation(_selectedAgent);
            if (preferred != null) {
              _targetKey = _locationKey(preferred);
              _targetExplicit = true;
            }
          }
          if (!_models.any((row) => row['name'] == _model)) _model = '';
          _repo = jsonMap(options['selection'])['repoId']?.toString() ?? '';
        });
      }
    } on ApiFailure catch (error) {
      if (mounted && revision == _revision) {
        setState(() {
          _error = error.message;
          _options = const {};
        });
      }
    } finally {
      if (mounted && revision == _revision) setState(() => _loading = false);
    }
  }

  Future<void> _confirm() async {
    if (_busy ||
        _uncertain ||
        _loading ||
        !_task.canArrange ||
        (_tab == 'ai'
            ? (_agent.isEmpty || _executionLocation(_selectedAgent) == null)
            : _person.isEmpty)) {
      return;
    }
    final state = MobileScope.read(context);
    if (_identity != state.identityRevision) {
      setState(() => _error = '账号已切换，请关闭后重新打开需求。');
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      if (_tab == 'mate') {
        await state.handoffTask(
          _task,
          assigneeUserId: _person,
          note: _note.text.trim(),
        );
      } else {
        final agent = _selectedAgent;
        if (agent.isEmpty) throw const ApiFailure('执行底座已变化，请刷新后重选。');
        final location = _executionLocation(agent);
        if (location == null) throw const ApiFailure('执行位置已失效，请刷新后重选。');
        final model = agent['modelPick'] == false ? '' : _model;
        final repo = _repos.where((row) => row['id'] == _repo).firstOrNull;
        final execution = <String, dynamic>{
          'schemaVersion': 1,
          'strategy': 'direct',
          'agent': {
            'id': _agent,
            'key': _agent,
            'cli': agent['cli'],
            'name': agent['name'],
          },
          'model': model,
          'location': {'mode': location['mode'], 'label': location['label']},
          'runner': {
            'mode': location['mode'],
            for (final key in [
              'runnerId',
              'clientId',
              'machineKey',
              'host',
              'version',
            ])
              if (location[key] != null) key: location[key],
          },
          'repo': ?repo,
        };
        await state.api.dispatchRequirement(_task.id, {
          'assigneeId': _agent,
          'assigneeType': 'agent',
          'model': model,
          'brief': _note.text.trim(),
          'executionContext': execution,
          'repo': ?repo,
          if (_repo.isNotEmpty) 'repoId': _repo,
          if (_submission.isNotEmpty) 'submissionMode': _submission,
        });
        if (_identity != state.identityRevision) return;
        await state.loadTask(_task.id);
      }
      if (mounted && _identity == state.identityRevision) {
        Navigator.of(context).pop(true);
      }
    } on ApiFailure catch (error) {
      if (mounted) {
        setState(() {
          _uncertain = error.isNetwork;
          _error = _uncertain
              ? '接单结果尚未确认，请关闭面板并刷新需求，确认执行状态后再操作。'
              : error.message;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    return PopScope(
      canPop: !_busy,
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SizedBox(
          height: MediaQuery.sizeOf(context).height * .86,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 6, 12, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        mobileText(context, '安排执行'),
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                    ),
                    IconButton(
                      tooltip: mobileText(context, '关闭'),
                      onPressed: _busy
                          ? null
                          : () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: SegmentedButton<String>(
                  segments: [
                    ButtonSegment(
                      value: 'ai',
                      label: Text(mobileText(context, '交给 AI')),
                      icon: Icon(Icons.auto_awesome_outlined),
                    ),
                    ButtonSegment(
                      value: 'mate',
                      label: Text(mobileText(context, '转给同事')),
                      icon: Icon(Icons.person_outline_rounded),
                    ),
                  ],
                  selected: {_tab},
                  onSelectionChanged: _busy
                      ? null
                      : (value) {
                          setState(() => _tab = value.first);
                          _load();
                        },
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    Text(
                      _task.title,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    if (_task.note.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(
                        _task.note,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: theme.inkMuted),
                      ),
                    ],
                    const SizedBox(height: 20),
                    if (_error.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: InlineError(
                          message: mobileText(context, _error),
                          onRetry: _busy ? null : _load,
                        ),
                      ),
                    if (_loading)
                      const SizedBox(height: 180, child: LoadingPane())
                    else if (_tab == 'ai')
                      ..._aiFields()
                    else
                      ..._mateFields(),
                    const SizedBox(height: 16),
                    TextField(
                      controller: _note,
                      enabled: !_busy,
                      minLines: 2,
                      maxLines: 5,
                      maxLength: 2000,
                      decoration: InputDecoration(
                        labelText: mobileText(context, '补充内容（选填）'),
                        hintText: mobileText(context, '补充验收标准、口径或参考资料'),
                      ),
                    ),
                  ],
                ),
              ),
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
                  child: SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed:
                          _busy ||
                              _uncertain ||
                              _loading ||
                              (_tab == 'ai'
                                  ? (_agent.isEmpty ||
                                        _executionLocation(_selectedAgent) ==
                                            null)
                                  : _person.isEmpty)
                          ? null
                          : _confirm,
                      child: Text(
                        _busy
                            ? mobileText(context, '正在确认接单…')
                            : _tab == 'ai'
                            ? mobileText(context, '确认派活')
                            : mobileText(context, '确认转交'),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _aiFields() {
    final agent = _selectedAgent;
    final serverReason =
        jsonMap(_options['availability'])['agentReason']?.toString() ?? '';
    final deviceLimited =
        !MobileScope.read(context).api.isLocalDevelopment &&
        serverReason.startsWith('本机 Agent 尚未在线');
    return [
      if (_agents.isEmpty) ...[
        Text(
          deviceLimited
              ? '当前服务尚未为此需求提供可用的云端执行环境。已配置的云电脑可用于云端对话，但需求派活仍受设备范围限制，请联系服务管理员。需求已保存，不会丢失。'
              : serverReason.isNotEmpty
              ? serverReason
              : mobileText(context, '当前没有可接单的执行机，请刷新或联系服务管理员。'),
        ),
        TextButton.icon(
          onPressed: _busy ? null : _load,
          icon: const Icon(Icons.refresh_rounded),
          label: Text(mobileText(context, '刷新执行底座')),
        ),
      ] else ...[
        MobileSelectField<String>(
          key: ValueKey('agent-$_agent'),
          initialValue: _agents.any((row) => row['key'] == _agent)
              ? _agent
              : null,
          hint: Text(mobileText(context, '原执行底座已不可用，请重新选择')),
          decoration: InputDecoration(labelText: mobileText(context, '执行底座')),
          items: _agents
              .map(
                (row) => DropdownMenuItem(
                  value: row['key'].toString(),
                  child: Text(row['name']?.toString() ?? row['cli'].toString()),
                ),
              )
              .toList(),
          onChanged: _busy
              ? null
              : (value) => setState(() {
                  _agent = value ?? '';
                  _model = '';
                  _targetExplicit = false;
                  _targetKey = '';
                }),
        ),
        const SizedBox(height: 12),
        if (_locations(agent).isNotEmpty)
          MobileSelectField<String>(
            key: ValueKey(
              'target-$_agent-$_targetKey-${_locations(agent).map(_locationKey).join(',')}',
            ),
            initialValue: _executionLocation(agent) == null
                ? null
                : _locationKey(_executionLocation(agent)!),
            decoration: InputDecoration(labelText: mobileText(context, '执行位置')),
            hint: Text(
              mobileText(
                context,
                _targetExplicit ? '原执行位置已不可用，请重新选择' : '请选择执行位置',
              ),
            ),
            items: _locations(agent)
                .map(
                  (row) => DropdownMenuItem(
                    value: _locationKey(row),
                    child: Text(
                      row['label'].toString(),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                )
                .toList(),
            onChanged: _busy
                ? null
                : (value) => setState(() {
                    _targetKey = value ?? '';
                    _targetExplicit = true;
                  }),
          )
        else
          Text(
            _executionLocation(agent)?['label']?.toString() ??
                mobileText(context, '执行机'),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        const SizedBox(height: 6),
        Text(
          _locationHint(agent),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (agent['modelPick'] != false) ...[
          const SizedBox(height: 16),
          MobileSelectField<String>(
            key: ValueKey('model-$_model-$_agent'),
            initialValue: _model,
            decoration: InputDecoration(labelText: mobileText(context, '模型')),
            items: [
              DropdownMenuItem(
                value: '',
                child: Text(mobileText(context, '使用底座默认模型')),
              ),
              ..._models.map(
                (row) => DropdownMenuItem(
                  value: row['name'].toString(),
                  child: Text(
                    row['label']?.toString() ?? row['name'].toString(),
                  ),
                ),
              ),
            ],
            onChanged: _busy
                ? null
                : (value) => setState(() => _model = value ?? ''),
          ),
        ],
      ],
      const SizedBox(height: 16),
      MobileSelectField<String>(
        key: ValueKey('repo-$_repo'),
        initialValue: _repos.any((row) => row['id'] == _repo) ? _repo : '',

        decoration: InputDecoration(labelText: mobileText(context, '关联工程')),
        items: [
          DropdownMenuItem(
            value: '',
            child: Text(mobileText(context, '不关联工程')),
          ),
          ..._repos.map(
            (row) => DropdownMenuItem(
              value: row['id'].toString(),
              child: Text(row['name']?.toString() ?? row['id'].toString()),
            ),
          ),
        ],
        onChanged: _busy || _loading
            ? null
            : (value) {
                setState(() => _repo = value ?? '');
                _load();
              },
      ),
      const SizedBox(height: 16),
      Text(
        mobileText(context, '工作方法：不用插件'),
        style: Theme.of(context).textTheme.bodyMedium,
      ),
      const SizedBox(height: 6),
      Text(
        mobileText(context, '沿用 PC 的直接执行流程。需要插件参数的任务请从对话中的插件入口发起。'),
        style: Theme.of(context).textTheme.bodySmall,
      ),
      const SizedBox(height: 16),
      MobileSelectField<String>(
        initialValue: _submission,

        decoration: InputDecoration(labelText: mobileText(context, '交付提交方式')),
        items: [
          DropdownMenuItem(
            value: '',
            child: Text(mobileText(context, '按交付物自动判断')),
          ),
          DropdownMenuItem(
            value: 'auto',
            child: Text(mobileText(context, '自动提交验收')),
          ),
          DropdownMenuItem(
            value: 'manual',
            child: Text(mobileText(context, '手动提交验收')),
          ),
        ],
        onChanged: _busy
            ? null
            : (value) => setState(() => _submission = value ?? ''),
      ),
    ];
  }

  List<Widget> _mateFields() {
    final query = _search.text.trim().toLowerCase();
    final rows = _mates.where(
      (row) => (row['name'] ?? row['displayName'] ?? '')
          .toString()
          .toLowerCase()
          .contains(query),
    );
    return [
      TextField(
        controller: _search,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          prefixIcon: Icon(Icons.search_rounded),
          hintText: mobileText(context, '搜索同事'),
        ),
      ),
      const SizedBox(height: 12),
      if (rows.isEmpty)
        Padding(
          padding: EdgeInsets.all(16),
          child: Text(mobileText(context, '当前没有可转交的同事。')),
        ),
      ...rows.map((row) {
        final id = (row['id'] ?? row['userId'] ?? '').toString();
        final name = (row['name'] ?? row['displayName'] ?? id).toString();
        return ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(name),
          subtitle: Text(
            (row['departmentName'] ?? row['department'] ?? '').toString(),
          ),
          leading: Icon(
            _person == id ? Icons.radio_button_checked : Icons.radio_button_off,
          ),
          selected: _person == id,
          onTap: _busy ? null : () => setState(() => _person = id),
        );
      }),
    ];
  }
}

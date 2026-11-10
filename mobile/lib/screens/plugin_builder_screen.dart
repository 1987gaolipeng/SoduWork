import '../ui/mobile_input_border.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import '../sdk/soduwork_brand.dart';
import '../ui/mobile_display_preferences.dart';
import '../ui/mobile_theme.dart';
import '../ui/plugin_fields_editor.dart';
import '../ui/plugin_fields_contract.dart';
import '../ui/plugin_workflow_editor.dart';
import '../ui/plugin_workflow_contract.dart';
import '../ui/plugin_workflow_preview.dart';
import '../state/mobile_state.dart';

/// Mobile plugin builder, following the desktop draft, preflight, and save flow.
/// AppShell provides conversational creation; this page confirms structured drafts.
class PluginBuilderScreen extends StatefulWidget {
  final Map<String, dynamic> initialValues;
  final VoidCallback? onConversationCreate;
  final String? targetComputer;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic>)?
  onPreflight;
  final Future<Map<String, dynamic>> Function(Map<String, dynamic>)? onInstall;

  const PluginBuilderScreen({
    super.key,
    this.initialValues = const {},
    this.onConversationCreate,
    this.targetComputer,
    this.onPreflight,
    this.onInstall,
  });

  @override
  State<PluginBuilderScreen> createState() => _PluginBuilderScreenState();
}

class _PluginBuilderScreenState extends State<PluginBuilderScreen> {
  late final Map<String, dynamic> _initial;
  final _name = TextEditingController();
  final _version = TextEditingController(text: '0.1.0');
  final _author = TextEditingController();
  final _description = TextEditingController();
  final _instructions = TextEditingController();
  final _mcpServers = TextEditingController();
  final _skills = TextEditingController();
  final _evaluation = TextEditingController();
  final _criteria = TextEditingController();
  List<Map<String, dynamic>> _inputs = [];
  List<String> _runtime = [];
  Map<String, dynamic> _setup = {};
  Map<String, dynamic> _workflow = {};
  MobileState? _owner;
  String _template = 'method';
  bool _standalone = false;
  bool _busy = false;
  int? _identity;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    _owner ??= state;
    _identity ??= state.identityRevision;
  }

  String _error = '';
  Map<String, dynamic>? _preview;
  Map<String, dynamic>? _created;

  @override
  void initState() {
    super.initState();
    _initial = cloneWorkflow(widget.initialValues);
    final values = _initial;
    _workflow = cloneWorkflow(workflowMap(values['workflow']));
    _runtime = workflowNames(
      values['runtimeCapabilities'] ?? values['runtime'],
    );
    _inputs = (values['inputs'] is List ? values['inputs'] as List : const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
    _setup = values['setup'] is Map
        ? Map<String, dynamic>.from(values['setup'] as Map)
        : {};
    _name.text = values['name']?.toString() ?? '';
    _version.text = values['version']?.toString() ?? '0.1.0';
    _author.text = values['author']?.toString() ?? '';
    _description.text = values['description']?.toString() ?? '';
    _instructions.text = values['instructions']?.toString() ?? '';
    final servers = values['mcpServers'];
    _mcpServers.text = servers is List
        ? servers.join(', ')
        : servers?.toString() ?? '';
    _evaluation.text = values['evaluationInstruction']?.toString() ?? '';
    final criteria = values['evaluationCriteria'];
    _criteria.text = criteria is List
        ? criteria.join('\n')
        : criteria?.toString() ?? '';
    final skills = values['skills'];
    _skills.text = skills is List
        ? skills.join(', ')
        : skills?.toString() ?? '';
    _template =
        const {
          'method',
          'connector',
          'workflow',
          'app',
        }.contains(values['template'])
        ? values['template'].toString()
        : 'method';
    _standalone = values['distribution'] == 'standalone';
    for (final controller in _controllers) {
      controller.addListener(_invalidatePreview);
    }
  }

  List<TextEditingController> get _controllers => [
    _name,
    _version,
    _author,
    _description,
    _instructions,
    _mcpServers,
    _skills,
    _evaluation,
    _criteria,
  ];

  @override
  void dispose() {
    for (final controller in _controllers) {
      controller.removeListener(_invalidatePreview);
      controller.dispose();
    }
    super.dispose();
  }

  void _invalidatePreview() {
    if (!mounted || (_preview == null && _created == null)) return;
    setState(() {
      _preview = null;
      _created = null;
      _error = '';
    });
  }

  List<String> _values(String value) => value
      .split(RegExp(r'[,，\n]'))
      .map((item) => item.trim())
      .where((item) => item.isNotEmpty)
      .toList(growable: false);

  Map<String, dynamic> _draft() {
    final workflow = _template == 'workflow' || _standalone;
    return <String, dynamic>{
      ..._initial,
      'template': workflow ? 'workflow' : _template,
      'name': _name.text.trim(),
      'version': _version.text.trim(),
      'author': _author.text.trim(),
      'description': _description.text.trim(),
      'instructions': _instructions.text.trim(),
      'distribution': _standalone ? 'standalone' : '',
      'skills': _values(_skills.text),
      'mcpServers': _values(_mcpServers.text).join(', '),
      'runtimeCapabilities': _runtime,
      'evaluationInstruction': _evaluation.text.trim(),
      'evaluationCriteria': _criteria.text.trim(),
      'inputs': _inputs,
      'setup': _setup,
      if (workflow || _workflow.isNotEmpty) 'workflow': _workflow,
      'entrypoints':
          (_template == _initial['template']
              ? _initial['entrypoints']
              : null) ??
          {'conversation': !workflow, 'task': true, 'automation': workflow},
    };
  }

  Future<void> _submit() async {
    if (_busy || _created != null) return;
    final name = _name.text.trim();
    final description = _description.text.trim();
    final instructions = _instructions.text.trim();
    if (name.isEmpty || description.isEmpty || instructions.isEmpty) {
      setState(() => _error = '插件名称、用途说明和工作方法都要写清楚。');
      return;
    }
    final state = MobileScope.read(context);
    final identity = state.identityRevision;
    if (_identity != identity || !identical(state, _owner)) {
      setState(() => _error = '账号或服务已切换，请重新打开草稿。');
      return;
    }
    final draft = _draft();
    final errors = [
      ...validatePluginFields(_inputs, _setup),
      if (draft['template'] == 'workflow')
        ...validatePluginWorkflow(_workflow, plugin: draft),
    ];
    if (errors.isNotEmpty) {
      setState(() => _error = errors.first);
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
      _created = null;
    });
    try {
      if (_preview == null) {
        final preview =
            await (widget.onPreflight?.call(draft) ??
                state.api.preflightPluginDraft(draft));
        if (!mounted ||
            state.identityRevision != identity ||
            !identical(MobileScope.read(context), _owner)) {
          return;
        }
        if (preview.isEmpty) throw const ApiFailure('未收到插件检查结果，请重试。');
        if (preview['ok'] == false) {
          throw ApiFailure(
            preview['message']?.toString() ??
                preview['reason']?.toString() ??
                '插件检查没有通过，请修正后重试。',
          );
        }
        setState(() => _preview = preview);
      } else {
        final created =
            await (widget.onInstall?.call(draft) ??
                state.api.createPluginDraft(draft));
        if (!mounted ||
            state.identityRevision != identity ||
            !identical(MobileScope.read(context), _owner)) {
          return;
        }
        if (created['ok'] != true ||
            created['plugin'] is! Map ||
            ((created['plugin'] as Map)[widget.onInstall == null
                        ? 'id'
                        : 'pluginId'])
                    ?.toString()
                    .isNotEmpty !=
                true) {
          throw ApiFailure(
            created['reason']?.toString() ?? '提交结果未确认，请先到插件目录核对结果。',
          );
        }
        setState(() => _created = created);
        Navigator.of(context).pop(created);
      }
    } on ApiFailure catch (error) {
      if (mounted &&
          identical(MobileScope.read(context), _owner) &&
          _owner?.identityRevision == identity) {
        setState(() => _error = error.message);
      }
    } catch (_) {
      if (mounted &&
          identical(MobileScope.read(context), _owner) &&
          _owner?.identityRevision == identity) {
        setState(() => _error = '插件草稿未完成，请检查内容后重试。');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  InputDecoration _dec(
    SoduWorkBrandTheme theme, {
    required String label,
    String? hint,
    String? helper,
  }) => InputDecoration(
    labelText: mobileText(context, label),
    hintText: hint == null ? null : mobileText(context, hint),
    helperText: helper == null ? null : mobileText(context, helper),
    filled: true,
    fillColor: theme.surface,
    alignLabelWithHint: true,
    contentPadding: const EdgeInsets.fromLTRB(15, 14, 15, 14),
    border: MobileInputBorder(
      borderRadius: BorderRadius.circular(15),
      borderSide: BorderSide(color: theme.line),
    ),
    enabledBorder: MobileInputBorder(
      borderRadius: BorderRadius.circular(15),
      borderSide: BorderSide(color: theme.line),
    ),
    focusedBorder: MobileInputBorder(
      borderRadius: BorderRadius.circular(15),
      borderSide: BorderSide(color: theme.primary, width: 1.5),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final theme = context.soduWorkTheme;
    final owner = MobileScope.of(context);
    final current =
        identical(owner, _owner) && owner.identityRevision == _identity;
    return PopScope(
      canPop: !_busy,
      child: Scaffold(
        backgroundColor: theme.canvas,
        appBar: AppBar(
          title: Text(mobileText(context, '制作插件')),
          actions: [
            IconButton(
              tooltip: mobileText(context, '关闭'),
              onPressed: _busy ? null : () => Navigator.of(context).maybePop(),
              icon: const Icon(CupertinoIcons.xmark),
            ),
          ],
        ),
        body: !current
            ? const Center(child: Text('账号或服务已切换，请关闭后重新打开草稿。'))
            : AbsorbPointer(
                absorbing: _busy || !current,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  children: [
                    if (!current) const Text('账号或服务已切换，请关闭后重新打开草稿。'),
                    if (widget.onConversationCreate != null)
                      _AgentCard(
                        theme: theme,
                        onConversationCreate: widget.onConversationCreate,
                      ),
                    const SizedBox(height: 16),
                    Text(
                      mobileText(context, '插件类型'),
                      style: TextStyle(
                        color: theme.ink,
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                      ),
                    ),
                    const SizedBox(height: 8),
                    LayoutBuilder(
                      builder: (context, constraints) {
                        final single =
                            constraints.maxWidth < 300 ||
                            MediaQuery.textScalerOf(context).scale(14) > 22;
                        final width = single
                            ? constraints.maxWidth
                            : (constraints.maxWidth - 10) / 2;
                        const items = [
                          (
                            'method',
                            '工作方法',
                            '沉淀一套可复用 Skill',
                            CupertinoIcons.doc_text,
                          ),
                          (
                            'connector',
                            '系统连接',
                            '组合连接器与工具',
                            CupertinoIcons.link,
                          ),
                          (
                            'workflow',
                            '自动化流程',
                            '编排 Agent、人审与交付',
                            CupertinoIcons.flowchart,
                          ),
                          ('app', '应用', '独立窗口、页面与对话', CupertinoIcons.app),
                        ];
                        return Wrap(
                          spacing: 10,
                          runSpacing: 10,
                          children: items.map((item) {
                            return SizedBox(
                              width: width,
                              child: _TemplateCard(
                                theme: theme,
                                value: item.$1,
                                title: item.$2,
                                subtitle: item.$3,
                                icon: item.$4,
                                selected: _template == item.$1,
                                onTap: () => setState(() {
                                  _template = item.$1;
                                  if (_template != 'workflow') {
                                    _standalone = false;
                                  }
                                  _preview = null;
                                  _created = null;
                                }),
                              ),
                            );
                          }).toList(),
                        );
                      },
                    ),
                    const SizedBox(height: 12),
                    Material(
                      color: theme.surface,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(15),
                        side: BorderSide(color: theme.line),
                      ),
                      child: SwitchListTile.adaptive(
                        value: _standalone,
                        onChanged: _template == 'workflow'
                            ? (value) => setState(() {
                                _standalone = value;
                                _preview = null;
                                _created = null;
                              })
                            : null,
                        title: Text(
                          mobileText(context, '独立上线插件'),
                          style: TextStyle(
                            color: theme.ink,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        subtitle: Text(
                          mobileText(context, '发布后可作为独立插件安装、审核和升级'),
                          style: TextStyle(
                            color: theme.inkMuted,
                            fontSize: 12.5,
                          ),
                        ),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 14,
                        ),
                      ),
                    ),
                    const SizedBox(height: 18),
                    _SectionTitle(
                      theme: theme,
                      title: '基本信息',
                      subtitle: '这些内容会显示在插件目录和版本记录中。',
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _name,
                      maxLength: 120,
                      decoration: _dec(theme, label: '插件名称', hint: '例如：产品原型交付'),
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _version,
                            maxLength: 40,
                            decoration: _dec(theme, label: '版本', hint: '0.1.0'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: TextField(
                            controller: _author,
                            maxLength: 120,
                            decoration: _dec(
                              theme,
                              label: '作者',
                              hint: '显示在插件目录中的名称',
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _description,
                      maxLength: 600,
                      minLines: 2,
                      maxLines: 4,
                      decoration: _dec(
                        theme,
                        label: '用途',
                        hint: '什么时候使用，最终交付什么',
                      ),
                    ),
                    const SizedBox(height: 18),
                    _SectionTitle(
                      theme: theme,
                      title: '工作方法与完成标准',
                      subtitle: '写清输入、判断规则、交付格式、验证方式和失败边界。',
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _instructions,
                      maxLength: 50000,
                      minLines: 7,
                      maxLines: 14,
                      decoration: _dec(
                        theme,
                        label: '工作方法',
                        hint: '按步骤描述插件如何工作',
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _evaluation,
                      maxLength: 2000,
                      minLines: 2,
                      maxLines: 4,
                      decoration: _dec(
                        theme,
                        label: '代表性评测试题',
                        hint: '给一份真实输入，插件应完成什么',
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _criteria,
                      maxLength: 4000,
                      minLines: 4,
                      maxLines: 8,
                      decoration: _dec(
                        theme,
                        label: '验收标准',
                        hint: '每行一条，例如：产出格式可以直接使用',
                      ),
                    ),
                    const SizedBox(height: 18),
                    _SectionTitle(
                      theme: theme,
                      title: '能力与连接',
                      subtitle: '可选；地址和授权仍由连接中心统一管理。',
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _mcpServers,
                      maxLength: 600,
                      decoration: _dec(
                        theme,
                        label: '依赖的连接器',
                        hint: 'knowledge-base, figma',
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _skills,
                      maxLength: 600,
                      decoration: _dec(
                        theme,
                        label: '复用 Skill',
                        hint: '用逗号或换行分隔',
                      ),
                    ),
                    if (_template == 'workflow' || _standalone)
                      ExpansionTile(
                        title: const Text('插件运行能力'),
                        subtitle: const Text('节点只能使用此处声明的能力，实际授权仍由服务端核验'),
                        children: [
                          for (final capability in {
                            'browser',
                            'computer',
                            'repository',
                            ..._runtime,
                          })
                            CheckboxListTile(
                              title: Text(
                                const {
                                      'browser': '浏览网页',
                                      'computer': '操作电脑',
                                      'repository': '代码仓库',
                                    }[capability] ??
                                    capability,
                              ),
                              value: _runtime.contains(capability),
                              onChanged: (enabled) => setState(() {
                                if (enabled == true) {
                                  _runtime = {..._runtime, capability}.toList();
                                } else {
                                  _runtime = _runtime
                                      .where((v) => v != capability)
                                      .toList();
                                }
                                _preview = null;
                                _created = null;
                                _error = '';
                              }),
                            ),
                        ],
                      ),
                    PluginFieldsEditor(
                      inputs: _inputs,
                      setup: _setup,
                      onChanged: (inputs, setup) {
                        setState(() {
                          _inputs = inputs;
                          _setup = setup;
                          _preview = null;
                          _created = null;
                          _error = '';
                        });
                      },
                    ),
                    if (_template == 'workflow' || _standalone)
                      PluginWorkflowEditor(
                        value: _workflow,
                        plugin: _draft(),
                        buildPlugin: _draft,
                        onChanged: (value) => setState(() {
                          _workflow = value;
                          _preview = null;
                          _created = null;
                          _error = '';
                        }),
                      ),
                    const SizedBox(height: 16),
                    if (_initial.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      ExpansionTile(
                        title: const Text('生成的完整配置'),
                        subtitle: const Text('输入参数、使用偏好、流程节点及资源会随草稿保留'),
                        children: [
                          Padding(
                            padding: const EdgeInsets.all(12),
                            child: _DraftDetails(draft: _draft()),
                          ),
                        ],
                      ),
                    ],
                    if (_error.isNotEmpty) ...[
                      const SizedBox(height: 14),
                      _Notice(
                        theme: theme,
                        color: theme.danger,
                        icon: CupertinoIcons.exclamationmark_triangle,
                        text: _error,
                      ),
                    ],
                    if (_preview != null) ...[
                      const SizedBox(height: 14),
                      _Notice(
                        theme: theme,
                        color: theme.primary,
                        icon: CupertinoIcons.checkmark_alt_circle,
                        text: widget.targetComputer == null
                            ? '预检通过，检查预览后可提交企业审核。提交不会立即安装或开放执行。'
                            : '检查通过，确认后安装到 ${widget.targetComputer}。不会自动开始工作。',
                      ),
                      PluginWorkflowPreview(preview: _preview!),
                    ],
                    if (_created != null) ...[
                      const SizedBox(height: 14),
                      _Notice(
                        theme: theme,
                        color: theme.success,
                        icon: CupertinoIcons.checkmark_seal,
                        text: (_created!['message'] ?? '插件草稿已保存到隔离区。')
                            .toString(),
                      ),
                    ],
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      onPressed: _busy || _created != null ? null : _submit,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(52),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16),
                        ),
                      ),
                      icon: _busy
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Icon(
                              _preview == null
                                  ? CupertinoIcons.checkmark_shield
                                  : CupertinoIcons.cloud_upload,
                            ),
                      label: Text(
                        mobileText(
                          context,
                          _busy
                              ? '处理中…'
                              : _preview == null
                              ? '检查并继续'
                              : widget.onInstall == null
                              ? '提交审核'
                              : '安装到电脑',
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      mobileText(
                        context,
                        widget.targetComputer == null
                            ? '个人定义工作方法；企业审核、授权、绑定和运行环境仍由服务端控制。'
                            : '保存为所选电脑的个人插件，沿用电脑的权限与运行设置。',
                      ),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: theme.inkMuted,
                        fontSize: 12,
                        height: 1.4,
                      ),
                    ),
                  ],
                ),
              ),
      ),
    );
  }
}

class _AgentCard extends StatelessWidget {
  final SoduWorkBrandTheme theme;
  final VoidCallback? onConversationCreate;
  const _AgentCard({required this.theme, required this.onConversationCreate});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(15),
    decoration: BoxDecoration(
      color: theme.primarySoft,
      borderRadius: BorderRadius.circular(19),
      border: Border.all(color: theme.primary.withValues(alpha: .22)),
    ),
    child: Row(
      children: [
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: theme.surface,
            borderRadius: BorderRadius.circular(13),
          ),
          child: Icon(
            CupertinoIcons.wand_stars,
            color: theme.primary,
            size: 23,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                mobileText(context, '让 SoduWork 帮你起草'),
                style: TextStyle(
                  color: theme.ink,
                  fontWeight: FontWeight.w700,
                  fontSize: 15,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                mobileText(context, '先描述做法，再用表单校准参数、能力和完成标准。'),
                style: TextStyle(
                  color: theme.inkMuted,
                  fontSize: 12.5,
                  height: 1.35,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        OutlinedButton(
          onPressed: onConversationCreate,
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 10),
            minimumSize: const Size(0, 40),
          ),
          child: Text(mobileText(context, '对话创建')),
        ),
      ],
    ),
  );
}

class _TemplateCard extends StatelessWidget {
  final SoduWorkBrandTheme theme;
  final String value;
  final String title;
  final String subtitle;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;
  const _TemplateCard({
    required this.theme,
    required this.value,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    borderRadius: BorderRadius.circular(16),
    child: AnimatedContainer(
      duration: const Duration(milliseconds: 160),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: selected ? theme.primarySoft : theme.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: selected ? theme.primary : theme.line,
          width: selected ? 1.4 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            icon,
            color: selected ? theme.primary : theme.inkSecondary,
            size: 21,
          ),
          const SizedBox(height: 10),
          Text(
            mobileText(context, title),
            style: TextStyle(
              color: theme.ink,
              fontWeight: FontWeight.w700,
              fontSize: 13.5,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            mobileText(context, subtitle),
            style: TextStyle(color: theme.inkMuted, fontSize: 12, height: 1.25),
          ),
        ],
      ),
    ),
  );
}

class _SectionTitle extends StatelessWidget {
  final SoduWorkBrandTheme theme;
  final String title;
  final String subtitle;
  const _SectionTitle({
    required this.theme,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        mobileText(context, title),
        style: TextStyle(
          color: theme.ink,
          fontWeight: FontWeight.w700,
          fontSize: 16,
        ),
      ),
      const SizedBox(height: 3),
      Text(
        mobileText(context, subtitle),
        style: TextStyle(color: theme.inkMuted, fontSize: 12.5, height: 1.35),
      ),
    ],
  );
}

class _Notice extends StatelessWidget {
  final SoduWorkBrandTheme theme;
  final Color color;
  final IconData icon;
  final String text;
  const _Notice({
    required this.theme,
    required this.color,
    required this.icon,
    required this.text,
  });

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(13),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .1),
      borderRadius: BorderRadius.circular(15),
      border: Border.all(color: color.withValues(alpha: .25)),
    ),
    child: Row(
      children: [
        Icon(icon, color: color, size: 21),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            mobileText(context, text),
            style: TextStyle(color: theme.ink, height: 1.35),
          ),
        ),
      ],
    ),
  );
}

class _DraftDetails extends StatelessWidget {
  final Map<String, dynamic> draft;
  const _DraftDetails({required this.draft});
  @override
  Widget build(BuildContext context) {
    final setup = draft['setup'];
    final workflow = draft['workflow'];
    final groups = <String, dynamic>{
      '启动参数': draft['inputs'],
      '使用偏好': setup is Map ? setup['preferences'] : null,
      '流程节点': workflow is Map ? workflow['nodes'] : null,
      '随包资源': draft['resources'],
      '执行能力': draft['runtimeCapabilities'],
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final group in groups.entries)
          if (group.value is List && (group.value as List).isNotEmpty) ...[
            Text(
              group.key,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            for (final item in group.value as List)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(
                  item is Map
                      ? (item['label'] ??
                                item['name'] ??
                                item['path'] ??
                                item['key'] ??
                                '')
                            .toString()
                      : item.toString(),
                  style: TextStyle(
                    color: context.soduWorkTheme.inkSecondary,
                    fontSize: 13,
                  ),
                ),
              ),
            const SizedBox(height: 10),
          ],
      ],
    );
  }
}

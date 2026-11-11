import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../core/soduwork_api.dart';
import '../core/work_file_picker.dart';
import '../state/mobile_scope.dart';
import '../state/mobile_state.dart';
import '../ui/mobile_theme.dart';
import 'plugin_builder_screen.dart';

/// Packages use the same server parser and signature checks as the desktop.
/// Import inspection never grants installation or execution permissions.
class PluginPackageScreen extends StatefulWidget {
  final Future<List<XFile>> Function()? chooseFiles;
  const PluginPackageScreen({super.key, this.chooseFiles});
  @override
  State<PluginPackageScreen> createState() => _PluginPackageScreenState();
}

class _PluginPackageScreenState extends State<PluginPackageScreen> {
  int? _identity;
  MobileState? _owner;
  bool _invalidated = false;
  bool _busy = false;
  XFile? _file;
  Map<String, dynamic>? _preview;
  Map<String, dynamic>? _draft;
  String _error = '';
  String _receipt = '';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final state = MobileScope.of(context);
    _owner ??= state;
    _identity ??= state.identityRevision;
    if (!identical(_owner, state) || state.identityRevision != _identity) {
      _invalidated = true;
      _file = null;
      _draft = null;
      _preview = null;
      _receipt = '';
      _error = '';
    }
  }

  bool get _current =>
      mounted &&
      !_invalidated &&
      identical(_owner, MobileScope.read(context)) &&
      MobileScope.read(context).identityRevision == _identity;
  Future<void> _inspect(XFile file) async {
    if (!_current) return;
    // Never attach an older inspection to a newly selected package.
    setState(() {
      _file = file;
      _draft = null;
      _preview = null;
      _receipt = '';
      _error = '';
    });
    final api = _owner!.api;
    final length = await file.length();
    if (!_current) return;
    Map<String, dynamic>? draft;
    Map<String, dynamic>? preview;
    if (file.name.toLowerCase().endsWith('.json')) {
      if (length == 0 || length > 24 * 1024 * 1024) {
        throw const ApiFailure('草稿不能为空，且不能超过 24 MB。');
      }
      final decoded = jsonDecode(utf8.decode(await file.readAsBytes()));
      if (!_current) return;
      if (decoded is! Map ||
          decoded['name'] is! String ||
          !const [
            'method',
            'connector',
            'workflow',
            'app',
          ].contains(decoded['template'])) {
        throw const ApiFailure('这不是有效的插件草稿，请选择 PC 导出的草稿文件。');
      }
      draft = Map<String, dynamic>.from(decoded);
    } else {
      preview = await api.preflightPluginPackage(file);
      if (!_current) return;
      final raw = preview['personalDraft'];
      if (raw is Map) draft = Map<String, dynamic>.from(raw);
      if (preview.isEmpty) throw const ApiFailure('未收到插件包检查结果，请重试。');
    }
    if (!_current) return;
    setState(() {
      _draft = draft;
      _preview = preview;
    });
  }

  Future<void> _pick() async {
    if (!_current || _busy) return;
    setState(() {
      _busy = true;
    });
    try {
      final files = await (widget.chooseFiles ?? pickWorkFiles)();
      if (!_current || files.isEmpty) return;
      if (files.length != 1) throw const ApiFailure('每次请选择一个插件包或草稿。');
      await _inspect(files.single);
    } catch (error) {
      _readError(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _retry() async {
    if (!_current || _busy || _file == null) return;
    setState(() {
      _busy = true;
    });
    try {
      await _inspect(_file!);
    } catch (error) {
      _readError(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _readError(Object error) {
    if (!_current) return;
    setState(
      () =>
          _error = error is ApiFailure ? error.message : '无法读取插件，请确认文件完整且格式正确。',
    );
  }

  Future<void> _edit() async {
    if (!_current || _busy || _draft == null) return;
    final result = await Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute(
        builder: (_) => PluginBuilderScreen(initialValues: _draft!),
      ),
    );
    if (!_current || result == null) return;
    setState(() => _receipt = result['message']?.toString() ?? '草稿已提交，等待审核。');
  }

  Future<void> _submit() async {
    if (!_current ||
        _busy ||
        _file == null ||
        _preview == null ||
        _receipt.isNotEmpty) {
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final result = await MobileScope.read(
        context,
      ).api.submitPluginPackage(_file!);
      if (_current) {
        setState(
          () => _receipt = result['message']?.toString() ?? '原包已提交，等待审核。',
        );
      }
    } catch (error) {
      if (_current) {
        setState(
          () => _error = error is ApiFailure
              ? error.message
              : '提交未确认，请检查插件目录中的提交记录。',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    MobileScope.of(context);
    final identityChanged = !_current;
    final preview = _preview ?? const <String, dynamic>{};
    final manifest = preview['manifest'] is Map
        ? preview['manifest'] as Map
        : preview;
    return PopScope(
      canPop: !_busy || identityChanged,
      child: Scaffold(
        appBar: AppBar(title: const Text('导入插件')),
        body: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text('把已有工作方法带到手机', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(
              '支持 PC 导出的插件草稿、插件包和 ZIP。先检查内容，再确认编辑或提交。',
              style: TextStyle(
                color: context.soduWorkTheme.inkSecondary,
                height: 1.5,
              ),
            ),
            const SizedBox(height: 20),
            OutlinedButton.icon(
              onPressed: _busy || identityChanged ? null : _pick,
              icon: const Icon(Icons.file_open_outlined),
              label: Text(_file == null ? '选择插件文件' : '重新选择'),
            ),
            if (_busy && !identityChanged)
              const Padding(
                padding: EdgeInsets.all(20),
                child: Center(child: CircularProgressIndicator()),
              ),
            if (identityChanged) const Text('账号或服务已切换，请关闭后重新打开。'),
            if (!identityChanged && _error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  _error,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (!identityChanged && _file != null)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(Icons.extension_outlined, size: 32),
                      const SizedBox(height: 12),
                      Text(
                        (_draft?['name'] ?? manifest['name'] ?? _file!.name)
                            .toString(),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 6),
                      Text(_file!.name),
                      if ((_draft?['description'] ?? manifest['description']) !=
                          null)
                        Padding(
                          padding: const EdgeInsets.only(top: 10),
                          child: Text(
                            (_draft?['description'] ?? manifest['description'])
                                .toString(),
                          ),
                        ),
                      const SizedBox(height: 16),
                      if (preview['checks'] is List) ...[
                        for (final check
                            in (preview['checks'] as List).whereType<Map>())
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Icon(
                                  check['ok'] == true
                                      ? Icons.check_circle_outline
                                      : Icons.info_outline,
                                  size: 18,
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    check['label']?.toString() ?? '检查项',
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                      Text(
                        _preview == null
                            ? _draft != null
                                  ? '草稿将在编辑后检查；确认提交后进入企业审核。'
                                  : '文件尚未通过检查，请重新检查或选择其他文件。'
                            : '已读取插件包。提交原包保留原始文件；编辑会生成新的草稿。',
                      ),
                    ],
                  ),
                ),
              ),
            if (!identityChanged && _receipt.isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  _receipt,
                  style: TextStyle(color: context.soduWorkTheme.primary),
                ),
              ),
            if (!identityChanged &&
                _file != null &&
                _preview == null &&
                _draft == null)
              OutlinedButton(
                onPressed: _busy ? null : _retry,
                child: const Text('重新检查'),
              ),
            if (!identityChanged && _draft != null && _receipt.isEmpty)
              FilledButton(
                onPressed: _busy || identityChanged ? null : _edit,
                child: const Text('编辑并确认草稿'),
              ),
            if (!identityChanged && _preview != null && _receipt.isEmpty)
              OutlinedButton(
                onPressed: _busy || identityChanged ? null : _submit,
                child: const Text('提交原包审核'),
              ),
          ],
        ),
      ),
    );
  }
}

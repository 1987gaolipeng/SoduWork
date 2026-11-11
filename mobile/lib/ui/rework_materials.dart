import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import '../core/soduwork_api.dart';
import '../core/work_file_picker.dart';
import '../models/work_models.dart';

class ReworkMaterial {
  final XFile file;
  final int size;
  String attachmentId = '';
  String uploadedSourceRef = '';
  ReworkMaterial(this.file, this.size);
}

/// Selected reference files only; never counts as delivery or gate evidence.
class ReworkMaterialsController extends ChangeNotifier {
  final List<ReworkMaterial> _files = [];
  int _generation = 0;
  bool _closed = false;
  @override
  void dispose() {
    _closed = true;
    _generation++;
    super.dispose();
  }

  List<ReworkMaterial> get files => List.unmodifiable(_files);
  int get generation => _generation;
  bool get isEmpty => _files.isEmpty;
  void clear() {
    if (_closed) return;
    _generation++;
    _files.clear();
    notifyListeners();
  }

  void remove(ReworkMaterial material) {
    if (_closed) return;
    _generation++;
    _files.remove(material);
    notifyListeners();
  }

  Future<void> add(List<XFile> files) async {
    if (_closed) return;
    final generation = _generation;
    if (_files.length + files.length > 20) {
      throw const ApiFailure('返修资料最多添加20个文件。');
    }
    var bytes = _files.fold<int>(0, (total, item) => total + item.size);
    final additions = <ReworkMaterial>[];
    for (final file in files) {
      final size = await file.length();
      if (generation != _generation) return;
      bytes += size;
      if (size <= 0 || bytes > 90 * 1024 * 1024) {
        throw const ApiFailure('文件不能为空，返修资料合计不能超过90MB。');
      }
      additions.add(ReworkMaterial(file, size));
    }
    if (generation != _generation) return;
    _generation++;
    _files.addAll(additions);
    notifyListeners();
  }

  Future<List<String>> upload({
    required String sourceRef,
    required Future<Map<String, dynamic>> Function(XFile file) send,
    required void Function() check,
  }) async {
    if (_closed) throw const ApiFailure('当前资料选择已关闭。');
    final generation = _generation;
    final selected = List<ReworkMaterial>.of(_files);
    final ids = <String>[];
    for (final material in selected) {
      check();
      if (generation != _generation) {
        throw const ApiFailure('返修资料所属任务已变化，请重新选择。');
      }
      if (material.attachmentId.isNotEmpty &&
          material.uploadedSourceRef != sourceRef) {
        throw const ApiFailure('返修资料不属于当前审批，请重新选择。');
      }
      if (material.attachmentId.isEmpty) {
        final result = await send(material.file);
        check();
        if (generation != _generation) {
          throw const ApiFailure('返修资料所属任务已变化，请重新选择。');
        }
        final attachment = jsonMap(result['attachment']);
        final id = attachment['id'];
        if (result['ok'] != true ||
            id is! String ||
            id.isEmpty ||
            attachment['role'] != 'rework_input' ||
            attachment['sourceRef'] != sourceRef) {
          throw const ApiFailure('未确认返修资料的归属，请重试上传。');
        }
        material.attachmentId = id;
        material.uploadedSourceRef = sourceRef;
        notifyListeners();
      }
      ids.add(material.attachmentId);
    }
    return ids;
  }
}

class ReworkMaterialsPicker extends StatefulWidget {
  final ReworkMaterialsController controller;
  final bool busy;
  final Future<List<XFile>> Function()? filePicker;
  const ReworkMaterialsPicker({
    super.key,
    required this.controller,
    this.busy = false,
    this.filePicker,
  });
  @override
  State<ReworkMaterialsPicker> createState() => _ReworkMaterialsPickerState();
}

class _ReworkMaterialsPickerState extends State<ReworkMaterialsPicker> {
  bool _picking = false;
  String _error = '';
  Future<void> _pick() async {
    if (_picking || widget.busy) return;
    setState(() {
      _picking = true;
      _error = '';
    });
    final controller = widget.controller;
    final generation = controller.generation;
    try {
      final files = await (widget.filePicker ?? pickWorkFiles)();
      if (!mounted ||
          controller != widget.controller ||
          generation != controller.generation ||
          widget.busy) {
        return;
      }
      await controller.add(files);
    } on ApiFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = '读取文件失败，请重新选择。');
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.controller,
    builder: (_, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextButton.icon(
          onPressed: widget.busy || _picking ? null : _pick,
          icon: const Icon(Icons.attach_file),
          label: Text(
            _picking
                ? mobileText(context, '正在读取…')
                : mobileText(context, '添加返修资料'),
          ),
        ),
        Text(mobileText(context, '仅在退回时上传，作为修改参考，不计入交付产物。')),
        for (final item in widget.controller.files)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(
              item.file.name,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            subtitle: Text(
              item.attachmentId.isEmpty
                  ? mobileText(context, '等待退回时上传')
                  : mobileText(context, '已上传，重试会复用'),
            ),
            trailing: IconButton(
              tooltip: mobileText(context, "移除 {0}", values: [item.file.name]),
              onPressed: widget.busy
                  ? null
                  : () => widget.controller.remove(item),
              icon: const Icon(Icons.close, size: 18),
            ),
          ),
        if (_error.isNotEmpty) Text(mobileText(context, _error)),
      ],
    ),
  );
}

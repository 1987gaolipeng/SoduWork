import 'package:image_picker/image_picker.dart';
import 'soduwork_api.dart';

Future<List<XFile>> pickWorkFiles() async =>
    throw const ApiFailure('当前平台请先使用照片；文件选择正在适配。');

Future<void> saveWorkFile(XFile file, String filename) => file.saveTo(filename);

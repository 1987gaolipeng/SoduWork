import 'dart:async';
import 'dart:js_interop';
import 'package:image_picker/image_picker.dart';
import 'soduwork_api.dart';

@JS('document.createElement')
external JSObject _createElement(String tag);
@JS()
extension type _Input(JSObject value) implements JSObject {
  external set type(String value);
  external set multiple(bool value);
  external _Files? get files;
  external void addEventListener(String event, JSFunction callback);
  external void removeEventListener(String event, JSFunction callback);
  external void click();
}
@JS()
extension type _Files(JSObject value) implements JSObject {
  external int get length;
  external _File? item(int index);
}
@JS()
extension type _File(JSObject value) implements JSObject {
  external String get name;
  external int get size;
  external JSPromise<JSArrayBuffer> arrayBuffer();
}

Future<List<XFile>> pickWorkFiles() async {
  final input = _Input(_createElement('input'));
  input.type = 'file';
  input.multiple = true;
  final selected = Completer<List<XFile>>();
  late JSFunction change;
  late JSFunction cancel;
  change = ((JSAny? event) {
    (() async {
      try {
        final files = input.files;
        final out = <XFile>[];
        var total = 0;
        if (files != null) {
          if (files.length > 20) throw const ApiFailure('最多添加20个文件。');
          for (var index = 0; index < files.length; index++) {
            final file = files.item(index);
            if (file == null) continue;
            total += file.size;
            if (file.size <= 0 || total > 90 * 1024 * 1024) {
              throw const ApiFailure('文件不能为空，合计不能超过90MB。');
            }
          }
          for (var index = 0; index < files.length; index++) {
            final file = files.item(index);
            if (file == null) continue;
            final bytes = (await file.arrayBuffer().toDart).toDart
                .asUint8List();
            out.add(XFile.fromData(bytes, name: file.name));
          }
        }
        if (!selected.isCompleted) selected.complete(out);
      } catch (error, stack) {
        if (!selected.isCompleted) selected.completeError(error, stack);
      }
    })();
  }).toJS;
  cancel = ((JSAny? event) {
    if (!selected.isCompleted) selected.complete(const []);
  }).toJS;
  input.addEventListener('change', change);
  input.addEventListener('cancel', cancel);
  try {
    input.click();
    return await selected.future.timeout(
      const Duration(minutes: 3),
      onTimeout: () => const [],
    );
  } finally {
    input.removeEventListener('change', change);
    input.removeEventListener('cancel', cancel);
  }
}

Future<void> saveWorkFile(XFile file, String filename) => file.saveTo(filename);

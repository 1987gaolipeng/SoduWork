export 'work_file_picker_stub.dart'
    if (dart.library.io) 'work_file_picker_native.dart'
    if (dart.library.js_interop) 'work_file_picker_web.dart';

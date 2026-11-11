import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';

/// Restores the workspace section without persisting credentials or draft content.
class WorkspaceLocationStore {
  final String key;
  static final _writes = <String, Future<void>>{};
  WorkspaceLocationStore(String hub, String owner)
    : key = owner.isEmpty
          ? ''
          : 'soduwork.mobile.location.v1.${base64Url.encode(utf8.encode(jsonEncode([hub, owner])))}';

  Future<String?> read() async => key.isEmpty
      ? null
      : (await SharedPreferences.getInstance()).getString(key);

  Future<void> save(String location) {
    if (key.isEmpty) return Future.value();
    final operation = (_writes[key] ?? Future<void>.value()).then((_) async {
      await (await SharedPreferences.getInstance()).setString(key, location);
    });
    _writes[key] = operation.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return operation;
  }
}

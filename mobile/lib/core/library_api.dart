part of 'soduwork_api.dart';

extension MobileLibraryApi on SoduWorkApi {
  Future<Map<String, dynamic>> libraryStorage() async =>
      _asMap(await _authorized('GET', '/api/v1/library/storage/status'));
  Future<Map<String, dynamic>> libraryMembers() async =>
      _asMap(await _authorized('GET', '/api/v1/library/share-members'));
  Future<Map<String, dynamic>> libraryRemoteAction(
    String action, {
    String id = '',
    Map<String, dynamic> body = const {},
  }) async {
    final item = '/api/v1/library/items/${Uri.encodeComponent(id)}';
    final folder = '/api/v1/library/folders/${Uri.encodeComponent(id)}';
    final (method, route) = switch (action) {
      'shareSelection' => ('POST', '/api/v1/library/items/batch-share'),
      'deleteItems' => ('POST', '/api/v1/library/items/batch-delete'),
      'createItem' => ('POST', '/api/v1/library/items'),
      'updateItem' => ('PATCH', item),
      'deleteItem' => ('DELETE', item),
      'restoreItem' => ('POST', '$item/restore'),
      'purgeItem' => ('DELETE', '$item/purge'),
      'emptyTrash' => (
        'DELETE',
        '/api/v1/library/trash?${Uri(queryParameters: {'storage': body['storage']?.toString() ?? ''}).query}',
      ),
      'createFolder' => ('POST', '/api/v1/library/folders'),
      'updateFolder' => ('PATCH', folder),
      'deleteFolder' => ('DELETE', folder),
      'share' => ('POST', '$item/share'),
      'shareLocal' => ('POST', '/api/v1/library/share-local'),
      'archive' => ('GET', '$item/archive'),
      _ => throw const ApiFailure('不支持的资料操作'),
    };
    return _asMap(
      await _authorized(
        method,
        route,
        body: action == 'deleteItems'
            ? {'itemIds': body['ids']}
            : method == 'GET' || method == 'DELETE'
            ? null
            : body,
      ),
    );
  }
}

import 'package:flutter/material.dart';
import '../core/mobile_library.dart';
import '../core/soduwork_api.dart';
import '../state/mobile_scope.dart';
import 'capability_widgets.dart';

class LibraryTargets {
  final List<Map<String, dynamic>> computers;
  final Map<String, dynamic> remote;
  final String computerError;
  const LibraryTargets(this.computers, this.remote, this.computerError);

  static Future<LibraryTargets> load(SoduWorkApi api) async {
    Future<Map<String, dynamic>> read(
      Future<Map<String, dynamic>> request,
    ) async {
      try {
        return await request;
      } catch (e) {
        return {'error': e.toString()};
      }
    }

    final results = await Future.wait([
      read(api.desktopCapabilityTargets()),
      read(api.libraryStorage()),
    ]);
    final status = results.last;
    final remote = (status['storage'] as Map?)?['remote'] ?? status['remote'];
    return LibraryTargets(
      capabilityRows(results.first['items']),
      remote is Map
          ? Map<String, dynamic>.from(remote)
          : {'message': status['error'] ?? '远程存储未配置'},
      results.first['error']?.toString() ?? '',
    );
  }

  bool get remoteReady =>
      remote['available'] == true &&
      remote['connected'] == true &&
      const {'nfs', 'minio'}.contains(remote['backend']);
  LibraryLocation get remoteLocation =>
      LibraryLocation(storage: remote['backend'] as String, label: '远程存储');
  static bool usable(Map<String, dynamic> row) =>
      row['ready'] == true && row['libraryReady'] == true;
  static LibraryLocation pc(Map<String, dynamic> row) => LibraryLocation(
    clientId: row['id'].toString(),
    label: row['name']?.toString() ?? '本人电脑',
  );
}

Future<LibraryLocation?> chooseLibraryLocation(BuildContext context) async {
  final state = MobileScope.read(context), revision = state.identityRevision;
  final future = LibraryTargets.load(state.api);
  return showModalBottomSheet<LibraryLocation>(
    context: context,
    isScrollControlled: true,
    builder: (context) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: FutureBuilder<LibraryTargets>(
          future: future,
          builder: (context, snapshot) {
            if (revision != state.identityRevision) {
              return const Text('账号已切换，请重新打开');
            }
            final targets = snapshot.data;
            if (targets == null) {
              return const Center(child: CircularProgressIndicator());
            }
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('本地存储', style: Theme.of(context).textTheme.titleMedium),
                for (final pc in targets.computers)
                  ListTile(
                    leading: const Icon(Icons.computer),
                    title: Text(pc['name']?.toString() ?? '本人电脑'),
                    subtitle: Text(
                      LibraryTargets.usable(pc)
                          ? '资料保存在这台电脑'
                          : pc['reason']?.toString().isNotEmpty == true
                          ? pc['reason'].toString()
                          : '请打开并更新电脑客户端',
                    ),
                    enabled: LibraryTargets.usable(pc),
                    onTap: () => Navigator.pop(context, LibraryTargets.pc(pc)),
                  ),
                if (targets.computers.isEmpty)
                  ListTile(
                    title: Text(
                      targets.computerError.isEmpty
                          ? '请在本人电脑打开 SoduWork 并登录同一账号'
                          : targets.computerError,
                    ),
                  ),
                const Divider(),
                ListTile(
                  leading: const Icon(Icons.cloud_outlined),
                  title: const Text('远程存储'),
                  subtitle: Text(
                    targets.remoteReady
                        ? '同账号多设备访问'
                        : targets.remote['message']?.toString() ?? '远程存储未连接',
                  ),
                  enabled: targets.remoteReady,
                  onTap: () => Navigator.pop(context, targets.remoteLocation),
                ),
              ],
            );
          },
        ),
      ),
    ),
  );
}

import 'soduwork_api.dart';

/// Local Web automation is consumed by the authenticated computer helper.
/// An online chat Runner alone does not prove that this consumer is ready.
Future<void> ensureAutomationExecutionReady(
  SoduWorkApi api, {
  required Map<String, dynamic> configuration,
  required void Function() checkCurrent,
  Map<String, dynamic>? preflight,
  Future<void> Function(Duration)? wait,
}) async {
  checkCurrent();
  // Only a successful Hub preflight can identify an independently consumed run.
  if (preflight?['state'] == 'ready' &&
      preflight?['executionMode'] == 'soduwork.cloud-automation/v1') {
    return;
  }
  if (!api.isLocalDevelopment ||
      (configuration['pluginBindingId']?.toString().trim() ?? '').isNotEmpty) {
    return;
  }
  final delay = wait ?? Future<void>.delayed;
  for (var attempt = 0; attempt < 20; attempt++) {
    final status = await api.automationConsumerStatus();
    checkCurrent();
    if (status['ready'] == true) return;
    final reason = status['reason']?.toString().trim() ?? '';
    if (!{
          'starting',
          'preparing',
          'offline',
          'waiting',
        }.contains(status['state']) ||
        attempt == 19) {
      throw ApiFailure(reason.isEmpty ? '自动化助手尚未就绪，请保持电脑在线，稍后重试。' : reason);
    }
    await delay(const Duration(milliseconds: 500));
    checkCurrent();
  }
}

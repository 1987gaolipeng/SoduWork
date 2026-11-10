import 'package:flutter_test/flutter_test.dart';
import 'package:soduwork_mobile/core/plugin_publication.dart';

void main() {
  test('organization submissions use the PC three-stage review contract', () {
    final pending = PluginPublication({
      'scope': 'organization',
      'provenance': {'signatureState': 'unknown-key'},
    });
    expect(pending.steps.map((s) => s.label), ['提交成功', '管理员审核', '开放使用']);
    expect(pending.current.label, '管理员审核');
    expect(pending.current.detail, contains('无需重新上传'));
    expect(pending.signature.$1, '发布身份待登记');
    expect(pending.feedback, '管理员还没有给出审查结论。');
    expect(pending.available, isFalse);
  });

  test('strict review retains identity and evaluation gates', () {
    final strict = PluginPublication({
      'scope': 'organization',
      'reviewMode': 'platform-strict',
      'provenance': {'signatureState': 'verified'},
      'qualitySummary': {'verified': true},
    });
    expect(strict.steps.length, 5);
    expect(strict.current.label, '管理员审核');
    expect(strict.steps[1].state, 'done');
    expect(strict.steps[2].state, 'done');
  });

  test('approval and task-only availability are not personal installation', () {
    final row = <String, dynamic>{
      'trustState': 'approved',
      'enabled': true,
      'marketPolicy': {'installation': 'not_available'},
      'bindingCount': 0,
      'scope': 'organization',
    };
    expect(PluginPublication(row).status, '审核已通过');
    expect(PluginPublication(row).available, isFalse);
    row['bindingCount'] = 1;
    expect(PluginPublication(row).status, '已开放使用');
    expect(PluginPublication(row).current.detail, contains('不开放个人安装'));
    row['enabled'] = false;
    expect(PluginPublication(row).status, '已停用');
    expect(PluginPublication(row).available, isFalse);
  });

  test('revoked and rejected receipts override stale catalog readiness', () {
    for (final decision in ['revoke', 'reject']) {
      final publication = PluginPublication({
        'trustState': 'approved',
        'enabled': true,
        'catalogReady': true,
        'reviewDecision': decision,
      });
      expect(publication.available, isFalse);
      expect(publication.current.state, 'bad');
      expect(publication.status, decision == 'revoke' ? '已撤销' : '需修改');
    }
  });
}

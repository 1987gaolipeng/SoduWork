/// Read-only publication progress matching the PC publication contract.
class PublicationStep {
  final String label;
  final String detail;
  final String state;
  const PublicationStep(this.label, this.detail, this.state);
}

class PluginPublication {
  final Map<String, dynamic> row;
  const PluginPublication(this.row);
  String text(String key) => row[key]?.toString() ?? '';
  Map get proof =>
      row['provenance'] is Map ? row['provenance'] as Map : const {};
  Map get quality =>
      row['qualitySummary'] is Map ? row['qualitySummary'] as Map : const {};
  bool get rejected =>
      text('reviewDecision') == 'reject' || text('trustState') == 'rejected';
  bool get revoked =>
      text('reviewDecision') == 'revoke' || text('trustState') == 'revoked';
  bool get approved =>
      text('trustState') == 'approved' &&
      row['enabled'] == true &&
      !rejected &&
      !revoked;
  bool get taskOnly =>
      row['marketPolicy'] is Map &&
      (row['marketPolicy'] as Map)['installation'] == 'not_available';
  bool get available =>
      approved &&
      (row['catalogReady'] == true ||
          (taskOnly && (num.tryParse('${row['bindingCount']}') ?? 0) > 0));
  bool get internal =>
      text('reviewMode') == 'internal-light' ||
      (text('reviewMode') != 'platform-strict' &&
          text('scope') == 'organization');

  String get status {
    if (revoked) return '已撤销';
    if (rejected) return '需修改';
    if (row['catalogReady'] == true) return '已发布';
    if (approved) return available ? '已开放使用' : '审核已通过';
    if (text('trustState') == 'approved') return '已停用';
    return '待审核';
  }

  List<PublicationStep> get steps {
    final review = PublicationStep(
      '管理员审核',
      rejected
          ? '已退回修改'
          : revoked
          ? '已撤销版本'
          : approved
          ? '已批准当前不可变版本'
          : internal
          ? (proof['signatureState'] == 'unknown-key'
                ? '等待管理员核对发布身份并审核，无需重新上传'
                : '等待管理员审核当前版本与使用范围')
          : '等待管理员给出结论',
      rejected || revoked
          ? 'bad'
          : approved
          ? 'done'
          : 'waiting',
    );
    final availability = PublicationStep(
      internal ? '开放使用' : '企业目录',
      available
          ? (taskOnly ? '已配置需求与自动化使用范围，不开放个人安装' : '已上架，可按选定范围安装使用')
          : approved
          ? (taskOnly ? '仅供需求与自动化使用，等待管理员配置使用范围' : '已批准，等待管理员开放目录')
          : '审核通过后按选定范围开放',
      available ? 'done' : 'waiting',
    );
    if (internal) {
      return [
        const PublicationStep('提交成功', '当前版本与随包资源已保存', 'done'),
        review,
        availability,
      ];
    }
    final verified = {'verified', 'platform'}.contains(proof['signatureState']);
    final count = num.tryParse('${quality['caseCount']}') ?? 0;
    return [
      const PublicationStep('隔离入库', '不可变版本已固定', 'done'),
      PublicationStep(
        '发布身份',
        verified
            ? '签名和来源已验证'
            : approved
            ? '管理员已人工核对来源'
            : proof['signatureState'] == 'unknown-key'
            ? '等待登记本机发布公钥'
            : '等待管理员核对来源',
        verified || approved ? 'done' : 'waiting',
      ),
      PublicationStep(
        '发布评测',
        quality['verified'] == true
            ? (quality['message']?.toString() ?? '发布评测已验证')
            : count == 0
            ? (approved ? '管理员已确认无代表性评测的风险' : '尚未声明代表性发布评测')
            : (quality['message']?.toString() ?? '等待发布评测结果'),
        quality['verified'] == true
            ? 'done'
            : count == 0 && approved
            ? 'warn'
            : 'waiting',
      ),
      review,
      availability,
    ];
  }

  PublicationStep get current {
    final items = steps;
    return items.firstWhere(
      (s) => s.state == 'bad',
      orElse: () =>
          items.firstWhere((s) => s.state != 'done', orElse: () => items.last),
    );
  }

  String get audience => switch (text('visibility')) {
    'users' => '指定 ${row['audienceCount'] ?? 0} 人',
    'org_units' => '指定 ${row['audienceCount'] ?? 0} 个团队',
    'organization' => '全公司',
    _ => '使用范围待确认',
  };
  (String, String) get signature => switch (proof['signatureState']) {
    'verified' => ('签名已验证', '平台已确认这是登记发布者签出的原始版本'),
    'platform' => ('平台来源', '由 SoduWork 平台内置并校验'),
    'unknown-key' => ('发布身份待登记', '管理员登记本机公钥后才能发布；不需要重新上传'),
    _ => ('普通隔离审查', '这个版本没有发布者签名，需要管理员人工核对来源'),
  };
  String get feedback => text('reviewNote').isNotEmpty
      ? text('reviewNote')
      : switch (text('reviewDecision')) {
          'approve' => '管理员已通过这个版本。',
          'revoke' => '管理员已撤销这个版本。',
          'reject' => '管理员已退回当前版本，尚未提供修改说明。',
          _ => '管理员还没有给出审查结论。',
        };
}

import 'mobile_display_preferences.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/work_models.dart';
import 'mobile_theme.dart';
import 'work_widgets.dart';

/// Renders the backend `soduwork.gate/1.0` packet without inventing readiness.
class GateDecisionSummary extends StatelessWidget {
  final ApprovalItem item;

  const GateDecisionSummary({super.key, required this.item});

  @override
  Widget build(BuildContext context) {
    final gate = item.gate;
    final readiness = jsonMap(gate['readiness']);
    final subject = jsonMap(gate['subject']);
    final requirements = jsonList(
      gate['requirements'],
    ).map(jsonMap).where((row) => row.isNotEmpty).toList(growable: false);
    final known = readiness.isNotEmpty;
    final ready = item.canApprove;
    final tone = !known
        ? context.soduWorkTheme.secondary
        : ready
        ? context.soduWorkTheme.success
        : context.soduWorkTheme.warning;
    final soft = !known
        ? context.soduWorkTheme.secondarySoft
        : ready
        ? context.soduWorkTheme.successSoft
        : context.soduWorkTheme.warningSoft;
    final environment = (subject['environmentName'] ?? '').toString().trim();
    final fingerprint = (subject['fingerprint'] ?? '').toString().trim();
    final artifactSeq = (subject['artifactSeq'] ?? '').toString().trim();

    return Semantics(
      container: true,
      label: mobileText(context, ready ? '门禁证据已就绪' : '门禁证据尚未就绪'),
      child: WorkSurface(
        padding: EdgeInsets.zero,
        child: Container(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 13),
          decoration: BoxDecoration(
            border: Border(left: BorderSide(color: tone, width: 4)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: soft,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      ready
                          ? Icons.verified_rounded
                          : Icons.rule_folder_outlined,
                      size: 18,
                      color: tone,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          !known
                              ? mobileText(context, '请核对后决定')
                              : ready
                              ? mobileText(context, '证据就绪，可以确认')
                              : mobileText(context, '还不能通过'),
                          style: TextStyle(
                            color: context.soduWorkTheme.ink,
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _statusLine(context, known: known, ready: ready),
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  Text(
                    mobileText(
                      context,
                      "{0} 份证据",
                      values: [item.evidenceCount],
                    ),
                    style: TextStyle(
                      color: tone,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              if (environment.isNotEmpty ||
                  artifactSeq.isNotEmpty ||
                  fingerprint.isNotEmpty) ...[
                const SizedBox(height: 12),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    if (environment.isNotEmpty)
                      _FactChip(icon: Icons.cloud_outlined, label: environment),
                    if (artifactSeq.isNotEmpty)
                      _FactChip(
                        icon: Icons.inventory_2_outlined,
                        label: mobileText(
                          context,
                          '固定版本 v{0}',
                          values: [artifactSeq],
                        ),
                      ),
                    if (fingerprint.isNotEmpty)
                      _FactChip(
                        icon: Icons.fingerprint_rounded,
                        label: fingerprint.length > 12
                            ? fingerprint.substring(0, 12)
                            : fingerprint,
                      ),
                  ],
                ),
              ],
              if (requirements.isNotEmpty) ...[
                const SizedBox(height: 12),
                Container(height: 1, color: context.soduWorkTheme.line),
                const SizedBox(height: 4),
                for (final requirement in requirements)
                  _RequirementRow(requirement: requirement),
              ],
              const SizedBox(height: 8),
              Text(
                mobileText(context, _nextStep(item.action)),
                style: TextStyle(
                  color: context.soduWorkTheme.inkSecondary,
                  fontSize: 12.5,
                  height: 1.45,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _statusLine(
    BuildContext context, {
    required bool known,
    required bool ready,
  }) {
    if (!known) return mobileText(context, '请结合完成标准和证据判断当前固定版本。');
    if (ready) return mobileText(context, '必需证据均已通过校验，决定会被完整留痕。');
    return item.blockers.isEmpty
        ? mobileText(context, '必需证据尚未满足，请补齐后再确认。')
        : mobileText(context, '还缺：{0}', values: [item.blockers.join('、')]);
  }

  String _nextStep(String action) => switch (action) {
    'baseline' => '通过后：任务按确认后的需求基线继续执行。',
    'review' => '通过后：当前固定成果进入下一环；驳回意见会回流返修。',
    'merge' => '通过后：系统自动合并这次已锁定的代码提交。',
    'deploy' => '通过后：系统按已配置的发布通路进入目标环境。',
    'uat' => '通过后：本次环境验收闭环，流程继续进入后续阶段。',
    _ => '通过或驳回都会写入任务全链路，作为后续执行依据。',
  };
}

class _FactChip extends StatelessWidget {
  final IconData icon;
  final String label;

  const _FactChip({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: context.soduWorkTheme.surfaceMuted,
        borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusSmall),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: context.soduWorkTheme.inkMuted),
          const SizedBox(width: 4),
          Text(
            label,
            style: TextStyle(
              color: context.soduWorkTheme.inkSecondary,
              fontSize: 11.5,
            ),
          ),
        ],
      ),
    );
  }
}

class _RequirementRow extends StatelessWidget {
  final Map<String, dynamic> requirement;

  const _RequirementRow({required this.requirement});

  @override
  Widget build(BuildContext context) {
    final satisfied = requirement['satisfied'] == true;
    final label = (requirement['label'] ?? '必需证据').toString();
    final color = satisfied
        ? context.soduWorkTheme.success
        : context.soduWorkTheme.warning;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        children: [
          Icon(
            satisfied ? Icons.check_circle_rounded : Icons.pending_outlined,
            color: color,
            size: 17,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                color: context.soduWorkTheme.inkSecondary,
                fontSize: 13,
              ),
            ),
          ),
          Text(
            satisfied ? mobileText(context, '已满足') : mobileText(context, '待补齐'),
            style: TextStyle(
              color: color,
              fontSize: 11.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class GateEvidenceList extends StatelessWidget {
  final List<dynamic> evidence;
  final Map<String, String> headers;
  final String Function(String) absoluteUrl;

  const GateEvidenceList({
    super.key,
    required this.evidence,
    required this.headers,
    required this.absoluteUrl,
  });

  @override
  Widget build(BuildContext context) {
    if (evidence.isEmpty) {
      return WorkSurface(
        child: Row(
          children: [
            Icon(Icons.fact_check_outlined, color: context.soduWorkTheme.inkMuted),
            const SizedBox(width: 11),
            Expanded(
              child: Text(
                mobileText(context, '还没有可复核证据。验收截图可直接拍照补充，其他证据由执行链路自动归集。'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        ),
      );
    }
    return WorkSurface(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (var index = 0; index < evidence.length; index++) ...[
            _EvidenceRow(
              evidence: jsonMap(evidence[index]),
              headers: headers,
              absoluteUrl: absoluteUrl,
            ),
            if (index < evidence.length - 1)
              const Divider(indent: 48, endIndent: 12),
          ],
        ],
      ),
    );
  }
}

class _EvidenceRow extends StatelessWidget {
  final Map<String, dynamic> evidence;
  final Map<String, String> headers;
  final String Function(String) absoluteUrl;

  const _EvidenceRow({
    required this.evidence,
    required this.headers,
    required this.absoluteUrl,
  });

  @override
  Widget build(BuildContext context) {
    final kind = (evidence['kind'] ?? 'file').toString().toLowerCase();
    final verification = jsonMap(evidence['verification']);
    final failed = verification['state'] == 'failed';
    final passed = verification['state'] == 'passed';
    final rawUrl = (evidence['url'] ?? evidence['downloadUrl'] ?? '')
        .toString();
    final url = rawUrl.isEmpty ? '' : absoluteUrl(rawUrl);
    final title =
        (evidence['title'] ??
                evidence['name'] ??
                evidence['filename'] ??
                mobileText(context, _kindLabel(kind)))
            .toString();
    final summary = (evidence['summary'] ?? evidence['value'] ?? '')
        .toString()
        .trim();
    final isImage = kind == 'image';
    final actionable = url.isNotEmpty;
    final statusColor = failed
        ? context.soduWorkTheme.danger
        : passed
        ? context.soduWorkTheme.success
        : context.soduWorkTheme.inkMuted;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: actionable
            ? () => _open(context, url, title, image: isImage)
            : null,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(13, 11, 11, 11),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              if (isImage && url.isNotEmpty)
                ClipRRect(
                  borderRadius: BorderRadius.circular(
                    context.soduWorkTheme.radiusSmall,
                  ),
                  child: Image.network(
                    url,
                    headers: headers,
                    width: 46,
                    height: 46,
                    fit: BoxFit.cover,
                    errorBuilder: (_, _, _) =>
                        _EvidenceIcon(kind: kind, color: statusColor),
                  ),
                )
              else
                _EvidenceIcon(kind: kind, color: statusColor),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: SelectableText(
                            title,
                            maxLines: 1,
                            style: TextStyle(
                              color: context.soduWorkTheme.ink,
                              fontSize: 13.5,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          failed
                              ? mobileText(context, '未通过')
                              : passed
                              ? mobileText(context, '已验证')
                              : mobileText(context, _kindLabel(kind)),
                          style: TextStyle(
                            color: statusColor,
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                    if (summary.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      SelectableText(
                        summary,
                        maxLines: 2,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ],
                ),
              ),
              if (actionable) ...[
                const SizedBox(width: 6),
                Icon(
                  Icons.chevron_right_rounded,
                  size: 19,
                  color: context.soduWorkTheme.inkMuted,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _open(
    BuildContext context,
    String url,
    String title, {
    required bool image,
  }) async {
    if (image) {
      await showDialog<void>(
        context: context,
        builder: (_) => Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(title: Text(title)),
            body: InteractiveViewer(
              child: Center(
                child: Image.network(
                  url,
                  headers: headers,
                  errorBuilder: (_, _, _) =>
                      const Icon(Icons.broken_image_outlined, size: 44),
                ),
              ),
            ),
          ),
        ),
      );
      return;
    }
    final uri = Uri.tryParse(url);
    if (uri == null ||
        !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(mobileText(context, '暂时无法打开这条证据地址。'))),
        );
      }
    }
  }

  String _kindLabel(String kind) => switch (kind) {
    'image' => '截图',
    'check' => '检查',
    'commit' => '提交',
    'url' => '地址',
    _ => '文件',
  };
}

class _EvidenceIcon extends StatelessWidget {
  final String kind;
  final Color color;

  const _EvidenceIcon({required this.kind, required this.color});

  @override
  Widget build(BuildContext context) {
    final icon = switch (kind) {
      'image' => Icons.image_outlined,
      'check' => Icons.monitor_heart_outlined,
      'commit' => Icons.commit_rounded,
      'url' => Icons.language_rounded,
      _ => Icons.insert_drive_file_outlined,
    };
    return Container(
      width: 38,
      height: 38,
      decoration: BoxDecoration(
        color: color.withValues(alpha: .09),
        borderRadius: BorderRadius.circular(context.soduWorkTheme.radiusSmall),
      ),
      child: Icon(icon, size: 19, color: color),
    );
  }
}

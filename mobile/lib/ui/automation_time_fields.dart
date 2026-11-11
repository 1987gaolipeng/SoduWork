import 'mobile_input_border.dart';
import 'package:flutter/material.dart';
import 'mobile_display_preferences.dart';
import 'mobile_select_field.dart';

// Beijing time has no daylight-saving transitions for current schedules.
// Other zones retain the existing device-time editor and its explicit label.
bool automationUsesBeijing(String zone) => zone.trim() == 'Asia/Shanghai';
DateTime automationDisplayTime(DateTime instant, String zone) =>
    automationUsesBeijing(zone)
    ? instant.toUtc().add(const Duration(hours: 8))
    : instant.toLocal();

DateTime? automationParseDate(String text, int hour, int minute, String zone) {
  final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(text.trim());
  if (match == null) return null;
  final year = int.parse(match[1]!);
  final month = int.parse(match[2]!);
  final day = int.parse(match[3]!);
  final value = DateTime.utc(year, month, day, hour, minute);
  if (value.year != year ||
      value.month != month ||
      value.day != day ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59) {
    return null;
  }
  return automationUsesBeijing(zone)
      ? value.subtract(const Duration(hours: 8))
      : DateTime(year, month, day, hour, minute).toUtc();
}

String _two(int value) => value.toString().padLeft(2, '0');
String _date(DateTime value) =>
    '${value.year}-${_two(value.month)}-${_two(value.day)}';

class AutomationClockFields extends StatelessWidget {
  final int hour;
  final int minute;
  final bool hourly;
  final bool enabled;
  final void Function(int hour, int minute) onChanged;
  const AutomationClockFields({
    super.key,
    required this.hour,
    required this.minute,
    this.hourly = false,
    required this.enabled,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) => Row(
    children: [
      if (!hourly) ...[
        Expanded(
          child: MobileSelectField<int>(
            key: const Key('automation-hour'),
            compact: true,
            initialValue: hour,
            decoration: InputDecoration(labelText: mobileText(context, '小时')),
            items: [
              for (var i = 0; i < 24; i++)
                DropdownMenuItem(value: i, child: Text(_two(i))),
            ],
            onChanged: enabled ? (value) => onChanged(value!, minute) : null,
          ),
        ),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 10),
          child: Text(':'),
        ),
      ],
      Expanded(
        child: MobileSelectField<int>(
          key: const Key('automation-minute'),
          compact: true,
          initialValue: minute,
          decoration: InputDecoration(
            labelText: mobileText(context, hourly ? '每小时第几分' : '分钟'),
          ),
          items: [
            for (var i = 0; i < 60; i++)
              DropdownMenuItem(value: i, child: Text(_two(i))),
          ],
          onChanged: enabled ? (value) => onChanged(hour, value!) : null,
        ),
      ),
    ],
  );
}

class AutomationDateTimeFields extends StatefulWidget {
  final DateTime? value;
  final String zone;
  final bool enabled;
  final ValueChanged<DateTime?> onChanged;
  const AutomationDateTimeFields({
    super.key,
    required this.value,
    required this.zone,
    required this.enabled,
    required this.onChanged,
  });
  @override
  State<AutomationDateTimeFields> createState() =>
      _AutomationDateTimeFieldsState();
}

class _AutomationDateTimeFieldsState extends State<AutomationDateTimeFields> {
  late final TextEditingController _dateText;
  late int _hour;
  late int _minute;
  @override
  void initState() {
    super.initState();
    final shown = automationDisplayTime(
      widget.value ?? DateTime.now().add(const Duration(minutes: 5)),
      widget.zone,
    );
    _dateText = TextEditingController(
      text: widget.value == null ? '' : _date(shown),
    );
    _hour = shown.hour;
    _minute = shown.minute;
  }

  @override
  void didUpdateWidget(covariant AutomationDateTimeFields oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.zone != widget.zone && widget.value != null) {
      final shown = automationDisplayTime(widget.value!, widget.zone);
      _dateText.text = _date(shown);
      _hour = shown.hour;
      _minute = shown.minute;
    }
  }

  void _changed() => widget.onChanged(
    automationParseDate(_dateText.text, _hour, _minute, widget.zone),
  );
  @override
  void dispose() {
    _dateText.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      TextFormField(
        key: const Key('automation-date'),
        controller: _dateText,
        enabled: widget.enabled,
        keyboardType: TextInputType.datetime,
        decoration: InputDecoration(
          labelText: mobileText(
            context,
            automationUsesBeijing(widget.zone) ? '执行日期 · 北京时间' : '执行日期 · 设备时间',
          ),
          hintText: 'YYYY-MM-DD',
          isDense: true,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 12,
            vertical: 14,
          ),
          border: MobileInputBorder(borderRadius: BorderRadius.circular(10)),
        ),
        onChanged: (_) => _changed(),
        validator: (text) =>
            automationParseDate(text ?? '', _hour, _minute, widget.zone) == null
            ? mobileText(context, '请输入有效日期，如 2026-11-02')
            : null,
      ),
      Row(
        children: [
          for (final entry in const [(0, '今天'), (1, '明天')])
            TextButton(
              onPressed: !widget.enabled
                  ? null
                  : () {
                      final now = automationDisplayTime(
                        DateTime.now(),
                        widget.zone,
                      );
                      _dateText.text = _date(
                        DateTime(now.year, now.month, now.day + entry.$1),
                      );
                      _changed();
                    },
              child: Text(mobileText(context, entry.$2)),
            ),
          const Spacer(),
          Text(
            mobileText(context, '24 小时制'),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
      AutomationClockFields(
        hour: _hour,
        minute: _minute,
        enabled: widget.enabled,
        onChanged: (hour, minute) {
          setState(() {
            _hour = hour;
            _minute = minute;
          });
          _changed();
        },
      ),
    ],
  );
}

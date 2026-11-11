import 'package:flutter/material.dart';
import 'mobile_display_preferences.dart';

class LocationSwitchRow extends StatelessWidget {
  const LocationSwitchRow({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
    this.maxLines = 1,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final int maxLines;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Row(
          children: [
            Icon(
              icon,
              size: 18,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                label,
                maxLines: maxLines,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              mobileText(context, '切换'),
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            const Icon(Icons.expand_more, size: 16),
          ],
        ),
      ),
    ),
  );
}

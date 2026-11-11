import 'package:flutter/material.dart';
import '../ui/mobile_display_preferences.dart';
import 'connector_catalog_screen.dart';
import 'plugin_catalog_screen.dart';
import 'skill_catalog_screen.dart';
import 'desktop_capabilities_screen.dart';

class CapabilityCenterScreen extends StatefulWidget {
  final VoidCallback? onConversationCreate;
  const CapabilityCenterScreen({super.key, this.onConversationCreate});
  @override
  State<CapabilityCenterScreen> createState() => _CapabilityCenterScreenState();
}

class _CapabilityCenterScreenState extends State<CapabilityCenterScreen> {
  bool _personal = true;
  int _tab = 0;
  final Set<int> _visited = {0};
  @override
  Widget build(BuildContext context) => _personal
      ? DesktopCapabilitiesScreen(
          onEnterprise: () => setState(() => _personal = false),
        )
      : Column(
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () => setState(() => _personal = true),
                icon: const Icon(Icons.computer),
                label: const Text('返回本人电脑'),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    for (final entry in [
                      (0, '插件'),
                      (1, '连接器'),
                      (2, '技能'),
                      (3, '市场'),
                    ])
                      ChoiceChip(
                        label: Text(mobileText(context, entry.$2)),
                        selected: _tab == entry.$1,
                        onSelected: (_) => setState(() {
                          _tab = entry.$1;
                          _visited.add(_tab);
                        }),
                      ),
                  ],
                ),
              ),
            ),
            Expanded(
              child: IndexedStack(
                index: _tab,
                children: [
                  PluginCatalogScreen(
                    key: const ValueKey('plugins'),
                    onConversationCreate: widget.onConversationCreate,
                  ),
                  if (_visited.contains(1))
                    const ConnectorCatalogScreen()
                  else
                    const SizedBox.shrink(),
                  if (_visited.contains(2))
                    const SkillCatalogScreen()
                  else
                    const SizedBox.shrink(),
                  if (_visited.contains(3))
                    const PluginCatalogScreen(
                      key: ValueKey('market'),
                      marketOnly: true,
                    )
                  else
                    const SizedBox.shrink(),
                ],
              ),
            ),
          ],
        );
}

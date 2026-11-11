/// Match the PC catalog boundary, including legacy navigation applications.
bool isWorkspaceApplication(Map<String, dynamic> item) {
  if (item['template'] == 'app') return true;
  final ui = item['ui'];
  if (ui is! Map) return false;
  final contributions = ui['contributions'];
  return contributions is List &&
      contributions.whereType<Map>().any(
        (row) => row['slot'] == 'workspace.navigation',
      );
}

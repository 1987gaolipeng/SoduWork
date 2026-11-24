const rows = [
  ["处理中…", "Processing…", "処理中…", "처리 중…"],
  ["已删除", "Deleted", "削除しました", "삭제되었습니다"],
  ["删除「{0}」将永久移除该服务及其模型，此操作不可撤销。", "Deleting “{0}” permanently removes the service and its models. This cannot be undone.", "「{0}」を削除すると、サービスとそのモデルが完全に削除されます。元に戻せません。", "‘{0}’ 서비스를 삭제하면 해당 서비스와 모델이 영구적으로 삭제됩니다. 되돌릴 수 없습니다."],
  ["将删除的模型（{0}）", "Models to delete ({0})", "削除するモデル（{0}）", "삭제할 모델 ({0})"],
  ["以下清单按共享模型名称匹配当前选择。同名模型可能也由其他服务提供。", "These lists match current selections by shared model name. Another service may offer the same name.", "現在の選択と共有モデル名を照合した一覧です。他のサービスが同名のモデルを提供している場合があります。", "현재 선택과 공유 모델 이름이 일치하는 항목입니다. 다른 서비스에도 같은 이름의 모델이 있을 수 있습니다."],
  ["仅显示你有权查看的成员和需求。", "Only members and issues you can view are shown.", "閲覧権限のあるメンバーと要件のみ表示されます。", "조회 권한이 있는 구성원과 요구사항만 표시합니다."],
  ["已保存模型偏好的成员（{0}）", "Members with saved model preferences ({0})", "モデル設定を保存しているメンバー（{0}）", "모델 설정을 저장한 구성원 ({0})"],
  ["需用户管理权限才能查看成员清单。", "User management permission is required to view members.", "メンバー一覧の閲覧にはユーザー管理権限が必要です。", "구성원 목록을 보려면 사용자 관리 권한이 필요합니다."],
  ["引用模型的未完成需求（{0}）", "Open issues referencing these models ({0})", "モデルを参照する未完了の要件（{0}）", "모델을 참조하는 미완료 요구사항 ({0})"],
  ["需需求查看权限才能查看需求清单。", "Issue viewing permission is required to view the list.", "要件一覧の閲覧には要件の閲覧権限が必要です。", "요구사항 목록을 보려면 요구사항 조회 권한이 필요합니다."],
  ["输入服务 ID「{0}」确认删除", "Type the service ID “{0}” to confirm deletion", "削除するにはサービス ID「{0}」を入力してください", "삭제하려면 서비스 ID ‘{0}’을 입력하세요"],
  ["删除影响已变化，请重新核对清单后确认", "The deletion impact has changed. Review the updated lists and confirm again.", "削除の影響範囲が変わりました。一覧を再確認してから確定してください。", "삭제 영향 범위가 변경되었습니다. 목록을 다시 확인하고 승인하세요."],
  ["请刷新管理端，预览删除影响并输入服务 ID 后再删除", "Reload the admin console, review the deletion impact, and enter the service ID before deleting.", "管理画面を再読み込みし、削除の影響を確認してサービス ID を入力してください。", "관리 화면을 새로 고침한 뒤 삭제 영향을 확인하고 서비스 ID를 입력하세요."],
  ["输入的服务 ID 不匹配", "The service ID does not match.", "入力したサービス ID が一致しません。", "입력한 서비스 ID가 일치하지 않습니다."],
]
const catalog = index => Object.fromEntries(rows.map(row => [row[0], row[index]]))
export default catalog(1)
export const ja = catalog(2)
export const ko = catalog(3)

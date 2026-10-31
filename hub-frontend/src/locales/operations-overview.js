// Strings composed by the Hub backend (app/services/operations.py) and rendered
// verbatim by the operations screen: blocker titles/details, topology labels and
// the recent-failure fallback. The zh-CN source string stays the stable dictionary
// key, exactly like the access catalogs. Backend-composed templates keep their
// {0} placeholder; the screen interpolates counts and exception names before the
// translation pass. The native file-picker captions of the client release upload
// dialog live here too because they are the same class of host-locale leakage.
export default {
  '数据库连接正常': 'Database connection healthy',
  '数据库不可用': 'Database unavailable',
  '数据库不可用：{0}': 'Database unavailable: {0}',
  '没有可接活的 Runner': 'No Runners accepting work',
  '请检查节点在线状态或退出排空模式。': 'Check node online status or turn off drain mode.',
  '{0} 条流程失败': '{0} failed workflows',
  '进入运行与交付查看失败节点和重试证据。': 'Open Runs & delivery to inspect failed nodes and retry evidence.',
  '多实例控制面': 'Multi-instance control plane',
  '单 Hub 控制面': 'Single-Hub control plane',
  '共享路由与事件总线': 'Shared routing and event bus',
  '本节点直接路由': 'Direct routing on this node',
  '流程执行失败': 'Workflow run failed',
  '选择文件': 'Choose file',
  '未选择任何文件': 'No file chosen',
}
export const ja = {
  '数据库连接正常': 'データベース接続は正常です',
  '数据库不可用': 'データベースに接続できません',
  '数据库不可用：{0}': 'データベースに接続できません: {0}',
  '没有可接活的 Runner': '作業を受け付けられる Runner がありません',
  '请检查节点在线状态或退出排空模式。': 'ノードのオンライン状態を確認するか、ドレイン モードを解除してください。',
  '{0} 条流程失败': 'ワークフローが {0} 件失敗しました',
  '进入运行与交付查看失败节点和重试证据。': '実行と配信を開いて、失敗したノードと再試行の証跡を確認してください。',
  '多实例控制面': 'マルチインスタンス制御プレーン',
  '单 Hub 控制面': 'シングル Hub 制御プレーン',
  '共享路由与事件总线': '共有ルーティングとイベントバス',
  '本节点直接路由': 'このノードが直接ルーティングします',
  '流程执行失败': 'ワークフローの実行に失敗しました',
  '选择文件': 'ファイルを選択',
  '未选择任何文件': 'ファイルが選択されていません',
}
export const ko = {
  '数据库连接正常': '데이터베이스 연결이 정상입니다',
  '数据库不可用': '데이터베이스를 사용할 수 없음',
  '数据库不可用：{0}': '데이터베이스를 사용할 수 없음: {0}',
  '没有可接活的 Runner': '작업을 수락할 수 있는 Runner가 없습니다',
  '请检查节点在线状态或退出排空模式。': '노드 온라인 상태를 확인하거나 드레인 모드를 해제하세요.',
  '{0} 条流程失败': '실패한 워크플로 {0}건',
  '进入运行与交付查看失败节点和重试证据。': '실행 및 전달에서 실패한 노드와 재시도 증거를 확인하세요.',
  '多实例控制面': '다중 인스턴스 제어 평면',
  '单 Hub 控制面': '단일 Hub 제어 평면',
  '共享路由与事件总线': '공유 라우팅 및 이벤트 버스',
  '本节点直接路由': '이 노드가 직접 라우팅합니다',
  '流程执行失败': '워크플로 실행 실패',
  '选择文件': '파일 선택',
  '未选择任何文件': '선택된 파일 없음',
}

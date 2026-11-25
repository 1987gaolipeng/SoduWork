// Strings composed by the Hub backend (app/services/operations.py) and rendered
// verbatim by the operations screen: blocker titles/details, topology labels and
// the recent-failure fallback. The zh-CN source string stays the stable dictionary
// key, exactly like the access catalogs. Backend-composed templates keep their
// {0} placeholder; the screen interpolates counts and exception names before the
// translation pass. The native file-picker captions of the client release upload
// dialog live here too because they are the same class of host-locale leakage.
const installerCopy = [
  ["点右上角「上传发布」，选择一个安装包，后台会自动解析、签名并登记。", "Choose Upload release and select one installer. The server inspects, signs and registers it automatically.", "「リリースをアップロード」でインストーラーを1つ選ぶと、サーバーが自動で解析、署名、登録します。", "배포 업로드에서 설치 파일 하나를 선택하면 서버가 자동으로 분석, 서명 및 등록합니다."],
  ["只需上传安装包，后台自动解析版本与平台、签名并登记。新登记的安装包默认停用，确认后再启用。", "Upload only the installer. The server reads its version and platform, signs it and registers it. New releases stay disabled until you enable them.", "インストーラーだけをアップロードしてください。サーバーがバージョンとプラットフォームを解析し、署名して登録します。新規登録は確認後に有効化してください。", "설치 파일만 업로드하세요. 서버가 버전과 플랫폼을 분석하고 서명하여 등록합니다. 새 배포는 확인 후 활성화하세요."],
  ["发布通道", "Release channel", "リリースチャンネル", "배포 채널"],
  ["使用当前环境默认通道", "Use this environment’s default channel", "この環境の既定チャンネルを使用", "현재 환경의 기본 채널 사용"],
  ["选择 beta 通道不会更改安装包版本；无 beta 后缀的包仅供手动安装。", "The beta channel does not change the package version. Packages without a beta suffix require manual installation.", "beta チャンネルを選んでもパッケージのバージョンは変わりません。beta 接尾辞のないパッケージは手動でインストールしてください。", "beta 채널을 선택해도 패키지 버전은 바뀌지 않습니다. beta 접미사가 없는 패키지는 수동으로 설치해야 합니다."],
  ["文件已传输，后台正在解析、签名并登记…", "File transferred. The server is inspecting, signing and registering it…", "転送完了。サーバーで解析、署名、登録しています…", "파일 전송 완료. 서버에서 분석, 서명 및 등록 중…"],
  ["该安装包已登记，保留原有发布状态。", "This installer is already registered. Its release state is unchanged.", "このインストーラーは登録済みです。公開状態は変更されていません。", "이미 등록된 설치 파일입니다. 기존 배포 상태가 유지됩니다."],
]
const installerLabels = column => Object.fromEntries(installerCopy.map(row => [row[0], row[column]]))
export default {
  ...installerLabels(1),
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
  ...installerLabels(2),
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
  ...installerLabels(3),
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

const rows = [
  ["使用日报示例", "Use daily report example", "日報サンプルを使用", "일일 보고 예시 사용"],
  ["汇总今天完成的工作、遇到的阻碍和明天的计划。", "Summarize completed work, blockers and plans for tomorrow.", "今日の成果、課題、明日の予定をまとめてください。", "오늘 완료한 일, 어려웠던 점, 내일 계획을 요약하세요."],
  ["调度与执行设置", "Schedule and execution settings", "スケジュールと実行設定", "일정 및 실행 설정"],
  ["默认生效日期", "Default effective dates", "既定の有効期間", "기본 유효 기간"],
  ["长期有效", "No date limits", "期間制限なし", "기간 제한 없음"],
  ["开始日期", "Start date", "開始日", "시작일"],
  ["结束日期", "End date", "終了日", "종료일"],
  ["开始日期无效，请重新选择", "Choose a valid start date", "有効な開始日を選択してください", "유효한 시작일을 선택하세요"],
  ["结束日期无效，请重新选择", "Choose a valid end date", "有効な終了日を選択してください", "유효한 종료일을 선택하세요"],
  ["开始日期不能晚于结束日期", "The start date cannot be after the end date", "開始日は終了日以前にしてください", "시작일은 종료일보다 늦을 수 없습니다"],
  ["请选择开始或结束日期，或选择长期有效", "Choose a start or end date, or select no date limits", "開始日か終了日を選択するか、期間制限なしを選択してください", "시작일 또는 종료일을 선택하거나 기간 제한 없음을 선택하세요"],
  ["按 {0} 时区计算，包含开始日和结束日；留空的一侧不限制。",
    "Dates use {0} and include both boundary days. A blank boundary is unrestricted.",
    "日付は {0} に基づき、開始日と終了日を含みます。空欄の側には制限がありません。",
    "날짜는 {0} 기준이며 시작일과 종료일을 포함합니다. 비워 둔 쪽은 제한이 없습니다."],
  ["模板日期作为新自动化的默认值；已创建的自动化请单独修改。",
    "Template dates are defaults for new automations. Edit existing automations separately.",
    "テンプレートの日付は新しい自動化の既定値です。作成済みの自動化は個別に編集してください。",
    "템플릿 날짜는 새 자동화의 기본값입니다. 기존 자동화는 개별적으로 수정하세요."],
  ["模板已被其他管理员修改。草稿已保留，请加载最新目录并核对后再保存。", "Another administrator changed the catalog. Your draft is preserved. Load the latest catalog and review it before saving.", "他の管理者が変更しました。下書きは保持されています。最新の一覧を読み込み、確認して保存してください。", "다른 관리자가 변경했습니다. 초안은 보존됩니다. 최신 목록을 불러와 확인한 후 저장하세요."],
  ["加载最新目录，保留草稿", "Load latest catalog, keep draft", "下書きを保持して最新の一覧を読み込む", "초안을 유지하고 최신 목록 불러오기"],
  ["模板已被其他管理员修改。请加载最新目录后重试。", "Another administrator changed the catalog. Load the latest catalog and try again.", "他の管理者が変更しました。最新の一覧を読み込み、再試行してください。", "다른 관리자가 변경했습니다. 최신 목록을 불러온 후 다시 시도하세요."],
  ["此模板已被删除。草稿仍保留，请复制内容后新建模板。", "This template was deleted. Your draft is preserved; copy its contents to a new template.", "テンプレートは削除されました。下書きをコピーして新規作成してください。", "템플릿이 삭제되었습니다. 초안 내용을 복사하여 새 템플릿을 만드세요."],
  [
    "停用后客户端不再展示模板，已创建的自动化不受影响。",
    "Disabled templates are hidden from clients. Existing automations are unaffected.",
    "無効にしたテンプレートはクライアントに表示されません。作成済みの自動化には影響しません。",
    "사용 중지한 템플릿은 클라이언트에 표시되지 않습니다. 기존 자동화에는 영향을 주지 않습니다."
  ],
  [
    "模板已停用，客户端不再展示",
    "Template disabled and hidden from clients",
    "テンプレートを無効にしました。クライアントには表示されません",
    "템플릿이 사용 중지되어 클라이언트에 표시되지 않습니다"
  ],
  [
    "模板已启用，客户端可使用",
    "Template enabled and available to clients",
    "テンプレートを有効にしました。クライアントで利用できます",
    "템플릿이 활성화되어 클라이언트에서 사용할 수 있습니다"
  ],
  [
    "停用模板「{0}」",
    "Disable template “{0}”",
    "テンプレート「{0}」を無効化",
    "템플릿 “{0}” 사용 중지"
  ],
  [
    "启用模板「{0}」",
    "Enable template “{0}”",
    "テンプレート「{0}」を有効化",
    "템플릿 “{0}” 활성화"
  ],
  [
    "请填写模板标识",
    "Enter a template ID",
    "テンプレートIDを入力してください",
    "템플릿 ID를 입력하세요"
  ],
  [
    "模板标识需为 2–64 个字符",
    "Template IDs must contain 2–64 characters",
    "テンプレートIDは2～64文字で入力してください",
    "템플릿 ID는 2~64자여야 합니다"
  ],
  [
    "模板标识须以小写字母或数字开头，仅支持小写字母、数字、点（.）、短横线（-）和下划线（_），不能包含空格",
    "Start with a lowercase letter or digit. Use only lowercase letters, digits, dots (.), hyphens (-) and underscores (_), with no spaces.",
    "先頭は小文字の英字または数字にしてください。小文字の英字、数字、ドット（.）、ハイフン（-）、アンダースコア（_）のみ使用でき、空白は使えません。",
    "소문자 또는 숫자로 시작하고 소문자, 숫자, 점(.), 하이픈(-), 밑줄(_)만 사용하세요. 공백은 사용할 수 없습니다."
  ],
  [
    "模板标识已存在，请更换一个",
    "This template ID already exists. Choose another.",
    "このテンプレートIDは既に存在します。別のIDを入力してください。",
    "이미 존재하는 템플릿 ID입니다. 다른 ID를 입력하세요."
  ],
  [
    "请填写模板名称，不能全为空白",
    "Enter a template name; it cannot consist only of whitespace",
    "テンプレート名を入力してください。空白のみの名前は使用できません。",
    "템플릿 이름을 입력하세요. 공백만 사용할 수 없습니다."
  ],
  [
    "模板名称最多 80 个字符",
    "Template names can contain up to 80 characters",
    "テンプレート名は80文字以内で入力してください",
    "템플릿 이름은 최대 80자입니다"
  ],
  [
    "模板名称不能包含换行或控制字符",
    "Template names cannot contain line breaks or control characters",
    "テンプレート名に改行や制御文字は使用できません",
    "템플릿 이름에 줄 바꿈이나 제어 문자를 사용할 수 없습니다"
  ],
  [
    "2–64 位，以小写字母或数字开头，可含 . - _，标识不可重复，创建后不可修改。",
    "2–64 characters; start with a lowercase letter or digit. Dots, hyphens and underscores are allowed. IDs must be unique and cannot be changed after creation.",
    "2～64文字。小文字の英字または数字で始め、. - _ も使用できます。IDは重複できず、作成後は変更できません。",
    "2~64자이며 소문자 또는 숫자로 시작해야 합니다. . - _ 를 사용할 수 있습니다. ID는 고유해야 하며 생성 후 변경할 수 없습니다."
  ],
  [
    "1–80 个字符，支持多语言和常用符号，不能全为空白或包含换行、控制字符。",
    "1–80 characters. Multilingual text and common symbols are supported; whitespace-only names, line breaks and control characters are not allowed.",
    "1～80文字。多言語や一般的な記号が使用できます。空白のみの名前、改行、制御文字は使用できません。",
    "1~80자이며 다국어와 일반 기호를 지원합니다. 공백만 있는 이름, 줄 바꿈, 제어 문자는 사용할 수 없습니다."
  ]
]
const catalog = index => Object.fromEntries(rows.map(row => [row[0], row[index]]))
export default catalog(1)
export const ja = catalog(2)
export const ko = catalog(3)

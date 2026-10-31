/* UI copy only; search never translates stored user content. */
(function (global) {
  const entries = [
    ['打开全局搜索', 'Open global search', 'グローバル検索を開く', '전체 검색 열기'],
    ['新建会话', 'New conversation', '新しい会話', '새 대화'], ['新建需求', 'New issue', '課題を作成', '새 요청'],
    ['打开资料库', 'Open library', '資料ライブラリを開く', '자료 라이브러리 열기'],
    ['打开需求池', 'Open issues', '課題一覧を開く', '요청 목록 열기'],
    ['打开插件', 'Open plugins', 'プラグインを開く', '플러그인 열기'],
    ['打开自动化', 'Open automations', '自動化を開く', '자동화 열기'],
    ['打开设置', 'Open settings', '設定を開く', '설정 열기'],
    ['打开快捷键设置', 'Open shortcut settings', 'ショートカット設定を開く', '단축키 설정 열기'],
    ['全局搜索', 'Global search', 'グローバル検索', '전체 검색'],
    ['搜索会话、项目、需求、资料或快捷操作', 'Search conversations, projects, issues, materials or actions', '会話、プロジェクト、課題、資料、操作を検索', '대화, 프로젝트, 요청, 자료 또는 작업 검색'],
    ['全部', 'All', 'すべて', '전체'], ['会话', 'Conversations', '会話', '대화'],
    ['项目', 'Projects', 'プロジェクト', '프로젝트'], ['需求', 'Issues', '課題', '요청'],
    ['资料库', 'Library', '資料ライブラリ', '자료 라이브러리'], ['即用', 'Apps', 'アプリ', '앱'],
    ['插件', 'Plugins', 'プラグイン', '플러그인'], ['自动化', 'Automations', '自動化', '자동화'],
    ['快捷操作', 'Quick actions', 'クイック操作', '빠른 작업'], ['技能', 'Skills', 'スキル', '스킬'],
    ['连接器', 'Connectors', 'コネクター', '커넥터'], ['本地资料库', 'Local library', 'ローカル資料', '로컬 자료'],
    ['远程资料库', 'Remote library', 'リモート資料', '원격 자료'],
    ['最近会话', 'Recent conversations', '最近の会話', '최근 대화'], ['最近资料', 'Recent materials', '最近の資料', '최근 자료'],
    ['关闭搜索', 'Close search', '検索を閉じる', '검색 닫기'], ['清除搜索', 'Clear search', '検索をクリア', '검색 지우기'],
    ['正在搜索…', 'Searching…', '検索中…', '검색 중…'], ['没有找到相关内容', 'No matching results', '一致する結果がありません', '일치하는 결과가 없습니다'],
    ['试试其他关键词或切换分类', 'Try another keyword or category', '別のキーワードや分類をお試しください', '다른 검색어나 분류를 사용해 보세요'],
    ['暂时无法搜索，请重试', 'Search is unavailable. Try again.', '現在検索できません。再試行してください', '검색할 수 없습니다. 다시 시도해 주세요'],
    ['部分来源加载失败', 'Some sources could not be loaded', '一部の検索元を読み込めませんでした', '일부 검색 대상을 불러오지 못했습니다'],
    ['重试', 'Retry', '再試行', '다시 시도'], ['显示更多', 'Show more', 'さらに表示', '더 보기'],
    ['选择', 'Select', '選択', '선택'], ['打开', 'Open', '開く', '열기'], ['切换分类', 'Switch category', '分類を切り替え', '분류 전환'],
    ['关闭', 'Close', '閉じる', '닫기'], ['无法打开此结果，请刷新后重试', 'Could not open this result. Refresh and try again.', 'この結果を開けません。更新して再試行してください', '결과를 열 수 없습니다. 새로고침 후 다시 시도해 주세요'],
    ['部分内容未检索；云端会话仅搜索标题，大型存档可能超出本次检索范围', 'Some content was not searched. Cloud conversations use titles only; large archives may exceed this search limit.', '一部の本文は検索対象外です。クラウド会話はタイトルのみ、大容量の履歴は検索上限を超える場合があります', '일부 내용은 검색되지 않았습니다. 클라우드 대화는 제목만 검색하며 큰 기록은 검색 한도를 초과할 수 있습니다'],
    ['仅显示当前账号可访问的内容', 'Only content accessible to your account', '現在のアカウントでアクセス可能な内容のみ', '현재 계정에서 접근할 수 있는 내용만 표시'],
    ['打开的内容已删除或当前账号无权访问', 'This content was removed or is no longer accessible', '削除されたか、現在のアカウントではアクセスできません', '삭제되었거나 현재 계정에 접근 권한이 없습니다'],
  ];
  const messages = { ...global.SoduWorkLocaleMessages };
  ['en-US', 'ja-JP', 'ko-KR'].forEach((locale, index) => {
    messages[locale] = Object.freeze({ ...Object.fromEntries(entries.map(row => [row[0], row[index + 1]])), ...messages[locale] });
  });
  global.SoduWorkLocaleMessages = Object.freeze(messages);
})(globalThis);

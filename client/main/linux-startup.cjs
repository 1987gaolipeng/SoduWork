'use strict';

const path = require('node:path');
const vault = require('./linux-device-vault.cjs');

const ACTION = 'soduwork-linux-storage:';
const recoveryWindows = new WeakMap();
// Match Chromium 152 GetDesktopEnvironment and Electron 44 SelectBackend so
// existing KWallet identities stay intact. The first recognized XDG value wins;
// LXQt and legacy KDE3 select basic_text, while COSMIC uses libsecret.
function recognizedDesktop(env) {
  for (const desktop of String(env.XDG_CURRENT_DESKTOP || '').split(':')) {
    const value = desktop.trim();
    if (value === 'LXQt') return false;
    if (['GNOME', 'Unity', 'X-Cinnamon', 'Deepin', 'Pantheon',
      'XFCE', 'UKUI', 'KDE', 'COSMIC'].includes(value)) return true;
  }
  const has = name => Object.hasOwn(env, name);
  const session = String(env.DESKTOP_SESSION || '');
  if (['gnome', 'mate', 'deepin', 'kde4', 'kde-plasma', 'ukui'].includes(session) ||
      session.includes('xfce') || session === 'xubuntu') return true;
  if (session === 'kde') return has('KDE_SESSION_VERSION');
  if (has('GNOME_DESKTOP_SESSION_ID')) return true;
  return has('KDE_FULL_SESSION') && has('KDE_SESSION_VERSION');
}

function configure({ app, platform = process.platform, env = process.env }) {
  if (platform !== 'linux' || app.isReady() || app.commandLine.hasSwitch('password-store') ||
      recognizedDesktop(env)) return false;
  // Must run synchronously at main-script entry: Electron configures OSCrypt
  // after loading app code but before ready. Never select the basic backend.
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
  return true;
}

function secureStorageReady(safeStorage) {
  try {
    const backend = safeStorage.getSelectedStorageBackend();
    return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend) &&
      safeStorage.isEncryptionAvailable() === true;
  } catch (_) { return false; }
}

const COPY = {
  'zh-CN': {
    createTitle: "使用本地加密凭据库",
    unlockTitle: "解锁本地设备凭据库",
    hint: "设置独立口令（12–256 个字符），以后每次启动都需要输入。请妥善保存，忘记后无法恢复。",
    password: "本地口令",
    confirm: "再次输入口令",
    create: "创建并继续",
    unlock: "解锁并继续",
    mismatch: "两次口令不一致。",
    error: "无法打开凭据库。请检查口令及配置目录的读写权限。",
    nativeHint: "也可以启用 GNOME Keyring 或 KWallet，再重新启动 SoduWork 以使用系统密钥环。",
    title: '请解锁系统密码管理器',
    detail: 'SoduWork 需要系统密码管理器来安全保存登录凭据。请完成系统的解锁提示；如果尚未安装密码管理器，请通过系统软件中心安装 GNOME Keyring，或启用桌面自带的 KWallet。',
    preserved: '现有设备凭据和聊天记录已保留。SoduWork 不会改用明文存储或重置密码管理器。',
    installed: '完成后重新启动 SoduWork，再继续登录。',
    source: '完成后退出，并从原来的启动入口重新打开 SoduWork。',
    restart: '重新启动', quit: '退出',
  },
  'en-US': {
    createTitle: "Use an encrypted local vault",
    unlockTitle: "Unlock your device vault",
    hint: "Choose a separate passphrase (12–256 characters). You will need it at each startup. A forgotten passphrase cannot be recovered.",
    password: "Local passphrase",
    confirm: "Confirm passphrase",
    create: "Create and continue",
    unlock: "Unlock and continue",
    mismatch: "Passphrases do not match.",
    error: "Could not open the vault. Check the passphrase and profile permissions.",
    nativeHint: "To use the system keyring instead, enable GNOME Keyring or KWallet and reopen SoduWork.",
    title: 'Unlock your system password manager',
    detail: 'SoduWork needs a system password manager to store sign-in credentials securely. Complete the system unlock prompt. If no password manager is installed, install GNOME Keyring from your system software center, or enable your desktop\'s KWallet.',
    preserved: 'Existing device credentials and chats are preserved. SoduWork will not use plaintext storage or reset your password manager.',
    installed: 'Then restart SoduWork to continue signing in.',
    source: 'Then quit and reopen SoduWork using the same launcher.',
    restart: 'Restart', quit: 'Quit',
  },
  'ja-JP': {
    createTitle: "ローカルの暗号化保管庫を使う",
    unlockTitle: "デバイス保管庫のロックを解除",
    hint: "専用のパスフレーズ（12〜256文字）を設定してください。起動のたびに必要です。忘れると復元できません。",
    password: "パスフレーズ",
    confirm: "確認用パスフレーズ",
    create: "作成して続ける",
    unlock: "解除して続ける",
    mismatch: "パスフレーズが一致しません。",
    error: "保管庫を開けません。パスフレーズとフォルダーの権限を確認してください。",
    nativeHint: "システムのキーリングを使う場合は、GNOME Keyring または KWallet を有効にして SoduWork を再起動してください。",
    title: 'システムのパスワード管理を解除してください',
    detail: 'SoduWork はログイン情報を安全に保存するため、システムのパスワード管理を使用します。システムのロック解除を完了してください。未導入の場合はソフトウェアセンターから GNOME Keyring をインストールするか、デスクトップの KWallet を有効にしてください。',
    preserved: '既存の端末認証情報とチャットは保持されます。平文保存への変更やパスワード管理のリセットは行いません。',
    installed: '完了後、SoduWork を再起動してログインを続けてください。',
    source: '完了後に終了し、元の起動方法で SoduWork を開いてください。',
    restart: '再起動', quit: '終了',
  },
  'ko-KR': {
    createTitle: "암호화된 로컬 저장소 사용",
    unlockTitle: "기기 저장소 잠금 해제",
    hint: "별도의 암호(12~256자)를 설정하세요. 시작할 때마다 필요하며 잊어버리면 복구할 수 없습니다.",
    password: "로컬 암호",
    confirm: "암호 확인",
    create: "만들고 계속",
    unlock: "잠금 해제하고 계속",
    mismatch: "암호가 일치하지 않습니다.",
    error: "저장소를 열 수 없습니다. 암호와 폴더 권한을 확인하세요.",
    nativeHint: "시스템 키링을 사용하려면 GNOME Keyring 또는 KWallet을 활성화한 뒤 SoduWork를 다시 여세요.",
    title: '시스템 암호 관리자의 잠금을 해제하세요',
    detail: 'SoduWork는 로그인 정보를 안전하게 저장하기 위해 시스템 암호 관리자를 사용합니다. 시스템 잠금 해제 안내를 완료하세요. 암호 관리자가 없다면 소프트웨어 센터에서 GNOME Keyring을 설치하거나 데스크톱의 KWallet을 활성화하세요.',
    preserved: '기존 기기 인증 정보와 채팅은 보존됩니다. 평문으로 저장하거나 암호 관리자를 초기화하지 않습니다.',
    installed: '완료한 후 SoduWork를 다시 시작하여 로그인하세요.',
    source: '완료한 후 종료하고 원래 실행 방법으로 SoduWork를 다시 여세요.',
    restart: '다시 시작', quit: '종료',
  },
};

function vaultForm(text, create) {
  const field = (id, label) => '<label>' + label + '<input type="password" id="' + id +
    '" autocomplete="off" minlength="12" maxlength="256" required></label>';
  return '<h1>' + (create ? text.createTitle : text.unlockTitle) + '</h1>' +
    (create ? '<p>' + text.hint + '</p>' : '') +
    '<form id="vault" data-error="' + text.error + '" data-mismatch="' + text.mismatch + '">' +
    field('passphrase', text.password) + (create ? field('confirm', text.confirm) : '') +
    '<p role="status"></p><button>' + (create ? text.create : text.unlock) + '</button></form>' +
    (create ? '<p class="note">' + text.nativeHint + '</p>' : '');
}

function recoveryPage(locale, restart, mode = 'recover') {
  locale = Object.hasOwn(COPY, locale) ? locale : 'en-US';
  const text = COPY[locale];
  const content = mode === 'recover'
    ? '<h1>' + text.title + '</h1><p>' + text.detail + '</p><p class="note">' + text.preserved +
      '</p><p>' + (restart ? text.installed : text.source) + '</p>'
    : vaultForm(text, mode === 'create');
  return '<!doctype html><html lang="' + locale + '"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; form-action \'none\'; style-src \'unsafe-inline\'">' +
    '<title>SoduWork</title><style>body{margin:0;background:#f3f6fb;color:#182236;font:16px/1.6 sans-serif}' +
    'main{max-width:560px;margin:42px auto;padding:0 32px}h1{font-size:25px}p{margin:18px 0}' +
    '.note{color:#526075;font-size:14px}nav{display:flex;gap:12px}a{color:white;background:#1769dc;padding:9px 18px;border-radius:8px;text-decoration:none}' +
    'form,nav{margin:16px 0}input{display:block;padding:8px;margin:4px 0 12px}button{padding:8px 14px}' +
    'a:last-child{background:#e3e9f2;color:#182236}a:focus-visible{outline:3px solid #75a9f5}</style></head><body><main>' +
    content + '<nav>' +
    (restart ? '<a role="button" href="' + ACTION + 'restart">' + text.restart + '</a>' : '') +
    '<a role="button" href="' + ACTION + 'quit">' + text.quit + '</a></nav></main></body></html>';
}

function focusRecovery(app) {
  const win = recoveryWindows.get(app);
  if (!win) return false;
  if (win.isDestroyed()) {
    recoveryWindows.delete(app);
    return false;
  }
  if (win.isMinimized?.()) win.restore();
  win.show();
  win.focus();
  return true;
}

function showRecovery({ app, BrowserWindow, safeStorage, platform = process.platform,
  env = process.env, warn = console.warn, onUnlock }) {
  if (platform !== 'linux' || !app.isReady()) return false;
  if (focusRecovery(app)) return true;
  const nativeReady = () => secureStorageReady(safeStorage);
  const mode = onUnlock ? vault.startupMode(app.getPath('userData'), nativeReady) : nativeReady() ? 'native' : 'recover';
  if (mode === 'native') return false;
  const useVault = mode === 'create' || mode === 'unlock';
  const rawLocale = String(app.getLocale() || 'en').toLowerCase();
  const locale = rawLocale.startsWith('zh') ? 'zh-CN' : rawLocale.startsWith('ja') ? 'ja-JP' :
    rawLocale.startsWith('ko') ? 'ko-KR' : 'en-US';
  // A source-session parent owns the local Hub and stops it when Electron exits.
  // Relaunching Electron alone would strand that child without its Hub.
  const restart = env.SODUWORK_SOURCE_SESSION !== '1';
  const win = new BrowserWindow({ width: 720, height: useVault ? 680 : 500, minWidth: 550, minHeight: 440,
    title: 'SoduWork', backgroundColor: '#f3f6fb', show: false, autoHideMenuBar: true,
    webPreferences: { partition: 'soduwork-linux-storage-recovery', sandbox: true,
      contextIsolation: true, nodeIntegration: false, devTools: false,
      ...(useVault ? { preload: path.join(__dirname, 'linux-vault-preload.cjs') } : {}) } });
  recoveryWindows.set(app, win);
  let exiting = false;
  function quit(relaunch = false) {
    if (exiting) return;
    exiting = true;
    if (relaunch) app.relaunch();
    app.quit();
  }
  if (useVault) {
    let busy = false;
    win.webContents.ipc.handle('linux-device-vault-unlock', async (event, passphrase) => {
      if (exiting || busy || event.senderFrame !== win.webContents.mainFrame) return false;
      busy = true;
      let store;
      try {
        store = await vault.unlock(app.getPath('userData'), mode, passphrase);
      } catch { return false; }
      finally { busy = false; }
      if (exiting || win.isDestroyed()) return false;
      exiting = true;
      onUnlock(store);
      win.close();
      return true;
    });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url === ACTION + 'quit') quit();
    if (url === ACTION + 'restart' && restart) quit(true);
  });
  win.on('closed', () => {
    if (recoveryWindows.get(app) === win) recoveryWindows.delete(app);
    quit();
  });
  Promise.resolve(win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(recoveryPage(locale, restart, mode))))
    .then(() => { if (!win.isDestroyed()) win.show(); })
    .catch(() => { warn('[startup] Linux secure-storage recovery could not be displayed'); quit(); });
  return true;
}

module.exports = { configure, recognizedDesktop, secureStorageReady, showRecovery, recoveryPage, focusRecovery };

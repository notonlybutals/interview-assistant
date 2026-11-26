const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');

// Windows: 透明 BrowserWindow 需要 DWM 硬件加速。
// 历史遗留 disableHardwareAcceleration() 已移除 ——
// 它会让 setContentProtection 退化成「窗口被捕获时显示黑色」(WDA_MONITOR)，
// 而非 Win10 2004+ 才支持的「直接从屏幕捕获中排除」(WDA_EXCLUDEFROMCAPTURE)，
// 后者才是真正的屏幕共享隐身。
// 如个别老 Win7/Win8 设备透明窗口出现渲染异常，可设环境变量 ELECTRON_DISABLE_HW_ACCEL=1 回退。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  if (process.env.ELECTRON_DISABLE_HW_ACCEL === '1') {
    app.disableHardwareAcceleration();
  }
}

// 跨平台：阻止系统 occlusion / window list 计算把 overlay 暴露给屏幕共享 / 录屏 API。
// 与 BrowserWindow 的 setContentProtection(true) (+ macOS type:'panel') 形成多重防御。
//
// macOS 真正生效的方案 (Electron PR #34362, refs issue #19880):
// 1. enable ScreenCaptureKitMac —— 切换到 macOS 12.3+ 的 ScreenCaptureKit 实现，
//    PR #34362 在这个 capturer 路径里 *硬编码* 跳过 setContentProtection(true) 的窗口，
//    是目前唯一让 overlay 在「always-on-top + transparent」配置下真正隐身的方案。
// 2. disable IOSurfaceCapturer / DesktopCaptureMacV2 —— 关掉旧 capturer 防回退,
//    它们绕过 NSWindowSharingNone 让 setContentProtection 失效 (这正是 overlay 截图可见的根因)。
// 3. disable CalculateNativeWinOcclusion —— 防 OS 把 overlay 列入 window list,
//    被 CGWindowListCreateImage 类老 API 抓到。
//
// 三件齐备后, ScreenCaptureKit / CGWindowListCreateImage / Lark/钉钉/Zoom 屏幕共享、
// macOS 系统截图 (Cmd+Shift+5) 都不再录到 overlay。
app.commandLine.appendSwitch('enable-features', 'ScreenCaptureKitMac');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,IOSurfaceCapturer,DesktopCaptureMacV2',
);
const {
  ShortcutStatus,
  createShortcutState,
  loadShortcutConfig,
  saveShortcutConfig,
  validateShortcutMap,
} = require('./shortcuts');
const {
  PROMPT_OVERLAY_DEFAULT_WIDTH,
  PROMPT_OVERLAY_MAX_WIDTH,
  consumePendingOverlayShow,
  createOverlayChromeOptions,
  getPromptOverlayInitialWidth,
  relayChildOutput,
} = require('./windowOptions');
const { createMultiScreenBatch } = require('./multiScreenBatch');

const pkg = require('./package.json');

/** 应用显示名：环境变量 ELECTRON_APP_DISPLAY_NAME > desktop/app-title.json > package.json appDisplayName > 默认 */
function loadAppDisplayName() {
  const env = process.env.ELECTRON_APP_DISPLAY_NAME;
  if (env && String(env).trim()) return String(env).trim();
  const titlePath = path.join(__dirname, 'app-title.json');
  try {
    const raw = fs.readFileSync(titlePath, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j.appDisplayName === 'string' && j.appDisplayName.trim()) {
      return j.appDisplayName.trim();
    }
  } catch {
    /* 无文件或解析失败 */
  }
  if (pkg.appDisplayName && String(pkg.appDisplayName).trim()) {
    return String(pkg.appDisplayName).trim();
  }
  return '学习助手';
}

const APP_DISPLAY_NAME = loadAppDisplayName();

// Windows 托盘/通知/任务栏分组依赖 AppUserModelID；必须在 app ready 之前设置，
// 放到 whenReady 里再设会导致已注册的托盘图标 AUMID 不一致而偶发「图标看不见」。
if (process.platform === 'win32') {
  try {
    app.setAppUserModelId('com.interviewassistant.desktop');
  } catch {
    /* ignore */
  }
}

// 打包后（electron-builder）资源在 resources/runtime 下；开发态仍是仓库根目录。
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.resolve(__dirname, '..');
let PORT = parseInt(process.env.PORT || '18080', 10);
let SERVER_URL = `http://127.0.0.1:${PORT}`;
if (app.isPackaged) {
  const userDir = process.env.IA_USER_DATA_DIR || path.join(app.getPath('appData'), 'InterviewAssistant');
  fs.mkdirSync(userDir, { recursive: true });
  app.setPath('userData', userDir);
}
const hasInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on('second-instance', () => {
  mainWindow?.show();
  mainWindow?.focus();
});

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let pythonProcess = null;
let isQuitting = false;
let shortcuts = {};
let _overlayDragging = false;
let _blurTimer = null;
let overlayAutoResizeUntil = 0;
let overlayPositionSaveTimer = null;
let overlayPositionSaveForce = false;
let overlayToggleBlockedUntil = 0;
let lastOverlayState = {
  initialized: false,
  enabled: false,
  visible: false,
  opacity: 0.88,
  fontSize: 14,
  fontColor: '#e2e8f0',
  showBg: true,
  mode: 'glass',
  focusWidthPct: 96,
  focusHeightPct: 90,
  promptMaxWidth: PROMPT_OVERLAY_DEFAULT_WIDTH,
  promptAutoFollow: false,
  maxLines: 0,
};

// 窗口偏好（任务栏显示 / 屏幕共享隐身 / 悬浮窗可拖动缩放）：默认在任务栏显示，
// 用户随时能找回窗口；需要隐身时可在设置或托盘菜单关闭。持久化到 userData。
let windowPrefs = { showInTaskbar: true, contentProtection: true, overlayInteractive: true };
let trayHintShown = false;

function getWindowPrefsFilePath() {
  return path.join(app.getPath('userData'), 'window-prefs.json');
}

function loadWindowPrefs() {
  try {
    const raw = fs.readFileSync(getWindowPrefsFilePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      windowPrefs = {
        showInTaskbar: data.showInTaskbar !== false,
        contentProtection: data.contentProtection !== false,
        overlayInteractive: data.overlayInteractive !== false,
      };
    }
  } catch {
    // 首次启动 / 文件损坏：使用默认值
  }
  return windowPrefs;
}

function saveWindowPrefs() {
  try {
    const file = getWindowPrefsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(windowPrefs, null, 2), 'utf8');
  } catch (error) {
    console.warn('saveWindowPrefs failed:', error?.message || error);
  }
}

function applyContentProtection(enabled) {
  windowPrefs.contentProtection = Boolean(enabled);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setContentProtection(windowPrefs.contentProtection);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setContentProtection(windowPrefs.contentProtection);
  }
  saveWindowPrefs();
}

function applyShowInTaskbar(enabled) {
  const next = Boolean(enabled);
  if (process.platform === 'win32' && !next && mainWindow && !mainWindow.isDestroyed()) {
    // 这台机器上出现过「托盘图标不可见 + 关掉任务栏 = 窗口彻底消失」的情况，
    // 关闭前明确警告一次，并提供取消。
    try {
      const { dialog } = require('electron');
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['仍然关闭（之后按 Ctrl+B 找回）', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '关闭「在任务栏显示」',
        message: '关闭后，最小化会隐藏到托盘。',
        detail: '如果本机托盘图标不可见，窗口将只能通过 Ctrl+B 快捷键找回。确定继续吗？',
      });
      if (choice !== 0) return;
    } catch {
      /* ignore */
    }
  }
  windowPrefs.showInTaskbar = next;
  if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
    // 托盘没建起来时不允许把任务栏也关掉，否则窗口会彻底消失、只能靠快捷键找回。
    if (!windowPrefs.showInTaskbar && !tray) {
      windowPrefs.showInTaskbar = true;
      mainWindow.setSkipTaskbar(false);
      saveWindowPrefs();
      return;
    }
    mainWindow.setSkipTaskbar(!windowPrefs.showInTaskbar);
  }
  saveWindowPrefs();
}

function applyOverlayInteractive(enabled) {
  windowPrefs.overlayInteractive = Boolean(enabled);
  saveWindowPrefs();
  // 前端 overlay 会通过 overlay-state 收到 interactive 字段并据此显示拖拽/缩放把手。
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.webContents.send('window-prefs', { ...windowPrefs });
    } catch {
      /* ignore */
    }
  }
}

function showTrayHintOnce() {
  if (trayHintShown || !tray) return;
  trayHintShown = true;
  try {
    tray.displayBalloon({
      title: APP_DISPLAY_NAME,
      content:
        '已隐藏到托盘：点击托盘图标或按 Ctrl+B 可找回窗口；右键托盘可关闭「屏幕共享隐身」以便截图。',
      iconType: 'info',
    });
  } catch {
    // 部分系统不支持托盘气泡，忽略即可
  }
}

const OVERLAY_PRESET = { width: 480, height: 320, minWidth: 300, minHeight: 100, resizable: true };
const PROMPT_OVERLAY_MIN_SIZE = { width: 180, height: 72 };
const PROMPT_OVERLAY_MAX_SIZE = { heightRatio: 0.48 };
const FOCUS_OVERLAY_MARGIN = 14;

let _frontReassertTimer = null;
const FRONT_REASSERT_LEVEL = 1;
const FOCUS_OVERLAY_SHORTCUT_ACTIONS = new Set(['focusPrevTab', 'focusNextTab']);
const VISIBLE_OVERLAY_SHORTCUT_ACTIONS = new Set(['cancelAnswer', 'overlayPrevQuestion', 'overlayNextQuestion']);
const FRONT_REASSERT_DURATION = 5000;
const FRONT_REASSERT_INTERVAL = 500;

function applyTopMost(win) {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver', FRONT_REASSERT_LEVEL);
  win.setContentProtection(windowPrefs.contentProtection);
  win.moveTop();
}

function keepWindowInFront(win) {
  if (_frontReassertTimer) { clearInterval(_frontReassertTimer); _frontReassertTimer = null; }
  if (!win || win.isDestroyed()) return;
  const start = Date.now();
  applyTopMost(win);
  _frontReassertTimer = setInterval(() => {
    if (!win || win.isDestroyed() || Date.now() - start > FRONT_REASSERT_DURATION) {
      clearInterval(_frontReassertTimer);
      _frontReassertTimer = null;
      return;
    }
    applyTopMost(win);
  }, FRONT_REASSERT_INTERVAL);
}

function getOverlayStateFilePath() {
  return path.join(app.getPath('userData'), 'overlay-window.json');
}

function loadOverlayWindowState() {
  try {
    const raw = fs.readFileSync(getOverlayStateFilePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
  } catch {
    /* ignore */
  }
  return { positions: {} };
}

function saveOverlayWindowState(data) {
  try {
    fs.writeFileSync(getOverlayStateFilePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.warn('saveOverlayWindowState failed:', error);
  }
}

function getStoredOverlayPosition() {
  const saved = loadOverlayWindowState();
  const pos = saved?.position;
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
  const displays = screen.getAllDisplays();
  const fitsSomeDisplay = displays.some((display) => {
    const area = display.workArea;
    return (
      pos.x >= area.x - 40
      && pos.x <= area.x + area.width - 80
      && pos.y >= area.y - 40
      && pos.y <= area.y + area.height - 60
    );
  });
  if (fitsSomeDisplay) return { x: pos.x, y: pos.y };
  const primary = screen.getPrimaryDisplay().workArea;
  return {
    x: primary.x + Math.max(16, Math.round((primary.width - OVERLAY_PRESET.width) / 2)),
    y: primary.y + Math.max(16, Math.round((primary.height - OVERLAY_PRESET.height) * 0.18)),
  };
}

function getDefaultOverlayBounds() {
  const primary = screen.getPrimaryDisplay().workArea;
  return {
    x: primary.x + Math.max(16, Math.round((primary.width - OVERLAY_PRESET.width) / 2)),
    y: primary.y + Math.max(16, Math.round((primary.height - OVERLAY_PRESET.height) * 0.18)),
    width: OVERLAY_PRESET.width,
    height: OVERLAY_PRESET.height,
  };
}

function getFocusOverlayBounds() {
  const canUseOverlayBounds = overlayWindow
    && !overlayWindow.isDestroyed()
    && (typeof overlayWindow.isVisible !== 'function' || overlayWindow.isVisible());
  const point = canUseOverlayBounds
    ? {
        x: overlayWindow.getBounds().x + Math.round(overlayWindow.getBounds().width / 2),
        y: overlayWindow.getBounds().y + Math.round(overlayWindow.getBounds().height / 2),
      }
    : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const margin = FOCUS_OVERLAY_MARGIN;
  const widthPct = Math.max(50, Math.min(100, Number(lastOverlayState?.focusWidthPct) || 96));
  const heightPct = Math.max(35, Math.min(100, Number(lastOverlayState?.focusHeightPct) || 90));
  const width = Math.round((area.width - margin * 2) * (widthPct / 100));
  const height = Math.round((area.height - margin * 2) * (heightPct / 100));
  return {
    x: area.x + margin + Math.max(0, Math.round(((area.width - margin * 2) - width) / 2)),
    y: area.y + margin + Math.max(0, Math.round(((area.height - margin * 2) - height) / 2)),
    width: Math.max(OVERLAY_PRESET.minWidth, width),
    height: Math.max(OVERLAY_PRESET.minHeight, height),
  };
}

function getNormalOverlayBounds(mode) {
  const storedPos = getStoredOverlayPosition();
  const saved = loadOverlayWindowState();
  const storedSize = saved?.position;
  const minOverlayWidth = OVERLAY_PRESET.minWidth || OVERLAY_PRESET.width;
  const minOverlayHeight = OVERLAY_PRESET.minHeight || OVERLAY_PRESET.height;
  // prompt 模式宽度由内容自适应驱动 (受 promptMaxWidth 约束), 旧物理 position.w 无意义;
  // 直接用 promptMaxWidth 作初始宽, 避免重开时先显示旧值再被前端收窄/撑开。
  let width;
  let height;
  if (mode === 'prompt') {
    width = getPromptOverlayInitialWidth(lastOverlayState?.promptMaxWidth);
    height = Math.max((storedSize?.h > 0) ? storedSize.h : OVERLAY_PRESET.height, minOverlayHeight);
  } else {
    width = Math.max((storedSize?.w > 0) ? storedSize.w : OVERLAY_PRESET.width, minOverlayWidth);
    height = Math.max((storedSize?.h > 0) ? storedSize.h : OVERLAY_PRESET.height, minOverlayHeight);
  }
  return {
    ...(storedPos ? storedPos : getDefaultOverlayBounds()),
    width,
    height,
  };
}

function applyOverlayModeBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const mode = lastOverlayState?.mode || (lastOverlayState?.showBg === false ? 'prompt' : 'glass');
  overlayWindow.setMinimumSize(
    mode === 'prompt' ? PROMPT_OVERLAY_MIN_SIZE.width : OVERLAY_PRESET.minWidth,
    mode === 'prompt' ? PROMPT_OVERLAY_MIN_SIZE.height : OVERLAY_PRESET.minHeight,
  );
  const bounds = mode === 'focus' ? getFocusOverlayBounds() : getNormalOverlayBounds(mode);
  overlayWindow.setBounds(bounds, false);
}

function persistOverlayPosition(force = false) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (lastOverlayState?.mode === 'focus') return;
  // fuse 屏蔽窗口 resize/moved 事件在程序化 setBounds 后 500ms 内的频繁写盘;
  // force=true 用于程序化设尺寸后的显式落盘 (来自 resize-overlay-window IPC), 绕过 fuse。
  if (!force && Date.now() < overlayAutoResizeUntil) return;
  const bounds = overlayWindow.getBounds();
  const saved = loadOverlayWindowState();
  saved.position = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
  saveOverlayWindowState(saved);
}

function schedulePersistOverlayPosition(force = false) {
  // force 语义必须保留：程序化 resize 后排的 force 持久化不能被随后的
  // 窗口 resize 事件（force=false）覆盖降级，否则自适应高度不落盘。
  overlayPositionSaveForce = overlayPositionSaveForce || force;
  if (overlayPositionSaveTimer) return;
  overlayPositionSaveTimer = setTimeout(() => {
    overlayPositionSaveTimer = null;
    const f = overlayPositionSaveForce;
    overlayPositionSaveForce = false;
    persistOverlayPosition(f);
  }, 180);
}

function createTrayIcon() {
  // 兜底托盘图标：画一个可见的橙色圆点。旧实现返回全透明图像，
  // 一旦 icon.png 加载失败，托盘里就完全看不到图标（用户实测过）。
  const size = 16;
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > radius) continue;
      const i = (y * size + x) * 4;
      buf[i] = 0x28; // B
      buf[i + 1] = 0x8c; // G
      buf[i + 2] = 0xf0; // R
      buf[i + 3] = 255; // A
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function waitForServer(timeout = 40000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const check = () => {
      if (settled) return;
      const req = http.get(`${SERVER_URL}/api/options`, { timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          settled = true;
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() - start > timeout) {
        settled = true;
        reject(new Error('Server start timeout'));
        return;
      }
      setTimeout(check, 300);
    };
    check();
  });
}

function startPythonBackend() {
  const isWin = process.platform === 'win32';
  let python = isWin ? 'python' : 'python3';
  if (app.isPackaged) {
    const bundled = path.join(ROOT, 'python', isWin ? 'python.exe' : path.join('bin', 'python3'));
    if (fs.existsSync(bundled)) python = bundled;
  }
  const args = [
    path.join(ROOT, 'start.py'),
    '--mode', 'network',
    '--no-build',
    '--port', String(PORT),
  ];
  const env = { ...process.env };
  // 国内直连 huggingface.co 基本不通，给后端注入 HF 镜像兜底；用户自己设了就以用户的为准。
  if (!String(env.HF_ENDPOINT || '').trim()) env.HF_ENDPOINT = 'https://hf-mirror.com';
  if (app.isPackaged) {
    const userDir = app.getPath('userData');
    const dataRoot = path.join(userDir, 'backend');
    fs.mkdirSync(dataRoot, { recursive: true });
    const configPath = path.join(dataRoot, 'config.json');
    if (!fs.existsSync(configPath)) {
      fs.copyFileSync(path.join(ROOT, 'backend', 'config.example.json'), configPath);
    }
    Object.assign(env, {
      IA_CONFIG_PATH: configPath,
      IA_BACKEND_DATA_ROOT: dataRoot,
      IA_LOG_DIR: path.join(userDir, 'log'),
      IA_FRONTEND_DIR: path.join(ROOT, 'frontend', 'dist'),
      IA_STT_LAZY_START: '1',
      NUMBA_CACHE_DIR: path.join(userDir, 'cache', 'numba'),
    });
  }
  pythonProcess = spawn(python, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });

  relayChildOutput(pythonProcess.stdout, process.stdout, '[py] ');
  relayChildOutput(pythonProcess.stderr, process.stderr, '[py] ');
  if (app.isPackaged) {
    fs.mkdirSync(env.IA_LOG_DIR, { recursive: true });
    const logPath = path.join(env.IA_LOG_DIR, 'backend-startup.log');
    for (const stream of [pythonProcess.stdout, pythonProcess.stderr]) {
      stream.on('data', (data) => fs.appendFileSync(logPath, data));
    }
  }
  pythonProcess.on('error', (error) => {
    const { dialog } = require('electron');
    dialog.showErrorBox('后端启动失败', error.message);
    app.quit();
  });
  pythonProcess.on('close', (code) => {
    console.log(`[py] exited with code ${code}`);
    pythonProcess = null;
    if (!isQuitting) {
      if (mainWindow) {
        const { dialog } = require('electron');
        dialog.showErrorBox('后端已退出', `Python 后端进程异常退出 (code ${code})。\n可能原因：端口 ${PORT} 被占用。\n请关闭占用该端口的进程后重试。`);
      }
      app.quit();
    }
  });
}

function createWindow() {
  const isWindows = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: APP_DISPLAY_NAME,
    frame: false,
    show: false,
    resizable: true,
    maximizable: true,
    // 默认不在任务栏显示（隐身，只在托盘）；可在托盘菜单勾选「在任务栏显示」
    skipTaskbar: isWindows ? !windowPrefs.showInTaskbar : false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setContentProtection(windowPrefs.contentProtection);
  const sendMaximizedState = () => {
    mainWindow.webContents.send('window-maximized', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);

  // 每次启动清除缓存，确保加载到最新的前端构建（避免设置里识别引擎等不更新）
  mainWindow.webContents.session.clearCache().then(() => {
    mainWindow.loadURL(SERVER_URL);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const t = JSON.stringify(APP_DISPLAY_NAME);
    mainWindow.webContents.executeJavaScript(`document.title = ${t}`).catch(() => {});
    mainWindow.setTitle(APP_DISPLAY_NAME);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Windows 下最小化：任务栏可见时正常最小化（用户点任务栏能还原）；
  // 只有关闭「在任务栏显示」的隐身模式才最小化到托盘。
  mainWindow.on('minimize', (e) => {
    if (process.platform === 'win32' && !windowPrefs.showInTaskbar) {
      e.preventDefault();
      mainWindow.hide();
      showTrayHintOnce();
    }
  });

  // 关闭按钮 = 真正退出
  mainWindow.on('close', () => {
    isQuitting = true;
  });
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }
  appendOverlayDebug('createOverlayWindow start');

  const initialMode = lastOverlayState?.mode || (lastOverlayState?.showBg === false ? 'prompt' : 'glass');
  const initialBounds = initialMode === 'focus' ? getFocusOverlayBounds() : getNormalOverlayBounds(initialMode);

  // 透明浮窗: 视觉上能看到桌面, 需要 transparent: true + alpha=0 背景.
  // 注意: setContentProtection 在 macOS 的透明窗口上只是 best effort,
  // 对部分截图路径 (尤其是 ScreenCaptureKit) 可能无效; 这是 OS 级限制.
  overlayWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    x: initialBounds.x,
    y: initialBounds.y,
    minWidth: OVERLAY_PRESET.minWidth,
    minHeight: OVERLAY_PRESET.minHeight,
    ...createOverlayChromeOptions(process.platform, OVERLAY_PRESET.resizable),
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hiddenInMissionControl: true,
    show: false,
    autoHideMenuBar: true,
    roundedCorners: true,
    title: `${APP_DISPLAY_NAME} Overlay`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const createdOverlayWindow = overlayWindow;
  // Content protection 必须尽早调用 —— 等到 ready-to-show 时,
  // 窗口可能已经被 window server 登记过一次, 导致 NSWindowSharingNone 漏掉初始帧
  overlayWindow.setContentProtection(windowPrefs.contentProtection);
  overlayWindow.setBackgroundColor('#00000000');
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', FRONT_REASSERT_LEVEL);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (process.platform === 'darwin') {
    // macOS: NSWindowCollectionBehaviorCanJoinAllSpaces + Transient
    // 让窗口不进入 Cmd+Tab, Mission Control, Exposé, 以及 CGWindowList
    try {
      overlayWindow.setHiddenInMissionControl(true);
    } catch { /* older electron */ }
  }

  overlayWindow._overlayReady = false;

  overlayWindow.once('ready-to-show', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setContentProtection(windowPrefs.contentProtection);
    overlayWindow.setBackgroundColor('#00000000');
    overlayWindow.setFocusable(false);
    overlayWindow.setAlwaysOnTop(true, 'screen-saver', FRONT_REASSERT_LEVEL);
  });
  overlayWindow.loadURL(`${SERVER_URL}?overlay=1`);
  overlayWindow.webContents.on('did-finish-load', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setContentProtection(windowPrefs.contentProtection);
    overlayWindow.setBackgroundColor('#00000000');
    overlayWindow.setFocusable(false);
    if (lastOverlayState) {
      overlayWindow.webContents.send('overlay-state', lastOverlayState);
    }
    setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      overlayWindow._overlayReady = true;
      if (consumePendingOverlayShow(overlayWindow, lastOverlayState?.visible)) {
        showOverlayWindow();
      }
    }, process.platform === 'win32' ? 120 : 0);
  });
  overlayWindow.on('show', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setContentProtection(windowPrefs.contentProtection);
    overlayWindow.setBackgroundColor('#00000000');
    overlayWindow.setFocusable(false);
  });

  overlayWindow.on('closed', () => {
    // destroy() 的 closed 事件可能晚于「新建 overlay」到达；只清理自己这一代，
    // 否则会把刚创建的新窗口引用置空，导致下一次 Ctrl+O 打开/关闭错乱。
    if (overlayWindow !== createdOverlayWindow) return;
    overlayWindow = null;
    _overlayDragging = false;
    if (_blurTimer) { clearTimeout(_blurTimer); _blurTimer = null; }
    if (_frontReassertTimer) { clearInterval(_frontReassertTimer); _frontReassertTimer = null; }
  });
  overlayWindow.on('moved', () => schedulePersistOverlayPosition());
  overlayWindow.on('resize', () => schedulePersistOverlayPosition());
  overlayWindow.on('focus', () => {
    if (_blurTimer) clearTimeout(_blurTimer);
    _blurTimer = setTimeout(() => {
      _blurTimer = null;
      if (!_overlayDragging && overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.blur();
      }
    }, 150);
  });

  appendOverlayDebug('createOverlayWindow ok');
  return overlayWindow;
}

function sendOverlayState(payload) {
  lastOverlayState = payload;
  [mainWindow, overlayWindow].forEach((win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('overlay-state', payload);
  });
}

function sendShortcutsState() {
  [mainWindow, overlayWindow].forEach((win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('shortcuts-state', shortcuts);
  });
}

function closeOverlayAndPersist() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try {
    persistOverlayPosition(true);
  } catch (error) {
    appendOverlayDebug(`persist position before close failed: ${error?.message || error}`);
  }
  overlayWindow._pendingShow = false;
  overlayWindow.destroy();
  overlayWindow = null;
}

function preheatOverlaySoon() {
  // 关闭后后台预建一个隐藏的 overlay，下次 Ctrl+O 打开可即时显示（不用等页面加载）。
  setTimeout(() => {
    try {
      if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    } catch (error) {
      appendOverlayDebug(`overlay preheat failed: ${error?.message || error}`);
    }
  }, 500);
}

function showOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    appendOverlayDebug('showOverlayWindow skip: no window');
    return;
  }
  appendOverlayDebug(`showOverlayWindow visible=${Boolean(lastOverlayState?.visible)} ready=${Boolean(overlayWindow._overlayReady)}`);
  if (!lastOverlayState?.visible) {
    overlayWindow._pendingShow = false;
    overlayWindow.hide();
    return;
  }
  if (!overlayWindow._overlayReady) {
    overlayWindow._pendingShow = true;
    return;
  }
  applyOverlayModeBounds();
  overlayWindow.setFocusable(false);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    overlayWindow.showInactive();
  } else {
    overlayWindow.show();
  }
  overlayWindow.setContentProtection(windowPrefs.contentProtection);
  keepWindowInFront(overlayWindow);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
    showTrayHintOnce();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function notifyMainWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function notifyDesktopToast(message, level = 'info') {
  if (!message) return;
  notifyMainWindow('desktop-toast', { message: String(message), level });
}

function notifyConfigUpdated(config) {
  if (config && typeof config === 'object') {
    notifyMainWindow('config-updated', config);
  }
}

function postBackend(pathname, body = '{}') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${SERVER_URL}${pathname}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (!raw) { resolve({ ok: true }); return; }
            try { resolve(JSON.parse(raw)); } catch { resolve({ ok: true }); }
            return;
          }
          reject(new Error(raw || res.statusMessage || `HTTP ${res.statusCode}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getBackend(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${SERVER_URL}${pathname}`, { method: 'GET' }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          if (!raw) { resolve({}); return; }
          try { resolve(JSON.parse(raw)); } catch { resolve({}); }
          return;
        }
        reject(new Error(raw || res.statusMessage || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getMultiScreenIdleMs() {
  try {
    const cfg = await getBackend('/api/config');
    const sec = Number(cfg?.multi_screen_capture_idle_sec ?? 10);
    return Math.max(1, Math.min(60, Number.isFinite(sec) ? sec : 10)) * 1000;
  } catch {
    return 10000;
  }
}

const multiServerScreenBatch = createMultiScreenBatch({
  submitImages: (images) => (
    postBackend('/api/ask-from-server-screens', JSON.stringify({ images }))
  ),
  onError: (error) => {
    console.error('flushMultiServerScreenBatch failed:', error);
  },
});

async function addMultiServerScreenShot() {
  try {
    const res = await postBackend('/api/capture-server-screen');
    if (!res?.image) throw new Error('capture response missing image');
    const idleMs = await getMultiScreenIdleMs();
    multiServerScreenBatch.add(res.image, idleMs);
  } catch (error) {
    console.error('addMultiServerScreenShot failed:', error);
  }
}

function appendTrayLog(message) {
  try {
    const file = path.join(app.getPath('userData'), 'tray.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function appendOverlayDebug(message) {
  try {
    const dir = path.join(ROOT, 'log');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'overlay-debug.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function createTray() {
  try {
    let icon = null;
    const icoPath = path.join(__dirname, 'build', 'icon.ico');
    const pngPath = path.join(__dirname, 'icon.png');
    // 优先用 16x16 PNG：部分 Windows 11 机器上大尺寸 ICO 会被托盘静默吞掉。
    if (fs.existsSync(pngPath)) {
      icon = nativeImage.createFromPath(pngPath);
      if (icon && !icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    }
    if (!icon || icon.isEmpty()) {
      icon = nativeImage.createFromPath(pngPath);
      if (icon && !icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    }
    if (!icon || icon.isEmpty()) {
      console.warn('createTray: icon assets empty, using generated icon');
      icon = createTrayIcon();
    }

    tray = new Tray(icon);
    tray.setToolTip(APP_DISPLAY_NAME);
    appendTrayLog(`tray created size=${JSON.stringify(icon.getSize())}`);

    const contextMenu = Menu.buildFromTemplate([
      { label: '显示窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: '隐藏到托盘', click: () => toggleWindow() },
      { type: 'separator' },
      {
        label: '显示/隐藏悬浮窗（Ctrl+O）',
        click: () => shortcutCallbacks.toggleInterviewOverlay(),
      },
      {
        label: '悬浮窗移到鼠标位置（Ctrl+M）',
        click: () => shortcutCallbacks.moveOverlayToMouse(),
      },
      { type: 'separator' },
      {
        label: '在任务栏显示',
        type: 'checkbox',
        checked: Boolean(windowPrefs.showInTaskbar),
        click: (menuItem) => applyShowInTaskbar(menuItem.checked),
      },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: false,
        click: (menuItem) => {
          mainWindow?.setAlwaysOnTop(menuItem.checked, 'floating');
        },
      },
      {
        label: '屏幕共享隐身（关闭后可截图）',
        type: 'checkbox',
        checked: Boolean(windowPrefs.contentProtection),
        click: (menuItem) => applyContentProtection(menuItem.checked),
      },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
    // Windows 双击托盘图标也能显示
    tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch (error) {
    // 托盘创建失败时退回任务栏显示，保证用户永远找得到窗口。
    console.warn('createTray failed, fall back to taskbar:', error?.message || error);
    appendTrayLog(`tray create failed: ${error?.message || error}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(false);
    }
  }
}

function isFocusOverlayActive() {
  const mode = lastOverlayState?.mode || (lastOverlayState?.showBg === false ? 'prompt' : 'glass');
  return Boolean(lastOverlayState?.visible) && mode === 'focus';
}

function isOverlayShortcutActive(action) {
  if (FOCUS_OVERLAY_SHORTCUT_ACTIONS.has(action)) return isFocusOverlayActive();
  if (VISIBLE_OVERLAY_SHORTCUT_ACTIONS.has(action)) return Boolean(lastOverlayState?.visible);
  // Non-overlay shortcuts are intentionally global and should stay registered.
  return true;
}

function registerManagedShortcut(shortcut) {
  const callback = shortcutCallbacks[shortcut.action];
  if (!callback) {
    shortcut.status = ShortcutStatus.Available;
    return false;
  }
  if (globalShortcut.register(shortcut.key, callback)) {
    shortcut.status = ShortcutStatus.Registered;
    return true;
  }
  shortcut.status = ShortcutStatus.Failed;
  return false;
}

function registerShortcuts() {
  shortcuts = loadShortcutConfig(app);
  Object.values(shortcuts).forEach((shortcut) => {
    if (!isOverlayShortcutActive(shortcut.action)) {
      shortcut.status = ShortcutStatus.Available;
      return;
    }
    registerManagedShortcut(shortcut);
  });
  syncFocusOverlayShortcuts();
}

function unregisterShortcut(action) {
  const shortcut = shortcuts[action];
  if (!shortcut) return;
  globalShortcut.unregister(shortcut.key);
  shortcut.status = ShortcutStatus.Available;
}

function unregisterAllManagedShortcuts() {
  Object.keys(shortcuts).forEach((action) => unregisterShortcut(action));
}

function syncFocusOverlayShortcuts() {
  for (const action of FOCUS_OVERLAY_SHORTCUT_ACTIONS) {
    const shortcut = shortcuts[action];
    if (!shortcut) continue;
    if (isOverlayShortcutActive(action)) {
      if (shortcut.status !== ShortcutStatus.Registered) registerManagedShortcut(shortcut);
    } else if (shortcut.status === ShortcutStatus.Registered || shortcut.status === ShortcutStatus.Failed) {
      unregisterShortcut(action);
    }
  }
  for (const action of VISIBLE_OVERLAY_SHORTCUT_ACTIONS) {
    const shortcut = shortcuts[action];
    if (!shortcut) continue;
    if (isOverlayShortcutActive(action)) {
      if (shortcut.status !== ShortcutStatus.Registered) registerManagedShortcut(shortcut);
    } else if (shortcut.status === ShortcutStatus.Registered || shortcut.status === ShortcutStatus.Failed) {
      unregisterShortcut(action);
    }
  }
  sendShortcutsState();
}

function registerShortcutSet(nextShortcuts) {
  const validation = validateShortcutMap(nextShortcuts);
  if (!validation.ok) {
    return { ok: false, error: validation.error, shortcuts };
  }

  const prevShortcuts = shortcuts;
  unregisterAllManagedShortcuts();

  const nextState = JSON.parse(JSON.stringify(nextShortcuts));
  let failedKey = null;
  for (const shortcut of Object.values(nextState)) {
    if (!isOverlayShortcutActive(shortcut.action)) {
      shortcut.status = ShortcutStatus.Available;
      continue;
    }
    const callback = shortcutCallbacks[shortcut.action];
    if (!callback) continue;
    if (globalShortcut.register(shortcut.key, callback)) {
      shortcut.status = ShortcutStatus.Registered;
    } else {
      shortcut.status = ShortcutStatus.Failed;
      failedKey = shortcut.key;
      break;
    }
  }

  if (failedKey) {
    Object.values(nextState).forEach((shortcut) => globalShortcut.unregister(shortcut.key));
    shortcuts = prevShortcuts;
    Object.values(shortcuts).forEach((shortcut) => {
      if (!isOverlayShortcutActive(shortcut.action)) {
        shortcut.status = ShortcutStatus.Available;
        return;
      }
      const callback = shortcutCallbacks[shortcut.action];
      if (!callback) return;
      globalShortcut.register(shortcut.key, callback);
      shortcut.status = ShortcutStatus.Registered;
    });
    return { ok: false, error: `快捷键注册失败：${failedKey}`, shortcuts };
  }

  shortcuts = nextState;
  syncFocusOverlayShortcuts();
  saveShortcutConfig(app, shortcuts);
  return { ok: true, shortcuts };
}

const shortcutCallbacks = {
  hideOrShowWindow: () => toggleWindow(),
  toggleContentProtection: () => {
    const next = !windowPrefs.contentProtection;
    applyContentProtection(next);
    notifyDesktopToast(
      next
        ? '已恢复屏幕共享隐身（窗口不可截图）'
        : '已关闭屏幕共享隐身，现在可以截图了',
      'info',
    );
  },
  hardClearSession: async () => {
    try {
      await postBackend('/api/clear');
    } catch (error) {
      console.error('hardClearSession failed:', error);
    }
  },
  askFromServerScreen: async () => {
    try {
      await postBackend('/api/ask-from-server-screen');
    } catch (error) {
      console.error('askFromServerScreen failed:', error);
    }
  },
  askScreenForceThink: async () => {
    try {
      await postBackend('/api/ask-from-server-screen', JSON.stringify({ override_think_mode: true }));
      notifyDesktopToast('已提交强制思考截图审题', 'success');
    } catch (error) {
      console.error('askScreenForceThink failed:', error);
      notifyDesktopToast(error?.message || '强制思考截图失败', 'error');
    }
  },
  askScreenForceNoThink: async () => {
    try {
      await postBackend('/api/ask-from-server-screen', JSON.stringify({ override_think_mode: false }));
      notifyDesktopToast('已提交强制非思考截图审题', 'success');
    } catch (error) {
      console.error('askScreenForceNoThink failed:', error);
      notifyDesktopToast(error?.message || '强制非思考截图失败', 'error');
    }
  },
  toggleThinkMode: async () => {
    try {
      const cfg = await getBackend('/api/config');
      let nextPayload;
      let toastMsg;
      if (cfg?.written_exam_mode) {
        const next = !Boolean(cfg.written_exam_think);
        nextPayload = await postBackend('/api/config', JSON.stringify({
          written_exam_think: next,
        }));
        toastMsg = next ? '笔试思考模式已开启' : '笔试思考模式已关闭';
      } else {
        const next = !Boolean(cfg?.think_mode);
        nextPayload = await postBackend('/api/config', JSON.stringify({
          think_mode: next,
          think_effort: next ? 'xhigh' : 'off',
        }));
        toastMsg = next ? '全局思考模式已开启' : '全局思考模式已关闭';
      }
      notifyConfigUpdated(nextPayload);
      notifyDesktopToast(toastMsg, 'success');
    } catch (error) {
      console.error('toggleThinkMode failed:', error);
      notifyDesktopToast(error?.message || '切换思考模式失败', 'error');
    }
  },
  cancelAnswer: async () => {
    try {
      await postBackend('/api/ask/cancel');
    } catch (error) {
      console.error('cancelAnswer failed:', error);
    }
  },
  addMultiServerScreenShot,
  toggleInterviewOverlay: () => {
    // Electron may repeat a global shortcut while the key is held. Debounce
    // the toggle so one physical press cannot hide and immediately re-show it.
    if (Date.now() < overlayToggleBlockedUntil) return;
    overlayToggleBlockedUntil = Date.now() + 350;
    const nextVisible = !Boolean(lastOverlayState.visible);
    const nextState = {
      ...lastOverlayState,
      initialized: true,
      enabled: nextVisible || lastOverlayState.enabled,
      visible: nextVisible,
    };
    sendOverlayState(nextState);
    syncFocusOverlayShortcuts();

    if (nextVisible) {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow._hiddenByOverlay = true;
        mainWindow.hide();
      }
      try {
        createOverlayWindow();
        showOverlayWindow();
      } catch (error) {
        appendOverlayDebug(`toggle open failed: ${error?.stack || error}`);
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow._hiddenByOverlay) {
          mainWindow._hiddenByOverlay = false;
          mainWindow.show();
        }
        notifyDesktopToast(`悬浮窗打开失败：${error?.message || error}`, 'error');
      }
    } else {
      // 快捷键关闭 overlay：直接销毁窗口而不是 hide()。
      // Windows 上透明/置顶窗口 hide→show 会留下残影、且鼠标事件可能失效；
      // 销毁重建后拖动/缩放/渲染都是干净的（位置/尺寸已持久化，重开会恢复）。
      appendOverlayDebug('toggle close');
      closeOverlayAndPersist();
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow._hiddenByOverlay) {
        mainWindow._hiddenByOverlay = false;
        mainWindow.show();
        mainWindow.focus();
      }
      preheatOverlaySoon();
    }
  },
  moveOverlayToMouse: () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const offsetX = 20;
    const offsetY = 20;
    const nextX = Math.round(cursor.x - offsetX);
    const nextY = Math.round(cursor.y - offsetY);
    overlayWindow.setPosition(nextX, nextY);
    schedulePersistOverlayPosition();
  },
  focusPrevTab: () => sendFocusTabCommand('prev'),
  focusNextTab: () => sendFocusTabCommand('next'),
  overlayPrevQuestion: () => sendOverlayQuestionCommand('prev'),
  overlayNextQuestion: () => sendOverlayQuestionCommand('next'),
};

function sendFocusTabCommand(direction) {
  if (!isFocusOverlayActive()) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('focus-tab-command', direction);
}

function sendOverlayQuestionCommand(direction) {
  if (!lastOverlayState?.visible) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('overlay-question-command', direction);
}

ipcMain.handle('hide-window', () => mainWindow?.hide());
ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('toggle-maximize-window', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('quit-app', () => { isQuitting = true; app.quit(); });
ipcMain.handle('show-window', () => { mainWindow?.show(); mainWindow?.focus(); });
ipcMain.handle('get-shortcuts', () => shortcuts);
ipcMain.handle('update-shortcuts', (_event, updates) => {
  const next = JSON.parse(JSON.stringify(shortcuts));
  for (const update of updates || []) {
    if (!update || typeof update.action !== 'string' || typeof update.key !== 'string') continue;
    if (!next[update.action]) continue;
    next[update.action].key = update.key;
  }
  const result = registerShortcutSet(next);
  if (result.ok) sendShortcutsState();
  return result;
});
ipcMain.handle('reset-shortcuts', () => {
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'shortcuts.json')); } catch {}
  const defaults = createShortcutState();
  const result = registerShortcutSet(defaults);
  if (result.ok) sendShortcutsState();
  return result;
});
ipcMain.handle('toggle-always-on-top', () => {
  if (!mainWindow) return false;
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next, 'floating');
  return next;
});
ipcMain.handle('toggle-content-protection', () => {
  applyContentProtection(!windowPrefs.contentProtection);
  return windowPrefs.contentProtection;
});
ipcMain.handle('get-window-state', () => ({
  maximized: mainWindow?.isMaximized() ?? false,
  alwaysOnTop: mainWindow?.isAlwaysOnTop() ?? false,
  contentProtection: windowPrefs.contentProtection !== false,
  visible: mainWindow?.isVisible() ?? false,
}));
ipcMain.handle('window-prefs:get', () => ({ ...windowPrefs }));
ipcMain.handle('window-prefs:set', (_event, payload = {}) => {
  if (payload && typeof payload === 'object') {
    if ('showInTaskbar' in payload) applyShowInTaskbar(payload.showInTaskbar);
    if ('contentProtection' in payload) applyContentProtection(payload.contentProtection);
    if ('overlayInteractive' in payload) applyOverlayInteractive(payload.overlayInteractive);
  }
  return { ...windowPrefs };
});
ipcMain.handle('overlay-move-by', (_event, dx, dy) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false };
  const stepX = Math.round(Number(dx) || 0);
  const stepY = Math.round(Number(dy) || 0);
  if (!stepX && !stepY) return { ok: true };
  const [x, y] = overlayWindow.getPosition();
  overlayWindow.setPosition(x + stepX, y + stepY);
  schedulePersistOverlayPosition(true);
  return { ok: true };
});
ipcMain.handle('overlay-resize-by', (_event, dw, dh) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false };
  const stepW = Math.round(Number(dw) || 0);
  const stepH = Math.round(Number(dh) || 0);
  if (!stepW && !stepH) return { ok: true };
  const bounds = overlayWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  });
  const work = display.workArea;
  const nextWidth = Math.max(240, Math.min(work.width, bounds.width + stepW));
  const nextHeight = Math.max(100, Math.min(work.height, bounds.height + stepH));
  overlayWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: nextWidth,
    height: nextHeight,
  });
  schedulePersistOverlayPosition(true);
  return { ok: true };
});
ipcMain.handle('overlay-hide', () => {
  appendOverlayDebug('overlay-hide ipc');
  const nextState = {
    ...lastOverlayState,
    initialized: true,
    visible: false,
    enabled: Boolean(lastOverlayState?.enabled),
  };
  sendOverlayState(nextState);
  closeOverlayAndPersist();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow._hiddenByOverlay) {
    mainWindow._hiddenByOverlay = false;
    mainWindow.show();
    mainWindow.focus();
  }
  preheatOverlaySoon();
  return { ok: true };
});
ipcMain.handle('sync-overlay-window', (_event, payload = {}) => {
  const style = {};
  if ('opacity' in payload) {
    const opacity = Number(payload.opacity);
    if (Number.isFinite(opacity)) style.opacity = Math.max(0, Math.min(1, opacity));
  }
  if ('fontSize' in payload) {
    const fontSize = Number(payload.fontSize);
    if (Number.isFinite(fontSize)) style.fontSize = Math.max(10, Math.min(48, Math.round(fontSize)));
  }
  if ('fontColor' in payload && typeof payload.fontColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(payload.fontColor)) {
    style.fontColor = payload.fontColor;
  }
  if ('showBg' in payload && typeof payload.showBg === 'boolean') {
    style.showBg = payload.showBg;
  }
  if ('mode' in payload && ['glass', 'prompt', 'focus'].includes(payload.mode)) {
    style.mode = payload.mode;
    style.showBg = payload.mode !== 'prompt';
  } else if ('showBg' in style && !('mode' in payload)) {
    style.mode = style.showBg ? 'glass' : 'prompt';
  }
  if ('focusWidthPct' in payload) {
    const focusWidthPct = Number(payload.focusWidthPct);
    if (Number.isFinite(focusWidthPct)) style.focusWidthPct = Math.max(50, Math.min(100, Math.round(focusWidthPct)));
  }
  if ('focusHeightPct' in payload) {
    const focusHeightPct = Number(payload.focusHeightPct);
    if (Number.isFinite(focusHeightPct)) style.focusHeightPct = Math.max(35, Math.min(100, Math.round(focusHeightPct)));
  }
  if ('promptMaxWidth' in payload) {
    const promptMaxWidth = Number(payload.promptMaxWidth);
    if (Number.isFinite(promptMaxWidth)) style.promptMaxWidth = Math.max(200, Math.min(PROMPT_OVERLAY_MAX_WIDTH, Math.round(promptMaxWidth)));
  }
  if ('promptAutoFollow' in payload && typeof payload.promptAutoFollow === 'boolean') {
    style.promptAutoFollow = payload.promptAutoFollow;
  }
  if ('maxLines' in payload) {
    const maxLines = Number(payload.maxLines);
    if (Number.isFinite(maxLines)) style.maxLines = Math.max(0, Math.min(50, Math.round(maxLines)));
  }

  const nextEnabled = typeof payload.enabled === 'boolean' ? payload.enabled : Boolean(lastOverlayState.enabled);
  const nextVisible = typeof payload.visible === 'boolean' ? payload.visible : Boolean(lastOverlayState.visible);

  const state = { ...lastOverlayState, ...style, enabled: nextEnabled, visible: nextVisible };
  state.initialized = true;
  const visibleChanged = Boolean(lastOverlayState.visible) !== state.visible;
  // 结构性变化才需要重设窗口 bounds：纯样式（透明度/颜色/自动跟读等）
  // 的 sync 若也走 showOverlayWindow，会把 prompt 自适应宽度重置回满宽。
  const modeChanged = Boolean(lastOverlayState.mode) !== Boolean(state.mode)
    || (lastOverlayState.mode || '') !== (state.mode || '');

  lastOverlayState = state;
  sendOverlayState(state);
  syncFocusOverlayShortcuts();

  if (visibleChanged) {
    if (state.visible) {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow._hiddenByOverlay = true;
        mainWindow.hide();
      }
    } else {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow._hiddenByOverlay) {
        mainWindow._hiddenByOverlay = false;
        mainWindow.show();
        mainWindow.focus();
      }
    }
  }

  if (!state.visible) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow._pendingShow = false;
      overlayWindow.hide();
    }
    return { ok: true, visible: false };
  }

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
  }

  if (visibleChanged || modeChanged) {
    showOverlayWindow();
  } else {
    // 纯样式 sync：窗口保持当前 bounds，避免把内容自适应的 prompt 宽度打回满宽
    if (lastOverlayState.visible && !overlayWindow.isVisible() && overlayWindow._overlayReady) {
      overlayWindow.showInactive();
    }
  }
  return { ok: true, visible: true };
});
ipcMain.handle('get-overlay-state', () => lastOverlayState);
ipcMain.handle('set-shortcuts-suspended', (_event, on) => {
  // 设置页正在录制新快捷键时暂停全部全局热键：否则按下的组合键会
  // 触发旧绑定（Ctrl+B 藏主窗口 / Ctrl+. 清空会话），录制 UI 直接被带走。
  const suspend = on === true;
  try {
    if (suspend) {
      unregisterAllManagedShortcuts();
    } else {
      registerShortcuts();
    }
  } catch (err) {
    // 恢复失败不阻塞：下次 registerShortcuts 时会重试
  }
  return { ok: true, suspended: suspend };
});
ipcMain.handle('resize-overlay-window', (_event, payload = {}) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return { ok: false };
  const mode = lastOverlayState?.mode || (lastOverlayState?.showBg === false ? 'prompt' : 'glass');
  if (mode !== 'prompt') return { ok: true, skipped: true };

  const bounds = overlayWindow.getBounds();
  const center = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  };
  const area = screen.getDisplayNearestPoint(center).workArea;
  const nextWidth = Number(payload.width);
  const nextHeight = Number(payload.height);
  const promptMaxWidth = Math.max(200, Math.min(PROMPT_OVERLAY_MAX_WIDTH, Number(lastOverlayState?.promptMaxWidth) || PROMPT_OVERLAY_DEFAULT_WIDTH));
  const width = Number.isFinite(nextWidth)
    ? Math.max(PROMPT_OVERLAY_MIN_SIZE.width, Math.min(promptMaxWidth, area.width - 16, Math.round(nextWidth)))
    : bounds.width;
  const height = Number.isFinite(nextHeight)
    ? Math.max(PROMPT_OVERLAY_MIN_SIZE.height, Math.min(Math.round(area.height * PROMPT_OVERLAY_MAX_SIZE.heightRatio), Math.round(nextHeight)))
    : bounds.height;
  const x = Math.max(area.x + 8, Math.min(bounds.x, area.x + area.width - width - 8));
  const y = Math.max(area.y + 8, Math.min(bounds.y, area.y + area.height - height - 8));

  overlayAutoResizeUntil = Date.now() + 500;
  overlayWindow.setBounds({ x, y, width, height }, false);
  // 程序化设的尺寸是 prompt 自适应的权威值, 显式落盘 (绕过 fuse), 使重开时生效。
  schedulePersistOverlayPosition(true);
  return { ok: true, width, height };
});
// M3: 添加 destroyOverlay 接口，支持显式销毁悬浮窗
ipcMain.handle('destroy-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  return { ok: true };
});
ipcMain.handle('move-overlay-window', (_event, dx, dy) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const [x, y] = overlayWindow.getPosition();
  overlayWindow.setPosition(x + Math.round(dx), y + Math.round(dy));
});
ipcMain.on('overlay-drag-start', (event) => {
  _overlayDragging = true;
  if (_blurTimer) { clearTimeout(_blurTimer); _blurTimer = null; }
  event.returnValue = true;
});
ipcMain.on('overlay-drag-end', () => {
  _overlayDragging = false;
  if (_blurTimer) { clearTimeout(_blurTimer); _blurTimer = null; }
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.blur();
});

function createAppMenu() {
  if (process.platform !== 'darwin') return;
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { label: '隐藏/显示窗口', click: () => toggleWindow() },
        { type: 'separator' },
        { role: 'hide', label: '隐藏应用' },
        { role: 'unhide', label: '显示应用' },
        { type: 'separator' },
        { label: '退出', accelerator: 'CommandOrControl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function requestAssistStop(timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const req = http.request(`${SERVER_URL}/api/stop`, {
      method: 'POST',
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('error', finish);
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) { /* ignore */ }
      finish();
    });
    req.end();
  });
}

// 优雅停止后端：先主动请求 assist stop，让复盘归档和 SQLite 刷盘完成；
// 再发 SIGTERM，超时后兜底 SIGKILL。
let pythonStopPromise = null;
function gracefulStopPython(timeoutMs = 20000) {
  if (pythonStopPromise) return pythonStopPromise;
  const proc = pythonProcess;
  if (!proc) return Promise.resolve();
  pythonStopPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    proc.once('exit', finish);
    const stopTimeoutMs = Math.max(1000, Math.min(15000, timeoutMs - 5000));
    requestAssistStop(stopTimeoutMs).then(() => {
      if (settled) return;
      try { proc.kill('SIGTERM'); } catch (err) { console.warn('[py] SIGTERM failed:', err.message); }
      setTimeout(() => {
        if (settled) return;
        try {
          if (!proc.killed) {
            console.warn('[py] graceful timeout, escalating to SIGKILL');
            proc.kill('SIGKILL');
          }
        } catch (err) {
          console.warn('[py] SIGKILL failed:', err.message);
        }
        finish();
      }, Math.max(1000, timeoutMs - stopTimeoutMs));
    });
  });
  return pythonStopPromise;
}

app.on('before-quit', (event) => {
  isQuitting = true;
  if (!pythonProcess || pythonStopPromise) return;
  event.preventDefault();
  gracefulStopPython().then(() => {
    pythonProcess = null;
    app.quit();
  });
});

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  try {
    app.setName(APP_DISPLAY_NAME);
  } catch {
    /* 个别平台/版本可能不支持 */
  }
  createAppMenu();
  if (app.isPackaged) {
    // A packaged app must coexist with an already running source checkout.
    PORT = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', (error) => {
        if (error.code === 'EADDRINUSE') probe.listen(0, '0.0.0.0');
        else reject(error);
      });
      probe.once('listening', () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
      probe.listen(PORT, '0.0.0.0');
    });
    SERVER_URL = `http://127.0.0.1:${PORT}`;
  }
  console.log('Starting Python backend...');
  startPythonBackend();

  try {
    await waitForServer();
    console.log('Backend ready, creating window...');
  } catch (err) {
    console.error('Failed to start backend:', err.message);
    app.quit();
    return;
  }

  loadWindowPrefs();
  createWindow();
  createTray();
  registerShortcuts();

  setImmediate(() => {
    if (overlayWindow && !overlayWindow.isDestroyed()) return;
    try {
      createOverlayWindow();
    } catch (error) {
      console.warn('overlay preheat failed:', error?.message || error);
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  mainWindow?.show();
  mainWindow?.focus();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (overlayPositionSaveTimer) {
    clearTimeout(overlayPositionSaveTimer);
    overlayPositionSaveTimer = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  // 兜底:before-quit 通常已经 graceful 停过 pythonProcess,
  // 这里 fallback 防止异常路径泄漏子进程。
  if (pythonProcess) {
    try { pythonProcess.kill('SIGKILL'); } catch (_) { /* ignore */ }
    pythonProcess = null;
  }
});


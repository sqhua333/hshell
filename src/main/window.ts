import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { dirname, join } from 'node:path'
import { launchFailureMessage } from './diagnostic-messages'
import { logDiagnostic } from './diagnostics'
import { WINDOW_BACKGROUND, type UiTheme } from './theme-prefs'

/**
 * Record renderer failures where the user can find them even when the window
 * stays blank. A partial app.asar (for example an interrupted unpack over a
 * running copy) is the usual cause of a white window in packaged builds.
 */
function logRendererFailure(message: string): void {
  logDiagnostic(message, 'renderer-errors.log')
}

// A failed renderer launch can fire more than once; show the guidance only once.
let launchFailureReported = false

// Packaged builds ship the PNG via electron-builder `extraResources`; in dev it
// is read straight from the repository's build/ directory.
const WINDOW_ICON = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(app.getAppPath(), 'build', 'icons', '128x128.png')

export function createWindow(theme: UiTheme = 'light'): BrowserWindow {
  const icon = nativeImage.createFromPath(WINDOW_ICON)
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    // Show the frame as soon as the main process is ready. Waiting for
    // `ready-to-show` can leave the user staring at nothing for seconds on a
    // cold Windows start (AV scan, unsigned exe), and a blocked renderer would
    // never reveal a window at all.
    show: true,
    title: 'HShell',
    icon,
    backgroundColor: WINDOW_BACKGROUND[theme],
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      // Read by the preload script and the inline bootstrap in index.html so
      // the first rendered frame already matches the saved theme.
      additionalArguments: [`--hshell-theme=${theme}`]
    }
  })

  win.once('ready-to-show', () => {
    // Electron only publishes _NET_WM_ICON reliably once the window is shown.
    if (!icon.isEmpty()) win.setIcon(icon)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return
    logRendererFailure(`did-fail-load ${code} ${description} ${url}`)
    dialog.showErrorBox(
      'HShell 界面加载失败',
      `错误码 ${code}：${description}\n${url}\n\n` +
        '安装文件可能不完整或仍被占用。请关闭所有 HShell.exe 进程，' +
        '把完整的压缩包解压到一个全新的空目录后重新运行。\n\n' +
        `诊断日志：${join(app.getPath('userData'), 'renderer-errors.log')}`
    )
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logRendererFailure(`render-process-gone ${details.reason} exitCode=${details.exitCode}`)
    if (details.reason !== 'launch-failed' || process.platform !== 'win32' || launchFailureReported) {
      return
    }
    // Windows refuses to start the sandboxed renderer when the install
    // directory lacks the AppContainer ACEs; without this the window simply
    // disappears during startup.
    launchFailureReported = true
    dialog.showErrorBox(
      'HShell 无法启动渲染进程',
      launchFailureMessage({
        appDir: dirname(process.execPath),
        logDir: app.getPath('userData'),
        reason: details.reason,
        exitCode: details.exitCode
      })
    )
  })

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logRendererFailure(`preload-error ${preloadPath}: ${error.message}`)
  })

  if (app.isPackaged) {
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        logRendererFailure(
          `console ${details.message} (${details.sourceId}:${details.lineNumber})`
        )
      }
    })
  }

  const loading = process.env.ELECTRON_RENDERER_URL
    ? win.loadURL(process.env.ELECTRON_RENDERER_URL)
    : win.loadFile(join(__dirname, '../renderer/index.html'))
  loading.catch((error: unknown) => {
    logRendererFailure(
      `load failed ${error instanceof Error ? error.message : String(error)}`
    )
  })

  return win
}

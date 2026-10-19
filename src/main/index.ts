import { app, BrowserWindow, dialog } from 'electron'
import { createWindow } from './window'
import { registerIpc } from './ipc'
import { createMenu } from './menu'
import { logDiagnostic } from './diagnostics'

let mainWindow: BrowserWindow | null = null

/** Record a fatal main-process error and keep the failure visible to the user. */
function reportFatal(kind: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  logDiagnostic(`${kind} ${detail}`)
  try {
    dialog.showErrorBox(
      'HShell 发生错误',
      `${kind}\n${detail.slice(0, 2000)}\n\n诊断日志：${app.getPath('userData')}`
    )
  } catch {
    /* showing the dialog is best-effort */
  }
  app.exit(1)
}

// Unhandled rejections are common in Electron (fire-and-forget promises) and
// are non-fatal by default, so only record them. Uncaught exceptions are fatal
// by default; keep that behavior but leave both a log and a visible message.
process.on('uncaughtException', (error) => reportFatal('uncaughtException', error))
process.on('unhandledRejection', (reason) => {
  logDiagnostic(
    `unhandledRejection ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
  )
})

logDiagnostic(
  `start version=${app.getVersion()} electron=${process.versions.electron} ` +
    `platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged} exe=${process.execPath}`
)

const gotLock = app.requestSingleInstanceLock()
logDiagnostic(`single-instance lock ${gotLock ? 'acquired' : 'not acquired'}`)

if (!gotLock) {
  // On Windows a process started at a different integrity level (e.g. one
  // instance elevated, one not) cannot signal the running instance, so the
  // launch would otherwise exit without showing anything. Explain it instead.
  if (process.platform === 'win32') {
    dialog.showErrorBox(
      'HShell',
      'HShell 已在运行。\n\n请先关闭正在运行的 HShell 窗口再启动。若已有一个以管理员身份运行的实例，' +
        '请用相同的权限级别启动，或先结束任务管理器中的 HShell.exe。\n\n' +
        'HShell is already running. Close the existing window first. If it was started ' +
        'as administrator, launch this one with the same privileges.'
    )
  }
  app.quit()
} else {
  app.on('second-instance', () => {
    logDiagnostic('second-instance')
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady()
    .then(() => {
      logDiagnostic('app ready')
      registerIpc(() => mainWindow)
      createMenu()
      mainWindow = createWindow()
      logDiagnostic('window created')

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createWindow()
        }
      })
    })
    .catch((error: unknown) => reportFatal('startup failed', error))
}

app.on('child-process-gone', (_event, details) => {
  logDiagnostic(
    `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}` +
      (details.serviceName ? ` service=${details.serviceName}` : '')
  )
})

app.on('before-quit', () => logDiagnostic('before-quit'))
app.on('will-quit', () => logDiagnostic('will-quit'))
app.on('quit', (_event, exitCode) => logDiagnostic(`quit exitCode=${exitCode}`))

app.on('window-all-closed', () => {
  logDiagnostic('window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})

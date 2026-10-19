import { app, BrowserWindow, dialog } from 'electron'
import { createWindow } from './window'
import { registerIpc } from './ipc'
import { createMenu } from './menu'

let mainWindow: BrowserWindow | null = null

const gotLock = app.requestSingleInstanceLock()
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
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    registerIpc(() => mainWindow)
    createMenu()
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

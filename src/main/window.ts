import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { join } from 'node:path'

// Packaged builds ship the PNG via electron-builder `extraResources`; in dev it
// is read straight from the repository's build/ directory.
const WINDOW_ICON = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(app.getAppPath(), 'build', 'icons', '128x128.png')

export function createWindow(): BrowserWindow {
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
    backgroundColor: '#eef1f5',
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

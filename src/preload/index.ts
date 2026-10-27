import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, HshellApi } from '@shared/types'

/**
 * Ask the main process for the saved theme synchronously so the pre-paint
 * bootstrap in index.html can apply it before React loads. Reading it on every
 * load (rather than trusting the launch argument) keeps the theme correct
 * after "Reload Interface". The launch argument is only a fallback.
 */
function readInitialTheme(): 'light' | 'dark' | null {
  try {
    const saved = ipcRenderer.sendSync('app:getTheme') as { theme?: unknown } | undefined
    if (saved && typeof saved === 'object') {
      return saved.theme === 'dark' ? 'dark' : saved.theme === 'light' ? 'light' : null
    }
  } catch {
    /* handler not ready; use the launch argument below */
  }
  const arg = process.argv.find((item) => item.startsWith('--hshell-theme='))
  if (arg === '--hshell-theme=dark') return 'dark'
  if (arg === '--hshell-theme=light') return 'light'
  return null
}

const api: HshellApi = {
  app: {
    initialTheme: readInitialTheme(),
    platform: process.platform,
    info: () => ipcRenderer.invoke('app:info'),
    setLocale: (locale) => ipcRenderer.invoke('app:setLocale', locale),
    setTheme: (theme) => ipcRenderer.invoke('app:setTheme', theme)
  },
  window: {
    toggleFullScreen: () => ipcRenderer.invoke('window:toggleFullScreen')
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    save: (session) => ipcRenderer.invoke('sessions:save', session),
    remove: (id) => ipcRenderer.invoke('sessions:remove', id),
    saveFolder: (folder) => ipcRenderer.invoke('folders:save', folder),
    removeFolder: (id) => ipcRenderer.invoke('folders:remove', id),
    exportToFile: (options) => ipcRenderer.invoke('sessions:export', options),
    importFromFile: (options) => ipcRenderer.invoke('sessions:import', options),
    importSshConfig: () => ipcRenderer.invoke('sessions:importSshConfig')
  },
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
    lock: () => ipcRenderer.invoke('vault:lock')
  },
  keys: {
    list: () => ipcRenderer.invoke('keys:list'),
    generate: (input) => ipcRenderer.invoke('keys:generate', input),
    import: (input) => ipcRenderer.invoke('keys:import', input),
    remove: (id) => ipcRenderer.invoke('keys:remove', id),
    publicKey: (id) => ipcRenderer.invoke('keys:publicKey', id),
    install: (runtimeId, keyId) => ipcRenderer.invoke('keys:install', runtimeId, keyId)
  },
  serial: {
    list: () => ipcRenderer.invoke('serial:list')
  },
  recording: {
    saveScript: (content, defaultName) =>
      ipcRenderer.invoke('recording:saveScript', content, defaultName)
  },
  ai: {
    info: () => ipcRenderer.invoke('ai:info'),
    watched: () => ipcRenderer.invoke('ai:watched'),
    sessions: () => ipcRenderer.invoke('ai:sessions'),
    setWatch: (runtimeId, watched) => ipcRenderer.invoke('ai:setWatch', runtimeId, watched),
    setWritable: (runtimeId, writable) =>
      ipcRenderer.invoke('ai:setWritable', runtimeId, writable),
    decideInput: (id, allow) => ipcRenderer.invoke('ai:decideInput', id, allow),
    bindAddresses: () => ipcRenderer.invoke('ai:bindAddresses'),
    setHost: (host) => ipcRenderer.invoke('ai:setHost', host)
  },
  ssh: {
    connect: (req) => ipcRenderer.invoke('ssh:connect', req),
    disconnect: (runtimeId) => ipcRenderer.invoke('ssh:disconnect', runtimeId),
    write: (runtimeId, data) => ipcRenderer.invoke('ssh:write', runtimeId, data),
    resize: (runtimeId, cols, rows) => ipcRenderer.invoke('ssh:resize', runtimeId, cols, rows),
    ack: (runtimeId, bytes) => ipcRenderer.invoke('ssh:ack', runtimeId, bytes),
    hostKeyDecision: (requestId, accept) =>
      ipcRenderer.invoke('ssh:hostKeyDecision', requestId, accept),
    providePassword: (requestId, password) =>
      ipcRenderer.invoke('ssh:providePassword', requestId, password),
    cancelPassword: (requestId) => ipcRenderer.invoke('ssh:cancelPassword', requestId),
    keyboardInteractive: (requestId, responses, cancel) =>
      ipcRenderer.invoke('ssh:keyboardInteractive', requestId, responses, cancel)
  },
  monitor: {
    sample: (runtimeId) => ipcRenderer.invoke('monitor:sample', runtimeId)
  },
  ftp: {
    home: (runtimeId: string) => ipcRenderer.invoke('ftp:home', runtimeId),
    startDir: (runtimeId: string) => ipcRenderer.invoke('ftp:startDir', runtimeId),
    list: (runtimeId: string, path: string) => ipcRenderer.invoke('ftp:list', runtimeId, path),
    mkdir: (runtimeId: string, path: string) => ipcRenderer.invoke('ftp:mkdir', runtimeId, path),
    remove: (runtimeId: string, path: string, isDir: boolean) =>
      ipcRenderer.invoke('ftp:remove', runtimeId, path, isDir),
    rename: (runtimeId: string, from: string, to: string) =>
      ipcRenderer.invoke('ftp:rename', runtimeId, from, to),
    chmod: (runtimeId: string, path: string, mode: number) =>
      ipcRenderer.invoke('ftp:chmod', runtimeId, path, mode),
    upload: (
      runtimeId: string,
      localPaths: string[],
      remoteDir: string,
      transferId?: string
    ) => ipcRenderer.invoke('ftp:upload', runtimeId, localPaths, remoteDir, transferId),
    download: (
      runtimeId: string,
      remotePaths: string[],
      localDir: string,
      transferId?: string
    ) => ipcRenderer.invoke('ftp:download', runtimeId, remotePaths, localDir, transferId),
    cancel: (transferId: string) => ipcRenderer.invoke('ftp:cancel', transferId)
  },
  sftp: {
    home: (runtimeId) => ipcRenderer.invoke('sftp:home', runtimeId),
    startDir: (runtimeId) => ipcRenderer.invoke('sftp:startDir', runtimeId),
    list: (runtimeId, path) => ipcRenderer.invoke('sftp:list', runtimeId, path),
    mkdir: (runtimeId, path) => ipcRenderer.invoke('sftp:mkdir', runtimeId, path),
    remove: (runtimeId, path, isDir) => ipcRenderer.invoke('sftp:remove', runtimeId, path, isDir),
    rename: (runtimeId, from, to) => ipcRenderer.invoke('sftp:rename', runtimeId, from, to),
    chmod: (runtimeId, path, mode) => ipcRenderer.invoke('sftp:chmod', runtimeId, path, mode),
    upload: (runtimeId, localPaths, remoteDir, transferId) =>
      ipcRenderer.invoke('sftp:upload', runtimeId, localPaths, remoteDir, transferId),
    download: (runtimeId, remotePaths, localDir, transferId) =>
      ipcRenderer.invoke('sftp:download', runtimeId, remotePaths, localDir, transferId),
    cancel: (transferId) => ipcRenderer.invoke('sftp:cancel', transferId)
  },
  tunnels: {
    start: (config) => ipcRenderer.invoke('tunnels:start', config),
    stop: (id) => ipcRenderer.invoke('tunnels:stop', id),
    list: (runtimeId) => ipcRenderer.invoke('tunnels:list', runtimeId)
  },
  layouts: {
    get: () => ipcRenderer.invoke('layouts:get'),
    save: (layout) => ipcRenderer.invoke('layouts:save', layout)
  },
  fs: {
    home: () => ipcRenderer.invoke('fs:home'),
    startDir: () => ipcRenderer.invoke('fs:startDir'),
    drives: () => ipcRenderer.invoke('fs:drives'),
    list: (path) => ipcRenderer.invoke('fs:list', path),
    mkdir: (path) => ipcRenderer.invoke('fs:mkdir', path),
    remove: (path, isDir) => ipcRenderer.invoke('fs:remove', path, isDir),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', from, to),
    pickFile: () => ipcRenderer.invoke('fs:pickFile'),
    pickDirectory: () => ipcRenderer.invoke('fs:pickDirectory')
  },
  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text)
  },
  events: {
    on(callback) {
      const listener = (_event: Electron.IpcRendererEvent, event: AppEvent): void => callback(event)
      ipcRenderer.on('hshell:event', listener)
      return () => ipcRenderer.removeListener('hshell:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('hshell', api)

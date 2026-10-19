import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, HshellApi } from '@shared/types'

const api: HshellApi = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    setLocale: (locale) => ipcRenderer.invoke('app:setLocale', locale)
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
  ssh: {
    connect: (req) => ipcRenderer.invoke('ssh:connect', req),
    disconnect: (runtimeId) => ipcRenderer.invoke('ssh:disconnect', runtimeId),
    write: (runtimeId, data) => ipcRenderer.invoke('ssh:write', runtimeId, data),
    resize: (runtimeId, cols, rows) => ipcRenderer.invoke('ssh:resize', runtimeId, cols, rows),
    ack: (runtimeId, bytes) => ipcRenderer.invoke('ssh:ack', runtimeId, bytes),
    hostKeyDecision: (requestId, accept) =>
      ipcRenderer.invoke('ssh:hostKeyDecision', requestId, accept),
    keyboardInteractive: (requestId, responses, cancel) =>
      ipcRenderer.invoke('ssh:keyboardInteractive', requestId, responses, cancel)
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

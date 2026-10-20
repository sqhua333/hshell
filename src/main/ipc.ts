import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  type IpcMainInvokeEvent
} from 'electron'
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import os from 'node:os'
import type { AppEvent, FileEntry, Folder, Session } from '@shared/types'
import {
  connectRequestSchema,
  folderSchema,
  keyGenerateSchema,
  keyImportSchema,
  recordingSaveSchema,
  sessionSchema,
  tunnelConfigSchema,
  vaultUnlockSchema,
  windowLayoutSchema
} from '@shared/schemas'
import { createMenu } from './menu'
import { AppStore } from './store'
import { CredentialStore } from './storage/credential-store'
import { LayoutStore } from './storage/layout-store'
import { listSerialPorts, SerialManager } from './serial/manager'
import { KeyService } from './ssh/key-service'
import { KnownHosts } from './ssh/known-hosts'
import { SshManager } from './ssh/manager'
import { Vault } from './storage/vault'
import {
  buildExportBundle,
  importEmbeddedKeys,
  parseExportBundle,
  serializeBundle
} from './storage/export-import'
import { sshConfigToSessions } from './storage/ssh-config'
import { resolveStartDir } from './util/start-dir'
import {
  attachStoredCredentials,
  jumpCredentialId,
  sessionCredentialId
} from './storage/session-credentials'

const MAX_IMPORT_BYTES = 20 * 1024 * 1024
const MAX_SSH_CONFIG_BYTES = 2 * 1024 * 1024

function assertAbsolute(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('需要绝对路径')
  return resolve(path)
}

function optionalPassword(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    ? value
    : undefined
}

function optionalTransferId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  if (value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error('传输 ID 无效')
  }
  return value
}

function readTextFile(file: string, maxBytes: number): string {
  const stats = statSync(file)
  if (!stats.isFile()) throw new Error('请选择文件')
  if (stats.size > maxBytes) throw new Error('文件过大，已取消导入')
  return readFileSync(file, 'utf8')
}

function localList(path: string): FileEntry[] {
  const target = assertAbsolute(path)
  const entries = readdirSync(target, { withFileTypes: true })
  return entries
    .map((entry) => {
      const full = join(target, entry.name)
      let stats: ReturnType<typeof statSync> | null = null
      try {
        stats = statSync(full)
      } catch {
        stats = null
      }
      const type = entry.isDirectory()
        ? 'directory'
        : entry.isSymbolicLink()
          ? 'symlink'
          : entry.isFile()
            ? 'file'
            : 'other'
      return {
        name: entry.name,
        path: full,
        type,
        size: stats?.size ?? 0,
        mtime: stats?.mtimeMs ?? 0,
        mode: stats?.mode ?? 0
      } as FileEntry
    })
    .sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (b.type === 'directory' && a.type !== 'directory') return 1
      return a.name.localeCompare(b.name)
    })
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const userData = app.getPath('userData')
  const storageAdapter = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    getSelectedStorageBackend: () =>
      process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'unknown',
    encryptString: (text: string) => safeStorage.encryptString(text),
    decryptString: (buffer: Buffer) => safeStorage.decryptString(buffer)
  }
  const store = new AppStore(userData)
  const credentials = new CredentialStore(userData, storageAdapter)
  const layouts = new LayoutStore(userData)
  const knownHosts = new KnownHosts(userData)
  const vault = new Vault(userData, storageAdapter)
  const keys = new KeyService(userData, vault)
  const emit = (event: AppEvent): void => {
    getWindow()?.webContents.send('hshell:event', event)
  }
  const zmodemHost = {
    async pickDownloadDirectory(suggestedName?: string): Promise<string | null> {
      const win = getWindow()
      if (!win) return null
      const result = await dialog.showOpenDialog(win, {
        title: suggestedName ? `保存 ${suggestedName} 到目录` : '选择接收文件的保存目录',
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
      })
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    async pickUploadFiles(): Promise<string[] | null> {
      const win = getWindow()
      if (!win) return null
      const result = await dialog.showOpenDialog(win, {
        title: '选择要发送到远程的文件（rz）',
        properties: ['openFile', 'multiSelections', 'showHiddenFiles']
      })
      return result.canceled ? null : result.filePaths
    }
  }
  const ssh = new SshManager(
    knownHosts,
    emit,
    zmodemHost,
    (keyId) => keys.getPrivateKey(keyId),
    join(userData, 'logs')
  )
  const serial = new SerialManager(emit, zmodemHost, join(userData, 'logs'))

  const assertSender = (event: IpcMainInvokeEvent): void => {
    const win = getWindow()
    if (!win || event.sender !== win.webContents) {
      throw new Error('Unauthorized IPC sender')
    }
  }

  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertSender(event)
      return await fn(...(args as never[]))
    })
  }

  handle('app:info', () => ({
    name: 'HShell',
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    username: os.userInfo().username
  }))
  handle('app:setLocale', (locale: unknown) => {
    createMenu(locale === 'en' ? 'en' : 'zh')
  })

  handle('window:toggleFullScreen', () => {
    const win = getWindow()
    if (win) win.setFullScreen(!win.isFullScreen())
  })

  handle('sessions:list', () => store.list())
  handle('sessions:save', (input: Session) => {
    const parsed = sessionSchema.parse(input)
    const previous = store.findSession(parsed.id)
    const saved = store.saveSession(parsed)
    if (parsed.auth.savePassword && parsed.auth.password) {
      credentials.put(sessionCredentialId(saved.id), parsed.auth.password)
    } else if (!parsed.auth.savePassword) {
      credentials.remove(sessionCredentialId(saved.id))
    }

    const keptJumpIds = new Set<string>()
    for (const jump of parsed.jumpHosts ?? []) {
      keptJumpIds.add(jump.id)
      const key = jumpCredentialId(saved.id, jump.id)
      const auth = jump.auth
      if (auth?.method === 'password' && auth.savePassword) {
        if (auth.password) credentials.put(key, auth.password)
      } else {
        credentials.remove(key)
      }
    }
    for (const jump of previous?.jumpHosts ?? []) {
      if (!keptJumpIds.has(jump.id)) credentials.remove(jumpCredentialId(saved.id, jump.id))
    }
    return saved
  })
  handle('sessions:remove', (id: string) => {
    const sessionId = String(id)
    const previous = store.findSession(sessionId)
    store.removeSession(sessionId)
    credentials.remove(sessionCredentialId(sessionId))
    for (const jump of previous?.jumpHosts ?? []) {
      credentials.remove(jumpCredentialId(sessionId, jump.id))
    }
  })
  handle('folders:save', (input: Folder) => store.saveFolder(folderSchema.parse(input)))
  handle('folders:remove', (id: string) => store.removeFolder(String(id)))

  handle('sessions:export', async (rawOptions?: { includeKeys?: boolean; password?: string }) => {
    const win = getWindow()
    if (!win) return { canceled: true, folders: 0, sessions: 0 }
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {}
    const { bundle, keyCount } = buildExportBundle(store.exportData(), {
      appName: 'HShell',
      appVersion: app.getVersion(),
      includeKeys: Boolean(options.includeKeys),
      password: optionalPassword(options.password)
    })

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const result = await dialog.showSaveDialog(win, {
      title: '导出会话',
      defaultPath: join(app.getPath('documents'), `hshell-sessions-${stamp}.json`),
      filters: [{ name: 'HShell 会话文件', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true, folders: 0, sessions: 0 }

    writeFileSync(result.filePath, serializeBundle(bundle), { mode: 0o600 })
    return {
      canceled: false,
      filePath: result.filePath,
      folders: bundle.folders.length,
      sessions: bundle.sessions.length,
      keys: keyCount
    }
  })

  handle('sessions:import', async (rawOptions?: { password?: string }) => {
    const win = getWindow()
    if (!win) return { canceled: true, folders: 0, sessions: 0, skipped: 0 }
    const result = await dialog.showOpenDialog(win, {
      title: '导入会话',
      properties: ['openFile'],
      filters: [{ name: 'HShell 会话文件', extensions: ['json'] }]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) {
      return { canceled: true, folders: 0, sessions: 0, skipped: 0 }
    }

    const bundle = parseExportBundle(readTextFile(filePath, MAX_IMPORT_BYTES))
    const options = rawOptions && typeof rawOptions === 'object' ? rawOptions : {}
    const { keyMap, count } = importEmbeddedKeys(
      bundle.keys,
      optionalPassword(options.password),
      join(app.getPath('userData'), 'keys')
    )
    const merged = store.importBundle(bundle, { keyMap })
    return {
      canceled: false,
      filePath,
      folders: merged.folders,
      sessions: merged.sessions,
      skipped: merged.skipped,
      keys: count
    }
  })

  handle('sessions:importSshConfig', async () => {
    const win = getWindow()
    if (!win) return { canceled: true, imported: 0, skipped: 0 }
    const result = await dialog.showOpenDialog(win, {
      title: '从 ~/.ssh/config 导入',
      defaultPath: join(os.homedir(), '.ssh', 'config'),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'SSH 配置', extensions: ['config'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return { canceled: true, imported: 0, skipped: 0 }

    const text = readTextFile(filePath, MAX_SSH_CONFIG_BYTES)
    const { sessions, skipped, warnings } = sshConfigToSessions(text, {
      username: os.userInfo().username,
      idFactory: (prefix) => store.newId(prefix)
    })
    const merged = store.importSessions(sessions, skipped)
    return {
      canceled: false,
      filePath,
      imported: merged.sessions,
      skipped: merged.skipped,
      warnings
    }
  })

  handle('vault:status', () => vault.status())
  handle('vault:unlock', (password: unknown) => {
    const ok = vault.unlock(vaultUnlockSchema.parse(String(password)))
    if (!ok) throw new Error('主密码错误')
    return vault.status()
  })
  handle('vault:lock', () => {
    vault.lock()
    return vault.status()
  })

  handle('keys:list', () => keys.list())
  handle('keys:generate', (input: unknown) => keys.generate(keyGenerateSchema.parse(input)))
  handle('keys:import', (input: unknown) => keys.importPrivateKey(keyImportSchema.parse(input)))
  handle('keys:remove', (id: string) => keys.remove(String(id)))
  handle('keys:publicKey', (id: string) => keys.publicKey(String(id)))
  handle('keys:install', (runtimeId: string, keyId: string) =>
    ssh.installPublicKey(String(runtimeId), keys.publicKey(String(keyId)))
  )

  handle('serial:list', () => listSerialPorts())

  handle('ssh:connect', async (req: unknown) => {
    const parsed = connectRequestSchema.parse(req)
    if (parsed.session.connectionType === 'serial') {
      await serial.connect(parsed)
      return
    }
    const session = attachStoredCredentials(parsed.session, credentials)
    await ssh.connect({ ...parsed, session })
  })
  // Serial runtimes use the same channels; dispatch by runtime ownership.
  handle('ssh:disconnect', (runtimeId: string) => {
    const id = String(runtimeId)
    if (serial.has(id)) serial.disconnect(id)
    else ssh.disconnect(id)
  })
  handle('ssh:write', (runtimeId: string, data: string) => {
    const id = String(runtimeId)
    if (serial.has(id)) serial.write(id, String(data))
    else ssh.write(id, String(data))
  })
  handle('ssh:resize', (runtimeId: string, cols: number, rows: number) => {
    const id = String(runtimeId)
    if (serial.has(id)) serial.resize(id, Number(cols), Number(rows))
    else ssh.resize(id, Number(cols), Number(rows))
  })
  handle('ssh:ack', (runtimeId: string, bytes: number) => {
    const id = String(runtimeId)
    if (serial.has(id)) serial.ack(id, Number(bytes))
    else ssh.ack(id, Number(bytes))
  })
  handle('ssh:hostKeyDecision', (requestId: string, accept: boolean) =>
    ssh.hostKeyDecision(String(requestId), Boolean(accept))
  )
  handle('ssh:keyboardInteractive', (requestId: string, responses?: string[], cancel?: boolean) =>
    ssh.keyboardInteractive(String(requestId), responses, cancel)
  )

  handle('sftp:home', (runtimeId: string) => ssh.sftpHome(String(runtimeId)))
  handle('sftp:startDir', (runtimeId: string) => ssh.sftpStartDir(String(runtimeId)))
  handle('sftp:list', (runtimeId: string, path: string) => ssh.sftpList(String(runtimeId), String(path)))
  handle('sftp:mkdir', (runtimeId: string, path: string) => ssh.sftpMkdir(String(runtimeId), String(path)))
  handle('sftp:remove', (runtimeId: string, path: string, isDir: boolean) =>
    ssh.sftpRemove(String(runtimeId), String(path), Boolean(isDir))
  )
  handle('sftp:rename', (runtimeId: string, from: string, to: string) =>
    ssh.sftpRename(String(runtimeId), String(from), String(to))
  )
  handle('sftp:chmod', (runtimeId: string, path: string, mode: number) =>
    ssh.sftpChmod(String(runtimeId), String(path), Number(mode))
  )
  handle(
    'sftp:upload',
    (runtimeId: string, localPaths: string[], remoteDir: string, transferId?: string) => {
      if (!Array.isArray(localPaths)) throw new Error('本地路径无效')
      return ssh.upload(
        String(runtimeId),
        localPaths.map(assertAbsolute),
        String(remoteDir),
        optionalTransferId(transferId)
      )
    }
  )
  handle(
    'sftp:download',
    (runtimeId: string, remotePaths: string[], localDir: string, transferId?: string) => {
      if (!Array.isArray(remotePaths)) throw new Error('远程路径无效')
      return ssh.download(
        String(runtimeId),
        remotePaths.map(String),
        assertAbsolute(localDir),
        optionalTransferId(transferId)
      )
    }
  )
  handle('sftp:cancel', (transferId: string) => {
    ssh.cancelTransfer(String(transferId))
  })

  handle('tunnels:start', (input: unknown) => ssh.startTunnel(tunnelConfigSchema.parse(input)))
  handle('tunnels:stop', (id: string) => ssh.stopTunnel(String(id)))
  handle('tunnels:list', (runtimeId: string) => ssh.listTunnels(String(runtimeId)))

  handle('layouts:get', () => layouts.get())
  handle('layouts:save', (input: unknown) => layouts.save(windowLayoutSchema.parse(input)))

  handle('fs:home', () => os.homedir())
  handle('fs:startDir', () =>
    resolveStartDir(os.homedir(), (path) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    })
  )
  handle('fs:list', (path: string) => localList(String(path)))
  handle('fs:mkdir', (path: string) => {
    mkdirSync(assertAbsolute(path))
  })
  handle('fs:remove', (path: string, isDir: boolean) => {
    rmSync(assertAbsolute(path), { recursive: Boolean(isDir), force: false })
  })
  handle('fs:rename', (from: string, to: string) => {
    renameSync(assertAbsolute(from), assertAbsolute(to))
  })
  handle('fs:pickFile', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择私钥文件',
      properties: ['openFile', 'showHiddenFiles']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('fs:pickDirectory', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择目录',
      properties: ['openDirectory', 'showHiddenFiles']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle('recording:saveScript', async (content: unknown, defaultName?: unknown) => {
    const win = getWindow()
    if (!win) return { canceled: true }
    const input = recordingSaveSchema.parse({ content, defaultName })
    const fallback = `hshell-recording-${Date.now()}.mjs`
    const result = await dialog.showSaveDialog(win, {
      title: '保存回放脚本',
      defaultPath: join(app.getPath('documents'), input.defaultName ?? fallback),
      filters: [{ name: 'JavaScript 脚本', extensions: ['mjs'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const filePath = result.filePath.endsWith('.mjs') ? result.filePath : `${result.filePath}.mjs`
    writeFileSync(filePath, input.content, { mode: 0o600 })
    try {
      chmodSync(filePath, 0o600)
    } catch {
      /* best-effort on filesystems without POSIX modes */
    }
    return { canceled: false, filePath }
  })

  handle('clipboard:readText', () => clipboard.readText())
  handle('clipboard:writeText', (text: string) => clipboard.writeText(String(text)))
}

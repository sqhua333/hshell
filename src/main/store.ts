import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Folder, Session, SessionData } from '@shared/types'
import type { ExportBundle } from '@shared/schemas'
import { readEnvelope, writeEnvelope } from './storage/json-file'
import {
  STORAGE_SCHEMA_VERSION,
  assertNoFolderCycles,
  migrateSessions,
  normalizeFolders
} from './storage/migrations'
import {
  buildExportBundle,
  mergeSessions,
  stripSessionPasswords,
  type MergeOptions
} from './storage/export-import'

function seed(): SessionData {
  const now = Date.now()
  const username = os.userInfo().username
  const terminal = { term: 'xterm-256color', theme: 'dark' as const, fontSize: 14 }
  const folders: Folder[] = [
    { id: 'f-local', name: '本地与测试', parentId: null, sortOrder: 0 },
    { id: 'f-prod', name: '生产环境（示例）', parentId: null, sortOrder: 1 }
  ]
  const sessions: Session[] = [
    {
      id: 's-local',
      name: 'localhost',
      folderId: 'f-local',
      host: '127.0.0.1',
      port: 22,
      username,
      auth: { method: 'key', keyPath: '~/.ssh/id_rsa' },
      terminal,
      proxyJump: null,
      color: '#2a6fd6',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 's-demo-web',
      name: 'web-prod-01（示例）',
      folderId: 'f-prod',
      host: '10.0.0.11',
      port: 22,
      username: 'root',
      auth: { method: 'agent' },
      terminal,
      proxyJump: null,
      color: '#d97706',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 's-demo-db',
      name: 'db-prod-01（示例）',
      folderId: 'f-prod',
      host: '10.0.0.12',
      port: 22,
      username: 'root',
      auth: { method: 'password' },
      terminal,
      proxyJump: null,
      color: '#059669',
      createdAt: now,
      updatedAt: now
    }
  ]
  return { folders, sessions }
}

export class AppStore {
  private sessionsFile: string
  private foldersFile: string
  private folders: Folder[] = []
  private sessions: Session[] = []
  /** A data file written by a newer HShell must not be overwritten. */
  private blocked = false

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.sessionsFile = join(dir, 'sessions.json')
    this.foldersFile = join(dir, 'folders.json')
    this.load()
  }

  private load(): void {
    const sessionsRead = readEnvelope(this.sessionsFile)
    const foldersRead = readEnvelope(this.foldersFile)

    if (
      sessionsRead.schemaVersion > STORAGE_SCHEMA_VERSION ||
      foldersRead.schemaVersion > STORAGE_SCHEMA_VERSION
    ) {
      this.blocked = true
      return
    }

    const seeded = seed()
    this.sessions = sessionsRead.missing
      ? seeded.sessions
      : migrateSessions(sessionsRead.data, sessionsRead.schemaVersion)

    const folders = foldersRead.missing
      ? { folders: seeded.folders, repaired: false }
      : normalizeFolders(foldersRead.data)
    this.folders = folders.folders

    if (sessionsRead.missing || sessionsRead.schemaVersion < STORAGE_SCHEMA_VERSION) {
      this.persistSessions()
    }
    if (
      foldersRead.missing ||
      foldersRead.schemaVersion < STORAGE_SCHEMA_VERSION ||
      folders.repaired
    ) {
      this.persistFolders()
    }
  }

  private assertWritable(): void {
    if (this.blocked) {
      throw new Error('会话数据来自较新版本的 HShell，请升级后再修改')
    }
  }

  private persistSessions(): void {
    writeEnvelope(this.sessionsFile, this.sessions, STORAGE_SCHEMA_VERSION)
  }

  private persistFolders(): void {
    writeEnvelope(this.foldersFile, this.folders, STORAGE_SCHEMA_VERSION)
  }

  list(): SessionData {
    return {
      folders: [...this.folders].sort((a, b) => a.sortOrder - b.sortOrder),
      sessions: [...this.sessions]
    }
  }

  exportData(): SessionData {
    return this.list()
  }

  findSession(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id)
  }

  saveSession(input: Session): Session {
    this.assertWritable()
    const now = Date.now()
    const existing = this.sessions.find((s) => s.id === input.id)
    const auth = { ...input.auth }
    delete auth.password
    const jumpHosts = input.jumpHosts?.map((jump) => {
      if (!jump.auth) return { ...jump }
      const jumpAuth = { ...jump.auth }
      delete jumpAuth.password
      return { ...jump, auth: jumpAuth }
    })
    const folderId =
      input.folderId && !this.folders.some((folder) => folder.id === input.folderId)
        ? null
        : input.folderId
    // Console login passwords follow the SSH rule: never on disk. An empty
    // password with savePassword means "keep the stored credential".
    let serial = input.serial
    if (serial?.login) {
      const login = { ...serial.login }
      delete login.password
      serial = { ...serial, login: login.enabled ? login : undefined }
    }
    const session: Session = {
      ...input,
      auth,
      jumpHosts,
      serial,
      folderId,
      proxyJump: input.proxyJump ?? null,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    }
    if (existing) {
      this.sessions = this.sessions.map((s) => (s.id === session.id ? session : s))
    } else {
      this.sessions.push(session)
    }
    this.persistSessions()
    return { ...session, auth: { ...session.auth, password: undefined } }
  }

  /**
   * Move a session to another folder and/or position. The array order is the
   * display order, so it is persisted as-is and survives a restart.
   */
  moveSession(id: string, folderId: string | null, beforeId: string | null): SessionData {
    this.assertWritable()
    const session = this.sessions.find((item) => item.id === id)
    if (!session) throw new Error('会话不存在')
    const target =
      folderId && this.folders.some((folder) => folder.id === folderId) ? folderId : null
    const rest = this.sessions.filter((item) => item.id !== id)
    // Only a sibling in the target folder is a meaningful insertion point.
    const at = beforeId
      ? rest.findIndex((item) => item.id === beforeId && item.folderId === target)
      : -1
    rest.splice(at >= 0 ? at : rest.length, 0, {
      ...session,
      folderId: target,
      updatedAt: Date.now()
    })
    this.sessions = rest
    this.persistSessions()
    return this.list()
  }

  removeSession(id: string): void {
    this.assertWritable()
    this.sessions = this.sessions.filter((s) => s.id !== id)
    this.persistSessions()
  }

  saveFolder(input: Folder): Folder {
    this.assertWritable()
    const existing = this.folders.find((f) => f.id === input.id)
    if (input.parentId && !this.folders.some((folder) => folder.id === input.parentId)) {
      throw new Error('父分组不存在')
    }
    if (input.parentId === input.id) {
      throw new Error('分组不能以自身为父分组')
    }
    const folder = {
      ...input,
      sortOrder: existing?.sortOrder ?? input.sortOrder ?? this.folders.length
    }
    const next = existing
      ? this.folders.map((f) => (f.id === folder.id ? folder : f))
      : [...this.folders, folder]
    assertNoFolderCycles(next)
    this.folders = next
    this.persistFolders()
    return folder
  }

  removeFolder(id: string): void {
    this.assertWritable()
    if (this.folders.some((f) => f.parentId === id)) {
      throw new Error('请先删除或移动该分组下的子分组')
    }
    this.folders = this.folders.filter((f) => f.id !== id)
    this.sessions = this.sessions.map((s) =>
      s.folderId === id ? { ...s, folderId: null, updatedAt: Date.now() } : s
    )
    this.persistFolders()
    this.persistSessions()
  }

  /** Merge an export bundle into the store and persist the result. */
  importBundle(bundle: ExportBundle, options: MergeOptions = {}): {
    folders: number
    sessions: number
    skipped: number
  } {
    this.assertWritable()
    // The bundle is user-supplied JSON; merge it only after the same secret
    // stripping the export path applies.
    const sanitized: ExportBundle = {
      ...bundle,
      sessions: bundle.sessions.map((session) => stripSessionPasswords(session as Session))
    }
    const merged = mergeSessions(
      { folders: this.folders, sessions: this.sessions },
      sanitized,
      options
    )
    this.folders = merged.data.folders
    this.sessions = merged.data.sessions
    this.persistFolders()
    this.persistSessions()
    return { folders: merged.folders, sessions: merged.sessions, skipped: merged.skipped }
  }

  /** Merge freshly created sessions (e.g. from ssh config). */
  importSessions(sessions: Session[], skipped = 0): { sessions: number; skipped: number } {
    this.assertWritable()
    const { bundle } = buildExportBundle(
      { folders: [], sessions },
      { appName: 'HShell', appVersion: '0.0.0' }
    )
    const merged = mergeSessions(
      { folders: this.folders, sessions: this.sessions },
      bundle,
      { dedupe: true }
    )
    this.folders = merged.data.folders
    this.sessions = merged.data.sessions
    this.persistFolders()
    this.persistSessions()
    return { sessions: merged.sessions, skipped: merged.skipped + skipped }
  }

  newId(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`
  }
}

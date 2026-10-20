import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Session, SessionData } from '@shared/types'
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  exportBundleSchema,
  type ExportBundle,
  type ExportedKey
} from '@shared/schemas'
import { findFolderCycles } from './migrations'
import { sanitizeFileName, uniqueFilePath } from './path-safety'

/** Refuse to embed anything larger than this much key material. */
const MAX_KEY_BYTES = 512 * 1024
const MIN_EXPORT_PASSWORD = 8

export interface ExportBuildOptions {
  appName: string
  appVersion: string
  includeKeys?: boolean
  password?: string
}

export interface MergeOptions {
  /** Skip sessions whose host/port/username already exists locally. */
  dedupe?: boolean
  /** Remap exported key paths to local files written on import. */
  keyMap?: Map<string, string>
  idFactory?: (prefix: string) => string
}

export interface MergeResult {
  data: SessionData
  folders: number
  sessions: number
  skipped: number
}

function defaultIdFactory(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

function stripPassword(session: Session): ExportBundle['sessions'][number] {
  const auth = { ...session.auth }
  delete auth.password
  const jumpHosts = session.jumpHosts?.map((jump) => {
    if (!jump.auth) return { ...jump }
    const jumpAuth = { ...jump.auth }
    delete jumpAuth.password
    return { ...jump, auth: jumpAuth }
  })
  return {
    ...session,
    auth,
    ...(jumpHosts ? { jumpHosts } : {}),
    proxyJump: session.proxyJump ?? null
  }
}

/** Expand `~` and relative key paths the way the SSH client resolves them. */
export function expandKeyPath(keyPath: string): string {
  if (keyPath === '~') return homedir()
  if (keyPath.startsWith('~/')) return join(homedir(), keyPath.slice(2))
  return isAbsolute(keyPath) ? keyPath : resolve(homedir(), keyPath)
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

export function encryptKeyMaterial(
  plain: Buffer,
  password: string
): Pick<ExportedKey, 'salt' | 'iv' | 'tag' | 'data'> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt), iv)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

export function decryptKeyMaterial(entry: ExportedKey, password: string): Buffer {
  const salt = Buffer.from(entry.salt, 'base64')
  const iv = Buffer.from(entry.iv, 'base64')
  const tag = Buffer.from(entry.tag, 'base64')
  if (salt.length < 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error('口令错误或密钥数据已损坏')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(password, salt), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()])
  } catch {
    throw new Error('口令错误或密钥数据已损坏')
  }
}

function collectKeys(sessions: Session[], password: string): ExportedKey[] {
  const keys: ExportedKey[] = []
  const seen = new Set<string>()

  for (const session of sessions) {
    if (session.auth.method !== 'key' || !session.auth.keyPath) continue
    const keyPath = session.auth.keyPath
    if (seen.has(keyPath)) continue
    seen.add(keyPath)

    const file = expandKeyPath(keyPath)
    try {
      const stats = statSync(file)
      if (!stats.isFile() || stats.size > MAX_KEY_BYTES) continue
      const plain = readFileSync(file)
      keys.push({
        path: keyPath,
        name: basename(file) || 'id_key',
        ...encryptKeyMaterial(plain, password)
      })
    } catch {
      // Missing/unreadable key files are left as path references.
    }
  }

  return keys
}

export function buildExportBundle(
  data: SessionData,
  options: ExportBuildOptions
): { bundle: ExportBundle; keyCount: number } {
  let keys: ExportedKey[] = []
  if (options.includeKeys) {
    const password = options.password ?? ''
    if (password.length < MIN_EXPORT_PASSWORD) {
      throw new Error(`导出私钥需要至少 ${MIN_EXPORT_PASSWORD} 位的口令`)
    }
    keys = collectKeys(data.sessions, password)
  }

  const bundle: ExportBundle = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: Date.now(),
    app: { name: options.appName, version: options.appVersion },
    folders: data.folders.map((folder) => ({ ...folder })),
    sessions: data.sessions.map(stripPassword),
    ...(keys.length > 0 ? { keys } : {})
  }

  return { bundle, keyCount: keys.length }
}

export function serializeBundle(bundle: ExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

export function parseExportBundle(text: string): ExportBundle {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('文件不是有效的 JSON')
  }
  const parsed = exportBundleSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error('不是有效的 HShell 会话导出文件')
  }
  return parsed.data
}

/**
 * Decrypt embedded private keys into `keysDir` and return a map from the
 * exported `keyPath` to the newly written local file.
 */
export function importEmbeddedKeys(
  keys: ExportedKey[] | undefined,
  password: string | undefined,
  keysDir: string
): { keyMap: Map<string, string>; count: number } {
  const keyMap = new Map<string, string>()
  if (!keys || keys.length === 0) return { keyMap, count: 0 }
  if (!password) throw new Error('该导出文件包含加密的私钥，请输入导出时使用的口令')

  mkdirSync(keysDir, { recursive: true, mode: 0o700 })
  for (const entry of keys) {
    const plain = decryptKeyMaterial(entry, password)
    const safeName = sanitizeFileName(entry.name) ?? 'id_key'
    const target = uniqueFilePath(keysDir, `imported-${safeName}`)
    // `wx` guarantees we never clobber an existing key.
    writeFileSync(target, plain, { mode: 0o600, flag: 'wx' })
    keyMap.set(entry.path, target)
  }

  return { keyMap, count: keys.length }
}

export function mergeSessions(
  current: SessionData,
  bundle: ExportBundle,
  options: MergeOptions = {}
): MergeResult {
  const cycles = findFolderCycles(bundle.folders)
  if (cycles.length > 0) throw new Error('导入文件中的分组存在循环引用')

  const idFactory = options.idFactory ?? defaultIdFactory
  const usedFolderIds = new Set(current.folders.map((folder) => folder.id))
  const folderMap = new Map<string, string>()

  // First pass: reserve an id for every imported folder (parents may appear
  // after their children in the file).
  for (const folder of bundle.folders) {
    let id = folder.id
    if (usedFolderIds.has(id)) {
      do {
        id = idFactory('folder')
      } while (usedFolderIds.has(id))
    }
    usedFolderIds.add(id)
    folderMap.set(folder.id, id)
  }

  const maxSortOrder = current.folders.reduce(
    (max, folder) => Math.max(max, folder.sortOrder),
    -1
  )
  const importedFolders = bundle.folders.map((folder, index) => ({
    ...folder,
    id: folderMap.get(folder.id)!,
    parentId: folder.parentId ? (folderMap.get(folder.parentId) ?? null) : null,
    sortOrder: maxSortOrder + 1 + index
  }))

  const existingKeys = new Set(
    current.sessions.map(
      (session) => `${session.host.toLowerCase()}\u0000${session.port}\u0000${session.username.toLowerCase()}`
    )
  )
  const usedSessionIds = new Set(current.sessions.map((session) => session.id))
  const importedSessions: Session[] = []
  let skipped = 0

  for (const source of bundle.sessions) {
    const dedupeKey = `${source.host.toLowerCase()}\u0000${source.port}\u0000${source.username.toLowerCase()}`
    if (options.dedupe && existingKeys.has(dedupeKey)) {
      skipped += 1
      continue
    }

    let id = source.id
    if (usedSessionIds.has(id)) {
      do {
        id = idFactory('session')
      } while (usedSessionIds.has(id))
    }
    usedSessionIds.add(id)

    const keyPath = source.auth.keyPath
    const mappedKeyPath = keyPath ? (options.keyMap?.get(keyPath) ?? keyPath) : undefined
    const jumpHosts = source.jumpHosts?.map((jump) => {
      if (!jump.auth) return { ...jump }
      const jumpKeyPath = jump.auth.keyPath
      return {
        ...jump,
        auth: {
          ...jump.auth,
          keyPath: jumpKeyPath ? (options.keyMap?.get(jumpKeyPath) ?? jumpKeyPath) : undefined
        }
      }
    })

    importedSessions.push({
      ...source,
      id,
      folderId: source.folderId ? (folderMap.get(source.folderId) ?? null) : null,
      auth: { ...source.auth, keyPath: mappedKeyPath },
      ...(jumpHosts ? { jumpHosts } : {}),
      proxyJump: source.proxyJump ?? null
    })
    existingKeys.add(dedupeKey)
  }

  return {
    data: {
      folders: [...current.folders, ...importedFolders],
      sessions: [...current.sessions, ...importedSessions]
    },
    folders: importedFolders.length,
    sessions: importedSessions.length,
    skipped
  }
}

/** Whether an export bundle carries encrypted key material. */
export function bundleHasKeys(bundle: ExportBundle): boolean {
  return Array.isArray(bundle.keys) && bundle.keys.length > 0
}

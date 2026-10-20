import type { Folder, Session } from '@shared/types'
import { folderSchema, sessionSchema } from '@shared/schemas'

/** Current on-disk schema version. Bumped when the persisted shape changes. */
export const STORAGE_SCHEMA_VERSION = 2

/**
 * Return every folder id that participates in a parent cycle (including a
 * self-reference). Missing parents are not cycles.
 */
export function findFolderCycles(folders: Folder[]): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const inCycle = new Set<string>()

  for (const folder of folders) {
    const path: string[] = []
    let current: Folder | undefined = folder
    while (current) {
      const index = path.indexOf(current.id)
      if (index >= 0) {
        for (const id of path.slice(index)) inCycle.add(id)
        break
      }
      path.push(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
  }

  return [...inCycle]
}

export function assertNoFolderCycles(folders: Folder[]): void {
  if (findFolderCycles(folders).length > 0) {
    throw new Error('分组层级存在循环引用，已取消操作')
  }
}

/**
 * Normalise loaded folders: drop invalid entries, point dangling parents at
 * the root and break any parent cycles.
 */
export function normalizeFolders(raw: unknown): { folders: Folder[]; repaired: boolean } {
  const folders: Folder[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const parsed = folderSchema.safeParse(item)
      if (parsed.success) folders.push(parsed.data)
    }
  }

  const ids = new Set(folders.map((folder) => folder.id))
  const cycles = new Set(findFolderCycles(folders))
  let repaired = cycles.size > 0
  const normalised = folders.map((folder) => {
    if (folder.parentId !== null && !ids.has(folder.parentId)) {
      repaired = true
      return { ...folder, parentId: null }
    }
    if (cycles.has(folder.id)) {
      return { ...folder, parentId: null }
    }
    return folder
  })

  return { folders: normalised, repaired }
}

/**
 * Convert persisted sessions into the current in-memory shape.
 *
 * - passwords are always stripped (they are never written to disk)
 * - unknown/invalid entries are dropped instead of poisoning the whole file
 * - `proxyJump` is introduced in schema v2
 */
export function migrateSessions(raw: unknown, fromVersion: number): Session[] {
  if (!Array.isArray(raw)) return []
  const sessions: Session[] = []

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = { ...(item as Record<string, unknown>) }
    const auth =
      source.auth && typeof source.auth === 'object'
        ? { ...(source.auth as Record<string, unknown>) }
        : {}
    delete auth.password
    source.auth = auth
    if (Array.isArray(source.jumpHosts)) {
      source.jumpHosts = source.jumpHosts.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry
        const jump = { ...(entry as Record<string, unknown>) }
        if (jump.auth && typeof jump.auth === 'object') {
          const jumpAuth = { ...(jump.auth as Record<string, unknown>) }
          delete jumpAuth.password
          jump.auth = jumpAuth
        }
        return jump
      })
    }

    if (fromVersion < 2 && source.proxyJump === undefined) {
      source.proxyJump = null
    }

    const parsed = sessionSchema.safeParse(source)
    if (parsed.success) sessions.push(parsed.data)
  }

  return sessions
}

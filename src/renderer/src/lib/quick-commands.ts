import type { QuickCommand } from '@shared/types'

export const QUICK_COMMAND_MAX = 100
export const QUICK_COMMAND_LABEL_MAX = 64
export const QUICK_COMMAND_TEXT_MAX = 4096

export type QuickCommandIdFactory = () => string

function defaultIdFactory(): string {
  return `qc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function keyOf(item: QuickCommand): string {
  return `${item.label}\u0000${item.command}`
}

/**
 * Accept only well-formed, non-empty entries; trim text, drop duplicates and
 * cap the list at the same limit enforced by the session schema.
 */
export function normalizeQuickCommands(
  input: unknown,
  idFactory: QuickCommandIdFactory = defaultIdFactory
): QuickCommand[] {
  if (!Array.isArray(input)) return []
  const result: QuickCommand[] = []
  const seen = new Set<string>()

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const label = typeof item.label === 'string' ? item.label.trim() : ''
    const command = typeof item.command === 'string' ? item.command.trim() : ''
    if (!label || !command) continue
    if (label.length > QUICK_COMMAND_LABEL_MAX || command.length > QUICK_COMMAND_TEXT_MAX) {
      continue
    }
    const id = typeof item.id === 'string' && item.id ? item.id : idFactory()
    const entry: QuickCommand = {
      id,
      label,
      command,
      ...(item.sendEnter === false ? { sendEnter: false } : {})
    }
    const key = keyOf(entry)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
    if (result.length >= QUICK_COMMAND_MAX) break
  }

  return result
}

/** Merge legacy per-session commands into a global list without duplicates. */
export function mergeQuickCommands(
  globalCommands: QuickCommand[],
  sessions: Array<{ quickCommands?: QuickCommand[] }>,
  idFactory: QuickCommandIdFactory = defaultIdFactory
): QuickCommand[] {
  const merged = normalizeQuickCommands(globalCommands, idFactory)
  const seen = new Set(merged.map(keyOf))

  for (const session of sessions) {
    for (const item of normalizeQuickCommands(session.quickCommands, idFactory)) {
      const key = keyOf(item)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(item)
      if (merged.length >= QUICK_COMMAND_MAX) return merged
    }
  }

  return merged
}

/** Parse localStorage content; returns null when the key has never been set. */
export function parseStoredQuickCommands(
  raw: string | null,
  idFactory: QuickCommandIdFactory = defaultIdFactory
): QuickCommand[] | null {
  if (raw === null) return null
  try {
    return normalizeQuickCommands(JSON.parse(raw), idFactory)
  } catch {
    return []
  }
}

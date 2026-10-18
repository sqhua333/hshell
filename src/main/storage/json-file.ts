import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'

export interface Envelope {
  schemaVersion: number
  data: unknown
}

export interface ReadEnvelopeResult {
  data: unknown
  schemaVersion: number
  /** File did not exist (fallback data should be seeded). */
  missing: boolean
  /** File existed but could not be parsed; it was renamed aside. */
  corrupted: boolean
}

/**
 * Read an atomic JSON envelope. Unreadable or non-envelope files are moved
 * aside instead of silently overwriting user data.
 */
export function readEnvelope(file: string): ReadEnvelopeResult {
  if (!existsSync(file)) {
    return { data: undefined, schemaVersion: 0, missing: true, corrupted: false }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Envelope
    if (!parsed || typeof parsed !== 'object' || typeof parsed.schemaVersion !== 'number') {
      throw new Error('invalid envelope')
    }
    return {
      data: parsed.data,
      schemaVersion: parsed.schemaVersion,
      missing: false,
      corrupted: false
    }
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    return { data: undefined, schemaVersion: 0, missing: true, corrupted: true }
  }
}

/** Write an envelope atomically (temp file + rename, keeping a .bak copy). */
export function writeEnvelope(file: string, data: unknown, schemaVersion: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const payload: Envelope = { schemaVersion, data }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(payload, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (existsSync(file)) {
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      /* ignore */
    }
  }
  renameSync(tmp, file)
}

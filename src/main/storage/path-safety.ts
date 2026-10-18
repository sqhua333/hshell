import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'

/** Windows device names that cannot be used as file names. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Turn a peer-supplied file name into a safe local base name.
 *
 * The name is reduced to its final path component, control characters are
 * removed and Windows-hostile trailing dots/spaces are trimmed. Returns null
 * when nothing usable remains.
 */
export function sanitizeFileName(input: unknown): string | null {
  if (typeof input !== 'string') return null
  if (input.includes('\0')) return null

  // Treat both separators as path separators; only the last component matters.
  let name = input.replace(/\\/g, '/')
  name = name.slice(name.lastIndexOf('/') + 1)

  // Drop control characters (including DEL) and escape sequences entirely.
  name = name.replace(/[\u0000-\u001f\u007f]/g, '')
  name = name.replace(/[<>:"|?*]/g, '_')
  name = name.trim()
  if (!name || name === '.' || name === '..') return null

  // Windows silently strips trailing dots and spaces, which can cause
  // collisions or surprising names.
  name = name.replace(/[. ]+$/g, '')
  if (!name) return null

  if (WINDOWS_RESERVED.test(name)) name = `_${name}`

  if (Buffer.byteLength(name, 'utf8') > 255) {
    let truncated = ''
    for (const char of name) {
      if (Buffer.byteLength(truncated + char, 'utf8') > 255) break
      truncated += char
    }
    name = truncated
  }

  return name || null
}

/** Return a path inside `dir` that does not collide with an existing file. */
export function uniqueFilePath(dir: string, name: string): string {
  const first = join(dir, name)
  if (!existsSync(first)) return first

  const ext = extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(dir, `${base} (${index})${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return join(dir, `${base} (${Date.now()})${ext}`)
}

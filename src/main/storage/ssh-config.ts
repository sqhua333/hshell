import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Session } from '@shared/types'
import { sessionSchema } from '@shared/schemas'

export interface ParsedSshHost {
  /** The `Host` pattern used as the session name. */
  name: string
  hostName: string
  user: string
  port: number
  identityFile?: string
  proxyJump?: string
}

export interface SshConfigParseResult {
  hosts: ParsedSshHost[]
  /** Patterns ignored because they contain wildcards or are duplicates. */
  skipped: number
  warnings: string[]
}

export interface SshConfigSessionOptions {
  username: string
  /** Timestamp for `createdAt`/`updatedAt`. */
  now?: number
  idFactory?: (prefix: string) => string
  home?: string
}

const COLOR_PALETTE = ['#2a6fd6', '#d97706', '#059669', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#dc2626']

const TERMINAL_DEFAULTS = { term: 'xterm-256color', theme: 'dark' as const, fontSize: 14 }

interface HostBlock {
  patterns: string[]
  directives: {
    hostName?: string
    user?: string
    port?: string
    identityFile?: string
    proxyJump?: string
  }
}

function stripComment(line: string): string {
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') quoted = !quoted
    else if (char === '#' && !quoted) return line.slice(0, index)
  }
  return line
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"')
  }
  return trimmed
}

function splitDirective(line: string): { key: string; value: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line)
  if (!match) {
    // A bare keyword such as `Host` with no value is meaningless.
    return /^[A-Za-z][A-Za-z0-9]*$/.test(line) ? { key: line, value: '' } : null
  }
  return { key: match[1], value: unquote(match[2]) }
}

function expandTokens(value: string, host: string, home: string): string {
  return value
    .replace(/%d/g, home)
    .replace(/%h/g, host)
    .replace(/%%/g, '%')
    .replace(/^~(?=$|\/)/, home)
}

function isPatternUsable(pattern: string): boolean {
  return pattern.length > 0 && !/[*?!]/.test(pattern)
}

/**
 * Parse the subset of `~/.ssh/config` HShell understands. The first value
 * obtained for a directive wins, matching OpenSSH behaviour. `Match` blocks
 * and wildcard-only `Host` blocks are ignored.
 */
export function parseSshConfig(
  text: string,
  options: { username: string; home?: string }
): SshConfigParseResult {
  const home = options.home ?? homedir()
  const warnings: string[] = []
  const results: ParsedSshHost[] = []
  const seen = new Set<string>()
  let skipped = 0
  let block: HostBlock | null = null

  const flush = (): void => {
    if (!block) return
    const current = block
    block = null

    for (const pattern of current.patterns) {
      if (!isPatternUsable(pattern)) {
        skipped += 1
        continue
      }
      const name = pattern
      if (seen.has(name.toLowerCase())) {
        skipped += 1
        continue
      }
      seen.add(name.toLowerCase())

      const hostName = expandTokens(current.directives.hostName ?? pattern, pattern, home) || pattern
      const user = expandTokens(current.directives.user ?? options.username, pattern, home)
      const portValue = Number.parseInt(current.directives.port ?? '22', 10)
      const port = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535 ? portValue : 22

      const identityFile = current.directives.identityFile
        ? resolve(home, expandTokens(current.directives.identityFile, pattern, home))
        : undefined

      const jumpRaw = current.directives.proxyJump?.trim()
      const proxyJump =
        jumpRaw && jumpRaw.toLowerCase() !== 'none'
          ? expandTokens(jumpRaw, pattern, home)
          : undefined

      results.push({
        name,
        hostName,
        user: user || options.username,
        port,
        ...(identityFile ? { identityFile } : {}),
        ...(proxyJump ? { proxyJump } : {})
      })
    }
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue

    const parsed = splitDirective(line)
    if (!parsed) continue

    const key = parsed.key.toLowerCase()
    if (key === 'host') {
      flush()
      const patterns = parsed.value.split(/\s+/).filter(Boolean)
      block = { patterns, directives: {} }
      continue
    }
    if (key === 'match') {
      flush()
      continue
    }
    if (!block) continue // Global directives (before the first Host) are ignored.

    switch (key) {
      case 'hostname':
        block.directives.hostName ??= parsed.value
        break
      case 'user':
        block.directives.user ??= parsed.value
        break
      case 'port':
        block.directives.port ??= parsed.value
        break
      case 'identityfile':
        block.directives.identityFile ??= parsed.value
        break
      case 'proxyjump':
        block.directives.proxyJump ??= parsed.value
        break
      case 'include':
        warnings.push('已忽略 Include 指令（暂不支持嵌套配置）')
        break
      default:
        break
    }
  }
  flush()

  return { hosts: results, skipped, warnings }
}

/** Turn parsed hosts into session records ready to merge into the store. */
export function sshConfigToSessions(
  text: string,
  options: SshConfigSessionOptions
): { sessions: Session[]; skipped: number; warnings: string[] } {
  const now = options.now ?? Date.now()
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}`)
  const parsed = parseSshConfig(text, { username: options.username, home: options.home })
  const sessions: Session[] = []
  let skipped = parsed.skipped

  for (const host of parsed.hosts) {
    const session: Session = {
      id: idFactory('session'),
      name: host.name,
      folderId: null,
      host: host.hostName,
      port: host.port,
      username: host.user,
      auth: host.identityFile
        ? { method: 'key', keyPath: host.identityFile }
        : { method: 'agent' },
      terminal: { ...TERMINAL_DEFAULTS },
      proxyJump: host.proxyJump ?? null,
      color: COLOR_PALETTE[sessions.length % COLOR_PALETTE.length],
      createdAt: now,
      updatedAt: now
    }
    if (sessionSchema.safeParse(session).success) sessions.push(session)
    else skipped += 1
  }

  return { sessions, skipped, warnings: parsed.warnings }
}

/** Default location of the OpenSSH client configuration. */
export function defaultSshConfigPath(home = homedir()): string {
  return join(isAbsolute(home) ? home : resolve(home), '.ssh', 'config')
}

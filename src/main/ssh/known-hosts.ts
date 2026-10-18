import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface KnownHostRecord {
  host: string
  port: number
  keyType: string
  keyBase64: string
  fingerprint: string
  addedAt: number
}

export type HostKeyState = 'known' | 'unknown' | 'changed'

export interface HostKeyLookup {
  state: HostKeyState
  oldFingerprint?: string
  source?: 'app' | 'openssh'
}

export function parseKeyAlgorithm(blob: Buffer): string {
  try {
    const len = blob.readUInt32BE(0)
    if (len <= 0 || len > 256 || 4 + len > blob.length) return 'unknown'
    return blob.subarray(4, 4 + len).toString('ascii')
  } catch {
    return 'unknown'
  }
}

export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

export function base64Key(blob: Buffer): string {
  return blob.toString('base64')
}

interface Envelope {
  schemaVersion: number
  data: KnownHostRecord[]
}

export class KnownHosts {
  private file: string
  private records: KnownHostRecord[] = []

  constructor(userDataDir: string) {
    mkdirSync(userDataDir, { recursive: true })
    this.file = join(userDataDir, 'known_hosts.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Envelope
      if (Array.isArray(parsed.data)) this.records = parsed.data
    } catch {
      /* corrupted store is ignored; TOFU will re-prompt */
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, data: this.records } satisfies Envelope, null, 2), {
      mode: 0o600
    })
    if (existsSync(this.file)) {
      try {
        renameSync(this.file, `${this.file}.bak`)
      } catch {
        /* ignore */
      }
    }
    renameSync(tmp, this.file)
  }

  list(): KnownHostRecord[] {
    return [...this.records]
  }

  lookup(host: string, port: number, blob: Buffer): HostKeyLookup {
    const keyBase64 = base64Key(blob)
    const appRecord = this.records.find((r) => r.host === host && r.port === port)
    if (appRecord) {
      if (appRecord.keyBase64 === keyBase64) return { state: 'known', source: 'app' }
      return { state: 'changed', oldFingerprint: appRecord.fingerprint, source: 'app' }
    }

    const openssh = this.lookupOpenSSH(host, port, blob)
    if (openssh) return openssh
    return { state: 'unknown' }
  }

  private lookupOpenSSH(host: string, port: number, blob: Buffer): HostKeyLookup | null {
    const file = join(homedir(), '.ssh', 'known_hosts')
    if (!existsSync(file)) return null
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return null
    }
    const keyBase64 = base64Key(blob)
    const keyType = parseKeyAlgorithm(blob)
    const candidates = new Set<string>([host])
    if (port !== 22) candidates.add(`[${host}]:${port}`)

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('|1|') || line.startsWith('@')) continue
      const parts = line.split(/\s+/)
      if (parts.length < 3) continue
      const [hostField, type, key] = parts
      if (type !== keyType) continue
      const matches = hostField.split(',').some((h) => candidates.has(h))
      if (!matches) continue
      if (key === keyBase64) return { state: 'known', source: 'openssh' }
      return {
        state: 'changed',
        oldFingerprint: this.fingerprintFromBase64(key),
        source: 'openssh'
      }
    }
    return null
  }

  private fingerprintFromBase64(base64: string): string {
    try {
      return fingerprintOf(Buffer.from(base64, 'base64'))
    } catch {
      return 'SHA256:unknown'
    }
  }

  save(host: string, port: number, blob: Buffer): void {
    const record: KnownHostRecord = {
      host,
      port,
      keyType: parseKeyAlgorithm(blob),
      keyBase64: base64Key(blob),
      fingerprint: fingerprintOf(blob),
      addedAt: Date.now()
    }
    this.records = this.records.filter((r) => !(r.host === host && r.port === port))
    this.records.push(record)
    this.persist()
  }

  remove(host: string, port: number): void {
    this.records = this.records.filter((r) => !(r.host === host && r.port === port))
    this.persist()
  }
}

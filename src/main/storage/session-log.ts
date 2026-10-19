import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { sanitizeFileName } from './path-safety'

export type LogFormat = 'text' | 'asciinema'

export interface SessionLogOptions {
  format: LogFormat
  cols?: number
  rows?: number
  term?: string
  /** Rotate when the file reaches this many bytes. */
  maxBytes?: number
  /** Number of rotated files to keep. */
  keepFiles?: number
  /** Prefix every text-log line with a local timestamp. */
  timestamps?: boolean
}

/**
 * Directory for a session's logs. A configured folder is used verbatim (after
 * expanding a leading `~`); relative paths are rejected so a typo cannot
 * scatter logs into the process working directory. An empty value keeps the
 * application default.
 */
export function resolveLogDirectory(configured: string | undefined, fallback: string): string {
  const trimmed = configured?.trim()
  if (!trimmed) return fallback
  if (trimmed.includes('\0')) throw new Error('日志目录包含非法字符')
  const expanded =
    trimmed === '~' || /^~[\\/]/.test(trimmed)
      ? join(homedir(), trimmed.slice(1).replace(/^[\\/]/, ''))
      : trimmed
  if (!isAbsolute(expanded)) throw new Error('日志目录必须是绝对路径')
  return normalize(expanded)
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_KEEP_FILES = 5
const BUFFER_BYTES = 64 * 1024
const FLUSH_INTERVAL_MS = 1000

function stamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('')
}

/** Human-readable prefix for lines in timestamped text logs. */
function lineStamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}] `
  )
}

/**
 * Writes a session recording to a 0600 file inside a 0700 directory.
 * Text mode stores terminal output verbatim; asciinema mode stores the
 * asciinema v2 JSONL format. Output is buffered and fsynced on close/rotation.
 */
export class SessionLogger {
  readonly filePath: string
  private fd: number | null = null
  private readonly decoder = new StringDecoder('utf8')
  private buffer: Buffer[] = []
  private bufferedBytes = 0
  private fileBytes = 0
  private startedAt = Date.now()
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private atLineStart = true
  private readonly maxBytes: number
  private readonly keepFiles: number
  private readonly basePath: string

  constructor(
    directory: string,
    private readonly label: string,
    private readonly options: SessionLogOptions
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES)
    this.keepFiles = Math.max(0, Math.min(50, options.keepFiles ?? DEFAULT_KEEP_FILES))
    const safe = sanitizeFileName(this.label) ?? 'session'
    const extension = options.format === 'asciinema' ? 'cast' : 'log'
    // Keep names predictable: <session>-<YYYYMMDD-HHMMSS>.<ext>. A numeric
    // suffix is only added when two connections would land on the same name.
    const base = `${safe}-${stamp()}`
    let filePath = join(directory, `${base}.${extension}`)
    for (let index = 2; existsSync(filePath); index += 1) {
      filePath = join(directory, `${base}-${index}.${extension}`)
    }
    this.basePath = filePath
    this.filePath = this.basePath
    this.fd = openSync(this.filePath, 'a', 0o600)
    if (options.format === 'asciinema') {
      const header = {
        version: 2,
        width: Math.max(1, options.cols ?? 80),
        height: Math.max(1, options.rows ?? 24),
        timestamp: Math.floor(this.startedAt / 1000),
        env: { TERM: options.term ?? 'xterm-256color' }
      }
      this.writeRaw(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
    }
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  get format(): LogFormat {
    return this.options.format
  }

  write(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return
    const text = this.decoder.write(chunk)
    if (!text) return
    if (this.options.format === 'asciinema') {
      const elapsed = (Date.now() - this.startedAt) / 1000
      const line = `${JSON.stringify([elapsed, 'o', text])}\n`
      this.buffer.push(Buffer.from(line, 'utf8'))
      this.bufferedBytes += line.length
    } else {
      // asciinema events already carry elapsed time, so timestamps only apply
      // to plain-text logs.
      const payload = this.options.timestamps ? this.stampLines(text) : text
      this.buffer.push(Buffer.from(payload, 'utf8'))
      this.bufferedBytes += payload.length
    }
    if (this.bufferedBytes >= BUFFER_BYTES) this.flush()
  }

  /**
   * Insert a timestamp at the start of every non-empty line. Output arrives in
   * arbitrary chunks, so remember whether the previous chunk ended a line.
   */
  private stampLines(text: string): string {
    const parts = text.split('\n')
    let out = ''
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) out += '\n'
      const startsLine = index > 0 || this.atLineStart
      if (startsLine && parts[index].length > 0) out += lineStamp()
      out += parts[index]
    }
    this.atLineStart = text.endsWith('\n')
    return out
  }

  flush(): void {
    if (this.closed || this.fd === null) return
    const tail = this.decoder.end()
    if (tail) this.buffer.push(Buffer.from(tail, 'utf8'))
    if (this.buffer.length === 0) return
    const payload = Buffer.concat(this.buffer)
    this.buffer = []
    this.bufferedBytes = 0
    try {
      writeSync(this.fd, payload)
      this.fileBytes += payload.length
    } catch {
      /* disk full or removed: keep the session running */
      return
    }
    if (this.fileBytes >= this.maxBytes) this.rotate()
  }

  close(): void {
    if (this.closed) return
    this.flush()
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd)
      } catch {
        /* ignore */
      }
      try {
        closeSync(this.fd)
      } catch {
        /* ignore */
      }
      this.fd = null
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd)
      } catch {
        /* ignore */
      }
      try {
        closeSync(this.fd)
      } catch {
        /* ignore */
      }
      this.fd = null
    }
    if (this.keepFiles > 0) {
      const oldest = `${this.basePath}.${this.keepFiles}`
      if (existsSync(oldest)) rmSync(oldest, { force: true })
      for (let index = this.keepFiles - 1; index >= 1; index -= 1) {
        const from = `${this.basePath}.${index}`
        if (!existsSync(from)) continue
        try {
          renameSync(from, `${this.basePath}.${index + 1}`)
        } catch {
          /* ignore */
        }
      }
      try {
        renameSync(this.basePath, `${this.basePath}.1`)
      } catch {
        /* ignore */
      }
    } else {
      try {
        rmSync(this.basePath, { force: true })
      } catch {
        /* ignore */
      }
    }
    this.fd = openSync(this.basePath, 'a', 0o600)
    this.fileBytes = 0
    this.startedAt = Date.now()
    if (this.options.format === 'asciinema') {
      const header = {
        version: 2,
        width: Math.max(1, this.options.cols ?? 80),
        height: Math.max(1, this.options.rows ?? 24),
        timestamp: Math.floor(this.startedAt / 1000),
        env: { TERM: this.options.term ?? 'xterm-256color' }
      }
      this.writeRaw(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
    }
  }

  private writeRaw(payload: Buffer): void {
    if (this.fd === null) return
    try {
      writeSync(this.fd, payload)
      this.fileBytes += payload.length
    } catch {
      /* ignore */
    }
  }

  /** Exposed for tests/diagnostics. */
  size(): number {
    try {
      return statSync(this.filePath).size
    } catch {
      return this.fileBytes
    }
  }
}

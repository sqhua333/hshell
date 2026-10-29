import { StringDecoder } from 'node:string_decoder'
import { stripAnsi } from '@shared/ansi'
import type {
  AiSessionSummary,
  AppEvent,
  ConnectionType,
  Session,
  SshStatus
} from '@shared/types'

export type AiDirection = 'in' | 'out'

export interface AiChunk {
  /** Monotonic per-session sequence number; stable across reconnects. */
  seq: number
  /** Epoch milliseconds when the chunk was observed. */
  at: number
  direction: AiDirection
  /** Who typed it; only set on input chunks. */
  source?: 'user' | 'ai'
  text: string
}

export interface AiReadResult {
  runtimeId: string
  chunks: AiChunk[]
  /** Pass this back as `sinceSeq` to continue after the returned chunks. */
  nextSeq: number
  /** Oldest chunk still buffered; `sinceSeq` below this means data was lost. */
  firstSeq: number
  /** The requested `sinceSeq` predates the buffer, so older output is gone. */
  truncated: boolean
  /** More chunks are buffered after this window; call again with `nextSeq`. */
  hasMore: boolean
}

export interface AiWaitResult extends AiReadResult {
  /** The `pattern` matched within the waited window. */
  matched: boolean
  /** The timeout expired before the pattern matched or the stream went quiet. */
  timedOut: boolean
}

export interface AiWaitOptions {
  sinceSeq?: number
  pattern?: string
  /** Resolve this long after the last new chunk (default 300 ms). */
  quietMs?: number
  /** Give up after this long (default 10 s, capped at 120 s). */
  timeoutMs?: number
}

/** Per-session memory cap; older chunks are dropped first. */
const MAX_SESSION_BYTES = 1024 * 1024
const MAX_CHUNKS = 4096
const MAX_SESSIONS = 16
/** A single chunk larger than this keeps only its tail. */
const MAX_CHUNK_CHARS = 32 * 1024
const DEFAULT_READ_BYTES = 64 * 1024
const MAX_READ_BYTES = 256 * 1024
const MAX_PATTERN_CHARS = 512
const DEFAULT_QUIET_MS = 300
const MAX_QUIET_MS = 10_000
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000
const POLL_MS = 100
const MAX_WAIT_TEXT_CHARS = 2 * 1024 * 1024

interface Channel {
  runtimeId: string
  sessionId: string
  name: string
  target: string
  connectionType: ConnectionType
  status: SshStatus
  startedAt: number
  lastActivityAt: number
  /** Only watched sessions are listed to AI clients and readable over MCP. */
  watched: boolean
  /** The user also allowed AI input; never implied by watching alone. */
  writable: boolean
  /**
   * Input skips the approval card. Only meaningful while `writable`, and
   * cleared whenever input or watching is revoked.
   */
  autoInput: boolean
  chunks: AiChunk[]
  bytes: number
  nextSeq: number
  firstSeq: number
  decoder: StringDecoder
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Normalise terminal output for a language model: drop escape sequences and
 * control characters, and turn the carriage returns that overwrite a line into
 * plain line breaks. `stripAnsi` already removes `\r`, so convert first.
 */
export function cleanTapText(value: string): string {
  return stripAnsi(value.replace(/\r\n?/g, '\n'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Read-only ring buffer of terminal traffic, keyed by runtime id.
 *
 * The main process is the only place that sees both directions of every
 * session (SSH, serial, Telnet and local shells), so the tap lives here rather
 * than in the renderer. Data is buffered while the session exists, but only
 * sessions the user marked as watched are listed or readable by MCP clients.
 * The tap never writes to a session.
 */
export class SessionTap {
  private channels = new Map<string, Channel>()

  /** Called when a connection starts; reconnects reuse the buffer. */
  register(runtimeId: string, session: Session, now = Date.now()): void {
    const existing = this.channels.get(runtimeId)
    if (existing) {
      existing.sessionId = session.id
      existing.name = session.name
      existing.target = sessionTargetOf(session)
      existing.connectionType = session.connectionType ?? 'ssh'
      return
    }
    if (this.channels.size >= MAX_SESSIONS) this.evictSession()
    this.channels.set(runtimeId, {
      runtimeId,
      sessionId: session.id,
      name: session.name,
      target: sessionTargetOf(session),
      connectionType: session.connectionType ?? 'ssh',
      status: 'connecting',
      startedAt: now,
      lastActivityAt: now,
      watched: false,
      writable: false,
      autoInput: false,
      chunks: [],
      bytes: 0,
      nextSeq: 1,
      firstSeq: 1,
      decoder: new StringDecoder('utf8')
    })
  }

  unregister(runtimeId: string): void {
    this.channels.delete(runtimeId)
  }

  has(runtimeId: string): boolean {
    return this.channels.has(runtimeId)
  }

  observeEvent(event: AppEvent): void {
    if (event.type === 'ssh:data') {
      this.recordOutput(event.runtimeId, event.data)
    } else if (event.type === 'ssh:status') {
      const channel = this.channels.get(event.runtimeId)
      if (channel) channel.status = event.status
    }
  }

  /** Terminal output as framed by the backend (UTF-8, possibly split). */
  recordOutput(runtimeId: string, data: Uint8Array, now = Date.now()): void {
    const channel = this.channels.get(runtimeId)
    if (!channel || data.length === 0) return
    const text = cleanTapText(channel.decoder.write(Buffer.from(data)))
    if (text) this.append(channel, 'out', text, now)
  }

  /**
   * Input typed into the session, including secrets typed at an interactive
   * prompt (e.g. a sudo password). Authentication passwords sent through the
   * login/password prompts use their own IPC channels and are not captured.
   */
  recordInput(
    runtimeId: string,
    data: string,
    source: 'user' | 'ai' = 'user',
    now = Date.now()
  ): void {
    const channel = this.channels.get(runtimeId)
    if (!channel || !data) return
    const text = cleanTapText(data)
    if (text) this.append(channel, 'in', text, now, source)
  }

  setWatched(runtimeId: string, watched: boolean): void {
    const channel = this.channels.get(runtimeId)
    if (!channel) throw new Error('会话未注册或已断开')
    channel.watched = watched
    // Revoking visibility also revokes input; the two toggles are independent
    // to grant, but turning watching off must never leave write access behind.
    if (!watched) {
      channel.writable = false
      channel.autoInput = false
    }
  }

  /** Input requires watching, so the AI can see the result of what it sent. */
  setWritable(runtimeId: string, writable: boolean): void {
    const channel = this.channels.get(runtimeId)
    if (!channel) throw new Error('会话未注册或已断开')
    if (writable && !channel.watched) throw new Error('请先开启 AI 观察')
    channel.writable = writable
    // Auto approval builds on the per-write grant; dropping one drops both.
    if (!writable) channel.autoInput = false
  }

  /**
   * Let writes bypass the approval card. Deliberately opt-in per session: the
   * grant is cleared when input or watching is revoked and when the session
   * disconnects.
   */
  setAutoInput(runtimeId: string, auto: boolean): void {
    const channel = this.channels.get(runtimeId)
    if (!channel) throw new Error('会话未注册或已断开')
    if (auto && !channel.writable) throw new Error('请先允许 AI 输入')
    channel.autoInput = auto
  }

  /**
   * Summarise a session that may accept AI input. Throws with a user-facing
   * message so the MCP tool can report why a write was refused.
   */
  requireInput(runtimeId: string): AiSessionSummary {
    const channel = this.channels.get(runtimeId)
    if (!channel) throw new Error('会话不存在或已断开')
    if (!channel.watched) throw new Error('该会话未开启 AI 观察')
    if (!channel.writable) throw new Error('该会话未允许 AI 输入')
    // A registered runtime can outlive its stream (remote shell exited); a
    // write would be silently dropped, so report it instead of "sent".
    if (channel.status !== 'connected') throw new Error('会话未连接')
    return this.summarize(channel)
  }

  watchedIds(): string[] {
    return [...this.channels.values()]
      .filter((channel) => channel.watched)
      .map((channel) => channel.runtimeId)
  }

  /** Summaries for watched sessions only; other sessions stay invisible. */
  list(): AiSessionSummary[] {
    return [...this.channels.values()]
      .filter((channel) => channel.watched)
      .map((channel) => this.summarize(channel))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  private summarize(channel: Channel): AiSessionSummary {
    return {
      runtimeId: channel.runtimeId,
      sessionId: channel.sessionId,
      name: channel.name,
      target: channel.target,
      connectionType: channel.connectionType,
      status: channel.status,
      startedAt: channel.startedAt,
      lastActivityAt: channel.lastActivityAt,
      bufferedBytes: channel.bytes,
      firstSeq: channel.firstSeq,
      latestSeq: Math.max(channel.firstSeq - 1, channel.nextSeq - 1),
      writable: channel.watched && channel.writable,
      autoInput: channel.watched && channel.writable && channel.autoInput
    }
  }

  /**
   * Read buffered traffic. With `sinceSeq` this returns the oldest chunks at or
   * after that sequence (bounded by `maxBytes`); without it, the most recent
   * `maxBytes` are returned so a client can ask "what just happened?".
   */
  read(runtimeId: string, sinceSeq?: number, maxBytes?: number): AiReadResult {
    const channel = this.requireWatched(runtimeId)
    const limit = clamp(
      Number.isFinite(maxBytes) && maxBytes ? Number(maxBytes) : DEFAULT_READ_BYTES,
      1,
      MAX_READ_BYTES
    )
    return this.readWindow(channel, sinceSeq, limit)
  }

  /**
   * Long-poll for new traffic. Resolves on a pattern match, after the stream is
   * quiet, or on timeout (whichever comes first). With no pattern and no
   * quietMs, new data resolves the wait after the default quiet period.
   */
  async waitForOutput(
    runtimeId: string,
    options: AiWaitOptions = {}
  ): Promise<AiWaitResult> {
    const channel = this.requireWatched(runtimeId)
    const patternSource = options.pattern
    let pattern: RegExp | null = null
    if (patternSource !== undefined) {
      if (!patternSource || patternSource.length > MAX_PATTERN_CHARS) {
        throw new Error(`pattern 长度必须在 1–${MAX_PATTERN_CHARS} 个字符之间`)
      }
      try {
        pattern = new RegExp(patternSource)
      } catch (error) {
        throw new Error(`pattern 不是有效的正则表达式：${(error as Error).message}`)
      }
    }
    const quietMs =
      options.quietMs === undefined
        ? DEFAULT_QUIET_MS
        : clamp(Number(options.quietMs) || 0, 0, MAX_QUIET_MS)
    const timeoutMs = clamp(
      options.timeoutMs === undefined
        ? DEFAULT_TIMEOUT_MS
        : Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS,
      100,
      MAX_TIMEOUT_MS
    )
    // `sinceSeq` 0/omitted means "start from now" for a wait, unlike `read`,
    // where it means "give me the recent tail".
    const startSeq =
      options.sinceSeq && options.sinceSeq > 0 ? options.sinceSeq : channel.nextSeq
    const deadline = Date.now() + timeoutMs
    let cursor = startSeq
    let text = ''
    let sawData = false

    for (;;) {
      const { chunks } = this.chunksSince(channel, cursor)
      for (const chunk of chunks) {
        cursor = chunk.seq + 1
        sawData = true
        if (text.length < MAX_WAIT_TEXT_CHARS) {
          text += chunk.text.slice(0, MAX_WAIT_TEXT_CHARS - text.length)
        }
      }
      if (pattern && pattern.test(text)) {
        return { ...this.readWindow(channel, startSeq, MAX_READ_BYTES), matched: true, timedOut: false }
      }
      const quiet =
        sawData &&
        quietMs > 0 &&
        Date.now() - channel.lastActivityAt >= quietMs &&
        // Only settle once every buffered chunk has been consumed.
        cursor >= channel.nextSeq
      if (quiet) {
        return { ...this.readWindow(channel, startSeq, MAX_READ_BYTES), matched: false, timedOut: false }
      }
      if (Date.now() >= deadline) {
        return { ...this.readWindow(channel, startSeq, MAX_READ_BYTES), matched: false, timedOut: true }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  private append(
    channel: Channel,
    direction: AiDirection,
    text: string,
    at: number,
    source?: 'user' | 'ai'
  ): void {
    let body = text
    if (body.length > MAX_CHUNK_CHARS) {
      body = `…[truncated]\n${body.slice(-MAX_CHUNK_CHARS)}`
    }
    const chunk: AiChunk = {
      seq: channel.nextSeq,
      at,
      direction,
      ...(source ? { source } : {}),
      text: body
    }
    channel.nextSeq += 1
    channel.chunks.push(chunk)
    channel.bytes += byteLength(body)
    channel.lastActivityAt = at
    while (
      channel.chunks.length > MAX_CHUNKS ||
      channel.bytes > MAX_SESSION_BYTES
    ) {
      const removed = channel.chunks.shift()
      if (!removed) break
      channel.bytes -= byteLength(removed.text)
    }
    channel.firstSeq = channel.chunks[0]?.seq ?? channel.nextSeq
  }

  private chunksSince(channel: Channel, sinceSeq: number): { chunks: AiChunk[] } {
    return { chunks: channel.chunks.filter((chunk) => chunk.seq >= sinceSeq) }
  }

  private readWindow(
    channel: Channel,
    sinceSeq: number | undefined,
    limit: number
  ): AiReadResult {
    const latest = channel.nextSeq - 1
    if (sinceSeq === undefined || sinceSeq <= 0) {
      const picked: AiChunk[] = []
      let bytes = 0
      for (let index = channel.chunks.length - 1; index >= 0; index -= 1) {
        const chunk = channel.chunks[index]
        const size = byteLength(chunk.text)
        if (picked.length > 0 && bytes + size > limit) break
        picked.unshift(chunk)
        bytes += size
      }
      return {
        runtimeId: channel.runtimeId,
        chunks: picked,
        nextSeq: picked.length ? picked[picked.length - 1].seq + 1 : channel.nextSeq,
        firstSeq: channel.firstSeq,
        truncated: false,
        hasMore: false
      }
    }

    const truncated = sinceSeq < channel.firstSeq
    const start = Math.max(sinceSeq, channel.firstSeq)
    const available = channel.chunks.filter((chunk) => chunk.seq >= start)
    const picked: AiChunk[] = []
    let bytes = 0
    let hasMore = false
    for (const chunk of available) {
      const size = byteLength(chunk.text)
      if (picked.length > 0 && bytes + size > limit) {
        hasMore = true
        break
      }
      picked.push(chunk)
      bytes += size
    }
    return {
      runtimeId: channel.runtimeId,
      chunks: picked,
      nextSeq: picked.length ? picked[picked.length - 1].seq + 1 : Math.max(start, latest + 1),
      firstSeq: channel.firstSeq,
      truncated,
      hasMore
    }
  }

  private requireWatched(runtimeId: string): Channel {
    const channel = this.channels.get(runtimeId)
    if (!channel) throw new Error('会话不存在或已断开')
    if (!channel.watched) throw new Error('该会话未开启 AI 观察')
    return channel
  }

  /** Prefer dropping an unwatched session; fall back to the oldest. */
  private evictSession(): void {
    const candidates = [...this.channels.values()].sort((a, b) => a.startedAt - b.startedAt)
    const victim = candidates.find((channel) => !channel.watched) ?? candidates[0]
    if (victim) this.channels.delete(victim.runtimeId)
  }
}

function sessionTargetOf(session: Session): string {
  if (session.connectionType === 'serial') {
    return session.serial ? `${session.serial.path} · ${session.serial.baudRate}` : session.name
  }
  if (session.connectionType === 'local') return session.name
  return session.username ? `${session.username}@${session.host}:${session.port}` : `${session.host}:${session.port}`
}

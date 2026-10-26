import { closeSync, createWriteStream, openSync, readSync, statSync, unlinkSync } from 'node:fs'
import { basename } from 'node:path'
import Zmodem from 'zmodem.js'
import type { ZmodemFileDetails, ZmodemOffer, ZmodemSession, ZmodemTransfer } from 'zmodem.js'
import { sanitizeFileName, uniqueFilePath } from '../storage/path-safety'

/**
 * `**` ZDLE 'B' '0' — the first five bytes of a ZRQINIT/ZRINIT hex header.
 * ZMODEM sessions are only started by these two frames, so anything else can
 * be shown on the terminal untouched.
 */
const ZMODEM_MARKER = Buffer.from([0x2a, 0x2a, 0x18, 0x42, 0x30])

/** Longest plausible init header before LF (CR LF + XON included). */
const MAX_HEADER_BYTES = 32

/**
 * How long a trailing marker prefix (`*`, `**`, ...) may be withheld while
 * waiting for the rest of a possibly split init header. Ordinary output that
 * happens to end with `*` (an echo of a typed asterisk, a prompt) must not be
 * stuck until the next chunk arrives, so release it once the burst ends.
 */
const HELD_FLUSH_MS = 30

/** Stop reading a local file when the SSH channel has this much queued. */
const SEND_HIGH_WATER = 4 * 1024 * 1024
const CHUNK_SIZE = 64 * 1024
const PROGRESS_INTERVAL_MS = 200
/**
 * How long to wait for the peer's ZFIN before aborting. lrzsz can otherwise
 * leave the session open for many seconds, during which the controller keeps
 * consuming terminal output and the shell appears frozen.
 */
const CLOSE_TIMEOUT_MS = 2000

export type ZmodemPhase =
  | 'detected'
  | 'receiving'
  | 'sending'
  | 'file-complete'
  | 'complete'
  | 'cancelled'
  | 'error'

export interface ZmodemStatus {
  phase: ZmodemPhase
  direction?: 'download' | 'upload'
  fileName?: string
  transferred?: number
  total?: number
  message?: string
}

export interface ZmodemHost {
  /** Ask the user where received files should be written. */
  pickDownloadDirectory(suggestedName?: string): Promise<string | null>
  /** Ask the user which local files to send to the remote side. */
  pickUploadFiles(): Promise<string[] | null>
}

export interface ZmodemCallbacks {
  /** Write protocol bytes to the remote shell channel. */
  writeRemote(data: Uint8Array): void
  /** Write ordinary terminal output (non-ZMODEM bytes) to the renderer. */
  writeTerminal(data: Uint8Array): void
  /** Report transfer progress/state changes. */
  status(update: ZmodemStatus): void
  /** Approximate number of bytes still buffered on the SSH channel. */
  remoteWritableLength?(): number
  host: ZmodemHost
}

interface FlowState {
  cancelled: boolean
  errored: boolean
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Resolution/rejection bound so a silent peer cannot wedge the controller. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('ZMODEM 对端无响应')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Intercepts a PTY stream and handles ZMODEM transfers initiated by `sz`/`rz`
 * on the remote host.
 *
 * The detector holds back only the trailing bytes that could be the beginning
 * of an init header, so normal terminal output is not delayed otherwise.
 */
export class ZmodemController {
  private held = Buffer.alloc(0)
  private heldTimer: ReturnType<typeof setTimeout> | null = null
  private session: ZmodemSession | null = null
  private disposed = false
  /** Swallow the XON/XOFF that follows a dropped control header. */
  private swallowFlowControl = false
  private flow: FlowState = { cancelled: false, errored: false }

  constructor(private readonly callbacks: ZmodemCallbacks) {}

  feed(chunk: Buffer): void {
    if (this.disposed) {
      this.callbacks.writeTerminal(chunk)
      return
    }
    this.clearHeldTimer()
    if (this.session) {
      this.consumeSession(this.session, chunk)
      return
    }
    const data = this.held.length ? Buffer.concat([this.held, chunk]) : chunk
    this.held = Buffer.alloc(0)
    this.scan(data)
  }

  dispose(): void {
    this.disposed = true
    this.session = null
    this.held = Buffer.alloc(0)
    this.clearHeldTimer()
  }

  private clearHeldTimer(): void {
    if (this.heldTimer) {
      clearTimeout(this.heldTimer)
      this.heldTimer = null
    }
  }

  /** Release a held init-header prefix if no further data completes it. */
  private scheduleHeldFlush(): void {
    this.clearHeldTimer()
    this.heldTimer = setTimeout(() => {
      this.heldTimer = null
      if (this.disposed || this.session || !this.held.length) return
      const held = this.held
      this.held = Buffer.alloc(0)
      this.callbacks.writeTerminal(held)
    }, HELD_FLUSH_MS)
  }

  private consumeSession(session: ZmodemSession, chunk: Buffer): void {
    try {
      session.consume(Array.from(chunk))
    } catch (error) {
      if (this.session === session) this.session = null
      if (!this.flow.cancelled && !this.flow.errored) {
        this.callbacks.status({
          phase: 'error',
          message: `ZMODEM 传输中断：${errorMessage(error)}`
        })
      }
    }
  }

  private scan(data: Buffer): void {
    let pos = 0
    if (this.swallowFlowControl) {
      while (pos < data.length && isFlowControl(data[pos])) pos += 1
      this.swallowFlowControl = false
    }
    for (;;) {
      const index = data.indexOf(ZMODEM_MARKER, pos)
      if (index < 0) {
        const hold = trailingPrefixLength(data, pos)
        const end = data.length - hold
        if (end > pos) this.callbacks.writeTerminal(data.subarray(pos, end))
        if (hold > 0) {
          this.held = Buffer.from(data.subarray(end))
          this.scheduleHeldFlush()
        }
        return
      }

      const candidate = data.subarray(index)
      const lfPos = firstLineFeed(candidate)
      if (lfPos < 0 || lfPos > MAX_HEADER_BYTES) {
        if (candidate.length <= MAX_HEADER_BYTES && lfPos < 0) {
          // Possibly a header split across chunks; hold it and wait.
          if (index > pos) this.callbacks.writeTerminal(data.subarray(pos, index))
          this.held = Buffer.from(candidate)
          return
        }
        // Not a real header — emit one byte and keep scanning.
        this.callbacks.writeTerminal(data.subarray(pos, index + 1))
        pos = index + 1
        continue
      }

      const octets = Array.from(candidate)
      let session: ZmodemSession | undefined
      try {
        session = Zmodem.Session.parse(octets)
      } catch {
        session = undefined
      }

      if (!session) {
        // A well-formed header that does not start a session (ZSKIP, ZFIN,
        // ZABORT reactions, ...) is leftover protocol noise from a just-ended
        // transfer. Drop it instead of drawing its control bytes.
        if (parsesAsHeader(candidate.subarray(0, lfPos + 1))) {
          if (index > pos) this.callbacks.writeTerminal(data.subarray(pos, index))
          pos = index + lfPos + 1
          while (pos < data.length && isFlowControl(data[pos])) pos += 1
          if (pos >= data.length) this.swallowFlowControl = true
          continue
        }
        this.callbacks.writeTerminal(data.subarray(pos, index + 1))
        pos = index + 1
        continue
      }

      if (index > pos) this.callbacks.writeTerminal(data.subarray(pos, index))
      const trailing = Buffer.from(octets)
      this.begin(session, trailing)
      return
    }
  }

  private begin(session: ZmodemSession, trailing: Buffer): void {
    this.session = session
    this.flow = { cancelled: false, errored: false }

    session.set_sender((octets) => {
      if (!this.disposed) this.callbacks.writeRemote(Uint8Array.from(octets))
    })
    session.on('garbage', (octets) => {
      if (!this.disposed) this.callbacks.writeTerminal(Uint8Array.from(octets))
    })
    session.on('session_end', () => {
      if (this.session === session) this.session = null
    })

    if (session.type === 'receive') {
      void this.receive(session, trailing)
    } else {
      void this.send(session, trailing)
    }
  }

  // ------------------------------------------------------------- receiving

  private async receive(session: ZmodemSession, trailing: Buffer): Promise<void> {
    const queued: ZmodemOffer[] = []
    let directory: string | null = null
    this.callbacks.status({ phase: 'detected', direction: 'download' })

    session.on('offer', (offer) => {
      if (this.disposed) return
      if (this.flow.cancelled) {
        this.skip(offer)
        return
      }
      if (directory) void this.acceptOffer(session, offer, directory)
      else queued.push(offer)
    })

    try {
      // Answer ZRQINIT right away; the remote keeps waiting for ZRINIT.
      const started = session.start()
      void started.catch(() => undefined)
      if (trailing.length) this.consumeSession(session, trailing)

      const selected = await this.callbacks.host.pickDownloadDirectory()
      if (this.disposed) return
      if (!selected) {
        this.flow.cancelled = true
        queued.splice(0).forEach((offer) => this.skip(offer))
        this.abort(session)
        this.callbacks.status({
          phase: 'cancelled',
          direction: 'download',
          message: '已取消接收文件'
        })
        return
      }

      directory = selected
      queued.splice(0).forEach((offer) => void this.acceptOffer(session, offer, selected))
    } catch (error) {
      this.fail(session, 'download', error)
    }
  }

  private async acceptOffer(
    session: ZmodemSession,
    offer: ZmodemOffer,
    directory: string
  ): Promise<void> {
    const details = offer.get_details()
    const name = sanitizeFileName(details.name)
    if (!name) {
      this.skip(offer)
      this.callbacks.status({
        phase: 'error',
        direction: 'download',
        message: `已跳过不安全的文件名：${String(details.name)}`
      })
      return
    }

    const target = uniqueFilePath(directory, name)
    const total = typeof details.size === 'number' ? details.size : 0
    let transferred = 0
    let lastReport = 0
    let writeError: Error | null = null
    const stream = createWriteStream(target, { mode: 0o600, flags: 'wx' })
    // Keep the protocol running (the sender must not stall) but remember the
    // failure so the transfer is reported as failed instead of completed.
    stream.on('error', (error) => {
      writeError = error
      this.flow.errored = true
    })

    this.callbacks.status({
      phase: 'receiving',
      direction: 'download',
      fileName: basename(target),
      transferred: 0,
      total
    })

    try {
      const done = offer.accept({
        on_input: (chunk) => {
          const buffer = Buffer.from(chunk)
          if (!writeError) stream.write(buffer)
          transferred += buffer.length
          const now = Date.now()
          if (now - lastReport >= PROGRESS_INTERVAL_MS) {
            lastReport = now
            this.callbacks.status({
              phase: 'receiving',
              direction: 'download',
              fileName: basename(target),
              transferred,
              total
            })
          }
        }
      })
      await done
      await new Promise<void>((resolve) => {
        if (writeError) {
          resolve()
          return
        }
        stream.once('close', () => resolve())
        stream.end(() => resolve())
      })
      if (writeError) throw writeError
      this.callbacks.status({
        phase: 'file-complete',
        direction: 'download',
        fileName: basename(target),
        transferred,
        total
      })
    } catch (error) {
      stream.destroy()
      try {
        unlinkSync(target)
      } catch {
        /* ignore */
      }
      // Stop the peer now; otherwise `sz` may keep the session open for
      // several seconds and terminal output stays trapped in the controller.
      this.abort(session)
      this.callbacks.status({
        phase: 'error',
        direction: 'download',
        fileName: basename(target),
        message: `接收失败：${errorMessage(error)}`
      })
    }
  }

  private skip(offer: ZmodemOffer): void {
    try {
      offer.skip()
    } catch {
      /* already skipped or finished */
    }
  }

  // ---------------------------------------------------------------- sending

  private async send(session: ZmodemSession, trailing: Buffer): Promise<void> {
    this.callbacks.status({ phase: 'detected', direction: 'upload' })
    try {
      if (trailing.length) this.consumeSession(session, trailing)

      const picked = await this.callbacks.host.pickUploadFiles()
      if (this.disposed) return
      if (!picked || picked.length === 0) {
        this.flow.cancelled = true
        this.abort(session)
        this.callbacks.status({
          phase: 'cancelled',
          direction: 'upload',
          message: '已取消发送文件'
        })
        return
      }

      const files = picked
        .map((path) => {
          const stat = statSync(path)
          return { path, name: basename(path), size: stat.size, mtime: stat.mtime }
        })
        .filter((file) => file.size >= 0)

      let bytesRemaining = files.reduce((sum, file) => sum + file.size, 0)
      // ZSKIP resolves send_offer() without a transfer; that is how `rz`
      // reports a file it cannot create (read-only directory, no space, ...).
      const skipped: string[] = []
      for (let index = 0; index < files.length; index += 1) {
        if (this.disposed || this.flow.cancelled) return
        const file = files[index]
        const details: ZmodemFileDetails = {
          name: file.name,
          size: file.size,
          mtime: file.mtime,
          files_remaining: files.length - index,
          bytes_remaining: bytesRemaining
        }
        const transfer = await session.send_offer(details)
        if (transfer) await this.sendFile(transfer, file)
        else skipped.push(file.name)
        bytesRemaining -= file.size
      }

      if (!this.disposed && !this.flow.cancelled) {
        if (skipped.length > 0) {
          // `rz` refused at least one file. Abort instead of waiting for the
          // ZFIN handshake, so the shell becomes usable again immediately.
          this.abort(session)
          this.flow.errored = true
          this.callbacks.status({
            phase: 'error',
            direction: 'upload',
            fileName: skipped.join(', '),
            message: `远端拒绝接收：${skipped.join('、')}（目录不可写或空间不足）`
          })
        } else {
          try {
            await withTimeout(session.close(), CLOSE_TIMEOUT_MS)
          } catch {
            this.abort(session)
          }
          this.callbacks.status({ phase: 'complete', direction: 'upload' })
        }
      }
    } catch (error) {
      this.fail(session, 'upload', error)
    }
  }

  private async sendFile(
    transfer: ZmodemTransfer,
    file: { path: string; name: string; size: number }
  ): Promise<void> {
    this.callbacks.status({
      phase: 'sending',
      direction: 'upload',
      fileName: file.name,
      transferred: 0,
      total: file.size
    })

    const fd = openSync(file.path, 'r')
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
    let offset = 0
    let lastReport = 0
    try {
      while (offset < file.size) {
        await this.waitForDrain()
        if (this.disposed || this.flow.cancelled) return
        const length = Math.min(CHUNK_SIZE, file.size - offset)
        const read = readSync(fd, buffer, 0, length, offset)
        if (read <= 0) break
        const piece = new Uint8Array(buffer.subarray(0, read))
        offset += read
        if (offset >= file.size) await transfer.end(piece)
        else transfer.send(piece)

        const now = Date.now()
        if (now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now
          this.callbacks.status({
            phase: 'sending',
            direction: 'upload',
            fileName: file.name,
            transferred: offset,
            total: file.size
          })
        }
      }
      if (file.size === 0) await transfer.end(new Uint8Array(0))
      this.callbacks.status({
        phase: 'file-complete',
        direction: 'upload',
        fileName: file.name,
        transferred: offset,
        total: file.size
      })
    } finally {
      closeSync(fd)
    }
  }

  private async waitForDrain(): Promise<void> {
    const pending = this.callbacks.remoteWritableLength
    if (!pending) return
    while (!this.disposed && pending() > SEND_HIGH_WATER) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  // ----------------------------------------------------------------- shared

  private abort(session: ZmodemSession): void {
    try {
      session.abort()
    } catch {
      /* already ended */
    }
  }

  private fail(session: ZmodemSession, direction: 'download' | 'upload', error: unknown): void {
    if (this.disposed) return
    this.flow.errored = true
    this.callbacks.status({
      phase: 'error',
      direction,
      message: `ZMODEM 传输失败：${errorMessage(error)}`
    })
    this.abort(session)
  }
}

function isFlowControl(octet: number): boolean {
  return octet === 0x11 || octet === 0x13
}

function parsesAsHeader(octets: Buffer): boolean {
  try {
    const header = Zmodem.Header.parse_hex(Array.from(octets))
    return Boolean(header?.NAME)
  } catch {
    return false
  }
}

/** Largest k < marker length such that `data` ends with marker[0..k]. */
function trailingPrefixLength(data: Buffer, start: number): number {
  const max = Math.min(ZMODEM_MARKER.length - 1, data.length - start)
  for (let length = max; length > 0; length -= 1) {
    if (data.subarray(data.length - length).equals(ZMODEM_MARKER.subarray(0, length))) {
      return length
    }
  }
  return 0
}

function firstLineFeed(buffer: Buffer): number {
  const lf = buffer.indexOf(0x0a)
  const lfHigh = buffer.indexOf(0x8a)
  if (lf < 0) return lfHigh
  if (lfHigh < 0) return lf
  return Math.min(lf, lfHigh)
}
